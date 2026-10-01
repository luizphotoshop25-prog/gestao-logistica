const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { install } = require("../electron/solicitation-notifications.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-notification-legacy-migration-"));
const file = path.join(root, "legacy.sqlite3");
const db = new DatabaseSync(file);
try {
  db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
  db.exec("CREATE TABLE usuarios(id TEXT PRIMARY KEY); CREATE TABLE solicitacoes(id TEXT PRIMARY KEY);");
  const userId = "812581b2-cf2a-4f7c-a4a1-57217a0dd2e2";
  const requestId = "a9d4ea7f-2f38-4b4d-bbdd-0a2c6ccf36df";
  const at = "2026-10-01T12:00:00.000Z";
  db.prepare("INSERT INTO usuarios VALUES (?)").run(userId);
  db.prepare("INSERT INTO solicitacoes VALUES (?)").run(requestId);
  db.exec(`CREATE TABLE solicitacao_notificacoes (
    id TEXT PRIMARY KEY,
    solicitacao_id TEXT NOT NULL REFERENCES solicitacoes(id) ON DELETE CASCADE,
    usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
    tipo TEXT NOT NULL CHECK (tipo IN ('ASSIGNED','DUE_TOMORROW','DUE_TODAY','DUE_IN_ONE_HOUR','OVERDUE')),
    prazo_snapshot TEXT NOT NULL, criado_em TEXT NOT NULL, entregue_em TEXT NOT NULL, visualizado_em TEXT,
    adiado_ate TEXT, resolvido_em TEXT, clicado_em TEXT, repeticoes INTEGER NOT NULL DEFAULT 0,
    UNIQUE(solicitacao_id,usuario_id,prazo_snapshot,tipo)
  )`);
  db.prepare(`INSERT INTO solicitacao_notificacoes
    (id,solicitacao_id,usuario_id,tipo,prazo_snapshot,criado_em,entregue_em,visualizado_em,adiado_ate,repeticoes)
    VALUES ('legacy-notification',?,?,'ASSIGNED','assigned:2026-10-01',?,?,?,?,2)`)
    .run(requestId, userId, at, at, at, "2026-10-01T12:20:00.000Z");
  const backupPath = path.join(root, "legacy-backup.sqlite3");
  let backupCalls = 0;
  const backup = () => {
    backupCalls++;
    db.exec(`VACUUM INTO '${backupPath.replace(/'/g, "''")}'`);
    return backupPath;
  };
  install(db, backup);
  install(db, backup);
  assert.equal(backupCalls, 1, "Migração repetida é idempotente e cria um único backup.");
  const row = db.prepare("SELECT * FROM solicitacao_notificacoes WHERE id='legacy-notification'").get();
  assert.equal(row.tipo, "ASSIGNED");
  assert.equal(row.visualizado_em, at);
  assert.equal(row.adiado_ate, "2026-10-01T12:20:00.000Z");
  assert.equal(row.repeticoes, 2);
  assert.equal(row.popup_apresentado_em, null);
  db.prepare(`INSERT INTO solicitacao_notificacoes
    (id,solicitacao_id,usuario_id,tipo,prazo_snapshot,criado_em,entregue_em)
    VALUES ('new-stage',?,?,'DUE_NOW','2026-10-01T13:00:00.000Z',?,?)`).run(requestId, userId, at, at);
  assert.equal(db.prepare("SELECT tipo FROM solicitacao_notificacoes WHERE id='new-stage'").get().tipo, "DUE_NOW");
  assert.equal(db.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  assert.equal(db.prepare("PRAGMA foreign_key_check").all().length, 0);
  const backupDb = new DatabaseSync(backupPath, { readOnly: true });
  assert.equal(backupDb.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  backupDb.close();
  console.log("Migration realista do schema antigo: backup validado, registros/snooze preservados, estágios novos, idempotência e integridade aprovados.");
} finally {
  db.close();
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
