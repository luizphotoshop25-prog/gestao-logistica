const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");
const { createPasswordHash } = require("../server/api-server.cjs");
const { exportSnapshot } = require("../scripts/export-cloudflare-snapshot.cjs");

class SqliteStorageMock {
  constructor() { this.db = new DatabaseSync(":memory:"); }
  exec(query, ...bindings) {
    const trimmed = String(query).trim();
    if (!bindings.length && /^(CREATE|DROP|ALTER)\b/i.test(trimmed)) {
      this.db.exec(query);
      return cursor([]);
    }
    const statement = this.db.prepare(query);
    if (statement.columns().length) return cursor(statement.all(...bindings));
    const result = statement.run(...bindings);
    return cursor([], result.changes);
  }
}

function cursor(rows, rowsWritten = 0) {
  return { toArray: () => rows, rowsWritten, rowsRead: rows.length,
    columnNames: rows.length ? Object.keys(rows[0]) : [] };
}

function sqliteContext() {
  const sql = new SqliteStorageMock();
  return { storage: { sql, transactionSync(callback) {
    sql.db.exec("BEGIN IMMEDIATE");
    try { const value = callback(); sql.db.exec("COMMIT"); return value; }
    catch (error) { sql.db.exec("ROLLBACK"); throw error; }
  } } };
}

