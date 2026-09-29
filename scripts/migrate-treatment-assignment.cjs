const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");

function main() {
  const directory = process.env.GESTAO_SERVER_DATA;
  if (!directory || !path.isAbsolute(directory)) throw new Error("GESTAO_SERVER_DATA deve apontar para a pasta de dados absoluta do servidor.");
  const source = path.join(directory, "gestao-logistica.sqlite3");
  const before = new DatabaseSync(source, { readOnly: true });
  try {
    const henrique = before.prepare("SELECT id,usuario,nome,role,ativo FROM usuarios WHERE usuario=? COLLATE NOCASE").get("henrique");
    const carlos = before.prepare("SELECT id,usuario,nome,role,ativo FROM usuarios WHERE usuario=? COLLATE NOCASE").get("Carlos");
    if (!henrique || henrique.ativo !== 1 || henrique.role !== "coordinator") throw new Error("A conta ativa de coordenação henrique não foi confirmada; migração cancelada.");
    if (!carlos || carlos.ativo !== 1 || carlos.role !== "employee") throw new Error("A conta ativa employee Carlos não foi confirmada; migração cancelada.");
  } finally { before.close(); }

  database.initializeDataDirectory(directory);
  try {
    const status = database.getStatus();
    const counts = database.assignmentBackfillCounts();
    if (status.integrity !== "ok") throw new Error("integrity_check do SQLite não retornou ok.");
    console.log(JSON.stringify({ ok: true, integrity: status.integrity, ...counts }, null, 2));
  } finally { database.close(); }
}

try { main(); } catch (error) { database.close(); console.error(error.message); process.exitCode = 1; }
