const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-revision-test-"));
const app = { getPath: () => root };
const databasePath = path.join(root, "GestaoLogistica", "gestao-logistica.sqlite3");
const backupDirectory = path.join(root, "GestaoLogistica", "backups");
const migrationBackups = () => fs.readdirSync(backupDirectory).filter((name) => name.startsWith("antes-revisao-pedidos-") && name.endsWith(".sqlite3"));

try {
  database.initialize(app);
  assert.equal(database.importSafeRows({ rows: [{ eligible: true, linha: 1,
    sessao: "M12345", clienteNome: "Cliente Revisão Sintético", clienteEmail: "revisao@example.invalid",
    clienteTelefone: "00000000000", clienteCidade: "TESTE", fotosQuantidade: 1,
    selecaoFinalizadaEm: null, tratamentoConcluido: false }] }).imported, 1);
  const orderId = database.listOrders({ search: "M12345", filter: "all" })[0].id;
  database.close();

  const legacy = new DatabaseSync(databasePath);
  try { legacy.exec("ALTER TABLE pedidos DROP COLUMN revisao"); }
  finally { legacy.close(); }
  database.initialize(app);
  assert.equal(database.getOrder(orderId).order.revisao, 1);
  assert.equal(database.getOrder(orderId).order.sessao, "M12345");
  assert.equal(migrationBackups().length, 1);
  const backup = new DatabaseSync(path.join(backupDirectory, migrationBackups()[0]), { readOnly: true });
  try {
    assert.equal(backup.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    assert.equal(backup.prepare("PRAGMA table_info(pedidos)").all().some((column) => column.name === "revisao"), false);
    assert.equal(backup.prepare("SELECT sessao FROM pedidos WHERE id=?").get(orderId).sessao, "M12345");
  } finally { backup.close(); }
  database.close();
  database.initialize(app);
  assert.equal(migrationBackups().length, 1);

  for (let revision = 1; revision < 7; revision += 1) {
    const saved = database.updateOrder({ id: orderId, revisao: revision, values: { observacoes: "Preparação sintética " + revision } });
    assert.equal(saved.order.revisao, revision + 1);
  }
  const clientA = database.getOrder(orderId);
  const clientB = database.getOrder(orderId);
  assert.equal(clientA.order.revisao, 7);
  assert.equal(clientB.order.revisao, 7);
  const savedA = database.updateOrder({ id: orderId, revisao: clientA.order.revisao, values: { observacoes: "Alteração de A" } });
  assert.equal(savedA.order.revisao, 8);
  assert.equal(savedA.events.length, clientA.events.length + 1);
  const savedB = database.updateOrder({ id: orderId, revisao: clientB.order.revisao, values: { observacoes: "Alteração de B" } });
  assert.equal(savedB.error, "REVISION_CONFLICT");
  assert.equal(savedB.revisaoAtual, 8);
  assert.deepEqual(database.getOrder(orderId), savedA);

  for (const revision of [undefined, null, "8", -1, 0, 1.5]) {
    assert.equal(database.updateOrder({ id: orderId, revisao: revision, values: { observacoes: "Inválido" } }).error, "REVISION_REQUIRED");
  }
  assert.deepEqual(database.getOrder(orderId), savedA);
  assert.equal(database.updateOrder({ id: orderId, revisao: 7, values: { observacoes: "Alteração de A" } }).error, "REVISION_CONFLICT");
  assert.equal(database.updateOrder({ id: orderId, revisao: 8, values: { observacoes: "Alteração de A" } }).unchanged, true);
  assert.deepEqual(database.getOrder(orderId), savedA);
  assert.equal(database.updateOrder({ id: orderId, revisao: 8, values: { fotos_quantidade: -1 } }).ok, false);
  assert.deepEqual(database.getOrder(orderId), savedA);

  assert.equal(database.updateMilestone({ id: orderId, field: "galeria_publicada_em", value: "2026-09-23" }).ok, true);
  assert.equal(database.getOrder(orderId).order.revisao, 9);
  assert.equal(database.updateOrder({ id: orderId, revisao: 8, values: { observacoes: "Ficha antes do marco" } }).error, "REVISION_CONFLICT");
  assert.equal(database.bulkUpdateOrders({ ids: [orderId], action: "archive" }).ok, true);
  assert.equal(database.getOrder(orderId).order.revisao, 10);
  const current = database.getOrder(orderId);
  database.close();
  database.initialize(app);
  assert.deepEqual(database.getOrder(orderId), current);
  assert.equal(migrationBackups().length, 1);
  console.log("Revisão: A/B 7→8, conflito sem escrita/histórico, revisão obrigatória, marcos, lote, persistência e migração com backup aprovados.");
} finally {
  database.close();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith("gestao-revision-test-"));
  assert(!fs.lstatSync(root).isSymbolicLink());
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
