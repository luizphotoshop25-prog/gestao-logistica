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
  const already = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='solicitacao_notificacoes'").get());
  if (already) {
    console.log("Migration já aplicada; integridade=ok; foreign_key_check=0.");
    process.exit(0);
  }
  const backupDirectory = path.join(resolved, "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(backupDirectory, `antes-solicitacao-notificacoes-${new Date().toISOString().replace(/[:.]/g, "-")}.sqlite3`);
  db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
  const backup = new DatabaseSync(backupPath, { readOnly: true });
  try {
    if (backup.prepare("PRAGMA integrity_check").get().integrity_check !== "ok") throw new Error("Backup inválido.");
  } finally { backup.close(); }
  install(db, () => backupPath);
  if (integrity() !== "ok" || foreignKeys() !== 0) throw new Error("Migration aplicada, mas banco falhou na verificação posterior; restauração manual exigida.");
  console.log(`Migration concluída; backup=${backupPath}; integrity_check=ok; foreign_key_check=0.`);
} finally { db.close(); }
