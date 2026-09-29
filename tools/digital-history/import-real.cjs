#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");
const planning = require("./import-plan.cjs");

const EXPECTED = { eligibleOrders: 172, newDigitalOrders: 172, newRelations: 780, conflicts: 0 };

function parseArgs(args) {
  const out = { db: "", plan: path.resolve("work/digital-history/import-plan.json"), listing: path.resolve("work/digital-history/listing.json"),
    details: path.resolve("work/digital-history/details.json"), backup: "", resultDir: path.resolve("work/digital-history") };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === "--db") out.db = path.resolve(args[++i] || "");
    else if (key === "--plan") out.plan = path.resolve(args[++i] || "");
    else if (key === "--listing") out.listing = path.resolve(args[++i] || "");
    else if (key === "--details") out.details = path.resolve(args[++i] || "");
    else if (key === "--backup") out.backup = path.resolve(args[++i] || "");
    else if (key === "--result-dir") out.resultDir = path.resolve(args[++i] || "");
    else throw new Error("import_cli_argument_invalid");
  }
  if (!out.db || !out.backup) throw new Error("import_cli_arguments_required");
  return out;
}

function sha256(file) { return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex"); }
function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function countRows(db) { return db.prepare("SELECT (SELECT count(*) FROM digital_envios) envios,(SELECT count(*) FROM digital_envio_itens) itens,(SELECT count(*) FROM digital_envio_eventos) eventos").get(); }
function integrity(db) { return db.prepare("PRAGMA integrity_check").all().map((row) => row.integrity_check); }
function foreignKeyViolations(db) { return db.prepare("PRAGMA foreign_key_check").all(); }

function validateApprovedPlan(plan) {
  if (!plan || plan.stage !== "import-plan" || plan.summary?.sourceOrders !== 200
    || plan.summary.eligibleOrders !== EXPECTED.eligibleOrders || plan.summary.newDigitalOrders !== EXPECTED.newDigitalOrders
    || plan.summary.newRelations !== EXPECTED.newRelations || plan.summary.conflicts !== EXPECTED.conflicts
    || plan.summary.excludedCancelled !== 19 || plan.summary.manualReviewOrders !== 1
    || plan.summary.excludedWithoutRelations !== 8 || plan.eligible?.length !== EXPECTED.eligibleOrders
    || plan.conflicts?.length !== 0 || plan.manualReview?.length !== 1)
    throw new Error("PREFLIGHT_CHANGED");
  if (plan.eligible.some((order) => order.classification !== "NEW_DIGITAL_ORDER"
    || order.relations.some((relation) => relation.classification !== "NEW_RELATION" || !relation.pedidoId)
    || !/^\d{4}-\d{2}-\d{2}$/.test(order.data))) throw new Error("PREFLIGHT_CHANGED");
  if (plan.eligible.reduce((sum, order) => sum + order.relations.length, 0) !== EXPECTED.newRelations)
    throw new Error("PREFLIGHT_CHANGED");
}

function freshPreflight({ dbPath, planPath, listingPath, detailsPath }) {
  const savedPlan = readJson(planPath);
  const listing = readJson(listingPath);
  const details = readJson(detailsPath);
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const fresh = planning.buildImportPlan(listing, details, planning.readImportPlanDatabase(db));
    const counts = countRows(db);
    const checks = { integrity: integrity(db), foreignKeys: foreignKeyViolations(db) };
    const stable = (value) => JSON.stringify({ summary: value.summary, eligible: value.eligible, excluded: value.excluded,
      manualReview: value.manualReview, missingSessions: value.missingSessions, conflicts: value.conflicts });
    const savedSummary = savedPlan.summary || {};
    const exact = stable(savedPlan) === stable(fresh)
      && fresh.summary.eligibleOrders === EXPECTED.eligibleOrders
      && fresh.summary.newDigitalOrders === EXPECTED.newDigitalOrders
      && fresh.summary.newRelations === EXPECTED.newRelations
      && fresh.summary.conflicts === EXPECTED.conflicts
      && fresh.summary.existingDigitalOrders === 0 && fresh.summary.existingRelations === 0
      && savedSummary.eligibleOrders === EXPECTED.eligibleOrders
      && savedSummary.newDigitalOrders === EXPECTED.newDigitalOrders
      && savedSummary.newRelations === EXPECTED.newRelations
      && savedSummary.conflicts === EXPECTED.conflicts
      && counts.envios === 0 && counts.itens === 0
      && checks.integrity.length === 1 && checks.integrity[0] === "ok" && checks.foreignKeys.length === 0;
    validateApprovedPlan(savedPlan);
    if (!exact) throw Object.assign(new Error("PREFLIGHT_CHANGED"), { preflight: { fresh: fresh.summary, counts, ...checks } });
    return { savedPlan, fresh, counts, ...checks, planHash: sha256(planPath) };
  } finally { db.close(); }
}

