const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { randomUUID } = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

const SOURCE = "DigitalSyncService";
const allowed = new Set(["CANDIDATE", "CANDIDATE_UNDER_TOTAL"]);
const localDate = (millis) => new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit"
}).format(new Date(millis));

function validatePlan(plan) {
  if (!allowed.has(plan?.category) || !String(plan.numeroPedido || "").trim()
    || !Number.isSafeInteger(plan.dataPedidoMiliegundos)
    || !Number.isSafeInteger(plan.itensDigital) || plan.itensDigital < 0
    || !Array.isArray(plan.relations) || !plan.relations.length || plan.relations.length > 500
    || !Array.isArray(plan.missingSessions) || plan.missingSessions.length
    || !["MATCH", "UNDER_TOTAL"].includes(plan.quantityClassification))
    return "REVIEW_INVALID_PLAN";
  const ids = new Set();
  let sum = 0;
  for (const relation of plan.relations) {
    if (!relation.pedidoId || !relation.sessao || ids.has(relation.pedidoId)
      || !Number.isSafeInteger(relation.expectedRevision) || relation.expectedRevision < 1
      || !Number.isSafeInteger(relation.quantidadeEnviada) || relation.quantidadeEnviada < 0)
      return "REVIEW_INVALID_PLAN";
    ids.add(relation.pedidoId);
    sum += relation.quantidadeEnviada;
    if (!Number.isSafeInteger(sum)) return "REVIEW_INVALID_PLAN";
  }
  if (sum > plan.itensDigital) return "REVIEW_OVER_TOTAL";
  if ((sum < plan.itensDigital ? "UNDER_TOTAL" : "MATCH") !== plan.quantityClassification)
    return "REVIEW_INVALID_PLAN";
  return null;
}

function existingOutcome(db, plan) {
  const shipment = db.prepare("SELECT id,itens_digital,revision FROM digital_envios WHERE numero_pedido_digital=? COLLATE NOCASE")
    .get(String(plan.numeroPedido));
  if (!shipment) return null;
  const autoEvent = db.prepare(`SELECT 1 FROM digital_envio_eventos
    WHERE digital_envio_id=? AND acao='digital_sync_created' AND usuario_id IS NULL`).get(shipment.id);
  if (!autoEvent) return { outcome: "EXISTING_MANUAL", shipmentId: shipment.id };
  const rows = db.prepare("SELECT pedido_id,quantidade_enviada FROM digital_envio_itens WHERE digital_envio_id=?")
    .all(shipment.id);
  const expected = new Map(plan.relations.map((row) => [row.pedidoId, row.quantidadeEnviada]));
  const identical = shipment.revision === 1 && shipment.itens_digital === plan.itensDigital
    && rows.length === expected.size && rows.every((row) => expected.get(row.pedido_id) === row.quantidade_enviada);
  return { outcome: identical ? "ALREADY_IMPORTED" : "REVIEW_IMPORTED_CHANGED", shipmentId: shipment.id };
}

function applyPlan(db, plan, { failAt = null } = {}) {
  if (plan?.category === "SKIP_CANCELLED") return { outcome: "SKIPPED_CANCELLED" };
  if (plan?.category === "PENDING_MISSING_SESSION" || plan?.category === "PENDING_NO_SESSION")
    return { outcome: plan.category };
  if (plan?.category?.startsWith("REVIEW_")) return { outcome: plan.category };
  const invalid = validatePlan(plan);
  if (invalid) return { outcome: invalid };
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; BEGIN IMMEDIATE");
  let committed = false;
  try {
    const duplicate = existingOutcome(db, plan);
    if (duplicate) return duplicate;
    const order = db.prepare("SELECT id,sessao,revisao FROM pedidos WHERE id=?");
    for (const relation of plan.relations) {
      const row = order.get(relation.pedidoId);
      if (!row || String(row.sessao).toUpperCase() !== String(relation.sessao).toUpperCase())
        return { outcome: "PENDING_MISSING_SESSION" };
      if (row.revisao !== relation.expectedRevision) return { outcome: "REVIEW_CONCURRENT_CHANGE" };
    }
    const shipmentId = randomUUID();
    const timestamp = new Date().toISOString();
    db.prepare(`INSERT INTO digital_envios(id,numero_pedido_digital,data_envio,criado_por_usuario_id,
      criado_em,atualizado_em,revision,itens_digital) VALUES(?,?,?,NULL,?,?,1,?)`)
      .run(shipmentId, String(plan.numeroPedido), localDate(plan.dataPedidoMiliegundos),
        timestamp, timestamp, plan.itensDigital);
    if (failAt === "shipment") throw new Error("SYNTHETIC_FAILURE");
    const add = db.prepare(`INSERT INTO digital_envio_itens
      (id,digital_envio_id,pedido_id,criado_em,quantidade_enviada) VALUES(?,?,?,?,?)`);
    for (const relation of plan.relations) add.run(randomUUID(), shipmentId,
      relation.pedidoId, timestamp, relation.quantidadeEnviada);
    if (failAt === "items") throw new Error("SYNTHETIC_FAILURE");
    const quantities = plan.relations.map((row) => `${row.sessao}=${row.quantidadeEnviada}`).join(", ");
    db.prepare(`INSERT INTO digital_envio_eventos
      (id,digital_envio_id,usuario_id,acao,descricao,criado_em) VALUES(?,?,NULL,?,?,?)`)
      .run(randomUUID(), shipmentId, "digital_sync_created",
        `${SOURCE} importou pedido Digital ${plan.numeroPedido}; sessões ${quantities}; total ${plan.itensDigital}; resultado IMPORTED.`,
        timestamp);
    if (failAt === "audit") throw new Error("SYNTHETIC_FAILURE");
    db.exec("COMMIT"); committed = true;
    return { outcome: "IMPORTED", shipmentId };
  } finally { if (!committed) db.exec("ROLLBACK"); }
}

function executeOnTemporaryCopy(dbPath, plan, options) {
  const target = fs.realpathSync(path.resolve(dbPath));
  const temporaryRoot = path.resolve(os.tmpdir()) + path.sep;
  if (!target.toLowerCase().startsWith(temporaryRoot.toLowerCase()) || !target.endsWith(".sqlite3"))
    throw new Error("DIGITAL_TEST_DATABASE_REQUIRED");
  const db = new DatabaseSync(target);
  try { return applyPlan(db, plan, options); }
  finally { db.close(); }
}

module.exports = { executeOnTemporaryCopy, validatePlan, SOURCE };
