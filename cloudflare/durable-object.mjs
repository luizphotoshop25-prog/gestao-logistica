import crypto from "node:crypto";
import database from "../electron/database.cjs";
import { createApiRequestHandler } from "../server/api-server.cjs";
import { createSqliteSyncAdapter } from "../server/cloudflare/sqlite-sync-adapter.cjs";
import { CloudDigitalSync, safeError } from "../server/cloudflare/digital-sync.cjs";

const MAX_BODY_BYTES = 1024 * 1024;
const IMPORT_PREFIX = "/__internal/import/";
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const json = (value, status = 200, headers = {}) => new Response(JSON.stringify(value), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
});

function constantTimeEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length > 0 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createLoginRateStore(sql) {
  const digest = (value) => crypto.createHash("sha256").update(String(value)).digest("hex");
  return {
    status(key, time = Date.now()) {
      const hash = digest(key);
      const row = sql.exec("SELECT window_started,failures,blocked_until FROM _gl_login_rate_limits WHERE ip_hash=?", hash).toArray()[0];
      if (!row) return { allowed: true };
      if (row.blocked_until > time) return { allowed: false, retryAfter: Math.ceil((row.blocked_until - time) / 1000) };
      if (row.window_started + 15 * 60 * 1000 <= time) {
        sql.exec("DELETE FROM _gl_login_rate_limits WHERE ip_hash=?", hash);
        return { allowed: true };
      }
      return { allowed: true };
    },
    recordFailure(key, time = Date.now()) {
      const hash = digest(key);
      sql.exec("DELETE FROM _gl_login_rate_limits WHERE blocked_until<=? AND window_started+900000<=?", time, time);
      const row = sql.exec("SELECT window_started,failures,blocked_until FROM _gl_login_rate_limits WHERE ip_hash=?", hash).toArray()[0];
      const entry = !row || row.window_started + 15 * 60 * 1000 <= time
        ? { windowStarted: time, failures: 0, blockedUntil: 0 }
        : { windowStarted: row.window_started, failures: row.failures, blockedUntil: row.blocked_until };
      entry.failures += 1;
      if (entry.failures >= 10) entry.blockedUntil = time + 15 * 60 * 1000;
      sql.exec(`INSERT INTO _gl_login_rate_limits(ip_hash,window_started,failures,blocked_until) VALUES(?,?,?,?)
        ON CONFLICT(ip_hash) DO UPDATE SET window_started=excluded.window_started,
          failures=excluded.failures,blocked_until=excluded.blocked_until`, hash,
      entry.windowStarted, entry.failures, entry.blockedUntil);
      return entry.blockedUntil > time ? Math.ceil((entry.blockedUntil - time) / 1000) : 0;
    },
    clear(key) { sql.exec("DELETE FROM _gl_login_rate_limits WHERE ip_hash=?", digest(key)); },
  };
}

function responseSink() {
  const headers = new Headers();
  return {
    statusCode: 200,
    result: null,
    setHeader(name, value) { headers.set(name, String(value)); },
    end(body = "") { this.result = new Response(body || null, { status: this.statusCode, headers }); },
  };
}

function cloudRequest(request, body) {
  const headers = Object.create(null);
  request.headers.forEach((value, name) => { headers[name.toLowerCase()] = value; });
  return {
    method: request.method,
    url: request.url,
    headers,
    socket: { remoteAddress: headers["cf-connecting-ip"] || "unknown" },
    jsonBody: body,
  };
}

