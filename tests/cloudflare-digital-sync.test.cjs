const assert = require("node:assert/strict");
const { test } = require("node:test");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const database = require("../electron/database.cjs");
const { DigitalSyncState } = require("../server/integrations/digital/digital-sync-state.cjs");
const { CloudDigitalSync, cloudCredentialProvider, safeError } = require("../server/cloudflare/digital-sync.cjs");
const { COLUMNS } = require("../server/cloudflare/digital-sync-state.cjs");
const { createSqliteSyncAdapter } = require("../server/cloudflare/sqlite-sync-adapter.cjs");
const { executeAuthorizedConnection } = require("../server/integrations/digital/digital-sync-executor.cjs");
const { planDetail, readDatabaseStateFromConnection } = require("../server/integrations/digital/digital-sync-planner.cjs");
const { SigiClient } = require("../server/integrations/digital/sigi-client.cjs");
const meta = (id) => ({ idFotoPedido: id, numeroPedido: `TEST-${id}`, dataPedidoMiliegundos: Date.UTC(2026, 8, 29),
  status: "0", descricaoStatus: "Não conferido", itens: 2 });
const baseline = meta("baseline");
const detail = () => ({ classification: "CANDIDATO", itensInformados: 2, fotosRetornadas: 2,
  arquivosInvalidos: 0, sessoes: [{ sessao: "M70001", arquivos: 2 }] });

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cloud-digital-"));
  database.initializeDataDirectory(root);
  database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M70001", clienteNome: "Sintético",
    fotosQuantidade: 2 }] });
  database.close();
  const legacy = new DigitalSyncState(root);
  legacy.importBaseline({ schema: 1, createdAt: "2026-09-29T12:00:00.000Z", orders: [baseline], pendingIds: [] },
    { rows: [{ idFotoPedido: baseline.idFotoPedido, exclusive: "BASELINE_EXISTING_UNIMPORTED" }] });
  const source = new DatabaseSync(legacy.file, { readOnly: true });
  const payload = { schema: 1, tables: Object.fromEntries(Object.entries(COLUMNS)
    .map(([name, cols]) => [name, source.prepare(`SELECT ${cols.join(",")} FROM ${name}`).all()])) };
  source.close();
  const db = new DatabaseSync(path.join(root, "gestao-logistica.sqlite3"));
  db.exec("PRAGMA foreign_keys=ON");
  const sql = { exec(query, ...args) {
    if (/^PRAGMA\s+busy_timeout/i.test(query.trim())) throw new Error("not authorized: SQLITE_AUTH");
    if (!args.length && /^(CREATE|ALTER)/i.test(query.trim())) { db.exec(query); return { toArray: () => [] }; }
    const statement = db.prepare(query);
    const rows = statement.columns().length ? statement.all(...args) : (statement.run(...args), []);
    return { toArray: () => rows };
  } };
  const storage = { sql, transactionSync(fn) {
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  } };
  const connection = createSqliteSyncAdapter(sql);
  const env = { DIGITAL_SYNC_ENABLED: "true", DIGITAL_SYNC_WRITE_ENABLED: "false" };
  let listed = [meta("new"), baseline];
  const clientFactory = () => ({ authenticated: true, version: "1.2.3.4", close() {},
    listOrders: async () => ({ orders: listed, totalRegistros: listed.length }),
    getOrderDetail: async (row) => { assert.notEqual(row.idFotoPedido, baseline.idFotoPedido); return detail(); } });
  const service = (opts = {}) => new CloudDigitalSync(connection, storage, env, { clientFactory, ...opts });
  t.after(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  return { payload, db, connection, storage, env, service, setListed: (rows) => { listed = rows; } };
}

