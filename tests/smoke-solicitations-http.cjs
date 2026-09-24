const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const database = require("../electron/database.cjs");
const { startApiServer, createPasswordHash } = require("../server/api-server.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-solicitacoes-http-"));
  let api;
  try {
    api = await startApiServer({ userDataPath: path.join(root, "api") });
    const password = "synthetic-only-solicitation-test";
    const createUser = (username, role) => database.createUser({ nome: username, usuario: username, role, senhaHash: createPasswordHash(password) }).user;
    const coordinator = createUser("coord-teste", "coordinator");
    const employeeA = createUser("func-a", "employee");
    createUser("func-b", "employee");
    assert.equal(database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M99997", clienteNome: "Fixture Solicitações", clienteEmail: "solicitacoes@example.invalid", clienteTelefone: "00000000000", clienteCidade: "TESTE", fotosQuantidade: 1, selecaoFinalizadaEm: null, tratamentoConcluido: false }] }).ok, true);

    const source = fs.readFileSync(path.join(__dirname, "../src/services/dataService.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const context = { exports: {}, fetch, URL, URLSearchParams, AbortSignal, window: { gestaoAPI: {}, gestaoConfig: { dataTransport: "http", apiUrl: api.origin } } };
    vm.runInNewContext(compiled, context);
    const { createHttpDataService } = context.exports;
    const serviceFor = async (username) => {
      const service = createHttpDataService(api.origin);
      const login = await service.login({ usuario: username, senha: password });
      assert.equal(login.ok, true);
      return { service, user: login.user };
    };
    const { service: manager, user: managerUser } = await serviceFor(coordinator.usuario);
    const { service: workerA, user: workerUser } = await serviceFor(employeeA.usuario);
    const { service: workerB } = await serviceFor("func-b");
    assert.equal(managerUser.role, "coordinator");
    assert.equal(workerUser.role, "employee");
    const assignees = await manager.listSolicitationAssignees();
    assert.equal(assignees.rows.length, 3);
    assert.ok(assignees.rows.some((person) => person.usuario === "func-a" && person.role === "employee"), "HTTP coordinator can assign an active employee");
    assert.equal((await workerA.listSolicitationAssignees()).error, "FORBIDDEN");

    const created = await manager.createSolicitation({ descricao: "Conferir seleção", sessao_codigo: "M99997", responsavel_usuario_id: employeeA.id });
    assert.equal(created.ok, true, created.message);
    assert.equal((await manager.listSolicitations()).rows.length, 1);
    assert.equal((await workerA.listSolicitations()).rows.length, 1);
    assert.equal((await workerB.listSolicitations()).rows.length, 0);
    assert.equal((await workerB.getSolicitation(created.solicitation.id)).error, "NOT_FOUND");
    assert.equal((await workerA.createSolicitation({ descricao: "Não permitido", responsavel_usuario_id: employeeA.id })).error, "FORBIDDEN");
    assert.equal((await workerA.updateSolicitation({ id: created.solicitation.id, revision: 1, values: { descricao: "Alteração vedada" } })).error, "FORBIDDEN");
    assert.equal((await workerB.transitionSolicitation({ id: created.solicitation.id, revision: 1, action: "start" })).error, "NOT_FOUND");
    assert.equal((await workerA.transitionSolicitation({ id: created.solicitation.id, revision: 1, action: "cancel" })).error, "FORBIDDEN");

    const started = await workerA.transitionSolicitation({ id: created.solicitation.id, revision: 1, action: "start" });
    assert.equal(started.solicitation.status, "in_progress");
    const completed = await workerA.transitionSolicitation({ id: created.solicitation.id, revision: started.solicitation.revision, action: "complete" });
    assert.equal(completed.solicitation.status, "completed");
    const stale = await manager.updateSolicitation({ id: created.solicitation.id, revision: 1, values: { descricao: "Revisão velha" } });
    assert.equal(stale.error, "REVISION_CONFLICT");
    const reopened = await manager.transitionSolicitation({ id: created.solicitation.id, revision: completed.solicitation.revision, action: "reopen" });
    assert.equal(reopened.solicitation.status, "pending");
    const edited = await manager.updateSolicitation({ id: created.solicitation.id, revision: reopened.solicitation.revision, values: { descricao: "Descrição ajustada pela coordenação" } });
    assert.equal(edited.solicitation.descricao, "Descrição ajustada pela coordenação");
    const cancelled = await manager.transitionSolicitation({ id: created.solicitation.id, revision: edited.solicitation.revision, action: "cancel" });
    assert.equal(cancelled.solicitation.status, "cancelled");
    assert.equal((await fetch(`${api.origin}/api/solicitations`, { headers: { Authorization: "Bearer inválido" } })).status, 401);
    console.log("Solicitações HTTP: DataService remoto, login/roles, isolamento, ações, bloqueios e revisão 409 aprovados.");
  } finally {
    if (api) await api.close(); else database.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
