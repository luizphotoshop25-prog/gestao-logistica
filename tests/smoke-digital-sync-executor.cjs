const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");
const { executeOnTemporaryCopy } = require("../server/integrations/digital/digital-sync-executor.cjs");
const { DigitalSyncState } = require("../server/integrations/digital/digital-sync-state.cjs");

async function main() {
  const sourcePath = process.env.GESTAO_TEST_SOURCE_DB;
  if (!sourcePath || !path.isAbsolute(sourcePath)) throw new Error("GESTAO_TEST_SOURCE_DB_REQUIRED");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digital-sync-executor-"));
  const copiedPath = path.join(dir, "operational-copy.sqlite3");
  let source, db;
  try {
    source = new DatabaseSync(sourcePath, { readOnly: true });
    source.exec("PRAGMA query_only=ON");
    await backup(source, copiedPath);
    source.close(); source = null;
    db = new DatabaseSync(copiedPath);
    db.exec("PRAGMA foreign_keys=ON");
    const sessions = db.prepare("SELECT id,sessao,revisao FROM pedidos WHERE revisao>=1 ORDER BY sessao DESC LIMIT 2").all();
    assert.equal(sessions.length, 2);
    const initial = {
      shipments: db.prepare("SELECT COUNT(*) n FROM digital_envios").get().n,
      relations: db.prepare("SELECT COUNT(*) n FROM digital_envio_itens").get().n
    };
    const prefix = `SYNTHETIC-${randomUUID().slice(0, 8)}`;
    const relation = (row, quantity) => ({ pedidoId: row.id, sessao: row.sessao,
      expectedRevision: row.revisao, quantidadeEnviada: quantity });
    const plan = (suffix, relations, total = relations.reduce((sum, row) => sum + row.quantidadeEnviada, 0)) => ({
      numeroPedido: `${prefix}-${suffix}`, idFotoPedido: `${prefix}-${suffix}`,
      dataPedidoMiliegundos: Date.UTC(2026, 8, 29), itensDigital: total,
      quantityClassification: total > relations.reduce((sum, row) => sum + row.quantidadeEnviada, 0)
        ? "UNDER_TOTAL" : "MATCH", category: total > relations.reduce((sum, row) => sum + row.quantidadeEnviada, 0)
          ? "CANDIDATE_UNDER_TOTAL" : "CANDIDATE", relations, missingSessions: []
    });
    const a = plan("A", [relation(sessions[0], 2)]);
    const b = plan("B", [relation(sessions[0], 1), relation(sessions[1], 2)]);
    const d = plan("D", [relation(sessions[0], 1)]);
    assert.equal(executeOnTemporaryCopy(copiedPath, a).outcome, "IMPORTED");
    assert.equal(executeOnTemporaryCopy(copiedPath, b).outcome, "IMPORTED");
    assert.equal(executeOnTemporaryCopy(copiedPath, a).outcome, "ALREADY_IMPORTED");
    assert.equal(executeOnTemporaryCopy(copiedPath, d).outcome, "IMPORTED");
    assert.equal(executeOnTemporaryCopy(copiedPath, { ...plan("E", []), category: "SKIP_CANCELLED" }).outcome,
      "SKIPPED_CANCELLED");
    assert.equal(executeOnTemporaryCopy(copiedPath, { ...plan("F", []),
      category: "PENDING_MISSING_SESSION" }).outcome, "PENDING_MISSING_SESSION");
    assert.equal(executeOnTemporaryCopy(copiedPath, { ...a, numeroPedido: `${prefix}-G`,
      itensDigital: 1, quantityClassification: "OVER_TOTAL", category: "REVIEW_OVER_TOTAL" }).outcome,
      "REVIEW_OVER_TOTAL");
    assert.throws(() => executeOnTemporaryCopy(copiedPath, plan("H", [relation(sessions[1], 1)]),
      { failAt: "items" }), /SYNTHETIC_FAILURE/);
    const afterRollback = db.prepare("SELECT COUNT(*) n FROM digital_envios WHERE numero_pedido_digital=?")
      .get(`${prefix}-H`).n;
    assert.equal(afterRollback, 0);
    const state = new DigitalSyncState(dir);
    const i = plan("I", [relation(sessions[1], 1)]);
    state.importBaseline({ schema: 1, createdAt: "2026-09-30T13:00:00.000Z",
      orders: [{ idFotoPedido: i.idFotoPedido, numeroPedido: i.numeroPedido,
        dataPedidoMiliegundos: i.dataPedidoMiliegundos, status: "0",
        descricaoStatus: "Não conferido", itens: 1 }], pendingIds: [] });
    assert.equal(executeOnTemporaryCopy(copiedPath, i).outcome, "IMPORTED");
    const restartedState = new DigitalSyncState(dir);
    assert.equal(restartedState.loadSnapshot().orders.length, 1);
    assert.equal(executeOnTemporaryCopy(copiedPath, i).outcome, "ALREADY_IMPORTED");
    restartedState.recordOutcome(i.idFotoPedido, "ALREADY_IMPORTED");
    const stateDb = new DatabaseSync(state.file, { readOnly: true });
    try { assert.equal(stateDb.prepare("SELECT process_state FROM observations WHERE id_foto_pedido=?")
      .get(i.idFotoPedido).process_state, "IMPORTED"); }
    finally { stateDb.close(); }
    const j = plan("J", [relation(sessions[1], 1)]);
    db.prepare("UPDATE pedidos SET revisao=revisao+1 WHERE id=?").run(sessions[1].id);
    assert.equal(executeOnTemporaryCopy(copiedPath, j).outcome, "REVIEW_CONCURRENT_CHANGE");
    const final = {
      shipments: db.prepare("SELECT COUNT(*) n FROM digital_envios").get().n,
      relations: db.prepare("SELECT COUNT(*) n FROM digital_envio_itens").get().n,
      audit: db.prepare("SELECT COUNT(*) n FROM digital_envio_eventos WHERE acao='digital_sync_created' AND usuario_id IS NULL").get().n,
      duplicates: db.prepare("SELECT COUNT(*) n FROM (SELECT numero_pedido_digital FROM digital_envios GROUP BY numero_pedido_digital HAVING COUNT(*)>1)").get().n,
      integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
      foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all().length
    };
    assert.equal(final.shipments, initial.shipments + 4);
    assert.equal(final.relations, initial.relations + 5);
    assert.equal(final.audit, 4);
    assert.equal(final.duplicates, 0);
    assert.equal(final.integrity, "ok");
    assert.equal(final.foreignKeyViolations, 0);
    process.stdout.write(JSON.stringify({ ok: true, scenarios: "A-J", initial, final,
      temporaryCopy: true, originalWrites: 0 }) + "\n");
  } finally {
    db?.close(); source?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((error) => { process.stderr.write(`DIGITAL_SYNC_TEST_FAILED:${error.code || error.message}\n`);
  process.exitCode = 1; });
