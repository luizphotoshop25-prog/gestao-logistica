const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { digitalOptions } = require("./sigi-config.cjs");
const { SigiClient } = require("./sigi-client.cjs");
const { credentialPath, loadCredential } = require("./credential-store.cjs");
const { buildDryRun, readDatabaseState } = require("./digital-sync-planner.cjs");
const { DigitalSyncState } = require("./digital-sync-state.cjs");

const running = new Set();
const ALLOWED_ERRORS = new Set([
  "DIGITAL_CREDENTIAL_MISSING", "DIGITAL_CREDENTIAL_STORE_ERROR", "DIGITAL_CREDENTIAL_PLATFORM_UNSUPPORTED",
  "DIGITAL_CONFIG_ERROR", "DIGITAL_BOOTSTRAP_ERROR", "DIGITAL_LOGIN_INVALID",
  "DIGITAL_LOGIN_PROTOCOL_ERROR", "DIGITAL_SESSION_ERROR", "DIGITAL_API_UNAVAILABLE",
  "DIGITAL_RATE_LIMIT", "DIGITAL_UNEXPECTED_RESPONSE", "DIGITAL_LIST_SCHEMA_ERROR",
  "DIGITAL_LIST_DUPLICATE_OR_INVALID", "DIGITAL_LIST_INCONSISTENT", "DIGITAL_DB_SCHEMA_ERROR",
  "DIGITAL_SYNC_BUSY", "DIGITAL_SNAPSHOT_INVALID", "DIGITAL_STATE_MISSING",
  "DIGITAL_STATE_CORRUPT", "DIGITAL_CHECKPOINT_BLOCKED"
]);
const safeError = (error) => ALLOWED_ERRORS.has(error?.code || error?.message)
  ? error.code || error.message : "DIGITAL_SYNC_FAILED";

function acquireRunLock(outputDir) {
  fs.mkdirSync(outputDir, { recursive: true });
  const file = path.join(outputDir, "digital-sync.lock");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try { fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, token })); }
      catch (error) { fs.closeSync(fd); fs.rmSync(file, { force: true }); throw error; }
      fs.closeSync(fd);
      return () => {
        try {
          if (JSON.parse(fs.readFileSync(file, "utf8")).token === token) fs.rmSync(file);
        } catch { /* A replaced lock belongs to another run. */ }
      };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = JSON.parse(fs.readFileSync(file, "utf8")); }
      catch { throw new Error("DIGITAL_SYNC_BUSY"); }
      const pid = owner.pid;
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("DIGITAL_SYNC_BUSY");
      try { process.kill(pid, 0); throw new Error("DIGITAL_SYNC_BUSY"); }
      catch (probe) {
        if (probe.code !== "ESRCH") throw new Error("DIGITAL_SYNC_BUSY");
      }
      try {
        if (JSON.parse(fs.readFileSync(file, "utf8")).token !== owner.token)
          throw new Error("DIGITAL_SYNC_BUSY");
        fs.rmSync(file);
      } catch { throw new Error("DIGITAL_SYNC_BUSY"); }
    }
  }
  throw new Error("DIGITAL_SYNC_BUSY");
}

function loadSnapshot(file) {
  if (!fs.existsSync(file)) return null;
  let snapshot;
  try { snapshot = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("DIGITAL_SNAPSHOT_INVALID"); }
  if (snapshot?.schema !== 1 || !Array.isArray(snapshot.orders) || !Array.isArray(snapshot.pendingIds))
    throw new Error("DIGITAL_SNAPSHOT_INVALID");
  return snapshot;
}

function writeJson(file, payload) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, { flag: "wx" });
    fs.renameSync(tmp, file);
  } finally { if (fs.existsSync(tmp)) fs.rmSync(tmp, { force: true }); }
}

