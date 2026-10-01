const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");
const { startApiServer } = require("../server/api-server.cjs");
const { createTestUser, login, authHeaders } = require("./http-test-auth.cjs");

const row = (session, photos, selection = null, extra = {}) => ({
  eligible: true,
  linha: Number(session.slice(1)),
  sessao: session,
  clienteNome: "Cliente Sintético",
  clienteEmail: `fixture-${session}@example.invalid`,
  clienteTelefone: "0000000000",
  clienteCidade: "Teste",
  fotosQuantidade: photos,
  observacoes: "",
  selecaoFinalizadaEm: selection,
  tratamentoConcluido: false,
  postadoEm: null,
  codigoRastreio: "",
  entregue: false,
  editor: "",
  warnings: [],
  ...extra,
});
const json = async (response) => ({ status: response.status, body: await response.json() });
const bySession = (session) => database.listOrders({ search: session })[0];
const finalizeWithEdit = (order, date = "2026-09-20") => database.updateOrder({
  id: order.id,
  revisao: order.revisao,
  values: { selecao_finalizada_em: date },
});

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-treatment-"));
  const userDataPath = path.join(root, "api");
  const legacyDir = path.join(root, "legacy");
  let api;
  try {
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
    await api.close();
    api = await startApiServer({ userDataPath });

    const boundarySessions = ["M96000", "M96001", "M96002", "M96003", "M96004", "M96005"];
    const boundaryPhotos = [0, 1, 47, 48, 49, 100];
    assert.equal(database.importSafeRows({ rows: boundarySessions.map((session, index) => row(session, boundaryPhotos[index])) }).imported, boundarySessions.length);
    const beforeSelection = boundarySessions.map(bySession);
    assert.deepEqual(beforeSelection.map(order => order.tratamento_responsavel_usuario_id), Array(6).fill(null), "known quantities do not assign before selection");
    assert.equal(database.listOrders({ scope: "mine", userId: henrique.id }).some(order => boundarySessions.includes(order.sessao)), false);
    assert.equal(database.listOrders({ scope: "mine", userId: carlos.id }).some(order => boundarySessions.includes(order.sessao)), false);

    for (let index = 0; index < boundarySessions.length; index += 1) {
      const result = finalizeWithEdit(bySession(boundarySessions[index]));
      assert.equal(result.ok, true);
      const expected = index <= 2 ? henrique.id : carlos.id;
      assert.equal(result.order.tratamento_responsavel_usuario_id, expected, `selection activates ${boundaryPhotos[index]} photo assignment`);
      assert.equal(database.listOrders({ scope: "mine", userId: expected }).some(order => order.id === result.order.id), true);
    }
    const removableSelection = bySession("M96004");
    const clearedSelection = database.updateOrder({ id: removableSelection.id, revisao: removableSelection.revisao, values: { selecao_finalizada_em: null } });
    assert.equal(clearedSelection.ok, true);
    assert.equal(clearedSelection.order.tratamento_responsavel_usuario_id, null, "clearing selection clears automatic active assignee");
    assert.equal(clearedSelection.order.prazo_tratamento_em, null);
    assert.equal(database.listOrders({ scope: "mine", userId: carlos.id }).some(order => order.id === removableSelection.id), false);
    const assignedCounts = database.assignmentBackfillCounts();
    assert.equal(assignedCounts.henrique >= 3 && assignedCounts.carlos >= 2 && assignedCounts.semQuantidade === 0, true);
    assert.equal(database.resolveTreatmentAssignee(null, { smallUserId: henrique.id, largeUserId: carlos.id }), null);
    assert.equal(database.resolveTreatmentAssignee(undefined, { smallUserId: henrique.id, largeUserId: carlos.id }), null);
    assert.equal(database.resolveTreatmentAssignee(-1, { smallUserId: henrique.id, largeUserId: carlos.id }), null);
    assert.equal(database.resolveTreatmentAssignee(47, { smallUserId: henrique.id, largeUserId: carlos.id }), henrique.id);
    assert.equal(database.resolveTreatmentAssignee(48, { smallUserId: henrique.id, largeUserId: carlos.id }), carlos.id);

    let order = bySession("M96002");
    let changed = database.updateOrder({ id: order.id, revisao: order.revisao, values: { fotos_quantidade: 48 } });
    assert.equal(changed.order.tratamento_responsavel_usuario_id, carlos.id, "selected automatic 47->48");
    changed = database.updateOrder({ id: changed.order.id, revisao: changed.order.revisao, values: { fotos_quantidade: 47 } });
    assert.equal(changed.order.tratamento_responsavel_usuario_id, henrique.id, "selected automatic 48->47");

    database.importSafeRows({ rows: [row("M96010", 47), row("M96011", 20), row("M96012", 20), row("M96013", 70), row("M96014", 30), row("M96015", 30), row("M96018", 20), row("M96019", 20)] });
    order = bySession("M96010");
    changed = database.updateOrder({ id: order.id, revisao: order.revisao, values: { fotos_quantidade: 48 } });
    assert.equal(changed.order.tratamento_responsavel_usuario_id, null, "preselection quantity edits stay unassigned");
    changed = finalizeWithEdit(changed.order);
    assert.equal(changed.order.tratamento_responsavel_usuario_id, carlos.id, "selection uses the latest preselection quantity");

    order = bySession("M96011");
    changed = database.updateTreatmentAssignee({ id: order.id, revisao: order.revisao, responsavelUsuarioId: carlos.id, actorRole: "coordinator", actorUserId: henrique.id });
    assert.equal(changed.order.tratamento_atribuicao_modo, "manual");
    assert.equal(database.listOrders({ scope: "mine", userId: carlos.id }).some(item => item.id === order.id), false, "manual preselection metadata is hidden from mine");
    changed = finalizeWithEdit(changed.order);
    assert.equal(changed.order.tratamento_responsavel_usuario_id, carlos.id, "selection preserves manual assignee");
    assert.equal(changed.order.tratamento_atribuicao_modo, "manual");
    assert.equal(database.listOrders({ scope: "mine", userId: carlos.id }).some(item => item.id === order.id), true);

    order = bySession("M96012");
    changed = database.updateTreatmentAssignee({ id: order.id, revisao: order.revisao, responsavelUsuarioId: carlos.id, actorRole: "coordinator", actorUserId: henrique.id });
    changed = database.restoreAutomaticTreatmentAssignee({ id: order.id, revisao: changed.order.revisao, actorRole: "coordinator", actorUserId: henrique.id });
    assert.equal(changed.order.tratamento_atribuicao_modo, "auto");
    assert.equal(changed.order.tratamento_responsavel_usuario_id, null, "restore before selection returns to automatic and unassigned");
    changed = finalizeWithEdit(changed.order);
    assert.equal(changed.order.tratamento_responsavel_usuario_id, henrique.id);

    order = finalizeWithEdit(bySession("M96013")).order;
    changed = database.updateTreatmentAssignee({ id: order.id, revisao: order.revisao, responsavelUsuarioId: henrique.id, actorRole: "coordinator", actorUserId: henrique.id });
    changed = database.restoreAutomaticTreatmentAssignee({ id: order.id, revisao: changed.order.revisao, actorRole: "coordinator", actorUserId: henrique.id });
    assert.equal(changed.order.tratamento_responsavel_usuario_id, carlos.id, "restore after selection applies 48+ mapping");

    order = bySession("M96014");
    changed = database.updateOrder({ id: order.id, revisao: order.revisao, values: { galeria_publicada_em: "2026-09-10", link_enviado_em: "2026-09-11" } });
    assert.equal(changed.ok, true);
    assert.equal(changed.order.tratamento_responsavel_usuario_id, null);
    assert.equal(database.updateMilestone({ id: order.id, field: "selecao_finalizada_em", value: "2026-09-20" }).ok, true);
    changed = database.getOrder(order.id).order;
    assert.equal(changed.selecao_finalizada_em, "2026-09-20");
    assert.equal(changed.prazo_tratamento_em, "2026-10-10");
    assert.equal(changed.prazo_maximo_em, "2026-11-19");
    assert.equal(changed.tratamento_responsavel_usuario_id, henrique.id, "milestone assigns immediately");

    order = bySession("M96015");
    const emailResult = database.importThunderbirdSelections([{ messageId: "synthetic-message-1", sessao: "M96015", recebidoEm: "2026-09-20T12:00:00.000Z", dataFinalizacao: "2026-09-20", quantidadeSelecionada: 30, quantidadeTotal: 30, codigos: [] }]);
    assert.equal(emailResult.datesSet, 1);
    changed = database.getOrder(order.id).order;
    assert.equal(changed.prazo_tratamento_em, "2026-10-10");
    assert.equal(changed.prazo_maximo_em, "2026-11-19");
    assert.equal(changed.tratamento_responsavel_usuario_id, henrique.id, "Thunderbird selection assigns immediately");
    const assignmentEventsBeforeRepeat = database.getOrder(order.id).events.filter(event => event.tipo === "atribuicao_tratamento").length;
    const repeatResult = database.importThunderbirdSelections([{ messageId: "synthetic-message-2", sessao: "M96015", recebidoEm: "2026-09-21T12:00:00.000Z", dataFinalizacao: "2026-09-21", quantidadeSelecionada: 30, quantidadeTotal: 30, codigos: [] }]);
    assert.equal(repeatResult.datesSet, 0, "repeated selection email preserves original date");
    assert.equal(database.getOrder(order.id).order.selecao_finalizada_em, "2026-09-20");
    assert.equal(database.getOrder(order.id).events.filter(event => event.tipo === "atribuicao_tratamento").length, assignmentEventsBeforeRepeat, "repeated email adds no assignment event");

    database.syncSiwinClients([{ CAD: 96016, NOME: "Cliente SIWIN Sintético", ESTUDIO: 1 }]);
    database.syncSiwinOrders([{ CAD: 96016, SESSAO: "96016", PED: 96016, FOTOS_COBRADAS: 8 }]);
    let siwinOrder = bySession("M96016");
    assert.equal(siwinOrder.tratamento_responsavel_usuario_id, null, "SIWIN order waits for selection");
    for (const photos of [15, 30]) {
      database.syncSiwinOrders([{ CAD: 96016, SESSAO: "96016", PED: 96016, FOTOS_COBRADAS: photos }]);
      siwinOrder = bySession("M96016");
      assert.equal(siwinOrder.fotos_quantidade, photos);
      assert.equal(siwinOrder.tratamento_responsavel_usuario_id, null, "SIWIN quantity edits before selection remain unassigned");
    }
    changed = finalizeWithEdit(siwinOrder);
    assert.equal(changed.order.tratamento_responsavel_usuario_id, henrique.id, "SIWIN latest quantity is applied after selection");
    database.syncSiwinOrders([{ CAD: 96016, SESSAO: "96016", PED: 96016, FOTOS_COBRADAS: 48 }]);
    assert.equal(bySession("M96016").tratamento_responsavel_usuario_id, carlos.id, "SIWIN quantity change after selection recalculates");
    siwinOrder = bySession("M96016");
    database.updateTreatmentAssignee({ id: siwinOrder.id, revisao: siwinOrder.revisao, responsavelUsuarioId: henrique.id, actorRole: "coordinator", actorUserId: henrique.id });
    database.syncSiwinOrders([{ CAD: 96016, SESSAO: "96016", PED: 96016, FOTOS_COBRADAS: 49 }]);
    assert.equal(database.getOrder(siwinOrder.id).order.tratamento_responsavel_usuario_id, henrique.id, "SIWIN preserves manual override");

    const historical = database.importSafeRows({ rows: [row("M96017", 24, "2026-09-01", { tratamentoConcluido: true })] });
    assert.equal(historical.imported, 1);
    let historicalOrder = bySession("M96017");
    assert.equal(historicalOrder.tratamento_responsavel_usuario_id, henrique.id, "selected historical import is assigned");
    database.syncSiwinClients([{ CAD: 96017, NOME: "Cliente Histórico Sintético", ESTUDIO: 1 }]);
    database.syncSiwinOrders([{ CAD: 96017, SESSAO: "96017", PED: 96017, FOTOS_COBRADAS: 48 }]);
    assert.equal(bySession("M96017").tratamento_responsavel_usuario_id, henrique.id, "SIWIN quantity refresh preserves completed history");

    const protectedOrder = bySession("M96000");
    changed = database.updateOrder({ id: protectedOrder.id, revisao: protectedOrder.revisao, values: { tratamento_concluido_em: "2026-09-21" } });
    assert.equal(changed.ok, true);
    const rejectedRemoval = database.updateOrder({ id: changed.order.id, revisao: changed.order.revisao, values: { selecao_finalizada_em: null } });
    assert.equal(rejectedRemoval.ok, false, "selection cannot be removed after downstream treatment milestone");

    const preselection = bySession("M96018");
    const manualPreselection = database.updateTreatmentAssignee({ id: preselection.id, revisao: preselection.revisao, responsavelUsuarioId: carlos.id, actorRole: "coordinator", actorUserId: henrique.id });
    const premature = bySession("M96019");
    const legacyAssignment = new DatabaseSync(database.getStatus().databasePath);
    legacyAssignment.prepare("UPDATE pedidos SET tratamento_responsavel_usuario_id=? WHERE id=?").run(carlos.id, premature.id);
    legacyAssignment.close();
    const mineCarlosLogin = await login(api.origin, "carlos");
    const mineHenriqueLogin = await login(api.origin, "henrique");
    const carlosMine = await json(await fetch(api.origin + "/api/orders?scope=mine", { headers: authHeaders(mineCarlosLogin.session) }));
    assert.equal(carlosMine.status, 200);
    assert.equal(carlosMine.body.rows.every(item => item.tratamento_responsavel_usuario_id === carlos.id
      && item.selecao_finalizada_em && !item.tratamento_concluido_em && item.acompanhamento_status === "ativo"), true,
    "HTTP mine returns only assigned active orders with a finalized selection");
    assert.equal(carlosMine.body.rows.some(item => item.id === preselection.id), false);
    assert.equal(carlosMine.body.rows.some(item => item.id === premature.id), false, "HTTP rejects a legacy preselection assignee");
    const mineHenrique = await json(await fetch(api.origin + "/api/orders?scope=mine&userId=" + carlos.id, { headers: authHeaders(mineHenriqueLogin.session) }));
    assert.equal(mineHenrique.body.rows.every(item => item.tratamento_responsavel_usuario_id === henrique.id), true, "mine scope ignores a supplied userId");
    const unauthorized = await json(await fetch(api.origin + "/api/orders/" + preselection.id + "/treatment-assignee", { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders(mineCarlosLogin.session) }, body: JSON.stringify({ revisao: manualPreselection.order.revisao, responsavelUsuarioId: carlos.id }) }));
    assert.equal(unauthorized.status, 403);

    database.importSafeRows({ rows: [row("M96020", 70), row("M96021", 20)] });
    const incorrect = finalizeWithEdit(bySession("M96020"));
    assert.equal(incorrect.order.tratamento_responsavel_usuario_id, carlos.id);
    const manualLegacy = database.updateTreatmentAssignee({ id: bySession("M96021").id, revisao: bySession("M96021").revisao, responsavelUsuarioId: carlos.id, actorRole: "coordinator", actorUserId: henrique.id });
    const corruption = new DatabaseSync(database.getStatus().databasePath);
    corruption.exec("BEGIN IMMEDIATE");
    corruption.prepare("UPDATE pedidos SET tratamento_responsavel_usuario_id=? WHERE id=?").run(henrique.id, incorrect.order.id);
    corruption.exec("COMMIT");
    corruption.close();
    const beforeReconcile = database.treatmentEligibilityAudit();
    assert.equal(beforeReconcile.autoAssignedWithoutSelection, 1);
    assert.equal(beforeReconcile.eligibleAutomaticIncorrect, 1);
    assert.equal(beforeReconcile.manualAssignedBeforeSelection, 2);
    const reconciliation = database.reconcileTreatmentAssignmentEligibility();
    assert.equal(reconciliation.ok, true);
    assert.equal(reconciliation.alreadyApplied, false);
    assert.equal(fs.existsSync(reconciliation.backup), true);
    assert.equal(reconciliation.clearedPremature, 1);
    assert.equal(reconciliation.correctedEligible, 1);
    assert.equal(reconciliation.audit.autoAssignedWithoutSelection, 0);
    assert.equal(reconciliation.audit.eligibleAutomaticIncorrect, 0);
    assert.equal(reconciliation.audit.eligibleAutomaticUnassigned, 0);
    assert.equal(bySession("M96019").tratamento_responsavel_usuario_id, null);
    assert.equal(bySession("M96020").tratamento_responsavel_usuario_id, carlos.id);
    assert.equal(bySession("M96021").tratamento_responsavel_usuario_id, manualLegacy.order.tratamento_responsavel_usuario_id);
    assert.equal(database.getOrder(premature.id).events.some(event => event.descricao === "Atribuição automática removida porque a seleção do cliente ainda não foi finalizada."), true);
    assert.equal(database.reconcileTreatmentAssignmentEligibility().alreadyApplied, true, "reconciliation runs once");
    assert.equal(database.treatmentEligibilityAudit().foreignKeyViolations, 0);

    const restoredManual = await json(await fetch(api.origin + "/api/orders/" + preselection.id + "/treatment-assignee/automatic", { method: "POST", headers: { "Content-Type": "application/json", ...authHeaders(mineHenriqueLogin.session) }, body: JSON.stringify({ revisao: manualPreselection.order.revisao }) }));
    assert.equal(restoredManual.status, 200);
    assert.equal(restoredManual.body.order.tratamento_atribuicao_modo, "auto");
    assert.equal(restoredManual.body.order.tratamento_responsavel_usuario_id, null);
    console.log("Atribuição de tratamento: elegibilidade pré/pós-seleção, 0/1/47/48/49/100 fotos, SIWIN, Thunderbird, milestone, edição, manual, restore, reconciliação one-time, HTTP mine e integridade aprovados.");
  } finally {
    if (api) await api.close(); else database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
