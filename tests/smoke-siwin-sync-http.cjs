const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const database = require("../electron/database.cjs");
const { startApiServer, createPasswordHash } = require("../server/api-server.cjs");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-siwin-http-"));
  let api;
  try {
    let calls = 0;
    const port = await freePort();
    api = await startApiServer({ dataDirectory: path.join(root, "data"), host: "127.0.0.1", port, lanPilot: true,
      runSiwinSync: async () => { calls += 1; return { imported: 2, updated: 3, total: 5, importedOrders: 1, updatedOrders: 4, syncedItems: 6, scopedClients: 7, linked: 8, unmatched: 0 }; } });
    const password = "synthetic-siwin-http-test";
    const coordinator = database.createUser({ nome: "Coordenador teste", usuario: "coord-siwin-test", role: "coordinator", senhaHash: createPasswordHash(password) }).user;
    database.createUser({ nome: "Funcionário teste", usuario: "employee-siwin-test", role: "employee", senhaHash: createPasswordHash(password) });
    const source = fs.readFileSync(path.join(__dirname, "../src/services/dataService.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const context = { exports: {}, fetch, URL, URLSearchParams, AbortSignal, window: { gestaoAPI: {}, gestaoConfig: { dataTransport: "http", apiUrl: api.origin } } };
    vm.runInNewContext(compiled, context);
    const { createHttpDataService } = context.exports;
    const coordinatorService = createHttpDataService(api.origin);
    const employeeService = createHttpDataService(api.origin);
    assert.equal((await coordinatorService.login({ usuario: coordinator.usuario, senha: password })).ok, true);
    assert.equal((await employeeService.login({ usuario: "employee-siwin-test", senha: password })).ok, true);
    assert.equal((await coordinatorService.siwinStatus()).ok, true);
    assert.equal((await employeeService.siwinStatus()).error, "FORBIDDEN");
    assert.equal((await employeeService.syncSiwin()).error, "FORBIDDEN");
    const result = await coordinatorService.syncSiwin();
    assert.equal(result.ok, true);
    assert.equal(result.importedOrders, 1);
    assert.equal(result.lastSync, database.getSiwinStatus().lastSync || result.lastSync);
    assert.equal(calls, 1);
    assert.ok(fs.readdirSync(path.join(root, "data", "backups")).some((name) => name.startsWith("antes-sincronizacao-siwin-manual-")), "creates verified safety backup before sync");
    console.log("SIWIN HTTP: coordinator-only route, DataService, pre-sync backup and one controlled sync passed.");
  } finally {
    if (api) await api.close(); else database.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
