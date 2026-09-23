const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");
const { startApiServer } = require("../server/api-server.cjs");
const { createTestUser, login, authHeaders } = require("./http-test-auth.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-http-race-"));
  const resolvedRoot = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  const userDataPath = path.join(root, "api-user-data");
  let api;
  try {
    assert(resolvedRoot.startsWith(tempRoot));
    assert(path.basename(resolvedRoot).startsWith("gestao-http-race-"));
    assert(!fs.lstatSync(resolvedRoot).isSymbolicLink());
    api = await startApiServer({ userDataPath });
    createTestUser(database);
    const token = (await login(api.origin)).session;
    assert.equal(database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M12346", clienteNome: "Cliente Corrida HTTP", clienteEmail: "corrida@example.invalid", clienteTelefone: "00000000000", clienteCidade: "TESTE", fotosQuantidade: 1, selecaoFinalizadaEm: null, tratamentoConcluido: false }] }).imported, 1);
    const orderId = database.listOrders({ search: "M12346", filter: "all" })[0].id;
    const initial = database.getOrder(orderId);
    const revision = initial.order.revisao;
    const request = (observacoes) => fetch(api.origin + "/api/orders/" + encodeURIComponent(orderId), { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ revisao: revision, values: { observacoes } }) }).then(async (response) => ({ status: response.status, body: await response.json() }));
    const attempts = await Promise.allSettled([request("Vencedor A"), request("Vencedor B")]);
    assert.equal(attempts.length, 2);
    assert(attempts.every((attempt) => attempt.status === "fulfilled"));
    const results = attempts.map((attempt) => attempt.value);
    assert.equal(results.filter((result) => result.status === 200 && result.body.ok).length, 1);
    assert.equal(results.filter((result) => result.status === 409 && result.body.error === "REVISION_CONFLICT").length, 1);
    const final = database.getOrder(orderId);
    assert.equal(final.order.revisao, revision + 1);
    assert(["Vencedor A", "Vencedor B"].includes(final.order.observacoes));
    assert.equal(final.events.length, initial.events.length + 1);
    const winner = results.find((result) => result.status === 200).body;
    assert.equal(final.order.observacoes, winner.order.observacoes);
    const databasePath = path.join(userDataPath, "GestaoLogistica", "gestao-logistica.sqlite3");
    database.close();
    const check = new DatabaseSync(databasePath, { readOnly: true });
    try { assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok"); } finally { check.close(); }
    console.log(JSON.stringify({ ok: true, attempts: 2, successes: 1, conflicts: 1, initialRevision: revision, finalRevision: revision + 1, rejectedWriteEvents: 0 }, null, 2));
  } finally {
    if (api) await api.close(); else database.close();
    assert(resolvedRoot.startsWith(tempRoot));
    assert(path.basename(resolvedRoot).startsWith("gestao-http-race-"));
    assert(!fs.lstatSync(resolvedRoot).isSymbolicLink());
    fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    console.log("Temporário de corrida HTTP removido:", resolvedRoot);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
