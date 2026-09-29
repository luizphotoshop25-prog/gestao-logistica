const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");
const { startApiServer } = require("../server/api-server.cjs");
const { createTestUser, login, authHeaders } = require("./http-test-auth.cjs");

const row = (session, photos) => ({ eligible: true, linha: Number(session.slice(1)), sessao: session, clienteNome: "Cliente Sintético", clienteEmail: "fixture@example.invalid", clienteTelefone: "0000000000", clienteCidade: "Teste", fotosQuantidade: photos, observacoes: "", selecaoFinalizadaEm: null, tratamentoConcluido: false, postadoEm: null, codigoRastreio: "", entregue: false, editor: "", warnings: [] });
const json = async (response) => ({ status: response.status, body: await response.json() });

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-treatment-"));
  const userDataPath = path.join(root, "api");
  let api;
  try {
    const legacyDir = path.join(root, "legacy");
    database.initializeDataDirectory(legacyDir);
    database.close();
    const legacyDbPath = path.join(legacyDir, "gestao-logistica.sqlite3");
    const legacy = new DatabaseSync(legacyDbPath);
    legacy.exec("DROP INDEX IF EXISTS idx_pedidos_tratamento_responsavel; ALTER TABLE pedidos DROP COLUMN tratamento_responsavel_usuario_id; ALTER TABLE pedidos DROP COLUMN tratamento_atribuicao_modo");
    legacy.close();
    database.initializeDataDirectory(legacyDir);
    const migrated = new DatabaseSync(legacyDbPath, { readOnly: true });
    assert.deepEqual(new Set(migrated.prepare("PRAGMA table_info(pedidos)").all().map(column => column.name).filter(name => name.startsWith("tratamento_"))), new Set(["tratamento_concluido_em", "tratamento_responsavel_usuario_id", "tratamento_atribuicao_modo"]));
    migrated.close();
    database.close();
    assert.equal(fs.readdirSync(path.join(legacyDir, "backups")).some(name => name.startsWith("antes-atribuicao-tratamento-")), true, "legacy schema migration keeps a safety backup");
    api = await startApiServer({ userDataPath });
    const henrique = createTestUser(database, "henrique", "Henrique");
    const carlos = createTestUser(database, "carlos", "Carlos");
    database.setUserRole("henrique", "coordinator");
    database.importSafeRows({ rows: [row("M96000", 0), row("M96001", 46), row("M96002", 47), row("M96003", 48), row("M96004", 49), row("M96005", null)] });
    api = await (async () => { await api.close(); return startApiServer({ userDataPath }); })();
    const backfill = ["M96000", "M96001", "M96002", "M96003", "M96004", "M96005"].map(session => database.listOrders({ search: session })[0]);
    assert.deepEqual(backfill.map(order => order.tratamento_responsavel_usuario_id), [henrique.id, henrique.id, henrique.id, carlos.id, carlos.id, null]);
    assert.deepEqual(database.assignmentBackfillCounts(), { henrique: 3, carlos: 2, semQuantidade: 1 });
    assert.equal(database.resolveTreatmentAssignee(null, { smallUserId: henrique.id, largeUserId: carlos.id }), null);
    assert.equal(database.resolveTreatmentAssignee(undefined, { smallUserId: henrique.id, largeUserId: carlos.id }), null);
    assert.equal(database.resolveTreatmentAssignee(-1, { smallUserId: henrique.id, largeUserId: carlos.id }), null);
    assert.equal(database.resolveTreatmentAssignee(46, { smallUserId: henrique.id, largeUserId: carlos.id }), henrique.id);
    assert.equal(database.resolveTreatmentAssignee(47, { smallUserId: henrique.id, largeUserId: carlos.id }), henrique.id);
    assert.equal(database.resolveTreatmentAssignee(48, { smallUserId: henrique.id, largeUserId: carlos.id }), carlos.id);
    assert.equal(database.resolveTreatmentAssignee(49, { smallUserId: henrique.id, largeUserId: carlos.id }), carlos.id);

    let order = database.listOrders({ search: "M96002" })[0];
    let changed = database.updateOrder({ id: order.id, revisao: order.revisao, values: { fotos_quantidade: 48 } });
    assert.equal(changed.order.tratamento_responsavel_usuario_id, carlos.id, "automatic 47->48");
    changed = database.updateOrder({ id: changed.order.id, revisao: changed.order.revisao, values: { fotos_quantidade: 47 } });
    assert.equal(changed.order.tratamento_responsavel_usuario_id, henrique.id, "automatic 48->47");
    changed = database.updateTreatmentAssignee({ id: order.id, revisao: changed.order.revisao, responsavelUsuarioId: carlos.id, actorRole: "coordinator", actorUserId: henrique.id });
    assert.equal(changed.order.tratamento_atribuicao_modo, "manual");
    changed = database.updateOrder({ id: order.id, revisao: changed.order.revisao, values: { fotos_quantidade: 2 } });
    assert.equal(changed.order.tratamento_responsavel_usuario_id, carlos.id, "SIWIN/local edits retain manual override");
    assert.equal(database.updateTreatmentAssignee({ id: order.id, revisao: changed.order.revisao, responsavelUsuarioId: henrique.id, actorRole: "employee", actorUserId: carlos.id }).error, "FORBIDDEN");
    changed = database.restoreAutomaticTreatmentAssignee({ id: order.id, revisao: changed.order.revisao, actorRole: "coordinator", actorUserId: henrique.id });
    assert.equal(changed.order.tratamento_atribuicao_modo, "auto");
    assert.equal(changed.order.tratamento_responsavel_usuario_id, henrique.id);
    assert.equal(database.updateTreatmentAssignee({ id: order.id, revisao: 1, responsavelUsuarioId: carlos.id, actorRole: "coordinator", actorUserId: henrique.id }).error, "REVISION_CONFLICT");

    const henriqueLogin = await login(api.origin, "henrique");
    const carlosLogin = await login(api.origin, "carlos");
    assert.equal((await json(await fetch(api.origin + "/api/orders?scope=mine", { headers: authHeaders(carlosLogin.session) }))).body.rows.every(item => item.tratamento_responsavel_usuario_id === carlos.id), true);
    const mineHenrique = await json(await fetch(api.origin + "/api/orders?scope=mine&userId=" + carlos.id, { headers: authHeaders(henriqueLogin.session) }));
    assert.equal(mineHenrique.body.rows.every(item => item.tratamento_responsavel_usuario_id === henrique.id), true, "mine scope must ignore a supplied userId");
    const unauthorized = await json(await fetch(api.origin + "/api/orders/" + order.id + "/treatment-assignee", { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders(carlosLogin.session) }, body: JSON.stringify({ revisao: database.getOrder(order.id).order.revisao, responsavelUsuarioId: carlos.id }) }));
    assert.equal(unauthorized.status, 403);
    order = database.listOrders({ search: "M96003", scope: "mine", userId: carlos.id })[0];
    const completed = database.updateOrder({ id: order.id, revisao: order.revisao, values: { selecao_finalizada_em: "2026-09-20", tratamento_concluido_em: "2026-09-21" } });
    assert.equal(completed.ok, true);
    assert.equal(database.listOrders({ scope: "mine", userId: carlos.id }).some(item => item.id === order.id), false);
    assert.equal(database.getOrder(order.id).order.tratamento_responsavel_usuario_id, carlos.id, "completion hides from queue but keeps assignment");

    const newOrder = database.importSafeRows({ rows: [row("M96006", 48)] });
    assert.equal(newOrder.imported, 1);
    assert.equal(database.listOrders({ search: "M96006" })[0].tratamento_responsavel_usuario_id, carlos.id, "new imported order assigned");
    database.syncSiwinClients([{ CAD: 96007, NOME: "Cliente SIWIN Sintético", ESTUDIO: 1 }]);
    database.syncSiwinOrders([{ CAD: 96007, SESSAO: "96007", PED: 96007, FOTOS_COBRADAS: 47 }]);
    let siwinOrder = database.listOrders({ search: "M96007" })[0];
    assert.equal(siwinOrder.tratamento_responsavel_usuario_id, henrique.id, "SIWIN import gets automatic assignment");
    database.syncSiwinOrders([{ CAD: 96007, SESSAO: "96007", PED: 96007, FOTOS_COBRADAS: 48 }]);
    siwinOrder = database.listOrders({ search: "M96007" })[0];
    assert.equal(siwinOrder.tratamento_responsavel_usuario_id, carlos.id, "SIWIN quantity recalculates automatic assignment");
    database.updateTreatmentAssignee({ id: siwinOrder.id, revisao: siwinOrder.revisao, responsavelUsuarioId: henrique.id, actorRole: "coordinator", actorUserId: henrique.id });
    database.syncSiwinOrders([{ CAD: 96007, SESSAO: "96007", PED: 96007, FOTOS_COBRADAS: 49 }]);
    assert.equal(database.getOrder(siwinOrder.id).order.tratamento_responsavel_usuario_id, henrique.id, "SIWIN preserves manual override");
    assert.equal(database.getOrder(siwinOrder.id).events.some(event => event.descricao.includes("alterado manualmente")), true);
    const revision = database.getOrder(order.id).order.revisao;
    const manual = await json(await fetch(api.origin + "/api/orders/" + order.id + "/treatment-assignee", { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders(henriqueLogin.session) }, body: JSON.stringify({ revisao: revision, responsavelUsuarioId: henrique.id }) }));
    assert.equal(manual.status, 200);
    assert.equal(manual.body.order.tratamento_atribuicao_modo, "manual");
    const restore = await json(await fetch(api.origin + "/api/orders/" + order.id + "/treatment-assignee/automatic", { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(henriqueLogin.session) }, body: JSON.stringify({ revisao: manual.body.order.revisao }) }));
    assert.equal(restore.status, 200);
    assert.equal(restore.body.order.tratamento_atribuicao_modo, "auto");
    console.log("Atribuição tratamento: migração/backup, fronteira 47/48, backfill auditado, importação/SIWIN, override manual, roles, revisão, escopo mine HTTP e persistência aprovados.");
  } finally {
    if (api) await api.close(); else database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