test("provider usa somente secrets env e SigiClient; erros não expõem valores", async () => {
  await assert.rejects(cloudCredentialProvider({})(), /DIGITAL_CREDENTIAL_MISSING/);
  const provider = cloudCredentialProvider({ DIGITAL_SIGI_USERNAME: "synthetic@example.invalid", DIGITAL_SIGI_PASSWORD: "synthetic" });
  assert.equal((await provider()).password, "synthetic");
  let provided = false;
  const client = new SigiClient({ credentialProvider: async () => { provided = true; return provider(); },
    discover: async () => { throw new Error("password=synthetic"); } });
  await assert.rejects(client.login(), /DIGITAL_LOGIN_PROTOCOL_ERROR/);
  assert.equal(provided, true);
  assert.equal(client.credentials, null);
  assert.equal(safeError(new Error("Cookie=synthetic; password=synthetic")), "DIGITAL_SYNC_FAILED");
});

test("migração conta tudo, preserva baseline, é idempotente e recusa conflito/incompleto", (t) => {
  const f = fixture(t), s = f.service();
  assert.throws(() => s.state.validate(), /DIGITAL_BASELINE_INVALID/);
  assert.deepEqual(s.state.migrate(f.payload).counts, { meta: 5, runs: 1, observations: 1, scan_window: 1 });
  assert.equal(s.state.migrate(f.payload).alreadyApplied, true);
  assert.equal(s.state.isBaselineOrder("baseline"), true);
  assert.equal(s.state.status().baselineExistingUnimported, 1);
  const changed = structuredClone(f.payload); changed.tables.observations[0].itens++;
  assert.throws(() => s.state.migrate(changed), /DIGITAL_BASELINE_CONFLICT/);
  assert.throws(() => s.state.migrate({ schema: 1, tables: {} }), /DIGITAL_BASELINE_INVALID/);
  assert.equal(f.service().state.validate().baseline, 1);
});

test("dry-run, teto 1, dois ciclos, reinício e baseline protegido", async (t) => {
  const f = fixture(t), s = f.service(); s.state.migrate(f.payload);
  f.setListed([meta("new"), meta("second"), baseline]);
  const dry = await s.run();
  assert.equal(dry.status, "COMPLETE"); assert.equal(dry.candidates, 2); assert.equal(dry.imported, 0);
  assert.equal(s.inspect().database.shipments, 0);
  f.env.DIGITAL_SYNC_WRITE_ENABLED = "true"; f.env.DIGITAL_SYNC_MAX_IMPORTS_PER_CYCLE = "50";
  const one = await f.service().run();
  assert.equal(one.imported, 1); assert.equal(one.status, "COMPLETE");
  assert.equal((await f.service().run()).imported, 1);
  assert.equal((await f.service().run()).imported, 0);
  assert.deepEqual(s.inspect().database, { shipments: 2, items: 2, events: 2, duplicates: 0, foreignKeyViolations: 0 });
  assert.equal(f.db.prepare("SELECT COUNT(*) n FROM digital_envio_eventos WHERE acao='digital_sync_created' AND usuario_id IS NULL").get().n, 2);
  assert.equal(s.state.status().baselineExistingUnimported, 1);
});

test("rollback integral em shipment/items/audit e baseline bloqueado pelo executor", async (t) => {
  const f = fixture(t), s = f.service(); s.state.migrate(f.payload); await s.run();
  const plan = planDetail(meta("new"), detail(), readDatabaseStateFromConnection(f.connection));
  const options = { syncEnabled: true, writeEnabled: true, stateStore: s.state, cycleBudget: { limit: 1, imported: 0 } };
  for (const failAt of ["shipment", "items", "audit"]) {
    assert.throws(() => f.storage.transactionSync(() => executeAuthorizedConnection(f.connection, plan,
      { ...options, failAt })), /SYNTHETIC_FAILURE/);
    assert.equal(s.inspect().database.shipments, 0);
    assert.equal(s.inspect().database.items, 0); assert.equal(s.inspect().database.events, 0);
  }
  assert.equal(f.storage.transactionSync(() => executeAuthorizedConnection(f.connection,
    { ...plan, idFotoPedido: "baseline" }, options)).outcome, "BASELINE_EXISTING_UNIMPORTED");
  assert.equal(f.storage.transactionSync(() => executeAuthorizedConnection(f.connection, plan, options)).outcome, "IMPORTED");
  assert.equal(f.storage.transactionSync(() => executeAuthorizedConnection(f.connection, plan,
    { ...options, cycleBudget: { limit: 1, imported: 0 } })).outcome, "ALREADY_IMPORTED");
});

