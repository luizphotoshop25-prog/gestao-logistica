const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const API_ORIGIN = String(process.env.GESTAO_CLOUDFLARE_API_ORIGIN || "").replace(/\/$/, "");
const TOKEN = process.env.GESTAO_CLOUDFLARE_MIGRATION_TOKEN || "";
const ROOT = path.resolve("work", "cloudflare-migration", "snapshot");
const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");

async function post(action, payload) {
  const response = await fetch(`${API_ORIGIN}/__internal/import/${action}`, {
    method: "POST", redirect: "error",
    headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Importação Cloudflare recusada em ${action} (HTTP ${response.status}, ${body.error || "sem código"}).`);
  return body;
}

async function importSnapshot() {
  if (!/^https:\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)*\.workers\.dev$/i.test(API_ORIGIN) || !TOKEN || TOKEN.length < 32)
    throw new Error("Configure o endpoint Workers e o token temporário no ambiente do processo.");
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
  if (manifest.schema !== 1 || !Array.isArray(manifest.tables) || !/^[a-f0-9]{64}$/.test(manifest.manifestSha256))
    throw new Error("Manifesto do snapshot inválido.");
  const canonical = { ...manifest };
  delete canonical.manifestSha256;
  if (sha256(JSON.stringify(canonical)) !== manifest.manifestSha256) throw new Error("O manifesto do snapshot foi alterado após a exportação.");
  const { tables, indexes, ...metadata } = manifest;
  await post("schema", { ...metadata, tables, indexes });
  let completed = 0;
  for (const table of tables) {
    for (let batch = 0; batch < table.batches; batch++) {
      const file = path.join(ROOT, "data", `${table.name}-${String(batch).padStart(5, "0")}.json`);
      const rows = JSON.parse(fs.readFileSync(file, "utf8"));
      const payload = JSON.stringify({ table: table.name, rows });
      const batchId = sha256(`${table.name}\n${batch}\n${payload}`);
      await post("batch", { table: table.name, batchId, rows });
      completed += 1;
    }
  }
  const result = await post("finalize", { manifestSha256: manifest.manifestSha256 });
  return { ok: true, tables: tables.length, rows: tables.reduce((sum, table) => sum + table.rowCount, 0), batches: completed, integrity: result.integrity, foreignKeyViolations: result.foreignKeyViolations };
}

if (require.main === module) {
  importSnapshot().then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => { console.error(error.message); process.exitCode = 1; });
}

module.exports = { importSnapshot };
