const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { DatabaseSync, backup } = require("node:sqlite");

const STATE_NAME = "digital-sync-state.sqlite3";
const coded = (value) => new Error(value);
const stateFile = (dataDir) => path.join(dataDir, "digital-sync", STATE_NAME);
const markerFile = (dataDir) => path.join(dataDir, "digital-sync.initialized");

function validateBaseline(snapshot) {
  if (snapshot?.schema !== 1 || !Array.isArray(snapshot.orders) || !snapshot.orders.length
    || !Array.isArray(snapshot.pendingIds) || !Number.isFinite(Date.parse(snapshot.createdAt)))
    throw coded("DIGITAL_BASELINE_INVALID");
  const ids = new Set(), numbers = new Set();
  for (const row of snapshot.orders) {
    const id = String(row?.idFotoPedido ?? "");
    const number = String(row?.numeroPedido ?? "").trim();
    if (!id || !number || ids.has(id) || numbers.has(number.toLowerCase())
      || (row.dataPedidoMiliegundos !== null && !Number.isSafeInteger(row.dataPedidoMiliegundos))
      || typeof row.descricaoStatus !== "string") throw coded("DIGITAL_BASELINE_INVALID");
    ids.add(id); numbers.add(number.toLowerCase());
  }
  if (snapshot.pendingIds.some((id) => !ids.has(String(id)))) throw coded("DIGITAL_BASELINE_INVALID");
  return snapshot;
}

function openVerified(file, readOnly = true) {
  if (!fs.existsSync(file)) throw coded("DIGITAL_STATE_MISSING");
  let db;
  try {
    db = new DatabaseSync(file, { readOnly });
    db.exec("PRAGMA foreign_keys=ON");
    if (readOnly) db.exec("PRAGMA query_only=ON");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
      .map((row) => row.name));
    if (!["meta", "runs", "observations", "scan_window"].every((name) => tables.has(name)))
      throw coded("DIGITAL_STATE_CORRUPT");
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
      || db.prepare("PRAGMA foreign_key_check").all().length
      || db.prepare("SELECT value FROM meta WHERE key='schema'").get()?.value !== "1"
      || db.prepare("SELECT value FROM meta WHERE key='baseline_run_id'").get()?.value == null)
      throw coded("DIGITAL_STATE_CORRUPT");
    return db;
  } catch {
    db?.close();
    throw coded("DIGITAL_STATE_CORRUPT");
  }
}

