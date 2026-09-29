const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { EXPECTED, importInTransaction, postImportIdempotency } = require("./import-real.cjs");

function planFixture(db, invalid = false) {
  const eligible = [];
  let relationNumber = 0;
  const addOrder = db.prepare("INSERT INTO pedidos(id,sessao) VALUES(?,?)");
  for (let i = 0; i < EXPECTED.eligibleOrders; i++) {
    const relationCount = i < 92 ? 5 : 4;
    const relations = [];
    for (let j = 0; j < relationCount; j++) {
      relationNumber++;
      const sessao = `M${String(relationNumber).padStart(5, "0")}`;
      const pedidoId = `pedido-${relationNumber}`;
      addOrder.run(pedidoId, sessao);
      relations.push({ pedidoId: invalid && relationNumber === EXPECTED.newRelations ? "missing" : pedidoId,
        sessao, classification: "NEW_RELATION" });
    }
    eligible.push({ numeroPedidoDigital: String(500000 + i), data: "2026-01-01", classification: "NEW_DIGITAL_ORDER", relations });
  }
  return { stage: "import-plan", summary: { sourceOrders: 200, eligibleOrders: EXPECTED.eligibleOrders,
    newDigitalOrders: EXPECTED.newDigitalOrders, newRelations: EXPECTED.newRelations, conflicts: 0,
    excludedCancelled: 19, manualReviewOrders: 1, excludedWithoutRelations: 8 }, eligible,
  conflicts: [], manualReview: [{}] };
}

function database() {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE pedidos(id TEXT PRIMARY KEY,sessao TEXT NOT NULL);
    CREATE TABLE digital_envios(id TEXT PRIMARY KEY,numero_pedido_digital TEXT NOT NULL UNIQUE,data_envio TEXT NOT NULL,
      criado_por_usuario_id TEXT,criado_em TEXT NOT NULL,atualizado_em TEXT NOT NULL,revision INTEGER NOT NULL);
    CREATE TABLE digital_envio_itens(id TEXT PRIMARY KEY,digital_envio_id TEXT NOT NULL REFERENCES digital_envios(id),
      pedido_id TEXT NOT NULL REFERENCES pedidos(id),criado_em TEXT NOT NULL,UNIQUE(digital_envio_id,pedido_id));
    CREATE TABLE digital_envio_eventos(id TEXT PRIMARY KEY,digital_envio_id TEXT NOT NULL REFERENCES digital_envios(id),
      usuario_id TEXT,acao TEXT NOT NULL,descricao TEXT NOT NULL,criado_em TEXT NOT NULL);`);
  return db;
}

function run() {
  const db = database();
  const plan = planFixture(db);
  const imported = importInTransaction(db, plan);
  assert.deepEqual({ ...imported.finalCounts }, { envios: 172, itens: 780, eventos: 172 });
  assert.deepEqual(postImportIdempotency(db, plan), { newDigitalOrders: 0, newRelations: 0,
    existingDigitalOrders: 172, existingRelations: 780, noOpDigitalOrders: 172, noOpRelations: 780 });
  db.close();

  const rollbackDb = database();
  const rollbackPlan = planFixture(rollbackDb, true);
  assert.throws(() => importInTransaction(rollbackDb, rollbackPlan), /PREFLIGHT_CHANGED/);
  assert.equal(rollbackDb.prepare("SELECT count(*) n FROM digital_envios").get().n, 0);
  assert.equal(rollbackDb.prepare("SELECT count(*) n FROM digital_envio_itens").get().n, 0);
  assert.equal(rollbackDb.prepare("SELECT count(*) n FROM digital_envio_eventos").get().n, 0);
  rollbackDb.close();
  process.stdout.write("digital history real import transaction tests passed\n");
}

run();