async function request(doInstance, pathname, { method = "GET", body, token, ip = "198.51.100.1" } = {}) {
  const headers = new Headers({ origin: "null", "cf-connecting-ip": ip });
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (body !== undefined) headers.set("content-type", "application/json");
  return doInstance.fetch(new Request(`https://api.test${pathname}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-cloudflare-smoke-"));
  const dataDir = path.join(root, "source");
  const snapshotDir = path.resolve("work", "cloudflare-migration", `smoke-${process.pid}`, "snapshot");
  const remoteOrigin = String(process.env.GESTAO_CLOUDFLARE_API_ORIGIN || "").replace(/\/$/, "");
  const token = process.env.GESTAO_CLOUDFLARE_MIGRATION_TOKEN || `synthetic-import-token-${"x".repeat(48)}`;
  const durableContext = remoteOrigin ? null : sqliteContext();
  try {
    database.initializeDataDirectory(dataDir);
    const coordinator = database.createUser({ nome: "Coordenação Sintética", usuario: "coord_test",
      senhaHash: createPasswordHash("synthetic-coordinator-password"), role: "coordinator" });
    const employee = database.createUser({ nome: "Funcionário Sintético", usuario: "employee_test",
      senhaHash: createPasswordHash("synthetic-employee-password"), role: "employee" });
    assert.equal(coordinator.ok, true);
    assert.equal(employee.ok, true);
    const imported = database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M90001",
      clienteNome: "Cliente Sintético", clienteEmail: "synthetic@example.invalid", clienteTelefone: "0000000000",
      clienteCidade: "Curitiba - TESTE", fotosQuantidade: 12, observacoes: "fixture de teste", editor: "Teste",
      selecaoFinalizadaEm: null, tratamentoConcluido: false }] });
    assert.equal(imported.ok, true);
    assert.equal(imported.imported, 1);
    const sourceOrder = database.listOrders({ search: "M90001", filter: "all" })[0];
    assert(sourceOrder);
    database.close();

    const sourceFile = path.join(dataDir, "gestao-logistica.sqlite3");
    const exported = exportSnapshot(sourceFile, snapshotDir);
    assert.equal(exported.integrity, "ok");
    const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, "manifest.json"), "utf8"));
    let api;
    if (remoteOrigin) {
      api = { fetch: async (request) => fetch(`${remoteOrigin}${new URL(request.url).pathname}${new URL(request.url).search}`, {
        method: request.method, headers: request.headers,
        ...(["GET", "HEAD"].includes(request.method) ? {} : { body: await request.arrayBuffer() }),
      }) };
    } else {
      const { ApiDatabase } = await import("../cloudflare/durable-object.mjs");
      api = new ApiDatabase(durableContext, { MIGRATION_TOKEN: token });
    }

    assert.equal((await (await request(api, "/health")).json()).database, "not-ready");
    const denied = await request(api, "/__internal/import/schema", { method: "POST", body: {} });
    assert.equal(denied.status, 404);
    const schemaResponse = await request(api, "/__internal/import/schema", {
      method: "POST", token, body: manifest,
    });
    assert.equal(schemaResponse.status, 200, JSON.stringify(await schemaResponse.json()));

    let batchCount = 0;
    for (const table of manifest.tables) {
      for (let batch = 0; batch < table.batches; batch++) {
        const file = path.join(snapshotDir, "data", `${table.name}-${String(batch).padStart(5, "0")}.json`);
        const rows = JSON.parse(fs.readFileSync(file, "utf8"));
        const response = await request(api, "/__internal/import/batch", {
          method: "POST", token, body: { table: table.name, batchId: "a".repeat(64 - String(batchCount).length) + batchCount, rows },
        });
        assert.equal(response.status, 200, `${table.name}/${batch}: ${JSON.stringify(await response.json())}`);
        batchCount += 1;
      }
    }
    const finalized = await request(api, "/__internal/import/finalize", {
      method: "POST", token, body: { manifestSha256: manifest.manifestSha256 },
    });
    assert.equal(finalized.status, 200, JSON.stringify(await finalized.json()));
    const health = await request(api, "/health");
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { ok: true, database: "available" });

    if (!remoteOrigin) {
      const { ApiDatabase } = await import("../cloudflare/durable-object.mjs");
      api = new ApiDatabase(durableContext, { MIGRATION_TOKEN: token });
    }
    const login = await request(api, "/api/auth/login", { method: "POST", ip: "198.51.100.1",
      body: { usuario: "coord_test", senha: "synthetic-coordinator-password" } });
    assert.equal(login.status, 200);
    const session = (await login.json()).session;
    const headers = { authorization: `Bearer ${session}`, origin: "null", "cf-connecting-ip": "198.51.100.1" };
    const orders = await api.fetch(new Request("https://api.test/api/orders?search=M90001&filter=all", { headers }));
    const orderBody = await orders.json();
    assert.equal(orders.status, 200);
    assert.equal(orderBody.rows.length, 1);
    assert.equal(orderBody.rows[0].sessao, "M90001");
    const assignees = await api.fetch(new Request("https://api.test/api/solicitations/assignees", { headers }));
    const assigneeBody = await assignees.json();
    assert.equal(assignees.status, 200);
    assert(assigneeBody.rows.some((row) => row.usuario === "employee_test"));
    const created = await api.fetch(new Request("https://api.test/api/solicitations", {
      method: "POST", headers, body: JSON.stringify({ descricao: "Validação sintética",
        responsavel_usuario_id: employee.user.id, prazo_em: null }),
    }));
    assert.equal(created.status, 201, JSON.stringify(await created.json()));

    for (let attempt = 0; attempt < 10; attempt++) {
      const failed = await request(api, "/api/auth/login", { method: "POST", ip: "198.51.100.9",
        body: { usuario: "coord_test", senha: "wrong-synthetic-password" } });
      assert([401, 429].includes(failed.status));
    }
    const blocked = await request(api, "/api/auth/login", { method: "POST", ip: "198.51.100.9",
      body: { usuario: "coord_test", senha: "wrong-synthetic-password" } });
    assert.equal(blocked.status, 429);

    console.log(JSON.stringify({ ok: true, syntheticImport: true, integrity: "ok", login: true,
      ordersRead: true, activeAssignees: true, solicitationWrite: true, persistentRateLimit: true,
      tables: exported.tables, fixtureRows: exported.rows, batches: batchCount }, null, 2));
  } finally {
    try { database.close(); } catch {}
    durableContext?.storage.sql.db.close();
    fs.rmSync(snapshotDir, { recursive: true, force: true });
    fs.rmSync(path.dirname(snapshotDir), { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
