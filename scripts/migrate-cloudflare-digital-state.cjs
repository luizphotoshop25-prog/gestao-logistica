const { DatabaseSync } = require("node:sqlite");
const { COLUMNS } = require("../server/cloudflare/digital-sync-state.cjs");

function readDigitalState(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok"
      || db.prepare("PRAGMA foreign_key_check").all().length) throw new Error("DIGITAL_BASELINE_INVALID");
    const tables = Object.fromEntries(Object.entries(COLUMNS).map(([table, columns]) => [table,
      db.prepare(`SELECT ${columns.join(",")} FROM ${table} ORDER BY ${columns[0]}`).all()]));
    if (tables.runs.some((row) => row.error_code != null && !/^DIGITAL_[A-Z_]+$/.test(row.error_code)))
      throw new Error("DIGITAL_UNSAFE_LEGACY_ERROR");
    return { schema: 1, tables };
  } finally { db.close(); }
}

async function migrate(file, origin, token) {
  const url = new URL(origin);
  if (url.origin !== "https://gestao-logistica-api.luizphotoshop25.workers.dev"
    || typeof token !== "string" || !token) throw new Error("DIGITAL_CONFIG_ERROR");
  const payload = readDigitalState(file);
  const response = await fetch(new URL("/__internal/digital-sync/migrate", url), {
    method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(payload), redirect: "error", signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error("DIGITAL_STATE_MIGRATION_FAILED");
  const result = await response.json();
  for (const name of Object.keys(COLUMNS)) {
    if (result.counts?.[name] !== payload.tables[name].length) throw new Error("DIGITAL_BASELINE_INVALID");
  }
  return { alreadyApplied: result.alreadyApplied === true, counts: result.counts };
}

if (require.main === module) migrate(process.argv[2], process.env.GESTAO_CLOUDFLARE_API_ORIGIN,
  process.env.DIGITAL_SYNC_INTERNAL_TOKEN).then((result) => console.log(JSON.stringify(result)))
  .catch(() => { console.error("DIGITAL_STATE_MIGRATION_FAILED"); process.exitCode = 1; });

module.exports = { readDigitalState, migrate };
