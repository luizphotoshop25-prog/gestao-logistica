#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const args = process.argv.slice(2);
function option(name, fallback = "") { const index = args.indexOf(name); return index < 0 ? fallback : path.resolve(args[index + 1] || ""); }
const databasePath = option("--db");
const backupPath = option("--backup");
const planPath = option("--plan", "work/digital-history/import-plan.json");
const detailsPath = option("--details", "work/digital-history/details.json");
if (!databasePath || !backupPath) throw new Error("db_and_backup_required");
const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
const details = JSON.parse(fs.readFileSync(detailsPath, "utf8"));
const sha = (value) => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
function snapshot(db) {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name<>'schema_migrations' AND name NOT IN ('digital_envios','digital_envio_itens') ORDER BY name").all().map((row) => row.name);
  return Object.fromEntries(names.map((name) => {
    const rows = db.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return [name, { count: rows.length, hash: sha(rows) }];
  }));
}
const live = new DatabaseSync(databasePath, { readOnly: true });
const backup = new DatabaseSync(backupPath, { readOnly: true });
try {
  live.exec("PRAGMA query_only=ON"); backup.exec("PRAGMA query_only=ON");
  const integrity = live.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
  const foreignKeys = live.prepare("PRAGMA foreign_key_check").all();
  const backupIntegrity = backup.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check);
  if (integrity.join() !== "ok" || foreignKeys.length || backupIntegrity.join() !== "ok") throw new Error("integrity_check_failed");
  const rowCounts = live.prepare("SELECT (SELECT count(*) FROM digital_envios) shipments,(SELECT count(*) FROM digital_envio_itens) relations,(SELECT count(*) FROM digital_envio_eventos) events,(SELECT count(*) FROM digital_envios WHERE itens_digital IS NULL) unknownTotals,(SELECT count(*) FROM digital_envio_itens WHERE quantidade_enviada IS NULL) unknownQuantities").get();
  if (rowCounts.shipments !== 172 || rowCounts.relations !== 780 || rowCounts.events !== 172 || rowCounts.unknownTotals !== 0 || rowCounts.unknownQuantities !== 0) throw new Error("pilot_counts_or_backfill_mismatch");
  const source = new Map(details.orders.map((row) => [row.numeroPedidoDigital, row]));
  const liveShipments = live.prepare("SELECT id,numero_pedido_digital,itens_digital FROM digital_envios").all();
  let match = 0, under = 0, over = 0;
  for (const shipment of liveShipments) {
    const detail = source.get(shipment.numero_pedido_digital);
    if (!detail || detail.itensInformados !== shipment.itens_digital) throw new Error(`order_total_mismatch:${shipment.numero_pedido_digital}`);
    const rows = live.prepare("SELECT p.sessao,i.quantidade_enviada FROM digital_envio_itens i JOIN pedidos p ON p.id=i.pedido_id WHERE i.digital_envio_id=?").all(shipment.id);
    const extracted = new Map(detail.sessoes.filter((row) => row.existeNoGestao).map((row) => [row.sessao.toUpperCase(), row.arquivos]));
    if (rows.length !== extracted.size) throw new Error(`relation_count_mismatch:${shipment.numero_pedido_digital}`);
    let sum = 0;
    for (const row of rows) {
      const expected = extracted.get(row.sessao.toUpperCase());
      if (expected === undefined || expected !== row.quantidade_enviada) throw new Error(`session_quantity_mismatch:${shipment.numero_pedido_digital}:${row.sessao}`);
      sum += expected;
    }
    if (sum === shipment.itens_digital) match++;
    else if (sum < shipment.itens_digital) under++;
    else over++;
  }
  if (over !== 0 || match !== 154 || under !== 18) throw new Error("total_category_mismatch");
  const canceledExamples = {};
  for (const number of ["117972", "118061"]) {
    const excluded = plan.excluded.find((row) => row.numeroPedidoDigital === number && row.reason === "CANCELLED");
    const detail = source.get(number);
    const pilot = live.prepare("SELECT 1 FROM digital_envios WHERE numero_pedido_digital=?").get(number);
    if (!excluded || !detail || pilot) throw new Error(`cancelled_order_handling_mismatch:${number}`);
    canceledExamples[number] = { totalDigital: detail.itensInformados, state: "cancelled_excluded_from_pilot" };
  }
  if (sha(snapshot(live)) !== sha(snapshot(backup))) throw new Error("unrelated_database_rows_changed");
  const values = Object.fromEntries(["118596", "118569", "118374", "118489", "118382", "118223", "118212", "118211", "118186", "118109", "118071", "118062", "117974", "117906"].map((number) => {
    const row = live.prepare("SELECT itens_digital FROM digital_envios WHERE numero_pedido_digital=?").get(number);
    if (!row) throw new Error(`example_missing:${number}`);
    return [number, row.itens_digital];
  }));
  const migration = live.prepare("SELECT version,name FROM schema_migrations WHERE version=1").get();
  if (migration?.name !== "digital_quantities_v1") throw new Error("migration_record_missing");
  console.log(JSON.stringify({ backupPath, backupIntegrity: backupIntegrity[0], migration, rowCounts, match, under, over, examples: values, canceledExamples, integrityCheck: integrity[0], foreignKeyViolations: foreignKeys.length, unrelatedTablesMatchBackup: true }, null, 2));
} finally { live.close(); backup.close(); }
