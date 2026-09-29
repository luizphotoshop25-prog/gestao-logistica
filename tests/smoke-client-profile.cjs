const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const database = require("../electron/database.cjs");
const { startApiServer } = require("../server/api-server.cjs");
const { createTestUser, login, authHeaders } = require("./http-test-auth.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-client-profile-"));
  const resolvedRoot = path.resolve(root);
  assert(resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert(path.basename(root).startsWith("gestao-client-profile-"));
  let api;
  const logs = [];
  const originalLog = console.log;
  const originalInfo = console.info;
  try {
    api = await startApiServer({ userDataPath: path.join(root, "api") });
    createTestUser(database);
    const token = (await login(api.origin)).session;
    const fixture = {
      CAD: 778899, ESTUDIO: 1, NOME: "Cliente Perfil Sintético", E_MAIL: "perfil@example.invalid",
      FONE: "4133334444", CELULAR: "41999998888", LOGRADOURO: "Rua de Teste", NUMERO: "123",
      COMPLEMENTO: "Sala 2", BAIRRO: "Centro", CIDADE: "Curitiba", UF: "PR", CEP: "80000000",
    };
    assert.equal(database.syncSiwinClients([fixture]).imported, 1);
    assert.equal(database.syncSiwinOrders([{ CAD: fixture.CAD, SESSAO: "778899", FOTOS_COBRADAS: 12 }]).importedOrders, 1);
    const order = database.listOrders({ filter: "all" })[0];
    assert.equal(order.cliente_id != null, true);

    const expected = {
      ok: true, linked: true, profile: {
        nomeCompleto: "Cliente Perfil Sintético", cpf: null, email: "perfil@example.invalid",
        telefone: "4133334444", celular: "41999998888", logradouro: "Rua de Teste", numero: "123",
        complemento: "Sala 2", bairro: "Centro", cidade: "Curitiba", uf: "PR", cep: "80000000",
      },
    };
    assert.deepEqual(database.getOrderClientProfile(order.id), expected);

    const source = fs.readFileSync(path.join(__dirname, "../src/services/dataService.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    let requestedUrl = "";
    const fixtureFetch = async (url, init) => {
      requestedUrl = String(url);
      assert.equal(init.headers.Authorization, "Bearer " + token);
      return fetch(url, init);
    };
    const context = { exports: {}, fetch: fixtureFetch, URL, URLSearchParams, AbortSignal, window: { gestaoAPI: {}, gestaoConfig: { dataTransport: "http", apiUrl: api.origin } }, Event };
    vm.runInNewContext(compiled, context);
    const service = context.exports.createHttpDataService(api.origin);
    service.restoreSession(token);
    const httpProfile = await service.getOrderClientProfile(order.id);
    assert.deepEqual(JSON.parse(JSON.stringify(httpProfile)), expected);
    assert.equal(new URL(requestedUrl).pathname, `/api/orders/${encodeURIComponent(order.id)}/client-profile`);
    assert.equal(requestedUrl.includes(fixture.E_MAIL), false, "PII must not be placed in the endpoint URL");

    const unauthenticated = await fetch(`${api.origin}/api/orders/${encodeURIComponent(order.id)}/client-profile`);
    assert.equal(unauthenticated.status, 401, "profile endpoint must require a session");
    const unknown = await fetch(`${api.origin}/api/orders/inexistente/client-profile`, { headers: authHeaders(token) });
    assert.equal(unknown.status, 404);
    assert.equal((await unknown.json()).error, "NOT_FOUND");

    const preloadPath = path.join(__dirname, "../electron/preload.cjs");
    const preloadSource = fs.readFileSync(preloadPath, "utf8");
    const invokes = [];
    const exposed = {};
    const preloadContext = {
      require: () => ({ contextBridge: { exposeInMainWorld: (name, apiValue) => { exposed[name] = apiValue; } }, ipcRenderer: { invoke: (channel, ...args) => { invokes.push([channel, ...args]); return Promise.resolve(expected); }, on() {}, removeListener() {} } }),
      process: { env: {} },
    };
    vm.runInNewContext(preloadSource, preloadContext);
    assert.deepEqual(await exposed.gestaoAPI.getOrderClientProfile(order.id), expected);
    assert.deepEqual(invokes[0], ["orders:client-profile", order.id], "IPC must send only the order identifier");

    console.log = (...args) => logs.push(args.join(" "));
    console.info = (...args) => logs.push(args.join(" "));
    await fetch(`${api.origin}/api/orders/${encodeURIComponent(order.id)}/client-profile`, { headers: authHeaders(token) });
    console.log = originalLog;
    console.info = originalInfo;
    const logged = logs.join("\n");
    for (const value of [fixture.NOME, fixture.E_MAIL, fixture.FONE, fixture.CELULAR, fixture.LOGRADOURO, fixture.NUMERO, fixture.CEP]) assert.equal(logged.includes(value), false, `PII appeared in logs: ${value}`);
    assert.equal(Object.keys(expected.profile).includes("cpf"), true);
    assert.equal(expected.profile.cpf, null, "CPF is unavailable in the SQLite/SIWIN synchronization contract");
    console.log("Ficha rápida do cliente: SQLite, IPC preload, DataService HTTP, autenticação, URL sem PII e logs aprovados.");
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
    if (api) await api.close(); else database.close();
    assert(resolvedRoot.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert(path.basename(root).startsWith("gestao-client-profile-"));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
