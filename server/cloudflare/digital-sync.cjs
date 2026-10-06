const { randomUUID } = require("node:crypto");
const { SigiClient } = require("../integrations/digital/sigi-client.cjs");
const { digitalOptions } = require("../integrations/digital/sigi-config.cjs");
const { buildDryRun, readDatabaseStateFromConnection } = require("../integrations/digital/digital-sync-planner.cjs");
const { executeAuthorizedConnection, inspectCommittedConnection } = require("../integrations/digital/digital-sync-executor.cjs");
const { CloudDigitalState } = require("./digital-sync-state.cjs");

const LEASE_MS = 10 * 60 * 1000;
const SAFE_ERRORS = new Set(["DIGITAL_CREDENTIAL_MISSING", "DIGITAL_CONFIG_ERROR", "DIGITAL_BOOTSTRAP_ERROR",
  "DIGITAL_LOGIN_INVALID", "DIGITAL_SESSION_ERROR", "DIGITAL_API_UNAVAILABLE", "DIGITAL_RATE_LIMIT",
  "DIGITAL_UNEXPECTED_RESPONSE", "DIGITAL_LOGIN_PROTOCOL_ERROR", "DIGITAL_BASELINE_INVALID",
  "DIGITAL_BASELINE_CONFLICT", "DIGITAL_LIST_SCHEMA_ERROR", "DIGITAL_LIST_DUPLICATE_OR_INVALID",
  "DIGITAL_LIST_INCONSISTENT", "DIGITAL_CHECKPOINT_BLOCKED", "DIGITAL_LEASE_EXPIRED", "DIGITAL_DB_SCHEMA_ERROR"]);
const safeError = (error) => SAFE_ERRORS.has(error?.code || error?.message) ? (error.code || error.message) : "DIGITAL_SYNC_FAILED";
function cloudCredentialProvider(env) {
  return async () => {
    if (typeof env.DIGITAL_SIGI_USERNAME !== "string" || !env.DIGITAL_SIGI_USERNAME
      || typeof env.DIGITAL_SIGI_PASSWORD !== "string" || !env.DIGITAL_SIGI_PASSWORD)
      throw new Error("DIGITAL_CREDENTIAL_MISSING");
    return { username: env.DIGITAL_SIGI_USERNAME, password: env.DIGITAL_SIGI_PASSWORD };
  };
}