async function createVerifiedBackup(dbPath, backupPath) {
  if (fs.existsSync(backupPath)) throw new Error("backup_path_already_exists");
  fs.mkdirSync(path.dirname(backupPath), { recursive: true });
  const source = new DatabaseSync(dbPath, { readOnly: true });
  try { source.exec("PRAGMA query_only=ON"); await backup(source, backupPath); }
  catch (error) { try { fs.rmSync(backupPath, { force: true }); } catch {} throw error; }
  finally { source.close(); }
  const copy = new DatabaseSync(backupPath, { readOnly: true });
  try {
    copy.exec("PRAGMA query_only=ON");
    const result = integrity(copy);
    if (result.length !== 1 || result[0] !== "ok") throw new Error("backup_integrity_failed");
    return result[0];
  } finally { copy.close(); }
}

function importInTransaction(db, plan) {
  validateApprovedPlan(plan);
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000; BEGIN IMMEDIATE");
  let committed = false;
  try {
    const existingRows = db.prepare("SELECT id,numero_pedido_digital,data_envio FROM digital_envios").all();
    if (existingRows.length !== 0) throw new Error("PREFLIGHT_CHANGED");
    const sessionById = new Map(db.prepare("SELECT id,sessao FROM pedidos").all().map((row) => [row.id, String(row.sessao).trim().toUpperCase()]));
    const insertShipment = db.prepare(`INSERT INTO digital_envios
      (id,numero_pedido_digital,data_envio,criado_por_usuario_id,criado_em,atualizado_em,revision)
      VALUES (?,?,?,?,?,?,1)`);
    const insertItem = db.prepare("INSERT INTO digital_envio_itens(id,digital_envio_id,pedido_id,criado_em) VALUES(?,?,?,?)");
    const insertEvent = db.prepare("INSERT INTO digital_envio_eventos(id,digital_envio_id,usuario_id,acao,descricao,criado_em) VALUES(?,?,NULL,?,?,?)");
    const shipmentIds = new Map();
    let insertedItems = 0, insertedEvents = 0;
    const timestamp = new Date().toISOString();
    for (const order of plan.eligible) {
      if (db.prepare("SELECT 1 FROM digital_envios WHERE numero_pedido_digital=? COLLATE NOCASE").get(order.numeroPedidoDigital))
        throw new Error("PREFLIGHT_CHANGED");
      const shipmentId = crypto.randomUUID();
      insertShipment.run(shipmentId, order.numeroPedidoDigital, order.data, null, timestamp, timestamp);
      shipmentIds.set(order.numeroPedidoDigital, shipmentId);
      for (const relation of order.relations) {
        const session = sessionById.get(relation.pedidoId);
        if (session !== relation.sessao.toUpperCase()) throw new Error("PREFLIGHT_CHANGED");
        const exists = db.prepare(`SELECT 1 FROM digital_envio_itens i JOIN digital_envios e ON e.id=i.digital_envio_id
          WHERE e.numero_pedido_digital=? COLLATE NOCASE AND i.pedido_id=?`).get(order.numeroPedidoDigital, relation.pedidoId);
        if (exists) throw new Error("PREFLIGHT_CHANGED");
        insertItem.run(crypto.randomUUID(), shipmentId, relation.pedidoId, timestamp);
        insertedItems++;
      }
      insertEvent.run(crypto.randomUUID(), shipmentId, "created",
        `Importação histórica Digital Fotos: pedido ${order.numeroPedidoDigital} importado com ${order.relations.length} sessões.`, timestamp);
      insertedEvents++;
    }
    const finalCounts = countRows(db);
    if (finalCounts.envios !== EXPECTED.newDigitalOrders || finalCounts.itens !== EXPECTED.newRelations
      || insertedItems !== EXPECTED.newRelations || insertedEvents !== EXPECTED.newDigitalOrders)
      throw new Error("import_counts_mismatch");
    const violations = foreignKeyViolations(db);
    if (violations.length) throw new Error("import_foreign_key_check_failed");
    const integrityResult = integrity(db);
    if (integrityResult.length !== 1 || integrityResult[0] !== "ok") throw new Error("import_integrity_check_failed");
    db.exec("COMMIT");
    committed = true;
    return { shipmentIds, insertedItems, insertedEvents, finalCounts };
  } finally {
    if (!committed) { try { db.exec("ROLLBACK"); } catch {} }
  }
}

