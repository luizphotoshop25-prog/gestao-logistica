#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");
const { applyDigitalQuantitiesMigration } = require("../../electron/digital-quantities-migration.cjs");

const EXPECTED = { shipments: 172, relations: 780 };
function args(argv) {
  const out = { db: "", plan: path.resolve("work/digital-history/import-plan.json"), details: path.resolve("work/digital-history/details.json"), backup: "" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--db") out.db = path.resolve(argv[++i] || "");
    else if (argv[i] === "--plan") out.plan = path.resolve(argv[++i] || "");
    else if (argv[i] === "--details") out.details = path.resolve(argv[++i] || "");
    else if (argv[i] === "--backup") out.backup = path.resolve(argv[++i] || "");
    else throw new Error("argument_invalid");
  }
  if (!out.db || !out.backup) throw new Error("db_and_backup_required");
  return out;
}
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const counts = (db) => db.prepare("SELECT (SELECT count(*) FROM digital_envios) shipments,(SELECT count(*) FROM digital_envio_itens) relations").get();
const integrity = (db) => db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
const foreignKeys = (db) => db.prepare("PRAGMA foreign_key_check").all();
function classifyTotal(total, quantities) {
  if (total === null || quantities.some((quantity) => quantity === null || quantity === undefined)) return "UNKNOWN";
  const sum = quantities.reduce((value, quantity) => value + quantity, 0);
  return sum === total ? "MATCH" : sum < total ? "UNDER_TOTAL" : "OVER_TOTAL";
}

function sourceMaps(plan, details) {
  if (plan?.stage !== "import-plan" || plan.summary?.eligibleOrders !== EXPECTED.shipments || plan.eligible?.length !== EXPECTED.shipments) throw new Error("plan_mismatch");
  if (details?.stage !== "details" || details.summary?.pedidosProcessados !== 200) throw new Error("details_mismatch");
  const detailMap = new Map();
  for (const detail of details.orders || []) {
    const number = String(detail.numeroPedidoDigital ?? "");
    if (!number || detailMap.has(number)) throw new Error("duplicate_or_missing_detail_number");
    detailMap.set(number, detail);
  }
  const eligible = new Map();
  for (const order of plan.eligible) {
    const number = String(order.numeroPedidoDigital);
    if (eligible.has(number)) throw new Error("duplicate_plan_number");
    const detail = detailMap.get(number);
    if (!detail || !Number.isSafeInteger(detail.itensInformados) || detail.itensInformados < 0 || !Array.isArray(detail.sessoes)) throw new Error(`order_total_missing:${number}`);
    const sessions = new Map();
    for (const row of detail.sessoes) {
      const session = String(row.sessao || "").toUpperCase();
      if (!/^M\d+$/.test(session) || !Number.isSafeInteger(row.arquivos) || row.arquivos < 0 || sessions.has(session)) throw new Error(`detail_session_invalid:${number}`);
      sessions.set(session, row.arquivos);
    }
    const planRelations = new Map(order.relations.map((row) => [String(row.sessao).toUpperCase(), row]));
    const missingRelations = new Map((order.missingRelations || []).map((row) => [String(row.sessao).toUpperCase(), row]));
    if (planRelations.size !== order.relations.length || missingRelations.size !== (order.missingRelations || []).length
      || sessions.size !== planRelations.size + missingRelations.size) throw new Error(`session_relation_mismatch:${number}`);
    for (const [session, row] of planRelations) if (sessions.get(session) !== row.arquivos) throw new Error(`session_quantity_mismatch:${number}:${session}`);
    for (const [session, row] of missingRelations) if (sessions.get(session) !== row.arquivos) throw new Error(`missing_session_quantity_mismatch:${number}:${session}`);
    eligible.set(number, { total: detail.itensInformados, sessions: new Map([...planRelations].map(([session]) => [session, sessions.get(session)])) });
  }
  return eligible;
}