function writeDryRunReports(outputDir, result) {
  fs.mkdirSync(outputDir, { recursive: true });
  const { nextSnapshot, ...report } = result;
  writeJson(path.join(outputDir, "dry-run.json"), report);
  writeJson(path.join(outputDir, "sync-diagnostics.json"), {
    mode: result.mode, possibleGap: result.scan.possibleGap,
    pages: result.scan.pages, databaseWrites: 0, loginSucceeded: result.loginSucceeded,
    sigiVersion: result.sigiVersion, durationMs: result.durationMs, apiErrors: 0,
    classifications: Object.fromEntries([...new Set(result.planned.map((p) => p.category))]
      .map((category) => [category, result.planned.filter((p) => p.category === category).length]))
  });
  fs.writeFileSync(path.join(outputDir, "dry-run.txt"), [
    `Modo: ${result.mode}`, `Login realizado: ${result.loginSucceeded ? "sim" : "não"}`,
    `Versão SIGI: ${result.sigiVersion || "desconhecida"}`,
    `Pedidos listados: ${result.scan.listed}`,
    `Páginas: ${result.scan.pages}`, `Possível lacuna: ${result.scan.possibleGap ? "sim" : "não"}`,
    `Já existentes: ${result.summary.existing}`, `Presentes no baseline: ${result.summary.baselineObserved}`,
    `Novos observados: ${result.summary.newObserved}`, `Cancelados: ${result.summary.cancelled}`,
    `Pendências: ${result.summary.pending}`, `Sessões ausentes: ${result.summary.missingSessions}`,
    `Divergências de quantidade: ${result.summary.quantityDivergences}`,
    `Planejados: ${result.planned.length}`, `Erros API: 0`,
    `Tempo: ${result.durationMs} ms`, `Alterações no banco: 0`
  ].join("\n") + "\n");
  if (!result.scan.possibleGap) writeJson(path.join(outputDir,
    result.mode === "baseline" ? "baseline-preview.json" : "latest-snapshot-preview.json"), nextSnapshot);
}

class DigitalSyncService {
  constructor({ dbPath, dataDir, outputDir = path.resolve("work/digital-sync"),
    options = digitalOptions(), clientFactory, dbReader = readDatabaseState,
    stateStore = null } = {}) {
    if (!path.isAbsolute(dbPath || "") || !path.isAbsolute(dataDir || "")) throw new Error("DIGITAL_CONFIG_ERROR");
    this.dbPath = dbPath;
    this.dataDir = dataDir;
    this.outputDir = outputDir;
    this.options = options;
    this.dbReader = dbReader;
    this.stateStore = stateStore || new DigitalSyncState(dataDir);
    this.injectedClient = typeof clientFactory === "function";
    this.clientFactory = clientFactory || (() => new SigiClient({
      credentialProvider: () => loadCredential(dataDir), delayMs: options.requestDelayMs
    }));
  }

  async runDryRun({ snapshot = undefined, writeReports = true } = {}) {
    const started = Date.now();
    const key = path.resolve(this.dbPath).toLowerCase();
    if (running.has(key)) throw new Error("DIGITAL_SYNC_BUSY");
    running.add(key);
    let client;
    let releaseLock;
    let runId;
    let runFinished = false;
    try {
      if (writeReports) releaseLock = acquireRunLock(this.outputDir);
      const previous = snapshot === undefined ? this.stateStore.loadSnapshot() : snapshot;
      if (!this.injectedClient && !fs.existsSync(credentialPath(this.dataDir)))
        throw new Error("DIGITAL_CREDENTIAL_MISSING");
      client = this.clientFactory();
      const dbState = this.dbReader(this.dbPath);
      if (snapshot === undefined) runId = this.stateStore.startRun();
      const result = await buildDryRun({ client, snapshot: previous, options: this.options, dbState });
      if (runId) {
        if (result.complete) this.stateStore.finishRun(runId, result);
        else this.stateStore.failRun(runId, "DIGITAL_CHECKPOINT_BLOCKED");
        runFinished = true;
      }
      result.loginSucceeded = client.authenticated === true;
      result.sigiVersion = typeof client.version === "string" ? client.version : null;
      result.durationMs = Date.now() - started;
      result.apiErrors = 0;
      result.summary = {
        existing: result.planned.filter((p) => p.category === "EXISTING" || p.category === "BASELINE_EXISTING").length,
        baselineObserved: result.scan.observedInBaseline,
        newObserved: result.scan.newObserved,
        cancelled: result.planned.filter((p) => p.category === "SKIP_CANCELLED").length,
        pending: result.planned.filter((p) => p.category.startsWith("PENDING_")).length,
        missingSessions: result.planned.reduce((count, p) => count + (p.missingSessions?.length || 0), 0),
        quantityDivergences: result.planned.filter((p) => /QUANTITY|OVER_TOTAL|ITEM_PHOTO/.test(p.category)).length
      };
      if (writeReports) writeDryRunReports(this.outputDir, result);
      return result;
    } catch (error) {
      if (runId && !runFinished) {
        try { this.stateStore.failRun(runId, safeError(error)); } catch { /* Preserve original failure. */ }
      }
      throw new Error(safeError(error));
    }
    finally { client?.close?.(); releaseLock?.(); running.delete(key); }
  }
}

module.exports = { DigitalSyncService, loadSnapshot, safeError, writeDryRunReports };