function createSchema(db) {
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
    CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE runs(run_id TEXT PRIMARY KEY,started_at TEXT NOT NULL,completed_at TEXT,
      status TEXT NOT NULL,checkpoint INTEGER NOT NULL DEFAULT 0,error_code TEXT);
    CREATE TABLE observations(
      id_foto_pedido TEXT PRIMARY KEY,numero_pedido TEXT NOT NULL COLLATE NOCASE UNIQUE,
      data_pedido_millis INTEGER,itens INTEGER,status TEXT NOT NULL,descricao_status TEXT NOT NULL,
      first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,last_run_id TEXT NOT NULL REFERENCES runs(run_id),
      process_state TEXT NOT NULL,classification TEXT NOT NULL,pending_reason TEXT);
    CREATE TABLE scan_window(position INTEGER PRIMARY KEY,id_foto_pedido TEXT NOT NULL
      REFERENCES observations(id_foto_pedido));`);
}

class DigitalSyncState {
  constructor(dataDir) {
    if (!path.isAbsolute(dataDir)) throw coded("DIGITAL_CONFIG_ERROR");
    this.dataDir = dataDir;
    this.file = stateFile(dataDir);
  }

  importBaseline(snapshot, reconciliation) {
    validateBaseline(snapshot);
    if (fs.existsSync(this.file)) {
      const existing = this.loadSnapshot();
      const same = existing.orders.length === snapshot.orders.length
        && existing.orders.every((row, index) => String(row.idFotoPedido) === String(snapshot.orders[index].idFotoPedido)
          && String(row.numeroPedido) === String(snapshot.orders[index].numeroPedido));
      if (!same) throw coded("DIGITAL_BASELINE_CONFLICT");
      if (!fs.existsSync(markerFile(this.dataDir)))
        fs.writeFileSync(markerFile(this.dataDir), "schema=1\n", { flag: "wx" });
      return { imported: false, count: existing.orders.length, firstObservedAt: existing.createdAt };
    }
    if (fs.existsSync(markerFile(this.dataDir))) throw coded("DIGITAL_STATE_MISSING");
    const lookup = new Map((reconciliation?.rows || []).map((row) => [String(row.idFotoPedido), row.exclusive]));
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const runId = randomUUID();
    let db;
    try {
      db = new DatabaseSync(temporary);
      createSchema(db);
      db.exec("BEGIN IMMEDIATE");
      try {
        db.prepare("INSERT INTO meta(key,value) VALUES('schema','1')").run();
        db.prepare("INSERT INTO meta(key,value) VALUES('baseline_run_id',?)").run(runId);
        db.prepare("INSERT INTO meta(key,value) VALUES('latest_run_id',?)").run(runId);
        db.prepare("INSERT INTO meta(key,value) VALUES('baseline_observed_at',?)").run(snapshot.createdAt);
        db.prepare("INSERT INTO meta(key,value) VALUES('last_successful_sync',?)").run(snapshot.createdAt);
        db.prepare("INSERT INTO runs(run_id,started_at,completed_at,status,checkpoint) VALUES(?,?,?,?,?)")
          .run(runId, snapshot.createdAt, snapshot.createdAt, "BASELINE_COMPLETE", snapshot.orders.length);
        const insert = db.prepare(`INSERT INTO observations(id_foto_pedido,numero_pedido,data_pedido_millis,itens,
          status,descricao_status,first_seen_at,last_seen_at,last_run_id,process_state,classification,pending_reason)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,NULL)`);
        const window = db.prepare("INSERT INTO scan_window(position,id_foto_pedido) VALUES(?,?)");
        for (let index = 0; index < snapshot.orders.length; index++) {
          const row = snapshot.orders[index];
          const classification = lookup.get(String(row.idFotoPedido)) || "BASELINE_OBSERVED";
          insert.run(String(row.idFotoPedido), String(row.numeroPedido), row.dataPedidoMiliegundos, row.itens ?? null,
            String(row.status), row.descricaoStatus, snapshot.createdAt, snapshot.createdAt,
            runId, "BASELINE", classification);
          window.run(index, String(row.idFotoPedido));
        }
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      db.close(); db = null;
      const verify = openVerified(temporary);
      try {
        if (verify.prepare("SELECT COUNT(*) n FROM observations").get().n !== snapshot.orders.length)
          throw coded("DIGITAL_STATE_CORRUPT");
      } finally { verify.close(); }
      fs.renameSync(temporary, this.file);
      fs.writeFileSync(markerFile(this.dataDir), "schema=1\n", { flag: "wx" });
      return { imported: true, count: snapshot.orders.length, firstObservedAt: snapshot.createdAt };
    } catch (error) {
      db?.close();
      if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true });
      throw error;
    }
  }

  loadSnapshot() {
    const db = openVerified(this.file);
    try {
      const rows = db.prepare(`SELECT o.* FROM scan_window w JOIN observations o
        ON o.id_foto_pedido=w.id_foto_pedido ORDER BY w.position`).all();
      if (!rows.length) throw coded("DIGITAL_STATE_CORRUPT");
      const createdAt = db.prepare("SELECT value FROM meta WHERE key='baseline_observed_at'").get()?.value;
      const baselineIds = db.prepare("SELECT id_foto_pedido FROM observations WHERE first_seen_at=?")
        .all(createdAt).map((row) => row.id_foto_pedido);
      const pendingIds = db.prepare("SELECT id_foto_pedido FROM observations WHERE process_state IN ('PENDING','READY','REVIEW')")
        .all().map((row) => row.id_foto_pedido);
      const toOrder = (row) => ({
        idFotoPedido: row.id_foto_pedido, numeroPedido: row.numero_pedido,
        dataPedidoMiliegundos: row.data_pedido_millis, status: row.status,
        descricaoStatus: row.descricao_status, itens: row.itens });
      return { schema: 1, createdAt, orders: rows.map(toOrder),
        knownOrders: db.prepare("SELECT * FROM observations").all().map(toOrder), baselineIds, pendingIds };
    } finally { db.close(); }
  }

  startRun() {
    const db = openVerified(this.file, false);
    try {
      const runId = randomUUID();
      db.prepare("INSERT INTO runs(run_id,started_at,status,checkpoint) VALUES(?,?,?,0)")
        .run(runId, new Date().toISOString(), "STARTED");
      return runId;
    } finally { db.close(); }
  }

  finishRun(runId, result) {
    const db = openVerified(this.file, false);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const run = db.prepare("SELECT status FROM runs WHERE run_id=?").get(runId);
        if (run?.status !== "STARTED" || result.scan.possibleGap) throw coded("DIGITAL_CHECKPOINT_BLOCKED");
        const timestamp = new Date().toISOString();
        const byNumber = new Map(result.planned.map((row) => [String(row.numeroPedido).toLowerCase(), row]));
        const upsert = db.prepare(`INSERT INTO observations(id_foto_pedido,numero_pedido,data_pedido_millis,itens,
          status,descricao_status,first_seen_at,last_seen_at,last_run_id,process_state,classification,pending_reason)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id_foto_pedido) DO UPDATE SET
          numero_pedido=excluded.numero_pedido,data_pedido_millis=excluded.data_pedido_millis,itens=excluded.itens,
          status=excluded.status,descricao_status=excluded.descricao_status,
          last_seen_at=excluded.last_seen_at,last_run_id=excluded.last_run_id,
          process_state=excluded.process_state,classification=excluded.classification,
          pending_reason=excluded.pending_reason`);
        db.exec("DELETE FROM scan_window");
        const window = db.prepare("INSERT INTO scan_window(position,id_foto_pedido) VALUES(?,?)");
        for (let index = 0; index < result.nextSnapshot.orders.length; index++) {
          const row = result.nextSnapshot.orders[index];
          const plan = byNumber.get(String(row.numeroPedido).toLowerCase());
          const prior = db.prepare("SELECT process_state,classification,pending_reason FROM observations WHERE id_foto_pedido=?")
            .get(String(row.idFotoPedido));
          const category = plan?.category || prior?.classification || "OBSERVED";
          const storedCategory = category === "EXISTING"
            && ["IMPORTED", "REVIEW"].includes(prior?.process_state)
            ? prior.classification : category;
          const state = category.startsWith("PENDING_") ? "PENDING" : category.startsWith("CANDIDATE") ? "READY"
              : category.startsWith("REVIEW_") ? "REVIEW" : category === "EXISTING"
                ? (["IMPORTED", "REVIEW"].includes(prior?.process_state) ? prior.process_state : "EXISTING")
              : category === "SKIP_CANCELLED" ? "CANCELLED" : prior?.process_state || "OBSERVED";
          upsert.run(String(row.idFotoPedido), String(row.numeroPedido), row.dataPedidoMiliegundos, row.itens ?? null,
            String(row.status), String(row.descricaoStatus), timestamp, timestamp, runId,
            state, storedCategory, storedCategory.startsWith("PENDING_") ? storedCategory : null);
          window.run(index, String(row.idFotoPedido));
        }
        const windowIds = new Set(result.nextSnapshot.orders.map((row) => String(row.idFotoPedido)));
        const updateOutsideWindow = db.prepare(`UPDATE observations SET process_state=?,classification=?,
          pending_reason=?,last_run_id=? WHERE id_foto_pedido=?`);
        for (const plan of result.planned) {
          const id = String(plan.idFotoPedido);
          if (windowIds.has(id)) continue;
          const category = plan.category;
          const state = category.startsWith("PENDING_") ? "PENDING"
            : category.startsWith("CANDIDATE") ? "READY"
              : category.startsWith("REVIEW_") ? "REVIEW"
                : category === "EXISTING" ? "EXISTING" : category === "SKIP_CANCELLED" ? "CANCELLED" : null;
          if (!state || updateOutsideWindow.run(state, category,
            state === "PENDING" ? category : null, runId, id).changes !== 1)
            throw coded("DIGITAL_CHECKPOINT_BLOCKED");
        }
        db.prepare("UPDATE runs SET status='COMPLETE',completed_at=?,checkpoint=? WHERE run_id=?")
          .run(timestamp, result.nextSnapshot.orders.length, runId);
        db.prepare("UPDATE meta SET value=? WHERE key='latest_run_id'").run(runId);
        db.prepare("UPDATE meta SET value=? WHERE key='last_successful_sync'").run(timestamp);
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  }

  failRun(runId, code) {
    const db = openVerified(this.file, false);
    try { db.prepare("UPDATE runs SET status='FAILED',completed_at=?,error_code=? WHERE run_id=? AND status='STARTED'")
      .run(new Date().toISOString(), /^DIGITAL_[A-Z_]+$/.test(code) ? code : "DIGITAL_SYNC_FAILED", runId); }
    finally { db.close(); }
  }

  markRunError(runId, code) {
    const db = openVerified(this.file, false);
    try { db.prepare(`UPDATE runs SET status='PARTIAL',error_code=?
      WHERE run_id=? AND status='COMPLETE'`).run(
      /^DIGITAL_[A-Z_]+$/.test(code) ? code : "DIGITAL_SYNC_FAILED", runId); }
    finally { db.close(); }
  }

  recordOutcome(idFotoPedido, outcome) {
    const classification = String(outcome);
    if (!["IMPORTED", "ALREADY_IMPORTED", "EXISTING_MANUAL", "REVIEW_IMPORTED_CHANGED",
      "REVIEW_CONCURRENT_CHANGE", "REVIEW_INVALID_PLAN", "REVIEW_OVER_TOTAL",
      "PENDING_MISSING_SESSION", "PENDING_NO_SESSION", "IMPORT_LIMIT_REACHED"].includes(classification))
      throw coded("DIGITAL_STATE_OUTCOME_INVALID");
    const state = ["IMPORTED", "ALREADY_IMPORTED"].includes(classification) ? "IMPORTED"
      : classification.startsWith("PENDING_") ? "PENDING"
        : classification === "IMPORT_LIMIT_REACHED" ? "READY" : "REVIEW";
    const db = openVerified(this.file, false);
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        const updated = db.prepare(`UPDATE observations SET process_state=?,classification=?,pending_reason=?
          WHERE id_foto_pedido=?`).run(state, classification,
          state === "PENDING" ? classification : null, String(idFotoPedido));
        if (updated.changes !== 1) throw coded("DIGITAL_STATE_ORDER_MISSING");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    } finally { db.close(); }
  }

  async classifyBaselineUnimported() {
    const db = openVerified(this.file, false);
    try {
      const baselineAt = db.prepare("SELECT value FROM meta WHERE key='baseline_observed_at'").get().value;
      const pending = db.prepare(`SELECT COUNT(*) n FROM observations WHERE first_seen_at=?
        AND classification='BASELINE_ABSENT_ACTIVE'`).get(baselineAt).n;
      if (!pending) return { changed: 0, backupPath: null };
      const backupDir = path.join(path.dirname(this.file), "backups");
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `before-baseline-classification-${Date.now()}-${randomUUID()}.sqlite3`);
      await backup(db, backupPath);
      const verified = openVerified(backupPath);
      verified.close();
      db.exec("BEGIN IMMEDIATE");
      try {
        const changed = db.prepare(`UPDATE observations SET classification='BASELINE_EXISTING_UNIMPORTED'
          WHERE first_seen_at=? AND classification='BASELINE_ABSENT_ACTIVE'`).run(baselineAt).changes;
        if (changed !== pending) throw coded("DIGITAL_STATE_CORRUPT");
        db.exec("COMMIT");
      } catch (error) { db.exec("ROLLBACK"); throw error; }
      return { changed: pending, backupPath };
    } finally { db.close(); }
  }

  inspect() {
    const db = openVerified(this.file);
    try { return {
      observations: db.prepare("SELECT COUNT(*) n FROM observations").get().n,
      window: db.prepare("SELECT COUNT(*) n FROM scan_window").get().n,
      baselineObservedAt: db.prepare("SELECT value FROM meta WHERE key='baseline_observed_at'").get().value,
      lastSuccessfulSync: db.prepare("SELECT value FROM meta WHERE key='last_successful_sync'").get().value,
      integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
      foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all().length
    }; } finally { db.close(); }
  }

  status() {
    const db = openVerified(this.file);
    try {
      const last = db.prepare(`SELECT started_at,completed_at,status,checkpoint,error_code
        FROM runs ORDER BY started_at DESC, rowid DESC LIMIT 1`).get();
      const lastSuccess = db.prepare(`SELECT completed_at FROM runs
        WHERE status IN ('BASELINE_COMPLETE','COMPLETE')
        ORDER BY started_at DESC,rowid DESC LIMIT 1`).get()?.completed_at;
      const counts = db.prepare(`SELECT COUNT(*) observed,
        SUM(CASE WHEN process_state='IMPORTED' THEN 1 ELSE 0 END) imported,
        SUM(CASE WHEN process_state IN ('PENDING','READY','REVIEW') THEN 1 ELSE 0 END) pending,
        SUM(CASE WHEN process_state='READY' THEN 1 ELSE 0 END) awaiting_import,
        SUM(CASE WHEN process_state='REVIEW' THEN 1 ELSE 0 END) in_review,
        SUM(CASE WHEN process_state='CANCELLED' THEN 1 ELSE 0 END) cancelled,
        SUM(CASE WHEN classification='BASELINE_EXISTING_UNIMPORTED' THEN 1 ELSE 0 END) baseline_unimported,
        SUM(CASE WHEN process_state IN ('BASELINE','CANCELLED','EXISTING') THEN 1 ELSE 0 END) ignored
        FROM observations`).get();
      const baselineAt = db.prepare("SELECT value FROM meta WHERE key='baseline_observed_at'").get().value;
      const newObserved = db.prepare("SELECT COUNT(*) n FROM observations WHERE first_seen_at<>?")
        .get(baselineAt).n;
      return { lastRunAt: last?.started_at ?? null, lastRunStatus: last?.status ?? null,
        lastSuccessfulAt: lastSuccess ?? null,
        durationMs: last?.completed_at ? Date.parse(last.completed_at) - Date.parse(last.started_at) : null,
        observed: counts.observed, newObserved, imported: counts.imported, ignored: counts.ignored,
        pending: counts.pending, awaitingImport: counts.awaiting_import, inReview: counts.in_review,
        cancelled: counts.cancelled, baselineExistingUnimported: counts.baseline_unimported,
        lastError: last?.error_code ?? null };
    } finally { db.close(); }
  }

  isBaselineOrder(idFotoPedido) {
    const db = openVerified(this.file);
    try {
      const baselineAt = db.prepare("SELECT value FROM meta WHERE key='baseline_observed_at'").get().value;
      const row = db.prepare("SELECT first_seen_at FROM observations WHERE id_foto_pedido=?")
        .get(String(idFotoPedido));
      if (!row) throw coded("DIGITAL_STATE_ORDER_MISSING");
      return row.first_seen_at === baselineAt;
    } finally { db.close(); }
  }
}

module.exports = { DigitalSyncState, stateFile, markerFile, validateBaseline };