function tableSnapshot(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('schema_migrations') ORDER BY name").all().map((r) => r.name);
  const omit = new Set(["digital_envios", "digital_envio_itens"]);
  return Object.fromEntries(names.filter((name) => !omit.has(name)).map((name) => {
    const escaped = name.replaceAll('"', '""');
    const rows = db.prepare(`SELECT * FROM "${escaped}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return [name, { count: rows.length, hash: sha(rows) }];
  }));
}

function preflight(db, plan, details) {
  const source = sourceMaps(plan, details);
  const c = counts(db);
  if (c.shipments !== EXPECTED.shipments || c.relations !== EXPECTED.relations) throw new Error("pilot_counts_mismatch");
  if (integrity(db).join() !== "ok" || foreignKeys(db).length) throw new Error("pilot_integrity_failed");
  const shipments = db.prepare("SELECT id,numero_pedido_digital FROM digital_envios").all();
  const seen = new Set();
  const updates = [], orderUpdates = [];
  let match = 0, under = 0, over = 0, totalMissing = 0, quantityMissing = 0;
  for (const shipment of shipments) {
    const number = String(shipment.numero_pedido_digital);
    if (seen.has(number.toLowerCase())) throw new Error("duplicate_pilot_order_number");
    seen.add(number.toLowerCase());
    const known = source.get(number);
    if (!known) { totalMissing++; throw new Error(`pilot_order_absent_from_source:${number}`); }
    orderUpdates.push({ shipmentId: shipment.id, total: known.total, number });
    const rows = db.prepare("SELECT i.id,p.sessao FROM digital_envio_itens i JOIN pedidos p ON p.id=i.pedido_id WHERE i.digital_envio_id=?").all(shipment.id);
    const actual = new Set();
    const quantities = [];
    for (const row of rows) {
      const session = String(row.sessao).toUpperCase();
      if (actual.has(session) || !known.sessions.has(session)) throw new Error(`pilot_relation_mismatch:${number}:${session}`);
      actual.add(session);
      const quantity = known.sessions.get(session);
      if (quantity === null || quantity === undefined) quantityMissing++;
      quantities.push(quantity ?? null);
      updates.push({ shipmentId: shipment.id, itemId: row.id, total: known.total, quantity: quantity ?? null });
    }
    if (actual.size !== rows.length || rows.length !== known.sessions.size) throw new Error(`pilot_relation_count_mismatch:${number}`);
    const classification = classifyTotal(known.total, quantities);
    if (classification === "MATCH") match++;
    else if (classification === "UNDER_TOTAL") under++;
    else if (classification === "OVER_TOTAL") over++;
  }
  if (over) throw new Error("over_total_blocks_backfill");
  if (updates.length !== EXPECTED.relations) throw new Error("pilot_relation_total_mismatch");
  return { source, updates, orderUpdates, counts: c, match, under, over, totalMissing, quantityMissing };
}

async function run(options) {
  if (fs.existsSync(options.backup)) throw new Error("backup_exists");
  const plan = read(options.plan), details = read(options.details);
  const beforeDb = new DatabaseSync(options.db, { readOnly: true });
  let pre;
  try { beforeDb.exec("PRAGMA query_only=ON"); pre = preflight(beforeDb, plan, details); }
  finally { beforeDb.close(); }
  fs.mkdirSync(path.dirname(options.backup), { recursive: true });
  const backupSource = new DatabaseSync(options.db, { readOnly: true });
  try { backupSource.exec("PRAGMA query_only=ON"); await backup(backupSource, options.backup); }
  finally { backupSource.close(); }
  const copy = new DatabaseSync(options.backup, { readOnly: true });
  try { copy.exec("PRAGMA query_only=ON"); if (integrity(copy).join() !== "ok") throw new Error("backup_integrity_failed"); }
  finally { copy.close(); }

  const db = new DatabaseSync(options.db);
  let committed = false;
  try {
    applyDigitalQuantitiesMigration(db);
    const unchanged = tableSnapshot(db);
    db.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    try {
      const live = preflight(db, plan, details);
      if (live.updates.length !== pre.updates.length || sha(live.updates) !== sha(pre.updates) || sha(live.orderUpdates) !== sha(pre.orderUpdates)) throw new Error("preflight_changed");
      const setShipment = db.prepare("UPDATE digital_envios SET itens_digital=? WHERE id=?");
      const setItem = db.prepare("UPDATE digital_envio_itens SET quantidade_enviada=? WHERE id=?");
      for (const update of live.orderUpdates) if (setShipment.run(update.total, update.shipmentId).changes !== 1) throw new Error("shipment_update_failed");
      for (const update of live.updates) {
        if (setItem.run(update.quantity, update.itemId).changes !== 1) throw new Error("relation_update_failed");
      }
      if (JSON.stringify(counts(db)) !== JSON.stringify(pre.counts)) throw new Error("row_counts_changed");
      if (sha(tableSnapshot(db)) !== sha(unchanged)) throw new Error("unrelated_table_changed");
      if (foreignKeys(db).length || integrity(db).join() !== "ok") throw new Error("post_write_integrity_failed");
      db.exec("COMMIT"); committed = true;
    } finally { if (!committed) { try { db.exec("ROLLBACK"); } catch {} } }
  } finally { db.close(); }
  const verify = new DatabaseSync(options.db, { readOnly: true });
  try {
    verify.exec("PRAGMA query_only=ON");
    const expected = { "118596": [48, { M49828: 40, M50204: 8 }], "118569": [1, { M50196: 1 }], "118374": [460, { M49868: 31, M49992: 156, M50014: 30, M50135: 51, M50175: 50, M50201: 142 }], "118489": [235], "118382": [8], "118223": [48], "118212": [32], "118211": [80], "118186": [48], "118109": [8], "118071": [1], "118062": [151], "118061": [151], "117974": [20], "117972": [35], "117906": [336] };
    const examples = Object.fromEntries(Object.keys(expected).map((number) => {
      const shipment = verify.prepare("SELECT id,itens_digital FROM digital_envios WHERE numero_pedido_digital=?").get(number);
      if (!shipment) {
        const excluded = plan.excluded?.find((row) => row.numeroPedidoDigital === number);
        const detail = details.orders.find((row) => row.numeroPedidoDigital === number);
        if (excluded?.reason !== "CANCELLED" || detail?.itensInformados !== expected[number][0]) throw new Error(`example_missing:${number}`);
        return [number, { total: expected[number][0], pilotImport: "excluded_cancelled", sessions: detail.sessoes }];
      }
      const sessions = verify.prepare("SELECT p.sessao,i.quantidade_enviada FROM digital_envio_itens i JOIN pedidos p ON p.id=i.pedido_id WHERE i.digital_envio_id=? ORDER BY p.sessao").all(shipment.id);
      if (shipment.itens_digital !== expected[number][0]) throw new Error(`example_total_mismatch:${number}`);
      for (const [session, quantity] of Object.entries(expected[number][1] || {})) if (sessions.find((row) => row.sessao.toUpperCase() === session)?.quantidade_enviada !== quantity) throw new Error(`example_session_mismatch:${number}:${session}`);
      return [number, { total: shipment.itens_digital, sessions }];
    }));
    return { backup: options.backup, backupIntegrity: "ok", finalCounts: counts(verify), match: pre.match, under: pre.under, over: pre.over, orderTotalsUpdated: EXPECTED.shipments, sessionQuantitiesUpdated: pre.updates.length, totalMissing: pre.totalMissing, quantityMissing: pre.quantityMissing, integrityCheck: integrity(verify), foreignKeyViolations: foreignKeys(verify), examples };
  } finally { verify.close(); }
}

if (require.main === module) run(args(process.argv.slice(2))).then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(`BLOQUEADO: ${error.message}`); process.exitCode = 1; });
module.exports = { classifyTotal, sourceMaps, preflight, run };
