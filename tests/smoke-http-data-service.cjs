const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const database = require("../electron/database.cjs");
const { startApiServer } = require("../server/api-server.cjs");
const { TEST_PASSWORD, createTestUser } = require("./http-test-auth.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-http-service-"));
  let api;
  try {
    api = await startApiServer({ userDataPath: path.join(root, "api-user-data") });
    createTestUser(database);
    const imported = database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M99997", clienteNome: "Cliente HTTP Teste", clienteEmail: "http-service@example.invalid", clienteTelefone: "00000000000", clienteCidade: "Curitiba - TESTE", fotosQuantidade: 3, observacoes: "Fixture do adaptador HTTP.", editor: "Editor HTTP", selecaoFinalizadaEm: null, tratamentoConcluido: false }] });
    assert.equal(imported.ok, true);
    const source = fs.readFileSync(path.join(__dirname, "../src/services/dataService.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const context = { exports: {}, fetch, URL, URLSearchParams, window: { gestaoAPI: {}, gestaoConfig: { dataTransport: "http", apiUrl: api.origin } } };
    vm.runInNewContext(compiled, context);
    const { dataService, httpDataService, ipcDataService } = context.exports;
    assert.equal(dataService, httpDataService);
    assert.notEqual(dataService, ipcDataService);
    assert.equal((await dataService.login({ usuario: "usuario-teste", senha: TEST_PASSWORD })).ok, true);
    const listed = await dataService.listOrders({ search: "M99997", filter: "all" });
    assert.equal(listed.rows.length, 1);
    const id = listed.rows[0].id;
    assert.equal((await dataService.getOrder(id)).order.cliente_nome, "Cliente HTTP Teste");
    assert.deepEqual(await dataService.getOrder("inexistente"), database.getOrder("inexistente"));
    assert.equal((await dataService.dashboard()).dashboard.total, 1);
    assert.equal((await dataService.updateOrder({ id, revisao: (await dataService.getOrder(id)).order.revisao, values: { observacoes: "Atualizado pelo httpDataService." } })).ok, true);
    assert.equal((await dataService.getOrder(id)).order.observacoes, "Atualizado pelo httpDataService.");
    assert.equal((await dataService.syncSiwin()).ok, false);
    console.log("httpDataService: seleção explícita, CRUD HTTP e bloqueio de integração local aprovados.");
  } finally {
    if (api) await api.close(); else database.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("gestao-http-service-"));
    assert(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