test("planner preserva cancelado/missing/over/under; nenhuma classificação bloqueada escreve", (t) => {
  const f = fixture(t), dbState = readDatabaseStateFromConnection(f.connection);
  assert.equal(planDetail(meta("new"), detail(), dbState).category, "CANDIDATE");
  assert.equal(planDetail({ ...meta("new"), descricaoStatus: "Cancelado" }, detail(), dbState).category, "SKIP_CANCELLED");
  assert.equal(planDetail(meta("new"), { ...detail(), sessoes: [{ sessao: "M99999", arquivos: 2 }] }, dbState).category, "PENDING_MISSING_SESSION");
  assert.equal(planDetail(meta("new"), { ...detail(), sessoes: [{ sessao: "M70001", arquivos: 3 }] }, dbState).category, "REVIEW_OVER_TOTAL");
  assert.equal(planDetail(meta("new"), { ...detail(), itensInformados: 3, fotosRetornadas: 3 }, dbState).category, "CANDIDATE_UNDER_TOTAL");
});

test("lease persistente bloqueia reentrada e expiração impede escrita por executor antigo", async (t) => {
  const f = fixture(t); let now = Date.now(), release;
  const barrier = new Promise((r) => { release = r; });
  const s = f.service({ now: () => now, clientFactory: () => ({ close() {},
    listOrders: async () => { await barrier; return { orders: [baseline], totalRegistros: 1 }; } }) });
  s.state.migrate(f.payload);
  const running = s.run();
  assert.equal((await f.service().run()).status, "ALREADY_RUNNING");
  now += 11 * 60 * 1000;
  const successor = f.service({ now: () => now });
  const lease = successor.acquire(); assert(lease);
  release();
  assert.equal((await running).errorCode, "DIGITAL_LEASE_EXPIRED");
  assert.equal(JSON.parse(s.state.get("lease")).token, lease.token);
  assert.equal(s.inspect().database.shipments, 0);
});

test("falha de checkpoint do import reverte operação inteira e erro fica sanitizado", async (t) => {
  const f = fixture(t), s = f.service(); s.state.migrate(f.payload); await s.run();
  f.env.DIGITAL_SYNC_WRITE_ENABLED = "true";
  const writer = f.service(); writer.state.recordOutcome = () => { throw new Error("password=synthetic-private"); };
  const result = await writer.run();
  assert.equal(result.errorCode, "DIGITAL_SYNC_FAILED");
  assert.equal(s.inspect().database.shipments, 0);
  assert(!JSON.stringify(s.state.status()).includes("synthetic-private"));
});

test("Worker Cron usa mesma identidade e bloqueia rota externa sem token", async () => {
  const { default: worker } = await import("../cloudflare/worker.mjs");
  let calls = 0, waited;
  const env = { DIGITAL_SYNC_ENABLED: "true", DIGITAL_SYNC_INTERNAL_TOKEN: "synthetic-internal",
    API_DATABASE: { idFromName(name) { assert.equal(name, "gestao-logistica-production"); return "same-id"; },
      get(id) { assert.equal(id, "same-id"); return { fetch: async (request) => {
        calls++; assert.equal(request.headers.get("authorization"), "Bearer synthetic-internal");
        assert.equal(new URL(request.url).pathname, "/__internal/digital-sync/run");
        return Response.json({ status: "COMPLETE" });
      } }; } } };
  assert.equal((await worker.fetch(new Request("https://api.test/__internal/digital-sync/run", { method: "POST" }), env)).status, 404);
  assert.equal(calls, 0);
  await worker.scheduled({}, env, { waitUntil: (promise) => { waited = promise; } }); await waited;
  assert.equal(calls, 1);
});