class CloudDigitalSync {
  constructor(connection, storage, env, { clientFactory, now = Date.now } = {}) {
    this.db = connection;
    this.transaction = (fn) => storage.transactionSync(fn);
    this.state = new CloudDigitalState(connection, this.transaction);
    this.options = digitalOptions(env);
    // Production's one-import budget is a ceiling, even if a variable is misconfigured.
    this.options = { ...this.options, maxImportsPerCycle: Math.min(1, this.options.maxImportsPerCycle) };
    this.now = now;
    this.clientFactory = clientFactory || (() => new SigiClient({ credentialProvider: cloudCredentialProvider(env),
      delayMs: this.options.requestDelayMs }));
  }
  nextDueAt() { return new Date((Math.floor(this.now() / 1800000) + 1) * 1800000).toISOString(); }
  acquire() {
    return this.transaction(() => {
      this.state.validate();
      const lease = JSON.parse(this.state.get("lease") || "null");
      if (lease && lease.until > this.now()) return null;
      if (lease?.runId) this.state.failRun(lease.runId, "DIGITAL_LEASE_EXPIRED");
      const next = { token: randomUUID(), until: this.now() + Math.min(LEASE_MS, this.options.timeoutMs), runId: this.state.startRun() };
      this.state.set("lease", JSON.stringify(next));
      return next;
    });
  }
  assertLease(lease) {
    const stored = JSON.parse(this.state.get("lease") || "null");
    if (stored?.token !== lease.token || stored.until <= this.now()) throw new Error("DIGITAL_LEASE_EXPIRED");
  }
  release(lease) {
    if (JSON.parse(this.state.get("lease") || "null")?.token === lease.token) this.state.set("lease", "null");
  }
  async run({ dryRun = false } = {}) {
    if (!this.options.enabled) return { status: "DISABLED", imported: 0 };
    let lease;
    try { lease = this.acquire(); } catch (error) { return { status: "FAILED", errorCode: safeError(error), imported: 0 }; }
    if (!lease) return { status: "ALREADY_RUNNING", imported: 0 };
    const diagnostic = { runId: lease.runId, startedAt: new Date(this.now()).toISOString(), completedAt: null,
      status: "STARTED", sigiVersion: null, loginSucceeded: false, listed: 0, pages: 0, candidates: 0,
      pending: 0, review: 0, imported: 0, databaseWrites: 0, historicalCandidates: 0, errorCode: null };
    let client;
    try {
      const snapshot = this.state.loadSnapshot();
      this.transaction(() => {
        this.assertLease(lease);
        for (const id of snapshot.pendingIds) {
          const order = snapshot.knownOrders.find((row) => row.idFotoPedido === id);
          const outcome = order && inspectCommittedConnection(this.db, order.numeroPedido);
          if (outcome) this.state.recordOutcome(id, outcome);
        }
      });
      client = this.clientFactory();
      const guarded = {
        listOrders: async (...args) => { this.assertLease(lease); const value = await client.listOrders(...args); this.assertLease(lease); return value; },
        getOrderDetail: async (...args) => { this.assertLease(lease); const value = await client.getOrderDetail(...args); this.assertLease(lease); return value; },
      };
      const result = await buildDryRun({ client: guarded, snapshot: this.state.loadSnapshot(), options: this.options,
        dbState: readDatabaseStateFromConnection(this.db) });
      diagnostic.sigiVersion = /^[0-9]+(?:\.[0-9]+){3}$/.test(client.version || "") ? client.version : null;
      diagnostic.loginSucceeded = client.authenticated === true;
      diagnostic.listed = result.scan.listed;
      diagnostic.pages = result.scan.pages;
      const candidates = result.planned.filter((p) => ["CANDIDATE", "CANDIDATE_UNDER_TOTAL"].includes(p.category));
      diagnostic.candidates = candidates.length;
      diagnostic.pending = result.planned.filter((p) => p.category.startsWith("PENDING_")).length;
      diagnostic.review = result.planned.filter((p) => p.category.startsWith("REVIEW_")).length;
      diagnostic.historicalCandidates = candidates.filter((p) => snapshot.baselineIds.includes(String(p.idFotoPedido))).length;
      if (!result.complete) throw new Error("DIGITAL_CHECKPOINT_BLOCKED");
      if (diagnostic.historicalCandidates) throw new Error("DIGITAL_BASELINE_INVALID");
      this.transaction(() => { this.assertLease(lease); this.state.finishRun(lease.runId, result); });
      const budget = { limit: this.options.maxImportsPerCycle, imported: 0 };
      if (this.options.writeEnabled && !dryRun) {
        for (const plan of candidates) {
          const outcome = this.transaction(() => {
            this.assertLease(lease);
            const value = executeAuthorizedConnection(this.db, plan, { syncEnabled: true, writeEnabled: true,
              stateStore: this.state, cycleBudget: budget });
            this.state.recordOutcome(plan.idFotoPedido, value.outcome);
            return value;
          });
          if (outcome.outcome === "IMPORTED") diagnostic.imported++;
          if (budget.imported >= budget.limit) break;
        }
      }
      diagnostic.databaseWrites = diagnostic.imported;
      diagnostic.status = "COMPLETE";
    } catch (error) {
      diagnostic.status = diagnostic.imported ? "PARTIAL" : "FAILED";
      diagnostic.databaseWrites = diagnostic.imported;
      diagnostic.errorCode = safeError(error);
      this.transaction(() => {
        if (JSON.parse(this.state.get("lease") || "null")?.token !== lease.token) return;
        this.state.failRun(lease.runId, diagnostic.errorCode);
        this.state.markRunError(lease.runId, diagnostic.errorCode);
      });
    } finally {
      client?.close();
      diagnostic.completedAt = new Date(this.now()).toISOString();
      this.transaction(() => {
        if (JSON.parse(this.state.get("lease") || "null")?.token !== lease.token) return;
        this.state.set("last_diagnostic", JSON.stringify(diagnostic));
        this.state.set(`diagnostic:${lease.runId}`, JSON.stringify(diagnostic));
        this.release(lease);
      });
    }
    return diagnostic;
  }
  inspect() {
    const count = (name) => this.db.prepare(`SELECT COUNT(*) n FROM ${name}`).get().n;
    const duplicates = this.db.prepare(`SELECT COUNT(*) n FROM (SELECT lower(trim(numero_pedido_digital))
      FROM digital_envios GROUP BY lower(trim(numero_pedido_digital)) HAVING COUNT(*)>1)`).get().n;
    const orphans = this.db.prepare(`SELECT COUNT(*) n FROM digital_envio_itens i
      WHERE NOT EXISTS(SELECT 1 FROM digital_envios e WHERE e.id=i.digital_envio_id)
      OR NOT EXISTS(SELECT 1 FROM pedidos p WHERE p.id=i.pedido_id)`).get().n;
    const eventOrphans = this.db.prepare(`SELECT COUNT(*) n FROM digital_envio_eventos v
      WHERE NOT EXISTS(SELECT 1 FROM digital_envios e WHERE e.id=v.digital_envio_id)`).get().n;
    return { enabled: this.options.enabled, writeEnabled: this.options.writeEnabled,
      maxImportsPerCycle: this.options.maxImportsPerCycle, nextRunAt: this.nextDueAt(),
      state: this.state.status(), validation: this.state.validate(),
      database: { shipments: count("digital_envios"), items: count("digital_envio_itens"),
        events: count("digital_envio_eventos"), duplicates, foreignKeyViolations: orphans + eventOrphans } };
  }
}
module.exports = { CloudDigitalSync, cloudCredentialProvider, safeError };
