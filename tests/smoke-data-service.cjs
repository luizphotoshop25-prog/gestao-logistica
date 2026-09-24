const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const database = require("../electron/database.cjs");

async function main() {
  const source = fs.readFileSync(path.join(__dirname, "../src/services/dataService.ts"), "utf8");
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const bridge = {};
  const context = { exports: {}, window: { gestaoAPI: bridge } };
  vm.runInNewContext(compiled, context);
  const { dataService, ipcDataService } = context.exports;
  assert.equal(dataService, ipcDataService);
  const delegatedMethods = Object.keys(dataService).filter((method) => !["login", "logout", "currentUser", "restoreSession"].includes(method));
  assert.equal(delegatedMethods.length, 25);
  for (const method of delegatedMethods) {
    const args = method.startsWith("on") ? [() => {}] : [{ id: "synthetic" }, "synthetic"];
    const expected = method.startsWith("on") ? () => {} : Promise.resolve({ ok: true });
    bridge[method] = function (...received) {
      assert.equal(this, bridge);
      assert.equal(received.length, dataService[method].length);
      received.forEach((argument, index) => assert.equal(argument, args[index]));
      return expected;
    };
    assert.equal(dataService[method](...args), expected);
    const error = new Error("synthetic failure");
    bridge[method] = () => { throw error; };
    assert.throws(() => dataService[method](...args), (caught) => caught === error);
    if (!method.startsWith("on")) {
      bridge[method] = () => Promise.reject(error);
      await assert.rejects(dataService[method](...args), (caught) => caught === error);
    }
  }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-service-test-"));
  try {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(!fs.lstatSync(root).isSymbolicLink());
    database.initialize({ getPath: () => root });
    assert.equal(database.importSafeRows({ rows: [{ eligible: true, linha: 1,
      sessao: "M99997", clienteNome: "Cliente Teste Adapter", clienteEmail: "adapter@example.invalid",
      clienteTelefone: "00000000000", clienteCidade: "TESTE", fotosQuantidade: 1,
      selecaoFinalizadaEm: null, tratamentoConcluido: false }] }).ok, true);
    bridge.listOrders = async (options) => ({ ok: true, rows: database.listOrders(options) });
    bridge.getOrder = async (id) => database.getOrder(id);
    bridge.updateOrder = async (input) => database.updateOrder(input);
    bridge.dashboard = async () => ({ ok: true, dashboard: database.getDashboard() });
    const listed = await dataService.listOrders({ search: "M99997", filter: "all" });
    assert.equal(listed.rows.length, 1);
    const id = listed.rows[0].id;
    assert.equal((await dataService.getOrder(id)).ok, true);
    const payload = { id, revisao: (await dataService.getOrder(id)).order.revisao, values: { observacoes: "Alteracao sintetica via dataService" } };
    assert.equal((await dataService.updateOrder(payload)).ok, true);
    assert.equal((await dataService.getOrder(id)).order.observacoes, payload.values.observacoes);
    assert.equal((await dataService.updateOrder(payload)).error, "REVISION_CONFLICT");
    payload.revisao = (await dataService.getOrder(id)).order.revisao;
    assert.equal((await dataService.updateOrder(payload)).unchanged, true);
    assert.equal((await dataService.dashboard()).dashboard.total, 1);
    console.log("25 métodos: delegação, identidade dos retornos/callbacks, erros e CRUD sintético aprovados.");
  } finally {
    database.close();
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("gestao-service-test-"));
    assert(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