function postImportIdempotency(db, plan) {
  const shipments = db.prepare("SELECT id,data_envio FROM digital_envios WHERE numero_pedido_digital=? COLLATE NOCASE");
  const item = db.prepare("SELECT 1 FROM digital_envio_itens WHERE digital_envio_id=? AND pedido_id=?");
  let existingOrders = 0, existingRelations = 0, newOrders = 0, newRelations = 0;
  for (const order of plan.eligible) {
    const prior = shipments.get(order.numeroPedidoDigital);
    if (!prior || prior.data_envio !== order.data) { newOrders++; continue; }
    existingOrders++;
    for (const relation of order.relations) {
      if (item.get(prior.id, relation.pedidoId)) existingRelations++; else newRelations++;
    }
  }
  if (existingOrders !== EXPECTED.eligibleOrders || existingRelations !== EXPECTED.newRelations || newOrders || newRelations)
    throw new Error("post_import_idempotency_failed");
  return { newDigitalOrders: newOrders, newRelations, existingDigitalOrders: existingOrders,
    existingRelations, noOpDigitalOrders: existingOrders, noOpRelations: existingRelations };
}

function validateKnownOrders(db) {
  const expected = new Map([
    ["118596", ["M49828", "M50204"]], ["118569", ["M50196"]],
    ["118374", ["M49868", "M49992", "M50014", "M50135", "M50175", "M50201"]],
    ["112650", ["M49721", "M49738", "M49744"]]
  ]);
  const get = db.prepare("SELECT id FROM digital_envios WHERE numero_pedido_digital=? COLLATE NOCASE");
  const sessions = db.prepare(`SELECT p.sessao FROM digital_envio_itens i JOIN pedidos p ON p.id=i.pedido_id WHERE i.digital_envio_id=? ORDER BY p.sessao`);
  const results = {};
  for (const [number, names] of expected) {
    const shipment = get.get(number);
    if (!shipment) throw new Error("functional_validation_failed");
    const actual = sessions.all(shipment.id).map((row) => String(row.sessao).toUpperCase()).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...names].sort())) throw new Error("functional_validation_failed");
    results[number] = { existsOnce: true, sessions: actual };
  }
  if (get.get("112097")) throw new Error("manual_review_order_was_imported");
  results["112097"] = { exists: false };
  return results;
}

function resultReport({ plan, planHash, backupPath, backupIntegrity, durationMs, counts, postIntegrity, postForeignKeys, idempotency, functional }) {
  return { generatedAt: new Date().toISOString(), planSha256: planHash, backupPath, backupIntegrity,
    sourceOrdersAnalyzed: plan.summary.sourceOrders, shipmentsInserted: EXPECTED.newDigitalOrders,
    relationsInserted: EXPECTED.newRelations, auditEventsInserted: EXPECTED.newDigitalOrders,
    cancelledSkipped: plan.summary.excludedCancelled, manualReviewOrders: plan.summary.manualReviewOrders,
    noImportableRelation: plan.summary.excludedWithoutRelations, missingSessions: plan.summary.sessionsNotFound,
    conflicts: plan.summary.conflicts, durationMs, finalCounts: counts, integrityCheck: postIntegrity,
    foreignKeyViolations: postForeignKeys, idempotency, functionalValidation: functional,
    databaseWrites: { digital_envios: EXPECTED.newDigitalOrders, digital_envio_itens: EXPECTED.newRelations,
      digital_envio_eventos: EXPECTED.newDigitalOrders, pedidos: 0, clientes: 0, solicitacoes: 0 }, result: "success" };
}

