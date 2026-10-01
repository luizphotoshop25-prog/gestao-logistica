const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { install } = require("../electron/solicitation-notifications.cjs");

const directory = process.argv[2];
if (!directory || !path.isAbsolute(directory)) throw new Error("Informe o diretório absoluto de dados.");
const resolved = fs.realpathSync(directory);
const databasePath = path.join(resolved, "gestao-logistica.sqlite3");
if (!fs.existsSync(databasePath) || fs.lstatSync(databasePath).isSymbolicLink()) throw new Error("Banco SQLite regular não encontrado.");
const db = new DatabaseSync(databasePath);
try {
  db.exec("PRAGMA foreign_keys=ON");
  const integrity = () => db.prepare("PRAGMA integrity_check").get().integrity_check;
  const foreignKeys = () => db.prepare("PRAGMA foreign_key_check").all().length;
  if (integrity() !== "ok" || foreignKeys() !== 0) throw new Error("Banco não passou nas verificações prévias.");

  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='solicitacao_notificacoes'").get();
  const columns = new Set(table ? db.prepare("PRAGMA table_info(solicitacao_notificacoes)").all().map((column) => column.name) : []);
  const needsMigration = !table || !columns.has("popup_apresentado_em") || !columns.has("popup_suprimido_em")
    || !columns.has("repeticao_atraso_em") || !table.sql.includes("DUE_IN_15_MINUTES") || !table.sql.includes("DUE_NOW");
  if (!needsMigration) {
    console.log("Migration já aplicada; integridade=ok; foreign_key_check=0.");
    return;
  }

  const backupDirectory = path.join(resolved, "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `antes-solicitacao-notificacoes-v2-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite3`);
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(FULL)").get();
  if (Number(checkpoint?.busy) !== 0) throw new Error("Backup cancelado: o checkpoint WAL não concluiu sem bloqueio.");
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (backup.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("Backup inválido.");
    if (backup.prepare("PRAGMA foreign_key_check").all().length !== 0) throw new Error("Backup com referências inválidas.");
  } finally { backup.close(); }

  install(db, () => backupPath);
  if (integrity() !== "ok" || foreignKeys() !== 0) throw new Error("Migration aplicada, mas o banco falhou nas verificações posteriores; o backup deve ser preservado para rollback.");
  console.log(`Migration concluída; backup=${backupPath}; integrity_check=ok; foreign_key_check=0.`);
} finally { db.close(); }
