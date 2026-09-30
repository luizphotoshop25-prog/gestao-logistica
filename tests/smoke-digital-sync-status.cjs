const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const database = require("../electron/database.cjs");
const { startApiServer, createPasswordHash } = require("../server/api-server.cjs");
const { DigitalSyncState } = require("../server/integrations/digital/digital-sync-state.cjs");

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "digital-status-"));
  const port = await freePort();
  let api;
  let step = "startup";
  try {
    const config = { enabled: false, writeEnabled: false, intervalMinutes: 30, timeoutMs: 120000 };
    api = await startApiServer({ dataDirectory: root, host: "127.0.0.1", port,
      lanPilot: true, digitalSyncConfig: config });
    step = "first request";
    const password = "Synthetic-Status-2026!";
    database.createUser({ nome: "Coordenador Sintético", usuario: "coord-synthetic",
      role: "coordinator", senhaHash: createPasswordHash(password) });
    database.createUser({ nome: "Funcionário Sintético", usuario: "employee-synthetic",
      role: "employee", senhaHash: createPasswordHash(password) });
    const store = new DigitalSyncState(root);
    store.importBaseline({ schema: 1, createdAt: "2026-09-30T13:53:11.628Z",
      orders: [{ idFotoPedido: "synthetic-baseline", numeroPedido: "SYNTHETIC-BASELINE",
        dataPedidoMiliegundos: Date.UTC(2026, 8, 29), status: "0",
        descricaoStatus: "Não conferido", itens: 1 }], pendingIds: [] });
    const endpoint = `${api.origin}/api/digital-sync/status`;
    assert.equal((await fetch(endpoint)).status, 401);
    async function token(usuario) {
      const response = await fetch(`${api.origin}/api/auth/login`, { method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usuario, senha: password }) });
      assert.equal(response.status, 200);
      return (await response.json()).session;
    }
    const employee = await token("employee-synthetic");
    assert.equal((await fetch(endpoint, { headers: { Authorization: `Bearer ${employee}` } })).status, 403);
    const coordinator = await token("coord-synthetic");
    const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${coordinator}` } });
    assert.equal(response.status, 200);
    const status = await response.json();
    assert.equal(status.enabled, false);
    assert.equal(status.writeEnabled, false);
    assert.equal(status.nextRunAt, null);
    assert.equal(status.state.observed, 1);
    assert.equal(status.state.lastSuccessfulAt, "2026-09-30T13:53:11.628Z");
    assert.equal(JSON.stringify(status).includes(password), false);
    await api.close(); api = null;
    step = "restart";
    const restartPort = await freePort();
    api = await startApiServer({ dataDirectory: root, host: "127.0.0.1", port: restartPort,
      lanPilot: true, digitalSyncConfig: { ...config, writeEnabled: true } });
    step = "second request";
    const afterRestart = await fetch(`${api.origin}/api/digital-sync/status`, {
      headers: { Authorization: `Bearer ${coordinator}` } }).then((item) => item.json());
    assert.equal(afterRestart.enabled, false);
    assert.equal(afterRestart.writeEnabled, true);
    assert.equal(afterRestart.nextRunAt, null);
    assert.equal(afterRestart.state.observed, 1);
    await api.close(); api = null;
    const planningPort = await freePort();
    api = await startApiServer({ dataDirectory: root, host: "127.0.0.1", port: planningPort,
      lanPilot: true, digitalSyncConfig: { ...config, enabled: true, writeEnabled: false } });
    const planning = await fetch(`${api.origin}/api/digital-sync/status`, {
      headers: { Authorization: `Bearer ${coordinator}` } }).then((item) => item.json());
    assert.equal(planning.enabled, true);
    assert.equal(planning.writeEnabled, false);
    assert.equal(typeof planning.nextRunAt, "string");
    assert.equal(planning.state.lastRunStatus, "BASELINE_COMPLETE",
      "startup must not execute a cycle immediately");
    process.stdout.write("Status Digital: 401/403/200, interruptores, agendamento sem execução imediata e reinício aprovados.\n");
  } catch (error) { throw new Error(`DIGITAL_STATUS_TEST_${step}: ${error.message}`); }
  finally { if (api) await api.close(); else database.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

main().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
