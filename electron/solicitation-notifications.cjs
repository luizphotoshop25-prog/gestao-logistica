const { randomUUID } = require("node:crypto");

const ACTIVE = "s.status IN ('pending','in_progress')";
const ZONE = "America/Sao_Paulo";
const DAY = 86400000;
const PRIORITY = ["ASSIGNED", "DUE_TOMORROW", "DUE_TODAY", "DUE_IN_ONE_HOUR", "DUE_IN_15_MINUTES", "DUE_NOW", "OVERDUE"];
const TEMPORAL_STAGES = PRIORITY.slice(1);
const OVERDUE_REPEAT_MS = 30 * 60000;
const NOTIFICATION_TABLE = `CREATE TABLE solicitacao_notificacoes (
  id TEXT PRIMARY KEY,
  solicitacao_id TEXT NOT NULL REFERENCES solicitacoes(id) ON DELETE CASCADE,
  usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL CHECK (tipo IN ('ASSIGNED','DUE_TOMORROW','DUE_TODAY','DUE_IN_ONE_HOUR','DUE_IN_15_MINUTES','DUE_NOW','OVERDUE')),
  prazo_snapshot TEXT NOT NULL,
  criado_em TEXT NOT NULL,
  entregue_em TEXT NOT NULL,
  visualizado_em TEXT,
  adiado_ate TEXT,
  resolvido_em TEXT,
  clicado_em TEXT,
  repeticoes INTEGER NOT NULL DEFAULT 0,
  popup_apresentado_em TEXT,
  popup_suprimido_em TEXT,
  repeticao_atraso_em TEXT,
  UNIQUE(solicitacao_id,usuario_id,prazo_snapshot,tipo)
)`;

function localDay(date) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const value = (key) => parts.find((part) => part.type === key).value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function dayDistance(left, right) {
  return Math.round((Date.parse(`${left}T12:00:00Z`) - Date.parse(`${right}T12:00:00Z`)) / DAY);
}

function hourInSaoPaulo(date) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, hour: "2-digit", hourCycle: "h23" }).format(date));
}

function minuteInSaoPaulo(date) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: ZONE, minute: "2-digit" }).format(date));
}

function currentStage(deadline, hasTime, at) {
  if (!deadline) return null;
  const due = new Date(deadline);
  if (!Number.isFinite(due.getTime())) return null;
  const today = localDay(at);
  const dueDay = localDay(due);
  const days = dayDistance(dueDay, today);
  if (!hasTime) {
    if (days < 0) return "OVERDUE";
    if (days === 0 && hourInSaoPaulo(at) >= 9) return "DUE_TODAY";
    if (days === 1 && hourInSaoPaulo(at) >= 9) return "DUE_TOMORROW";
    return null;
  }
  const remaining = due.getTime() - at.getTime();
  if (remaining <= -15 * 60000) return "OVERDUE";
  if (remaining <= 0) return "DUE_NOW";
  if (remaining <= 15 * 60000) return "DUE_IN_15_MINUTES";
  if (remaining <= 60 * 60000) return "DUE_IN_ONE_HOUR";
  if (days === 0 && (hourInSaoPaulo(at) > 9 || (hourInSaoPaulo(at) === 9 && minuteInSaoPaulo(at) >= 0))) return "DUE_TODAY";
  if (days === 1 && hourInSaoPaulo(at) >= 9) return "DUE_TOMORROW";
  return null;
}

