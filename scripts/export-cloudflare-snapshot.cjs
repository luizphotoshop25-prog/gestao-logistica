const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const BATCH_SIZE = 200;
const quote = (value) => `"${String(value).replace(/"/g, '""')}"`;
const serialize = (value) => Buffer.isBuffer(value) || value instanceof Uint8Array
  ? { __cloudflareBlob: Buffer.from(value).toString("base64") } : value;
const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");

function dependencyOrder(tables, db) {
  const names = new Set(tables.map((table) => table.name));
  const dependencies = new Map(tables.map((table) => [table.name,
    db.prepare(`PRAGMA foreign_key_list(${quote(table.name)})`).all()
      .map((row) => row.table).filter((name) => name !== table.name && names.has(name))]));
  const ordered = [], active = new Set(), visited = new Set();
  const visit = (name) => {
    if (visited.has(name)) return;
    if (active.has(name)) throw new Error("O esquema possui dependência circular; importação cancelada.");
    active.add(name);
    for (const dependency of dependencies.get(name) || []) visit(dependency);
    active.delete(name); visited.add(name); ordered.push(name);
  };
  for (const table of tables) visit(table.name);
  return ordered.map((name) => tables.find((table) => table.name === name));
}

function exportSnapshot(databaseFile, outputDirectory) {
  const source = path.resolve(databaseFile || "");
  const destination = path.resolve(outputDirectory || "");
  const allowedOutput = path.resolve("work", "cloudflare-migration");
  if (!path.isAbsolute(databaseFile || "") || path.basename(destination) !== "snapshot"
    || !destination.startsWith(`${allowedOutput}${path.sep}`))
    throw new Error("Informe o banco absoluto e use exclusivamente work/cloudflare-migration/snapshot como destino.");
  if (!fs.existsSync(source) || fs.lstatSync(source).isSymbolicLink()) throw new Error("O banco de origem não existe ou não é um arquivo seguro.");
  const db = new DatabaseSync(source, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    if (db.prepare("PRAGMA integrity_check").get()?.integrity_check !== "ok"
      || db.prepare("PRAGMA foreign_key_check").all().length !== 0)
      throw new Error("A origem não passou na verificação de integridade; nenhum snapshot foi gerado.");

    const tables = db.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all().map(({ name, sql }) => ({ name, sql }));
    const extraObjects = db.prepare("SELECT type,name FROM sqlite_master WHERE type IN ('view','trigger') AND sql IS NOT NULL").all();
    if (extraObjects.length) throw new Error("O banco contém views/triggers que precisam de migração explícita.");
    const orderedTables = dependencyOrder(tables, db);
    const indexes = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name")
      .all().map((row) => row.sql);
    const foreignKeys = [];
    for (const table of orderedTables) {
      const rows = db.prepare(`PRAGMA foreign_key_list(${quote(table.name)})`).all();
      const groups = new Map();
      for (const row of rows) {
        const group = groups.get(row.id) || { table: table.name, refTable: row.table, columns: [], refColumns: [] };
        group.columns[row.seq] = row.from;
        group.refColumns[row.seq] = row.to || null;
        groups.set(row.id, group);
      }
      for (const group of groups.values()) {
        if (group.refColumns.some((column) => column === null)) {
          const primary = db.prepare(`PRAGMA table_info(${quote(group.refTable)})`).all()
            .filter((column) => column.pk).sort((left, right) => left.pk - right.pk).map((column) => column.name);
          group.refColumns = group.refColumns.map((column, index) => column || primary[index]);
        }
        foreignKeys.push(group);
      }
    }
    const temp = `${destination}.tmp-${process.pid}`;
    fs.rmSync(temp, { recursive: true, force: true });
    fs.mkdirSync(path.join(temp, "data"), { recursive: true });
    const manifest = { schema: 1, tables: [], indexes, foreignKeys, batchSize: BATCH_SIZE };
    for (const table of orderedTables) {
      const count = Number(db.prepare(`SELECT COUNT(*) AS count FROM ${quote(table.name)}`).get().count);
      const entry = { name: table.name, sql: table.sql, rowCount: count, batches: Math.ceil(count / BATCH_SIZE) };
      manifest.tables.push(entry);
      for (let offset = 0, batchNumber = 0; offset < count; offset += BATCH_SIZE, batchNumber++) {
        const rows = db.prepare(`SELECT * FROM ${quote(table.name)} ORDER BY rowid LIMIT ? OFFSET ?`)
          .all(BATCH_SIZE, offset).map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => [key, serialize(value)])));
        const fileName = `${table.name}-${String(batchNumber).padStart(5, "0")}.json`;
        fs.writeFileSync(path.join(temp, "data", fileName), `${JSON.stringify(rows)}\n`, { flag: "wx" });
      }
    }
    const canonical = JSON.stringify(manifest);
    manifest.manifestSha256 = hash(canonical);
    fs.writeFileSync(path.join(temp, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(temp, destination);
    db.exec("COMMIT");
    return { tables: manifest.tables.length, rows: manifest.tables.reduce((sum, table) => sum + table.rowCount, 0), batches: manifest.tables.reduce((sum, table) => sum + table.batches, 0), integrity: "ok" };
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  } finally { db.close(); }
}

if (require.main === module) {
  try {
    const result = exportSnapshot(process.argv[2], process.argv[3]);
    console.log(JSON.stringify({ ok: true, ...result, output: path.resolve("work", "cloudflare-migration", "snapshot") }, null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}

module.exports = { BATCH_SIZE, exportSnapshot };
