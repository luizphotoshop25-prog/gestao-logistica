const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { DigitalSyncState, stateFile, markerFile } = require("../server/integrations/digital/digital-sync-state.cjs");
const { reconcileBaseline } = require("../server/integrations/digital/digital-sync-reconcile.cjs");
const { DigitalSyncService, safeError } = require("../server/integrations/digital/digital-sync-service.cjs");
const { prepareDigitalSyncScheduler } = require("../server/integrations/digital/digital-sync-scheduler.cjs");
const { buildDryRun } = require("../server/integrations/digital/digital-sync-planner.cjs");

const observedAt = "2026-09-30T13:53:11.628Z";
const order = (id, number, description = "Não conferido") => ({ idFotoPedido: id,
  numeroPedido: number, dataPedidoMiliegundos: 1790000000000,
  status: "0", descricaoStatus: description, itens: 2 });
const baseline = () => ({ schema: 1, createdAt: observedAt,
  orders: [order("a", "111"), order("b", "222", "Cancelado"), order("c", "333")], pendingIds: [] });
const dbState = { existing: new Map([["111", { id: "p1" }]]) };
const withStore = async (fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digital-state-"));
  try { await fn(new DigitalSyncState(dir), dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

test("reconciliação produz contagens independentes e classificação exclusiva", () => {
  const result = reconcileBaseline(baseline(), dbState);
  assert.deepEqual(result.independent, { existing: 1, cancelled: 1, otherStatus: 0,
    absentNonCancelled: 1, existingAndCancelled: 0 });
  assert.deepEqual(result.exclusive, { EXISTING: 1, CANCELLED: 1, BASELINE_ABSENT_ACTIVE: 1 });
  const overlap = reconcileBaseline({ ...baseline(), orders: [order("a", "111", "Cancelado")] }, dbState);
  assert.equal(overlap.independent.existingAndCancelled, 1);
  assert.deepEqual(overlap.exclusive, { EXISTING: 1 });
});

test("baseline é importado atomicamente, preserva observação e é idempotente", async () => withStore((store) => {
  const source = baseline();
  const reconciled = reconcileBaseline(source, dbState);
  assert.deepEqual(store.importBaseline(source, reconciled), {
    imported: true, count: 3, firstObservedAt: observedAt });
  assert.equal(store.importBaseline(source, reconciled).imported, false);
  assert.deepEqual(store.inspect(), { observations: 3, window: 3,
    baselineObservedAt: observedAt, lastSuccessfulSync: observedAt,
    integrity: "ok", foreignKeyViolations: 0 });
  assert.deepEqual(store.loadSnapshot().orders.map((row) => row.itens), [2, 2, 2]);
  const db = new DatabaseSync(store.file, { readOnly: true });
  try { assert.equal(db.prepare("SELECT first_seen_at FROM observations WHERE id_foto_pedido='a'").get().first_seen_at,
    observedAt); }
  finally { db.close(); }
}));

test("ausentes do primeiro baseline são classificados após backup íntegro", async () => withStore(async (store) => {
  store.importBaseline(baseline(), reconcileBaseline(baseline(), dbState));
  const result = await store.classifyBaselineUnimported();
  assert.equal(result.changed, 1);
  assert.equal(fs.existsSync(result.backupPath), true);
  assert.equal((await store.classifyBaselineUnimported()).changed, 0);
  const db = new DatabaseSync(store.file, { readOnly: true });
  try { assert.equal(db.prepare("SELECT classification FROM observations WHERE id_foto_pedido='c'").get()
    .classification, "BASELINE_EXISTING_UNIMPORTED"); }
  finally { db.close(); }
}));

test("duplicatas e conflito não substituem baseline existente", async () => withStore((store) => {
  const source = baseline();
  assert.throws(() => store.importBaseline({ ...source, orders: [...source.orders, source.orders[0]] }),
    /DIGITAL_BASELINE_INVALID/);
  store.importBaseline(source);
  const conflicting = { ...source, orders: [order("x", "999")] };
  assert.throws(() => store.importBaseline(conflicting), /DIGITAL_BASELINE_CONFLICT/);
  assert.equal(store.inspect().observations, 3);
}));

test("reinício após consulta interrompida mantém último checkpoint", async () => withStore((store, dir) => {
  store.importBaseline(baseline());
  const started = store.startRun();
  const restarted = new DigitalSyncState(dir);
  assert.equal(restarted.inspect().lastSuccessfulSync, observedAt);
  assert.equal(restarted.loadSnapshot().orders.length, 3);
  restarted.failRun(started, "DIGITAL_API_UNAVAILABLE");
  const db = new DatabaseSync(store.file, { readOnly: true });
  try { assert.equal(db.prepare("SELECT status FROM runs WHERE run_id=?").get(started).status, "FAILED"); }
  finally { db.close(); }
}));

test("checkpoint só avança após transação completa; falha de snapshot faz rollback", async () => withStore((store) => {
  store.importBaseline(baseline());
  const runId = store.startRun();
  const nextSnapshot = { ...baseline(), orders: [order("x", "444"), ...baseline().orders] };
  const result = { nextSnapshot, planned: [{ idFotoPedido: "x", numeroPedido: "444", category: "CANDIDATE" }],
    scan: { possibleGap: false } };
  store.finishRun(runId, result);
  assert.equal(store.loadSnapshot().orders.length, 4);
  assert.deepEqual(store.loadSnapshot().pendingIds, ["x"]);
  const last = store.inspect().lastSuccessfulSync;
  const failed = store.startRun();
  assert.throws(() => store.finishRun(failed, { ...result,
    nextSnapshot: { ...nextSnapshot, orders: [order("z", "444"), ...nextSnapshot.orders] } }));
  assert.equal(store.inspect().lastSuccessfulSync, last);
  assert.equal(store.inspect().window, 4);
}));

test("estado ausente ou corrompido bloqueia sem recriar baseline", async () => withStore((store, dir) => {
  store.importBaseline(baseline());
  assert.equal(fs.existsSync(markerFile(dir)), true);
  const archived = `${stateFile(dir)}.hold`;
  fs.renameSync(store.file, archived);
  assert.throws(() => store.loadSnapshot(), /DIGITAL_STATE_MISSING/);
  assert.throws(() => store.importBaseline(baseline()), /DIGITAL_STATE_MISSING/);
  fs.writeFileSync(store.file, "corrupted state");
  assert.throws(() => store.loadSnapshot(), /DIGITAL_STATE_CORRUPT/);
  assert.equal(fs.readFileSync(store.file, "utf8"), "corrupted state");
}));

test("serviço usa o estado persistente após reinício, sem depender de work", async () => withStore(async (store, dir) => {
  store.importBaseline(baseline());
  const service = new DigitalSyncService({ dbPath: path.join(dir, "synthetic.sqlite3"),
    dataDir: dir, outputDir: path.join(dir, "reports"), stateStore: store,
    options: { pageSize: 3, recentOrders: 3, maxScanPages: 1 },
    dbReader: () => ({ existing: new Map(), sessions: new Map(), revisions: new Map(),
      counts: { envios: 0, relacoes: 0 } }),
    clientFactory: () => ({ authenticated: true, version: "1.2.3.4", close() {},
      listOrders: async () => ({ orders: baseline().orders, totalRegistros: 3 }),
      getOrderDetail: async () => { throw Error("baseline orders must not request detail"); } }) });
  const result = await service.runDryRun({ writeReports: false });
  assert.equal(result.scan.newObserved, 0);
  assert.equal(new DigitalSyncState(dir).inspect().observations, 3);
  assert.notEqual(new DigitalSyncState(dir).inspect().lastSuccessfulSync, observedAt);
}));

test("pedido observado antes da janela atual não vira novidade ao reaparecer", async () => {
  const old = baseline().orders[0];
  const recent = baseline().orders[1];
  const snapshot = { schema: 1, createdAt: observedAt, orders: [recent],
    knownOrders: [old, recent], pendingIds: [] };
  const result = await buildDryRun({ snapshot, options: { pageSize: 2, recentOrders: 2,
    maxScanPages: 1 }, dbState: { existing: new Map(), sessions: new Map(), counts: {} },
  client: { listOrders: async () => ({ orders: [old, recent], totalRegistros: 2 }),
    getOrderDetail: async () => { throw Error("already observed order must not request detail"); } } });
  assert.equal(result.scan.newObserved, 0);
});

test("pedido ausente do baseline nunca se torna candidato automático", async () => withStore(async (store) => {
  store.importBaseline(baseline(), reconcileBaseline(baseline(), dbState));
  const result = await buildDryRun({ snapshot: store.loadSnapshot(),
    options: { pageSize: 3, recentOrders: 3, maxScanPages: 1 },
    dbState: { existing: new Map(), sessions: new Map(), revisions: new Map(), counts: {} },
    client: { listOrders: async () => ({ orders: baseline().orders, totalRegistros: 3 }),
      getOrderDetail: async () => { throw Error("baseline must not request detail"); } } });
  assert.equal(result.planned.find((row) => row.idFotoPedido === "c").category,
    "BASELINE_EXISTING_UNIMPORTED");
}));

test("pendente fora da janela é reavaliado e mantém resultado no estado auxiliar", async () => withStore(async (store) => {
  store.importBaseline(baseline());
  store.recordOutcome("c", "PENDING_MISSING_SESSION");
  let details = 0;
  const result = await buildDryRun({ snapshot: store.loadSnapshot(),
    options: { pageSize: 2, recentOrders: 2, maxScanPages: 1, pendingRecheckLimit: 1 },
    dbState: { existing: new Map(), sessions: new Map([["M1", "pedido-1"]]),
      revisions: new Map([["pedido-1", 3]]), counts: {} },
    client: { listOrders: async () => ({ orders: baseline().orders.slice(0, 2), totalRegistros: 2 }),
      getOrderDetail: async (meta) => {
        assert.equal(meta.idFotoPedido, "c"); details++;
        return { classification: "CANDIDATO", itensInformados: 2, fotosRetornadas: 2,
          arquivosInvalidos: 0, sessoes: [{ sessao: "M1", arquivos: 2 }] };
      } } });
  assert.equal(details, 1);
  assert.equal(result.pendingRechecked, 1);
  assert.equal(result.planned.find((row) => row.idFotoPedido === "c").category, "CANDIDATE");
  store.finishRun(store.startRun(), result);
  const restarted = store.loadSnapshot();
  assert.deepEqual(restarted.pendingIds, ["c"]);
  const db = new DatabaseSync(store.file, { readOnly: true });
  try {
    const row = db.prepare("SELECT process_state,classification FROM observations WHERE id_foto_pedido='c'").get();
    assert.equal(row.process_state, "READY");
    assert.equal(row.classification, "CANDIDATE");
  } finally { db.close(); }
}));

test("falha na normalização não avança o checkpoint nem vaza exceção", async () => withStore(async (store, dir) => {
  store.importBaseline(baseline());
  const service = new DigitalSyncService({ dbPath: path.join(dir, "synthetic.sqlite3"),
    dataDir: dir, outputDir: path.join(dir, "reports"), stateStore: store,
    options: { pageSize: 4, recentOrders: 4, maxScanPages: 1 },
    dbReader: () => ({ existing: new Map(), sessions: new Map(), revisions: new Map(), counts: {} }),
    clientFactory: () => ({ close() {}, listOrders: async () => ({
      orders: [order("new", "444"), ...baseline().orders], totalRegistros: 4 }),
      getOrderDetail: async () => { throw Error("password=synthetic-only"); } }) });
  await assert.rejects(service.runDryRun({ writeReports: false }), /DIGITAL_SYNC_FAILED/);
  assert.equal(store.inspect().lastSuccessfulSync, observedAt);
  assert.equal(store.inspect().observations, 3);
}));

test("sanitização de exceções não repassa valores sensíveis", () => {
  assert.equal(safeError(new Error("credential supplied in exception")), "DIGITAL_SYNC_FAILED");
  assert.equal(safeError(new Error("DIGITAL_RATE_LIMIT")), "DIGITAL_RATE_LIMIT");
});

test("agendador fica desligado e impede duas execuções simultâneas", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const events = [];
  const scheduler = prepareDigitalSyncScheduler({ options: { enabled: false, intervalMinutes: 30 },
    run: () => barrier, onResult: (event) => events.push(event),
    setIntervalImpl: () => { throw Error("scheduler should remain disabled"); } });
  assert.equal(scheduler.start(), false);
  assert.equal(scheduler.isScheduled(), false);
  const first = scheduler.runOnce();
  assert.deepEqual(await scheduler.runOnce(), { skipped: "DIGITAL_SYNC_BUSY" });
  release({ ok: true });
  assert.equal((await first).ok, true);
  assert.equal(events.length, 1);
});

test("timeout do agendador responde sem iniciar ciclo sobreposto", async () => {
  let expire, release;
  const barrier = new Promise((resolve) => { release = resolve; });
  const events = [];
  const scheduler = prepareDigitalSyncScheduler({ options: { enabled: false },
    run: () => barrier, timeoutMs: 1000, onResult: (event) => events.push(event),
    setTimeoutImpl: (callback) => { expire = callback; return 1; }, clearTimeoutImpl: () => {} });
  const cycle = scheduler.runOnce();
  expire();
  assert.deepEqual(await cycle, { ok: false, reason: "DIGITAL_SYNC_TIMEOUT" });
  assert.equal(scheduler.isRunning(), true);
  assert.deepEqual(await scheduler.runOnce(), { skipped: "DIGITAL_SYNC_BUSY" });
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scheduler.isRunning(), false);
  assert.deepEqual(events, [{ ok: false, reason: "DIGITAL_SYNC_TIMEOUT" }]);
});