function humanReport(result) {
  return ["IMPORTAÇÃO HISTÓRICA DIGITAL FOTOS — RESULTADO", `Gerado: ${result.generatedAt}`,
    `SHA-256 do plano: ${result.planSha256}`, `Backup: ${result.backupPath}`, `Integridade do backup: ${result.backupIntegrity}`,
    `Pedidos analisados: ${result.sourceOrdersAnalyzed}`, `Envios inseridos: ${result.shipmentsInserted}`,
    `Relações inseridas: ${result.relationsInserted}`, `Eventos de auditoria: ${result.auditEventsInserted}`,
    `Cancelados ignorados: ${result.cancelledSkipped}`, `Revisão manual: ${result.manualReviewOrders}`,
    `Sem relação importável: ${result.noImportableRelation}`, `Sessões ausentes: ${result.missingSessions}`,
    `Conflitos: ${result.conflicts}`, `Duração: ${result.durationMs} ms`,
    `Contagens finais: digital_envios=${result.finalCounts.envios}; digital_envio_itens=${result.finalCounts.itens}`,
    `integrity_check: ${result.integrityCheck.join(", ")}`, `foreign_key_check: ${result.foreignKeyViolations.length} violações`,
    `Idempotência: novos=${result.idempotency.newDigitalOrders}/${result.idempotency.newRelations}; no-op=${result.idempotency.noOpDigitalOrders}/${result.idempotency.noOpRelations}`,
    `Resultado: ${result.result.toUpperCase()}`, "ALTERAÇÕES EM PEDIDOS/CLIENTES/SOLICITAÇÕES: 0", ""].join("\n");
}

async function run(options) {
  const started = Date.now();
  fs.mkdirSync(options.resultDir, { recursive: true });
  const preflight = freshPreflight({ dbPath: options.db, planPath: options.plan, listingPath: options.listing, detailsPath: options.details });
  validateApprovedPlan(preflight.savedPlan);
  const backupIntegrity = await createVerifiedBackup(options.db, options.backup);
  const db = new DatabaseSync(options.db);
  let transactionResult;
  try { transactionResult = importInTransaction(db, preflight.savedPlan); }
  finally { db.close(); }

  const verify = new DatabaseSync(options.db, { readOnly: true });
  let counts, postIntegrity, postForeignKeys, idempotency, functional;
  try {
    verify.exec("PRAGMA query_only=ON");
    counts = countRows(verify);
    postIntegrity = integrity(verify);
    postForeignKeys = foreignKeyViolations(verify);
    idempotency = postImportIdempotency(verify, preflight.savedPlan);
    functional = validateKnownOrders(verify);
    if (counts.envios !== EXPECTED.newDigitalOrders || counts.itens !== EXPECTED.newRelations
      || postIntegrity.length !== 1 || postIntegrity[0] !== "ok" || postForeignKeys.length !== 0)
      throw new Error("post_import_validation_failed");
  } finally { verify.close(); }
  const planHashAfter = sha256(options.plan);
  if (planHashAfter !== preflight.planHash) throw new Error("import_plan_changed_during_execution");
  const result = resultReport({ plan: preflight.savedPlan, planHash: preflight.planHash, backupPath: options.backup,
    backupIntegrity, durationMs: Date.now() - started, counts, postIntegrity, postForeignKeys, idempotency, functional });
  fs.writeFileSync(path.join(options.resultDir, "import-result.json"), `${JSON.stringify(result, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(options.resultDir, "import-result.txt"), humanReport(result), "utf8");
  return { result, transactionResult };
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    run(options).then(({ result }) => process.stdout.write(`${humanReport(result)}\n`)).catch((error) => {
      process.stderr.write(`${error.message === "PREFLIGHT_CHANGED" ? "BLOQUEADO: PREFLIGHT_CHANGED" : `Importação interrompida: ${error.message}`}\n`);
      if (error.preflight) process.stderr.write(`${JSON.stringify(error.preflight)}\n`);
      process.exitCode = 1;
    });
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

module.exports = { EXPECTED, createVerifiedBackup, freshPreflight, humanReport, importInTransaction, parseArgs,
  postImportIdempotency, resultReport, run, validateApprovedPlan, validateKnownOrders };