function install(db, backup) {
  const exists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='solicitacao_notificacoes'").get();
  if (!exists) {
    db.exec(NOTIFICATION_TABLE);
    createIndexes(db);
    return;
  }
  const columns = new Set(db.prepare("PRAGMA table_info(solicitacao_notificacoes)").all().map((column) => column.name));
  const tableSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='solicitacao_notificacoes'").get()?.sql || "";
  const needsMigration = !columns.has("popup_apresentado_em") || !columns.has("popup_suprimido_em")
    || !columns.has("repeticao_atraso_em") || !tableSql.includes("DUE_IN_15_MINUTES") || !tableSql.includes("DUE_NOW");
  if (!needsMigration) { createIndexes(db); return; }
  backup("solicitacao-notificacoes-v2");
  const has = (column) => columns.has(column) ? column : "NULL";
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("DROP TABLE IF EXISTS solicitacao_notificacoes_v2");
    db.exec(NOTIFICATION_TABLE.replace("CREATE TABLE solicitacao_notificacoes", "CREATE TABLE solicitacao_notificacoes_v2"));
    db.exec(`INSERT INTO solicitacao_notificacoes_v2
      (id,solicitacao_id,usuario_id,tipo,prazo_snapshot,criado_em,entregue_em,visualizado_em,adiado_ate,resolvido_em,clicado_em,repeticoes,popup_apresentado_em,popup_suprimido_em,repeticao_atraso_em)
      SELECT id,solicitacao_id,usuario_id,tipo,prazo_snapshot,criado_em,entregue_em,visualizado_em,adiado_ate,resolvido_em,clicado_em,repeticoes,
        ${has("popup_apresentado_em")},${has("popup_suprimido_em")},${has("repeticao_atraso_em")}
      FROM solicitacao_notificacoes`);
    db.exec("DROP TABLE solicitacao_notificacoes");
    db.exec("ALTER TABLE solicitacao_notificacoes_v2 RENAME TO solicitacao_notificacoes");
    createIndexes(db);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function createIndexes(db) {
  db.exec("CREATE INDEX IF NOT EXISTS idx_solicitacao_notificacoes_user ON solicitacao_notificacoes(usuario_id,resolvido_em,entregue_em DESC);");
  db.exec("CREATE INDEX IF NOT EXISTS idx_solicitacao_notificacoes_request ON solicitacao_notificacoes(solicitacao_id,resolvido_em);");
}

function reconcile(db, solicitationId, timestamp) {
  db.prepare(`UPDATE solicitacao_notificacoes SET resolvido_em=?,adiado_ate=NULL WHERE solicitacao_id=? AND resolvido_em IS NULL
    AND NOT EXISTS (SELECT 1 FROM solicitacoes s WHERE s.id=? AND ${ACTIVE} AND s.responsavel_usuario_id=solicitacao_notificacoes.usuario_id
      AND (solicitacao_notificacoes.tipo='ASSIGNED' OR COALESCE(s.prazo_em,'')=solicitacao_notificacoes.prazo_snapshot))`)
    .run(timestamp, solicitationId, solicitationId);
}

function assigned(db, solicitationId, userId, timestamp) {
  db.prepare(`INSERT OR IGNORE INTO solicitacao_notificacoes
    (id,solicitacao_id,usuario_id,tipo,prazo_snapshot,criado_em,entregue_em) VALUES (?,?,?,'ASSIGNED',?, ?,?)`)
    .run(randomUUID(), solicitationId, userId, `assigned:${timestamp}`, timestamp, timestamp);
}

function poll(db, userId, at = new Date()) {
  const timestamp = at.toISOString();
  const user = db.prepare("SELECT ativo FROM usuarios WHERE id=?").get(userId);
  if (!user?.ativo) return [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const requests = db.prepare(`SELECT s.id,s.prazo_em FROM solicitacoes s WHERE ${ACTIVE} AND s.responsavel_usuario_id=?`).all(userId);
    for (const request of requests) {
      reconcile(db, request.id, timestamp);
      const stage = request.prazo_em ? currentStage(request.prazo_em, /T\d{2}:\d{2}/i.test(request.prazo_em), at) : null;
      if (!stage) continue;
      const snapshot = request.prazo_em;
      let existing = db.prepare("SELECT * FROM solicitacao_notificacoes WHERE solicitacao_id=? AND usuario_id=? AND prazo_snapshot=? AND tipo=?")
        .get(request.id, userId, snapshot, stage);
      if (!existing) {
        const itemId = randomUUID();
        db.prepare(`INSERT INTO solicitacao_notificacoes (id,solicitacao_id,usuario_id,tipo,prazo_snapshot,criado_em,entregue_em)
          VALUES (?,?,?,?,?,?,?)`).run(itemId, request.id, userId, stage, snapshot, timestamp, timestamp);
        existing = db.prepare("SELECT * FROM solicitacao_notificacoes WHERE id=?").get(itemId);
      }
      const rank = PRIORITY.indexOf(stage);
      const lower = PRIORITY.slice(0, rank).filter((type) => type !== "ASSIGNED");
      if (lower.length) db.prepare(`UPDATE solicitacao_notificacoes SET resolvido_em=?,adiado_ate=NULL WHERE solicitacao_id=? AND usuario_id=?
        AND prazo_snapshot=? AND resolvido_em IS NULL AND tipo IN (${lower.map(() => "?").join(",")})`)
        .run(timestamp, request.id, userId, snapshot, ...lower);
      db.prepare(`UPDATE solicitacao_notificacoes SET popup_suprimido_em=COALESCE(popup_suprimido_em,?)
        WHERE solicitacao_id=? AND usuario_id=? AND tipo='ASSIGNED' AND resolvido_em IS NULL`)
        .run(timestamp, request.id, userId);
      if (stage === "OVERDUE" && !existing.resolvido_em && !existing.visualizado_em && !existing.adiado_ate
        && !existing.repeticao_atraso_em && Date.parse(existing.entregue_em) + OVERDUE_REPEAT_MS <= at.getTime()) {
        db.prepare("UPDATE solicitacao_notificacoes SET repeticao_atraso_em=?,entregue_em=?,popup_apresentado_em=NULL WHERE id=?")
          .run(timestamp, timestamp, existing.id);
      }
      if (existing.adiado_ate && existing.adiado_ate <= timestamp && !existing.resolvido_em) {
        db.prepare("UPDATE solicitacao_notificacoes SET entregue_em=?,adiado_ate=NULL,repeticoes=repeticoes+1,popup_apresentado_em=NULL,visualizado_em=NULL WHERE id=?")
          .run(timestamp, existing.id);
      }
    }
    const pending = db.prepare(`SELECT n.id,n.solicitacao_id,n.tipo,n.entregue_em,n.prazo_snapshot
      FROM solicitacao_notificacoes n JOIN solicitacoes s ON s.id=n.solicitacao_id
      WHERE n.usuario_id=? AND n.resolvido_em IS NULL AND n.popup_apresentado_em IS NULL AND n.popup_suprimido_em IS NULL AND n.visualizado_em IS NULL
        AND (n.adiado_ate IS NULL OR n.adiado_ate<=?) AND ${ACTIVE} AND s.responsavel_usuario_id=?
      ORDER BY n.entregue_em DESC`).all(userId, timestamp, userId);
    const byRequest = new Map();
    for (const item of pending) {
      const current = byRequest.get(item.solicitacao_id);
      if (!current || PRIORITY.indexOf(item.tipo) > PRIORITY.indexOf(current.tipo)) byRequest.set(item.solicitacao_id, item);
    }
    for (const item of pending) {
      if (byRequest.get(item.solicitacao_id)?.id !== item.id) {
        db.prepare("UPDATE solicitacao_notificacoes SET popup_suprimido_em=COALESCE(popup_suprimido_em,?) WHERE id=?").run(timestamp, item.id);
      }
    }
    db.exec("COMMIT");
    return [...byRequest.values()].map((item) => item.id);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function list(db, userId) {
  return db.prepare(`SELECT n.id,n.solicitacao_id,n.tipo,n.prazo_snapshot,n.criado_em,n.entregue_em,n.visualizado_em,
    n.adiado_ate,n.resolvido_em,n.clicado_em,n.repeticoes,n.popup_apresentado_em,n.popup_suprimido_em,n.repeticao_atraso_em,
    s.descricao,s.sessao_codigo,s.status,s.prazo_em
    FROM solicitacao_notificacoes n JOIN solicitacoes s ON s.id=n.solicitacao_id
    WHERE n.usuario_id=? AND n.resolvido_em IS NULL AND ${ACTIVE} AND s.responsavel_usuario_id=?
    ORDER BY n.entregue_em DESC LIMIT 100`).all(userId, userId);
}

function allowedSnooze(type, deadline, at = new Date()) {
  const options = type === "DUE_IN_ONE_HOUR" ? [15, 30]
    : type === "DUE_IN_15_MINUTES" ? [5, 10, 15]
      : ["DUE_NOW", "OVERDUE"].includes(type) ? [15, 30, 60]
        : type === "DUE_TODAY" ? [30, 60] : [];
  if (!["DUE_IN_ONE_HOUR", "DUE_IN_15_MINUTES"].includes(type) || !deadline) return options;
  const remaining = new Date(deadline).getTime() - at.getTime();
  if (!Number.isFinite(remaining)) return options;
  const minimumUsefulDelay = type === "DUE_IN_ONE_HOUR" ? 15 : 5;
  const latestUsefulDelay = Math.max(minimumUsefulDelay, Math.ceil(remaining / 60000));
  return options.filter((minutes) => minutes <= latestUsefulDelay);
}

function update(db, userId, notificationId, action, minutes, at = new Date()) {
  const item = db.prepare(`SELECT n.*,s.status,s.responsavel_usuario_id,s.prazo_em FROM solicitacao_notificacoes n
    JOIN solicitacoes s ON s.id=n.solicitacao_id WHERE n.id=? AND n.usuario_id=?`).get(notificationId, userId);
  if (!item || item.resolvido_em || !["pending", "in_progress"].includes(item.status) || item.responsavel_usuario_id !== userId)
    return { ok: false, message: "Notificação indisponível." };
  const timestamp = at.toISOString();
  if (action === "presented") {
    db.prepare("UPDATE solicitacao_notificacoes SET popup_apresentado_em=COALESCE(popup_apresentado_em,?) WHERE id=?").run(timestamp, item.id);
  } else if (action === "snooze") {
    const allowed = allowedSnooze(item.tipo, item.prazo_em, at);
    if (!allowed.includes(minutes)) return { ok: false, message: "Adiamento inválido." };
    db.prepare("UPDATE solicitacao_notificacoes SET adiado_ate=?,visualizado_em=COALESCE(visualizado_em,?) WHERE id=?")
      .run(new Date(at.getTime() + minutes * 60000).toISOString(), timestamp, item.id);
  } else if (action === "seen" || action === "open") {
    db.prepare(`UPDATE solicitacao_notificacoes SET visualizado_em=COALESCE(visualizado_em,?),clicado_em=CASE WHEN ?='open' THEN ? ELSE clicado_em END WHERE id=?`)
      .run(timestamp, action, timestamp, item.id);
  } else if (action === "resolve") {
    db.prepare("UPDATE solicitacao_notificacoes SET resolvido_em=?,adiado_ate=NULL WHERE id=?").run(timestamp, item.id);
  } else return { ok: false, message: "Ação inválida." };
  return { ok: true };
}

module.exports = { install, reconcile, assigned, poll, list, update, currentStage, allowedSnooze, PRIORITY };
