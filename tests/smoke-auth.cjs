const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");
const { startApiServer, createPasswordHash } = require("../server/api-server.cjs");
const { TEST_PASSWORD, authHeaders } = require("./http-test-auth.cjs");

async function json(responsePromise) { const response = await responsePromise; return { status: response.status, retryAfter: response.headers.get("retry-after"), body: await response.json() }; }
async function login(origin, usuario, senha) {
  return json(await fetch(origin + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario, senha }) }));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-auth-"));
  let api;
  try {
    api = await startApiServer({ userDataPath: path.join(root, "api") });
    const userA = database.createUser({ nome: "Usuário A", usuario: "usuario-a", senhaHash: createPasswordHash(TEST_PASSWORD) }).user;
    const userB = database.createUser({ nome: "Usuário B", usuario: "usuario-b", senhaHash: createPasswordHash(TEST_PASSWORD + "B") }).user;
    assert.equal((await login(api.origin, "usuario-a", "errada")).status, 401);
    assert.equal((await json(await fetch(api.origin + "/api/orders"))).status, 401);
    const authA = await login(api.origin, "usuario-a", TEST_PASSWORD);
    const authB = await login(api.origin, "usuario-b", TEST_PASSWORD + "B");
    assert.equal(authA.status, 200);
    assert.equal(authB.status, 200);
    const inspection = new DatabaseSync(path.join(root, "api", "GestaoLogistica", "gestao-logistica.sqlite3"), { readOnly: true });
    const storedUser = inspection.prepare("SELECT senha_hash FROM usuarios WHERE id=?").get(userA.id);
    const storedSession = inspection.prepare("SELECT token_hash FROM sessoes WHERE usuario_id=? ORDER BY criado_em DESC LIMIT 1").get(userA.id);
    assert.notEqual(storedUser.senha_hash, TEST_PASSWORD);
    assert.match(storedUser.senha_hash, /^scrypt:v1:/);
    assert.notEqual(storedSession.token_hash, authA.body.session);
    assert.equal(storedSession.token_hash, crypto.createHash("sha256").update(authA.body.session).digest("hex"));
    inspection.close();
    assert.equal((await json(await fetch(api.origin + "/api/auth/current", { headers: authHeaders(authA.body.session) }))).body.user.usuario, "usuario-a");
    database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M12347", clienteNome: "Cliente Auth", clienteEmail: "auth@example.invalid", clienteTelefone: "00000000000", clienteCidade: "TESTE", fotosQuantidade: 1, selecaoFinalizadaEm: null, tratamentoConcluido: false }] });
    const id = database.listOrders({ search: "M12347" })[0].id;
    const save = (token, revisao, observacoes) => json(fetch(api.origin + "/api/orders/" + id, { method: "PATCH", headers: { "Content-Type": "application/json", ...authHeaders(token) }, body: JSON.stringify({ revisao, values: { observacoes } }) }));
    const revision = database.getOrder(id).order.revisao;
    assert.equal((await save(authA.body.session, revision, "A")).status, 200);
    assert.equal(database.getOrder(id).events[0].usuario_id, userA.id);
    assert.equal((await save(authB.body.session, revision, "B conflito")).status, 409);
    assert.equal(database.getOrder(id).events.length, 1);
    assert.equal((await save(authB.body.session, database.getOrder(id).order.revisao, "B")).status, 200);
    assert.equal(database.getOrder(id).events[0].usuario_id, userB.id);
    await fetch(api.origin + "/api/auth/logout", { method: "POST", headers: authHeaders(authA.body.session) });
    assert.equal((await json(await fetch(api.origin + "/api/dashboard", { headers: authHeaders(authA.body.session) }))).status, 401);
    const relogin = await login(api.origin, "usuario-a", TEST_PASSWORD);
    database.setUserActive(userA.id, false);
    assert.equal((await json(await fetch(api.origin + "/api/dashboard", { headers: authHeaders(relogin.body.session) }))).status, 401);
    const attempts = [];
    for (let index = 0; index < 10; index += 1) attempts.push(await login(api.origin, "usuario-inexistente", "senha-incorreta"));
    assert.deepEqual(attempts.slice(0, 9).map((attempt) => attempt.status), Array(9).fill(401));
    assert.equal(attempts[9].status, 429);
    const limited = await login(api.origin, "usuario-a", TEST_PASSWORD);
    assert.equal(limited.status, 429);
    assert(Number(limited.retryAfter) > 0);
    console.log("Autenticação: sessões, autoria, conflito e limite de dez tentativas por IP em quinze minutos aprovados.");
  } finally {
    if (api) await api.close(); else database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
