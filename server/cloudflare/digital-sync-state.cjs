const { createHash } = require("node:crypto");
const { DigitalSyncState } = require("../integrations/digital/digital-sync-state.cjs");

const TABLES = Object.freeze({ meta: "_gl_digital_sync_meta", runs: "_gl_digital_sync_runs",
  observations: "_gl_digital_sync_observations", scan_window: "_gl_digital_sync_window" });
const COLUMNS = Object.freeze({
  meta: ["key", "value"],
  runs: ["run_id", "started_at", "completed_at", "status", "checkpoint", "error_code"],
  observations: ["id_foto_pedido", "numero_pedido", "data_pedido_millis", "itens", "status",
    "descricao_status", "first_seen_at", "last_seen_at", "last_run_id", "process_state", "classification", "pending_reason"],
  scan_window: ["position", "id_foto_pedido"],
});
const META_KEYS = ["schema", "baseline_run_id", "latest_run_id", "baseline_observed_at", "last_successful_sync"];
const translate = (query) => query.replace(/\b(meta|runs|observations|scan_window)\b/g, (name) => TABLES[name]);
const digest = (payload) => createHash("sha256").update(JSON.stringify(payload)).digest("hex");

class CloudDigitalState extends DigitalSyncState {
  constructor(connection, transaction) {
    const scoped = { prepare: (query) => connection.prepare(translate(query)),
      exec: (query) => connection.exec(translate(query)), close() {} };
    super(null, { connectionFactory: () => {
      if (scoped.prepare("SELECT value FROM meta WHERE key='cloud_migration_digest'").get() == null)
        throw new Error("DIGITAL_BASELINE_INVALID");
      return scoped;
    } });
    this.db = scoped;
    this.transaction = transaction;
    scoped.exec(`CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS runs(run_id TEXT PRIMARY KEY,started_at TEXT NOT NULL,completed_at TEXT,
        status TEXT NOT NULL,checkpoint INTEGER NOT NULL DEFAULT 0,error_code TEXT);
      CREATE TABLE IF NOT EXISTS observations(
        id_foto_pedido TEXT PRIMARY KEY,numero_pedido TEXT NOT NULL COLLATE NOCASE UNIQUE,
        data_pedido_millis INTEGER,itens INTEGER,status TEXT NOT NULL,descricao_status TEXT NOT NULL,
        first_seen_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,last_run_id TEXT NOT NULL REFERENCES runs(run_id),
        process_state TEXT NOT NULL,classification TEXT NOT NULL,pending_reason TEXT);
      CREATE TABLE IF NOT EXISTS scan_window(position INTEGER PRIMARY KEY,
        id_foto_pedido TEXT NOT NULL REFERENCES observations(id_foto_pedido));`);
  }

  get(key) { return this.db.prepare("SELECT value FROM meta WHERE key=?").get(key)?.value; }
  set(key, value) { this.db.prepare(`INSERT INTO meta(key,value) VALUES(?,?)
    ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value)); }

  migrate(payload) {
    if (payload?.schema !== 1 || !payload.tables) throw new Error("DIGITAL_BASELINE_INVALID");
    for (const [name, columns] of Object.entries(COLUMNS)) {
      const rows = payload.tables[name];
      if (!Array.isArray(rows) || !rows.length || rows.length > 100000
        || rows.some((row) => !row || Object.keys(row).length !== columns.length
          || columns.some((c) => !(c in row) || (row[c] !== null && !["string", "number"].includes(typeof row[c])))))
        throw new Error("DIGITAL_BASELINE_INVALID");
    }
    const meta = Object.fromEntries(payload.tables.meta.map((row) => [row.key, row.value]));
    if (payload.tables.meta.length !== META_KEYS.length || META_KEYS.some((key) => !(key in meta))
      || meta.schema !== "1" || !Number.isFinite(Date.parse(meta.baseline_observed_at))
      || !payload.tables.runs.some((row) => row.run_id === meta.baseline_run_id && row.status === "BASELINE_COMPLETE")
      || !payload.tables.runs.some((row) => row.run_id === meta.latest_run_id)
      || !payload.tables.observations.some((row) => row.first_seen_at === meta.baseline_observed_at))
      throw new Error("DIGITAL_BASELINE_INVALID");
    const hash = digest(payload);
    return this.transaction(() => {
      if (this.get("cloud_migration_digest")) {
        if (this.get("cloud_migration_digest") !== hash) throw new Error("DIGITAL_BASELINE_CONFLICT");
        return { alreadyApplied: true, counts: JSON.parse(this.get("cloud_migration_counts")) };
      }
      for (const name of Object.keys(COLUMNS)) {
        if (this.db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n)
          throw new Error("DIGITAL_BASELINE_CONFLICT");
      }
      const counts = {};
      for (const [name, columns] of Object.entries(COLUMNS)) {
        const insert = this.db.prepare(`INSERT INTO ${name}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`);
        for (const row of payload.tables[name]) insert.run(...columns.map((c) => row[c]));
        counts[name] = this.db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n;
        if (counts[name] !== payload.tables[name].length) throw new Error("DIGITAL_BASELINE_INVALID");
      }
      this.set("cloud_migration_digest", hash);
      this.set("cloud_migration_counts", JSON.stringify(counts));
      this.validate();
      return { alreadyApplied: false, counts };
    });
  }

  validate() {
    const snapshot = this.loadSnapshot();
    const missing = this.db.prepare(`SELECT COUNT(*) n FROM observations o
      WHERE NOT EXISTS(SELECT 1 FROM runs r WHERE r.run_id=o.last_run_id)`).get().n;
    const windowMissing = this.db.prepare(`SELECT COUNT(*) n FROM scan_window w
      WHERE NOT EXISTS(SELECT 1 FROM observations o WHERE o.id_foto_pedido=w.id_foto_pedido)`).get().n;
    if (!snapshot.baselineIds.length || missing || windowMissing) throw new Error("DIGITAL_BASELINE_INVALID");
    return { observations: snapshot.knownOrders.length, pending: snapshot.pendingIds.length,
      baseline: snapshot.baselineIds.length, window: snapshot.orders.length, foreignKeyViolations: 0 };
  }

  status() {
    const status = super.status();
    const last = JSON.parse(this.get("last_diagnostic") || "null");
    return { ...status, lastSuccessAt: status.lastSuccessfulAt, lastErrorCode: status.lastError,
      lastImportedCount: last?.imported ?? 0, sigiVersion: last?.sigiVersion ?? null, diagnostic: last };
  }
}

module.exports = { CloudDigitalState, TABLES, COLUMNS };