export class ApiDatabase {
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.sql = ctx.storage.sql;
    this.connection = createSqliteSyncAdapter(this.sql);
    this.sql.exec("PRAGMA foreign_keys=ON");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS _gl_cloud_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS _gl_import_batches(batch_id TEXT PRIMARY KEY,table_name TEXT NOT NULL,row_count INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS _gl_login_rate_limits(ip_hash TEXT PRIMARY KEY,window_started INTEGER NOT NULL,
        failures INTEGER NOT NULL,blocked_until INTEGER NOT NULL)`);
    this.digitalSync = new CloudDigitalSync(this.connection, ctx.storage, env);
    this.handler = createApiRequestHandler({
      allowedOrigin: ["null", "file://"],
      digitalSyncConfig: this.digitalSync.options,
      syncState: this.digitalSync.state,
      syncScheduler: this.digitalSync,
      loginRateStore: createLoginRateStore(this.sql),
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/__internal/digital-sync/")) return this.handleDigitalSync(request, url.pathname);
    if (url.pathname.startsWith(IMPORT_PREFIX)) return this.handleImport(request, url.pathname.slice(IMPORT_PREFIX.length));
    if (request.method === "GET" && url.pathname === "/health") return this.health();
    if (!this.isReady()) return json({ ok: false, database: "not-ready" }, 503);

    let body = {};
    if (["POST", "PATCH"].includes(request.method)) {
      try {
        const text = await request.text();
        if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) return json({ error: "PAYLOAD_TOO_LARGE", message: "Corpo excede 1 MB." }, 413);
        body = text ? JSON.parse(text) : {};
      } catch {
        return json({ error: "INVALID_JSON", message: "JSON inválido." }, 400);
      }
    }

    const nodeRequest = cloudRequest(request, body);
    const sink = responseSink();
    try {
      return this.ctx.storage.transactionSync(() => database.withDatabaseConnection(this.connection, () => {
        this.handler.dispatchParsed(nodeRequest, sink);
        return sink.result || json({ error: "INTERNAL_ERROR", message: "Erro interno." }, 500);
      }));
    } catch {
      return json({ error: "INTERNAL_ERROR", message: "Erro interno." }, 500,
        request.headers.has("origin") ? { "access-control-allow-origin": request.headers.get("origin") } : {});
    }
  }

  isReady() {
    return this.sql.exec("SELECT value FROM _gl_cloud_meta WHERE key='migration_complete'").toArray()[0]?.value === "1";
  }

  async handleDigitalSync(request, pathname) {
    if (!constantTimeEqual(request.headers.get("authorization")?.replace(/^Bearer\s+/i, ""),
      String(this.env.DIGITAL_SYNC_INTERNAL_TOKEN || "").trim())) return json({ error: "NOT_FOUND" }, 404);
    if (!this.isReady()) return json({ error: "DATABASE_NOT_READY" }, 503);
    try {
      if (request.method === "GET" && pathname === "/__internal/digital-sync/status") return json(this.digitalSync.inspect());
      if (request.method !== "POST") return json({ error: "NOT_FOUND" }, 404);
      const text = await request.text();
      if (Buffer.byteLength(text) > MAX_BODY_BYTES) return json({ error: "PAYLOAD_TOO_LARGE" }, 413);
      const body = text ? JSON.parse(text) : {};
      if (pathname === "/__internal/digital-sync/migrate") {
        if (this.digitalSync.options.writeEnabled) return json({ error: "DIGITAL_WRITE_ENABLED" }, 409);
        return json(this.digitalSync.state.migrate(body));
      }
      if (pathname === "/__internal/digital-sync/run") return json(await this.digitalSync.run({ dryRun: body.dryRun === true }));
      return json({ error: "NOT_FOUND" }, 404);
    } catch (error) { return json({ error: safeError(error) }, 409); }
  }

  health() {
    if (!this.isReady()) return json({ ok: false, database: "not-ready" }, 503);
    try {
      const exists = this.sql.exec("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='pedidos'").toArray()[0]?.ok === 1;
      return exists ? json({ ok: true, database: "available" }) : json({ ok: false, database: "not-ready" }, 503);
    } catch { return json({ ok: false, database: "unavailable" }, 503); }
  }

  authorized(request) {
    return constantTimeEqual(request.headers.get("authorization")?.replace(/^Bearer\s+/i, ""), String(this.env.MIGRATION_TOKEN || "").trim());
  }

  async readImportJson(request) {
    if (!this.authorized(request)) return { response: json({ error: "NOT_FOUND" }, 404) };
    try {
      const text = await request.text();
      if (Buffer.byteLength(text, "utf8") > 5 * 1024 * 1024) return { response: json({ error: "PAYLOAD_TOO_LARGE" }, 413) };
      return { value: JSON.parse(text) };
    } catch { return { response: json({ error: "INVALID_JSON" }, 400) }; }
  }

  async handleImport(request, action) {
    if (!this.authorized(request)) return json({ error: "NOT_FOUND" }, 404);
    if (request.method === "GET" && action === "status") return this.importStatus();
    if (request.method !== "POST") return json({ error: "NOT_FOUND" }, 404);
    const input = await this.readImportJson(request);
    if (input.response) return input.response;
    try {
      if (action === "schema") return this.importSchema(input.value);
      if (action === "batch") return this.importBatch(input.value);
      if (action === "finalize") return this.finalizeImport(input.value);
      return json({ error: "NOT_FOUND" }, 404);
    } catch { return json({ error: "IMPORT_FAILED" }, 400); }
  }

  importSchema(manifest) {
    if (this.isReady() || this.sql.exec("SELECT name FROM sqlite_master WHERE type='table' AND name='pedidos'").toArray().length)
      return json({ error: "IMPORT_ALREADY_STARTED" }, 409);
    if (!manifest || manifest.schema !== 1 || !Array.isArray(manifest.tables) || !manifest.tables.length
      || !Array.isArray(manifest.indexes) || !Array.isArray(manifest.foreignKeys)) return json({ error: "INVALID_MANIFEST" }, 400);
    const names = new Set();
    for (const table of manifest.tables) {
      if (!IDENTIFIER.test(table?.name || "") || typeof table.sql !== "string"
        || !/^CREATE TABLE\b/i.test(table.sql.trim()) || table.name.startsWith("_gl_"))
        return json({ error: "INVALID_SCHEMA" }, 400);
      names.add(table.name);
    }
    for (const index of manifest.indexes) {
      if (typeof index !== "string" || !/^CREATE (?:UNIQUE )?INDEX\b/i.test(index.trim())) return json({ error: "INVALID_SCHEMA" }, 400);
    }
    for (const relation of manifest.foreignKeys) {
      if (!names.has(relation?.table) || !names.has(relation?.refTable)
        || !Array.isArray(relation.columns) || !relation.columns.length
        || relation.columns.length !== relation.refColumns?.length
        || [...relation.columns, ...relation.refColumns].some((column) => !IDENTIFIER.test(column || "")))
        return json({ error: "INVALID_SCHEMA" }, 400);
    }
    return this.ctx.storage.transactionSync(() => {
      for (const table of manifest.tables) this.sql.exec(table.sql);
      for (const index of manifest.indexes) this.sql.exec(index);
      this.sql.exec("INSERT INTO _gl_cloud_meta(key,value) VALUES('import_manifest',?)", JSON.stringify(manifest));
      return json({ ok: true, tables: names.size });
    });
  }

  importBatch(batch) {
    const manifest = JSON.parse(this.sql.exec("SELECT value FROM _gl_cloud_meta WHERE key='import_manifest'").toArray()[0]?.value || "null");
    const table = manifest?.tables.find((item) => item.name === batch?.table);
    if (!table || typeof batch.batchId !== "string" || !/^[a-f0-9]{64}$/.test(batch.batchId)
      || !Array.isArray(batch.rows) || !batch.rows.length || batch.rows.length > 500)
      return json({ error: "INVALID_BATCH" }, 400);
    const prior = this.sql.exec("SELECT row_count FROM _gl_import_batches WHERE batch_id=?", batch.batchId).toArray()[0];
    if (prior) return json({ ok: true, alreadyApplied: true, rows: prior.row_count });
    const info = this.sql.exec(`PRAGMA table_info("${table.name}")`).toArray();
    const allowed = new Set(info.map((column) => column.name));
    const columns = Object.keys(batch.rows[0]);
    if (!columns.length || columns.some((column) => !allowed.has(column))
      || batch.rows.some((row) => !row || Array.isArray(row) || Object.keys(row).length !== columns.length
        || columns.some((column) => !(column in row)))) return json({ error: "INVALID_BATCH" }, 400);
    const quoted = columns.map((column) => `"${column}"`).join(",");
    const placeholders = columns.map(() => "?").join(",");
    return this.ctx.storage.transactionSync(() => {
      const duplicate = this.sql.exec("SELECT 1 AS found FROM _gl_import_batches WHERE batch_id=?", batch.batchId).toArray()[0];
      if (duplicate) return json({ ok: true, alreadyApplied: true });
      for (const row of batch.rows) this.sql.exec(`INSERT INTO "${table.name}"(${quoted}) VALUES(${placeholders})`,
        ...columns.map((column) => row[column] && typeof row[column] === "object"
          && Object.keys(row[column]).length === 1 && typeof row[column].__cloudflareBlob === "string"
          ? Uint8Array.from(Buffer.from(row[column].__cloudflareBlob, "base64")) : row[column]));
      this.sql.exec("INSERT INTO _gl_import_batches(batch_id,table_name,row_count) VALUES(?,?,?)", batch.batchId, batch.table, batch.rows.length);
      return json({ ok: true, rows: batch.rows.length });
    });
  }

  importStatus() {
    const manifestText = this.sql.exec("SELECT value FROM _gl_cloud_meta WHERE key='import_manifest'").toArray()[0]?.value;
    const manifest = manifestText ? JSON.parse(manifestText) : null;
    const batches = this.sql.exec("SELECT table_name,COUNT(*) batches,SUM(row_count) rows FROM _gl_import_batches GROUP BY table_name").toArray();
    return json({ ready: this.isReady(), manifest: manifest ? manifest.tables.map(({ name, rowCount, batches }) => ({ name, rowCount, batches })) : null, batches });
  }

  finalizeImport(input) {
    if (this.isReady()) return json({ error: "IMPORT_ALREADY_FINALIZED" }, 409);
    const manifestText = this.sql.exec("SELECT value FROM _gl_cloud_meta WHERE key='import_manifest'").toArray()[0]?.value;
    const manifest = manifestText ? JSON.parse(manifestText) : null;
    if (!manifest || !Array.isArray(manifest.tables)) return json({ error: "IMPORT_NOT_STARTED" }, 409);
    const counts = {};
    for (const table of manifest.tables) {
      const actual = Number(this.sql.exec(`SELECT COUNT(*) AS count FROM "${table.name}"`).toArray()[0]?.count || 0);
      counts[table.name] = actual;
      if (actual !== table.rowCount) return json({ error: "ROW_COUNT_MISMATCH", table: table.name, expected: table.rowCount, actual }, 409);
    }
    let foreignKeyViolations = 0;
    for (const relation of manifest.foreignKeys) {
      const complete = relation.columns.map((column) => `child."${column}" IS NOT NULL`).join(" AND ");
      const joined = relation.columns.map((column, index) =>
        `parent."${relation.refColumns[index]}"=child."${column}"`).join(" AND ");
      const result = this.sql.exec(`SELECT COUNT(*) AS count FROM "${relation.table}" AS child
        WHERE ${complete} AND NOT EXISTS(SELECT 1 FROM "${relation.refTable}" AS parent WHERE ${joined})`).toArray()[0];
      foreignKeyViolations += Number(result?.count || 0);
    }
    if (foreignKeyViolations) return json({ error: "DATABASE_INTEGRITY_FAILED", foreignKeyViolations }, 409);
    if (input?.manifestSha256 !== manifest.manifestSha256) return json({ error: "MANIFEST_MISMATCH" }, 409);
    this.sql.exec("INSERT INTO _gl_cloud_meta(key,value) VALUES('migration_complete','1')");
    return json({ ok: true, integrity: "row-counts-and-foreign-keys-validated", foreignKeyViolations, counts });
  }
}
