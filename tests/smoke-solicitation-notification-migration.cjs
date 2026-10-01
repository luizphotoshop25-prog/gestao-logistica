const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-notification-migration-"));
try {
  database.initializeDataDirectory(root);
  database.close();
  const file = path.join(root, "gestao-logistica.sqlite3");
  const db = new DatabaseSync(file);
  db.exec("DROP TABLE solicitacao_notificacoes");
  db.close();
  const migration = path.join(__dirname, "../scripts/migrate-solicitation-notifications.cjs");
  const first = spawnSync(process.execPath, [migration, root], { encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /Migration concluída/);
  const second = spawnSync(process.execPath, [migration, root], { encoding: "utf8" });
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /já aplicada/);
  const check = new DatabaseSync(file, { readOnly: true });
  assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(check.prepare("PRAGMA foreign_key_check").all().length, 0);
  assert.ok(check.prepare("SELECT 1 FROM sqlite_master WHERE name='solicitacao_notificacoes'").get());
  check.close();
  assert.ok(fs.readdirSync(path.join(root, "backups")).some((name) => name.startsWith("antes-solicitacao-notificacoes-")));
  console.log("Migration de notificações: backup, transação, idempotência e integridade aprovados.");
} finally {
  database.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
