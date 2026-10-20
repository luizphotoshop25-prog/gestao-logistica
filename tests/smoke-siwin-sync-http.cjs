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
  const previousAppData = process.env.APPDATA;
  const appData = path.join(root, "appdata");
  let api;
  try {
    let calls = 0;
    const profile = path.join(appData, "Thunderbird", "Profiles", "smoke.default");
    const inboxDirectory = path.join(profile, "Mail", "mail.manoelguimaraes.com.br");
    fs.mkdirSync(inboxDirectory, { recursive: true });
    fs.writeFileSync(path.join(appData, "Thunderbird", "profiles.ini"), "[Profile0]\nName=default\nIsRelative=1\nPath=Profiles/smoke.default\nDefault=1\n", "utf8");
    fs.writeFileSync(path.join(profile, "prefs.js"), [
      'user_pref("mail.server.server1.hostname", "mail.manoelguimaraes.com.br");',
      'user_pref("mail.server.server1.directory-rel", "[ProfD]Mail/mail.manoelguimaraes.com.br");',
    ].join("\n"), "utf8");
    fs.writeFileSync(path.join(inboxDirectory, "INBOX"), [
      "From smoke@example.invalid Tue Oct 20 12:00:00 2026",
      "From: nao-responda@epics.com.br",
      "Subject: Finalizaram uma seleção de fotos: M30000",
      "Date: Tue, 20 Oct 2026 12:00:00 -0300",
      "Message-ID: <smoke-selection-30000@example.invalid>",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "Selecionados: 2 de 8",
      "Usando o Adobe Lightroom",
      "12345678, 23456789",
      "Usando o Windows",
      "",
    ].join("\r\n"), "latin1");
    process.env.APPDATA = appData;
    const port = await freePort();
    api = await startApiServer({ dataDirectory: path.join(root, "data"), host: "127.0.0.1", port, lanPilot: true,
      runSiwinSync: async () => { calls += 1; return { imported: 2, updated: 3, total: 5, importedOrders: 1, updatedOrders: 4, syncedItems: 6, scopedClients: 7, linked: 8, unmatched: 0 }; } });
    const fixture = database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M30000",
      clienteNome: "Cliente smoke Thunderbird", clienteEmail: "thunderbird-smoke@example.invalid",
      clienteTelefone: "00000000000", clienteCidade: "TESTE", fotosQuantidade: 8,
      selecaoFinalizadaEm: null, tratamentoConcluido: false }] });
    assert.equal(fixture.imported, 1);
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
    assert.equal(result.siwin.ok, true);
    assert.equal(result.thunderbird.ok, true);
    assert.equal(result.thunderbird.imported, 1);
    assert.equal(result.thunderbird.linked, 1);
    assert.equal(result.thunderbird.datesSet, 1);
    const order = database.listOrders({ search: "M30000", filter: "all" })[0];
    assert.equal(order.selecao_finalizada_em, "2026-10-20", "finalization from Thunderbird reaches the shared SQLite database");
    assert.equal(result.lastSync, database.getSiwinStatus().lastSync || result.lastSync);
    assert.equal(calls, 1);
    const repeated = await coordinatorService.syncSiwin();
    assert.equal(repeated.thunderbird.imported, 0, "Message-ID de-duplication makes repeated sync idempotent");
    assert.equal(repeated.thunderbird.datesSet, 0, "repeated sync preserves the first finalization date");
    assert.equal(calls, 2);
    assert.ok(fs.readdirSync(path.join(root, "data", "backups")).some((name) => name.startsWith("antes-sincronizacao-integrada-manual-")), "creates verified safety backup before sync");
    console.log("Combined SIWIN/Thunderbird HTTP sync: coordinator authorization, backup, finalization import and idempotency passed.");
  } finally {
    if (previousAppData === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previousAppData;
    if (api) await api.close(); else database.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
