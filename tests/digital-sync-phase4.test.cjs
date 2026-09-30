const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const database = require("../electron/database.cjs");
const { DigitalSyncState } = require("../server/integrations/digital/digital-sync-state.cjs");
const { DigitalSyncService } = require("../server/integrations/digital/digital-sync-service.cjs");
const { executeAuthorizedPlan, inspectCommittedShipment } = require("../server/integrations/digital/digital-sync-executor.cjs");
const { rehearse } = require("../scripts/rehearse-digital-sync-recovery.cjs");

const observedAt = "2026-09-30T13:53:11.628Z";
const meta = (id, number) => ({ idFotoPedido: id, numeroPedido: number,
  dataPedidoMiliegundos: Date.UTC(2026, 8, 29), status: "0",
  descricaoStatus: "Não conferido", itens: 2 });

test("ciclo integrado exige dois interruptores, protege baseline e recupera commit sem checkpoint", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "digital-phase4-"));
  const dbPath = path.join(root, "gestao-logistica.sqlite3");
  try {
    database.initializeDataDirectory(root);
    assert.equal(database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M70001",
      clienteNome: "Cliente sintético", fotosQuantidade: 2, selecaoFinalizadaEm: null,
      tratamentoConcluido: false }] }).imported, 1);
    database.close();
    const state = new DigitalSyncState(root);
    const baseline = meta("baseline-id", "SYNTHETIC-BASELINE");
    state.importBaseline({ schema: 1, createdAt: observedAt,
      orders: [baseline], pendingIds: [] });
    const first = meta("new-id", "SYNTHETIC-NEW-1");
    const second = meta("new-id-2", "SYNTHETIC-NEW-2");
    const third = { ...meta("new-id-3", "SYNTHETIC-UNDER-TOTAL"), itens: 3 };
    const fourth = meta("new-id-4", "SYNTHETIC-AUX-FAILURE");
    let listed = [first, baseline], detailCalls = 0;
    const options = { enabled: false, writeEnabled: true, pageSize: 5,
      recentOrders: 5, maxScanPages: 1, pendingRecheckLimit: 2 };
    const clientFactory = () => ({ authenticated: true, version: "synthetic", close() {},
      listOrders: async () => ({ orders: listed, totalRegistros: listed.length }),
      getOrderDetail: async (row) => { detailCalls++; assert.notEqual(row.idFotoPedido, "baseline-id");
        return { classification: "CANDIDATO",
          itensInformados: row.idFotoPedido === "new-id-3" ? 3 : 2,
          fotosRetornadas: row.idFotoPedido === "new-id-3" ? 3 : 2,
          arquivosInvalidos: 0, sessoes: [{ sessao: "M70001", arquivos: 2 }] }; } });
    const service = () => new DigitalSyncService({ dbPath, dataDir: root,
      outputDir: path.join(root, "reports"), options, clientFactory, stateStore: state });
    assert.equal((await service().runCycle({ writeReports: false })).status, "DISABLED");
    assert.equal(detailCalls, 0);
    options.enabled = true; options.writeEnabled = false;
    const dry = await service().runCycle({ writeReports: false });
    assert.equal(dry.databaseWrites, 0);
    assert.equal(dry.planned.find((row) => row.idFotoPedido === "baseline-id").category,
      "BASELINE_EXISTING_UNIMPORTED");
    const candidate = dry.planned.find((row) => row.idFotoPedido === "new-id");
    assert.equal(candidate.category, "CANDIDATE");
    assert.equal(executeAuthorizedPlan(dbPath, candidate,
      { syncEnabled: true, writeEnabled: false, stateStore: state }).outcome, "DIGITAL_WRITE_DISABLED");
    assert.equal(executeAuthorizedPlan(dbPath, { ...candidate, idFotoPedido: "baseline-id" },
      { syncEnabled: true, writeEnabled: true, stateStore: state }).outcome,
    "BASELINE_EXISTING_UNIMPORTED");
    options.writeEnabled = true;
    const imported = await service().runCycle({ writeReports: false });
    assert.equal(imported.databaseWrites, 1);
    assert.equal(imported.outcomes[0].outcome, "IMPORTED");
    assert.equal(inspectCommittedShipment(dbPath, first.numeroPedido), "ALREADY_IMPORTED");
    listed = [second, first, baseline];
    const interrupted = await service().runDryRun({ writeReports: false });
    const secondPlan = interrupted.planned.find((row) => row.idFotoPedido === "new-id-2");
    assert.equal(executeAuthorizedPlan(dbPath, secondPlan,
      { syncEnabled: true, writeEnabled: true, stateStore: state }).outcome, "IMPORTED");
    // Simulate process exit before recordOutcome; the next cycle must reconcile the operational commit.
    const resumed = await service().runCycle({ writeReports: false });
    assert.equal(resumed.databaseWrites, 0);
    assert.equal(inspectCommittedShipment(dbPath, second.numeroPedido), "ALREADY_IMPORTED");
    assert.equal(state.status().imported, 2);
    const cancelledSecond = { ...second, descricaoStatus: "Cancelado" };
    listed = [third, cancelledSecond, first, baseline];
    const under = await service().runCycle({ writeReports: false });
    assert.equal(under.databaseWrites, 1);
    assert.equal(under.planned.find((row) => row.idFotoPedido === "new-id-3").category,
      "CANDIDATE_UNDER_TOTAL");
    assert.equal(under.outcomes.length, 1);
    assert.equal(inspectCommittedShipment(dbPath, second.numeroPedido), "ALREADY_IMPORTED");
    listed = [fourth, third, cancelledSecond, first, baseline];
    const recordOutcome = state.recordOutcome.bind(state);
    state.recordOutcome = () => { throw Error("password=synthetic-only"); };
    await assert.rejects(service().runCycle({ writeReports: false }), /DIGITAL_SYNC_FAILED/);
    state.recordOutcome = recordOutcome;
    assert.equal(state.status().lastRunStatus, "PARTIAL");
    assert.equal(state.status().lastError, "DIGITAL_SYNC_FAILED");
    assert.equal(inspectCommittedShipment(dbPath, fourth.numeroPedido), "ALREADY_IMPORTED");
    const recovered = await service().runCycle({ writeReports: false });
    assert.equal(recovered.databaseWrites, 0);
    assert.equal(state.status().imported, 4);
    database.initializeDataDirectory(root);
    const domainShipment = database.listDigitalShipments({ search: fourth.numeroPedido }).rows[0];
    assert.equal(domainShipment.registrado_por, "DigitalSyncService");
    assert.equal(database.getDigitalShipment(domainShipment.id).events[0].usuario_nome, "DigitalSyncService");
    database.close();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      assert.equal(db.prepare("SELECT COUNT(*) n FROM digital_envios").get().n, 4);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM digital_envio_itens").get().n, 4);
      assert.equal(db.prepare("SELECT COUNT(*) n FROM digital_envio_eventos WHERE acao='digital_sync_created' AND usuario_id IS NULL").get().n, 4);
      assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
      assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
    } finally { db.close(); }
    const recovery = await rehearse(root);
    assert.equal(recovery.ok, true);
    assert.equal(recovery.databases.operational.snapshot.shipments, 4);
    assert.equal(recovery.databases.auxiliary.snapshot.observations, 5);
  } finally { database.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test("dois ciclos não atravessam a trava entre processos", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "digital-cycle-lock-"));
  try {
    const state = new DigitalSyncState(root);
    const baseline = meta("baseline", "SYNTHETIC-LOCK");
    state.importBaseline({ schema: 1, createdAt: observedAt, orders: [baseline], pendingIds: [] });
    let release;
    const barrier = new Promise((resolve) => { release = resolve; });
    const service = new DigitalSyncService({ dbPath: path.join(root, "unused.sqlite3"),
      dataDir: root, outputDir: path.join(root, "reports"), stateStore: state,
      options: { enabled: true, writeEnabled: false, pageSize: 1, recentOrders: 1,
        maxScanPages: 1 },
      dbReader: () => ({ sessions: new Map(), revisions: new Map(),
        existing: new Map(), counts: { envios: 0, relacoes: 0 } }),
      clientFactory: () => ({ authenticated: true, version: "synthetic", close() {},
        listOrders: async () => { await barrier; return { orders: [baseline], totalRegistros: 1 }; },
        getOrderDetail: async () => { throw Error("unexpected detail"); } }) });
    const first = service.runCycle({ writeReports: false });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(service.runCycle({ writeReports: false }), /DIGITAL_SYNC_BUSY/);
    release();
    assert.equal((await first).databaseWrites, 0);
    assert.equal(state.inspect().observations, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
