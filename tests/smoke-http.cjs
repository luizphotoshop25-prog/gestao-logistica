const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const database = require("../electron/database.cjs");
const { startApiServer } = require("../server/api-server.cjs");
const { createTestUser, login, authHeaders } = require("./http-test-auth.cjs");
let token = "";

async function getJson(url, init) {
  const response = await fetch(url, { ...init, headers: { ...authHeaders(token), ...(init?.headers || {}) } });
  const body = await response.json();
  assert.equal(response.ok, true, body.message || `HTTP ${response.status}`);
  return body;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-logistica-http-"));
  const resolvedRoot = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  assert(resolvedRoot.startsWith(tempRoot));
  assert(path.basename(resolvedRoot).startsWith("gestao-logistica-http-"));
  assert(!fs.lstatSync(resolvedRoot).isSymbolicLink());
  let api;
  try {
    api = await startApiServer({ userDataPath: path.join(root, "api-user-data") });
    assert.equal((await fetch(api.origin + "/health").then((response) => response.json())).ok, true);
    createTestUser(database);
    token = (await login(api.origin)).session;
    const imported = database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M99997", clienteNome: "Cliente HTTP Teste", clienteEmail: "http-teste@example.invalid", clienteTelefone: "00000000000", clienteCidade: "Curitiba - TESTE", fotosQuantidade: 12, observacoes: "Fixture HTTP sintético.", editor: "Editor HTTP", selecaoFinalizadaEm: null, tratamentoConcluido: false }] });
    assert.equal(imported.ok, true);
    assert.equal(imported.imported, 1);

    const directList = database.listOrders({ search: "M99997", filter: "all" });
    const httpList = await getJson(api.origin + "/api/orders?search=M99997&filter=all");
    assert.deepEqual(httpList, { ok: true, rows: directList });
    const orderId = directList[0].id;

    const directDetail = database.getOrder(orderId);
    const httpDetail = await getJson(api.origin + "/api/orders/" + encodeURIComponent(orderId));
    assert.deepEqual(httpDetail, directDetail);
    assert.equal(httpDetail.order.sessao, "M99997");
    assert.equal(httpDetail.order.cliente_nome, "Cliente HTTP Teste");
    const missingResponse = await fetch(api.origin + "/api/orders/inexistente", { headers: authHeaders(token) });
    assert.equal(missingResponse.status, 404);
    assert.deepEqual(await missingResponse.json(), database.getOrder("inexistente"));

    const directDashboard = { ok: true, dashboard: database.getDashboard() };
    const httpDashboard = await getJson(api.origin + "/api/dashboard");
    assert.deepEqual(httpDashboard, directDashboard);
    assert.equal(httpDashboard.dashboard.total, 1);

    const revision = httpDetail.order.revisao;
    const updated = await getJson(api.origin + "/api/orders/" + encodeURIComponent(orderId), { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ revisao: revision, values: { observacoes: "Atualizado exclusivamente pelo smoke HTTP." } }) });
    assert.equal(updated.ok, true);
    const persisted = await getJson(api.origin + "/api/orders/" + encodeURIComponent(orderId));
    assert.equal(persisted.order.observacoes, "Atualizado exclusivamente pelo smoke HTTP.");
    assert.equal(persisted.order.revisao, revision + 1);
    const conflictResponse = await fetch(api.origin + "/api/orders/" + encodeURIComponent(orderId), { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ revisao: revision, values: { observacoes: "Sobrescrita que não pode acontecer." } }) });
    assert.equal(conflictResponse.status, 409);
    const conflict = await conflictResponse.json();
    assert.equal(conflict.ok, false);
    assert.equal(conflict.error, "REVISION_CONFLICT");
    assert.equal((await getJson(api.origin + "/api/orders/" + encodeURIComponent(orderId))).order.observacoes, "Atualizado exclusivamente pelo smoke HTTP.");
    assert.deepEqual(persisted, JSON.parse(JSON.stringify(database.getOrder(orderId))));

    console.log(JSON.stringify({ ok: true, origin: api.origin, fixture: "M99997", listEquivalent: true, detailEquivalent: true, dashboardEquivalent: true, updatePersisted: true }, null, 2));
  } finally {
    if (api) await api.close(); else database.close();
    assert(resolvedRoot.startsWith(tempRoot));
    assert(path.basename(resolvedRoot).startsWith("gestao-logistica-http-"));
    assert(!fs.lstatSync(resolvedRoot).isSymbolicLink());
    fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    console.log("Temporário HTTP removido:", resolvedRoot);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
