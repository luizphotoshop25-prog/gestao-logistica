const { randomUUID } = require("node:crypto");

const ACTIVE = "s.status IN ('pending','in_progress')";
const ZONE = "America/Sao_Paulo";
const DAY = 86400000;
const STAGES = ["DUE_TOMORROW", "DUE_TODAY", "DUE_IN_ONE_HOUR", "OVERDUE"];

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

function currentStage(deadline, hasTime, at) {
  if (!deadline) return null;
  const due = new Date(deadline);
  if (!Number.isFinite(due.getTime())) return null;
  const today = localDay(at);
  const dueDay = localDay(due);
  const days = dayDistance(dueDay, today);
  if ((hasTime && at >= due) || (!hasTime && days < 0)) return "OVERDUE";
  if (hasTime && due.getTime() - at.getTime() <= 60 * 60000 && due > at) return "DUE_IN_ONE_HOUR";
  if (days === 0 && hourInSaoPaulo(at) >= 9) return "DUE_TODAY";
  if (days === 1 && hourInSaoPaulo(at) >= 9) return "DUE_TOMORROW";
  return null;
}

function install(db, backup) {
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='solicitacao_notificacoes'").get()) return;
  backup("solicitacao-notificacoes");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE solicitacao_notificacoes (
      id TEXT PRIMARY KEY,
      solicitacao_id TEXT NOT NULL REFERENCES solicitacoes(id) ON DELETE CASCADE,
      usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL CHECK (tipo IN ('ASSIGNED','DUE_TOMORROW','DUE_TODAY','DUE_IN_ONE_HOUR','OVERDUE')),
      prazo_snapshot TEXT NOT NULL,
      criado_em TEXT NOT NULL,
      entregue_em TEXT NOT NULL,
      visualizado_em TEXT,
      adiado_ate TEXT,
      resolvido_em TEXT,
      clicado_em TEXT,
      repeticoes INTEGER NOT NULL DEFAULT 0,
      UNIQUE(solicitacao_id,usuario_id,prazo_snapshot,tipo)
    );
    CREATE INDEX idx_solicitacao_notificacoes_user ON solicitacao_notificacoes(usuario_id,resolvido_em,entregue_em DESC);
    CREATE INDEX idx_solicitacao_notificacoes_request ON solicitacao_notificacoes(solicitacao_id,resolvido_em);`);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
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
  const newItems = [];
  db.exec("BEGIN IMMEDIATE");
  try {
    const requests = db.prepare(`SELECT s.id,s.prazo_em
      FROM solicitacoes s WHERE ${ACTIVE} AND s.responsavel_usuario_id=? AND s.prazo_em IS NOT NULL`).all(userId);
    for (const request of requests) {
      reconcile(db, request.id, timestamp);
      const stage = currentStage(request.prazo_em, true, at);
      if (!stage) continue;
      const existing = db.prepare(`SELECT * FROM solicitacao_notificacoes WHERE solicitacao_id=? AND usuario_id=? AND prazo_snapshot=? AND tipo=?`)
        .get(request.id, userId, request.prazo_em, stage);
      const higherPriority = STAGES.indexOf(stage);
      db.prepare(`UPDATE solicitacao_notificacoes SET resolvido_em=?,adiado_ate=NULL WHERE solicitacao_id=? AND usuario_id=?
        AND prazo_snapshot=? AND resolvido_em IS NULL AND tipo IN (${STAGES.slice(0, higherPriority).map(() => "?").join(",") || "'__none__'"})`)
        .run(timestamp, request.id, userId, request.prazo_em, ...STAGES.slice(0, higherPriority));
      if (!existing) {
        const itemId = randomUUID();
        db.prepare(`INSERT INTO solicitacao_notificacoes (id,solicitacao_id,usuario_id,tipo,prazo_snapshot,criado_em,entregue_em)
          VALUES (?,?,?,?,?,?,?)`).run(itemId, request.id, userId, stage, request.prazo_em, timestamp, timestamp);
        newItems.push(itemId);
      } else if (!existing.resolvido_em && existing.adiado_ate && existing.adiado_ate <= timestamp) {
        db.prepare("UPDATE solicitacao_notificacoes SET entregue_em=?,adiado_ate=NULL,repeticoes=repeticoes+1 WHERE id=?")
          .run(timestamp, existing.id);
        newItems.push(existing.id);
      }
    }
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return newItems;
}

function list(db, userId) {
  return db.prepare(`SELECT n.id,n.solicitacao_id,n.tipo,n.prazo_snapshot,n.criado_em,n.entregue_em,n.visualizado_em,
    n.adiado_ate,n.resolvido_em,n.clicado_em,n.repeticoes,s.descricao,s.sessao_codigo,s.status
    FROM solicitacao_notificacoes n JOIN solicitacoes s ON s.id=n.solicitacao_id
    WHERE n.usuario_id=? AND n.resolvido_em IS NULL AND ${ACTIVE} AND s.responsavel_usuario_id=?
    ORDER BY n.entregue_em DESC LIMIT 100`).all(userId, userId);
}

function update(db, userId, notificationId, action, minutes, at = new Date()) {
  const item = db.prepare(`SELECT n.*,s.status,s.responsavel_usuario_id,s.prazo_em FROM solicitacao_notificacoes n
    JOIN solicitacoes s ON s.id=n.solicitacao_id WHERE n.id=? AND n.usuario_id=?`).get(notificationId, userId);
  if (!item || item.resolvido_em || !["pending", "in_progress"].includes(item.status) || item.responsavel_usuario_id !== userId)
    return { ok: false, message: "Notificação indisponível." };
  if (action === "snooze") {
    const allowed = item.tipo === "DUE_IN_ONE_HOUR" ? [15, 30] : [15, 30, 60];
    if (!allowed.includes(minutes) || item.tipo === "DUE_TOMORROW") return { ok: false, message: "Adiamento inválido." };
    db.prepare("UPDATE solicitacao_notificacoes SET adiado_ate=?,visualizado_em=COALESCE(visualizado_em,?) WHERE id=?")
      .run(new Date(at.getTime() + minutes * 60000).toISOString(), at.toISOString(), item.id);
  } else if (action === "seen" || action === "open") {
    db.prepare(`UPDATE solicitacao_notificacoes SET visualizado_em=COALESCE(visualizado_em,?),clicado_em=CASE WHEN ?='open' THEN ? ELSE clicado_em END WHERE id=?`)
      .run(at.toISOString(), action, at.toISOString(), item.id);
  } else if (action === "resolve") {
    db.prepare("UPDATE solicitacao_notificacoes SET resolvido_em=?,adiado_ate=NULL WHERE id=?").run(at.toISOString(), item.id);
  } else return { ok: false, message: "Ação inválida." };
  return { ok: true };
}

module.exports = { install, reconcile, assigned, poll, list, update, currentStage };
