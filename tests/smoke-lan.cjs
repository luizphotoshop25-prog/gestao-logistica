const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const database = require("../electron/database.cjs");
const { startApiServer, createPasswordHash } = require("../server/api-server.cjs");
const { TEST_PASSWORD } = require("./http-test-auth.cjs");

async function availablePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-lan-"));
  const dataDirectory = path.join(root, "server-data");
  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  let api;
  try {
    api = await startApiServer({ dataDirectory, host: "127.0.0.1", port, allowedOrigin: ["null", "file://"], lanPilot: true });
    const userA = database.createUser({ nome: "Usuário LAN A", usuario: "lan-a", senhaHash: createPasswordHash(TEST_PASSWORD) }).user;
    const userB = database.createUser({ nome: "Usuário LAN B", usuario: "lan-b", senhaHash: createPasswordHash(TEST_PASSWORD + "B") }).user;
    database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M12348", clienteNome: "Cliente LAN", clienteEmail: "lan@example.invalid", clienteTelefone: "00000000000", clienteCidade: "TESTE", fotosQuantidade: 2, selecaoFinalizadaEm: null, tratamentoConcluido: false }] });
    const source = fs.readFileSync(path.join(__dirname, "../src/services/dataService.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const context = { exports: {}, fetch, URL, URLSearchParams, TypeError, AbortSignal, window: { gestaoAPI: {}, gestaoConfig: { dataTransport: "http", apiUrl: origin } } };
    vm.runInNewContext(compiled, context);
    const serviceA = context.exports.createHttpDataService(origin);
    const serviceB = context.exports.createHttpDataService(origin);
    assert.equal((await fetch(origin + "/health").then((response) => response.json())).database, "available");
    assert.equal((await fetch(origin + "/health", { headers: { Origin: "null" } })).headers.get("access-control-allow-origin"), "null");
    assert.equal((await serviceA.login({ usuario: "lan-a", senha: TEST_PASSWORD })).user.id, userA.id);
    assert.equal((await serviceB.login({ usuario: "lan-b", senha: TEST_PASSWORD + "B" })).user.id, userB.id);
    const rows = await serviceA.listOrders({ search: "M12348", filter: "all" });
    const orderId = rows.rows[0].id;
    const initial = await serviceA.getOrder(orderId);
    assert.equal((await serviceA.dashboard()).dashboard.total, 1);
    assert.equal((await serviceA.updateOrder({ id: orderId, revisao: initial.order.revisao, values: { observacoes: "LAN A" } })).ok, true);
    const conflict = await serviceB.updateOrder({ id: orderId, revisao: initial.order.revisao, values: { observacoes: "LAN B conflito" } });
    assert.equal(conflict.error, "REVISION_CONFLICT");
    const afterA = await serviceB.getOrder(orderId);
    assert.equal(afterA.order.observacoes, "LAN A");
    assert.equal(afterA.events[0].usuario_id, userA.id);
    assert.equal(afterA.events.length, 1);
    assert.equal((await serviceB.updateOrder({ id: orderId, revisao: afterA.order.revisao, values: { observacoes: "LAN B" } })).ok, true);
    assert.equal((await serviceA.getOrder(orderId)).events[0].usuario_id, userB.id);
    await api.close();
    api = null;
    await assert.rejects(() => serviceA.dashboard(), /Não foi possível conectar ao servidor/);
    api = await startApiServer({ dataDirectory, host: "0.0.0.0", port, allowedOrigin: ["null", "file://"], lanPilot: true });
    assert.equal((await serviceA.dashboard()).dashboard.total, 1);
    console.log("LAN simulado: login, listagem, ficha, dashboard, update, conflito, autoria, offline e reconexão aprovados.");
  } finally {
    if (api) await api.close(); else database.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
