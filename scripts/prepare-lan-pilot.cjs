const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");

function quoteSql(value) { return `'${String(value).replaceAll("'", "''")}'`; }

function main() {
  const source = process.env.GESTAO_PILOT_SOURCE_DB;
  const destination = process.env.GESTAO_SERVER_DATA;
  if (!source || !path.isAbsolute(source) || !fs.existsSync(source)) throw new Error("GESTAO_PILOT_SOURCE_DB deve apontar para um SQLite existente e absoluto.");
  if (!destination || !path.isAbsolute(destination)) throw new Error("GESTAO_SERVER_DATA absoluto é obrigatório.");
  const resolvedSource = fs.realpathSync(source);
  const resolvedDestination = path.resolve(destination);
  const target = path.join(resolvedDestination, "gestao-logistica.sqlite3");
  if (path.resolve(resolvedSource) === path.resolve(target)) throw new Error("Origem e destino do piloto não podem ser iguais.");
  fs.mkdirSync(resolvedDestination, { recursive: true });
  if (fs.existsSync(target)) throw new Error("O banco de piloto já existe; remova-o explicitamente se quiser recriar.");
  const temporary = `${target}.preparing`;
  fs.rmSync(temporary, { force: true });
  const sourceDb = new DatabaseSync(resolvedSource, { readOnly: true });
  try {
    sourceDb.exec(`VACUUM INTO ${quoteSql(temporary)}`);
  } finally { sourceDb.close(); }
  fs.renameSync(temporary, target);
  const backupDirectory = path.join(resolvedDestination, "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  fs.copyFileSync(target, path.join(backupDirectory, `antes-migracao-piloto-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite3`));
  database.initializeDataDirectory(resolvedDestination);
  const status = database.getStatus();
  database.close();
  console.log(JSON.stringify({ ok: true, source: resolvedSource, destination: target, integrity: status.integrity }, null, 2));
}

try { main(); } catch (error) { database.close(); console.error(error.message); process.exitCode = 1; }
