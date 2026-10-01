// Selective, transaction-safe application of approved legacy workbook fields.
// Default mode is read-only dry-run. The only write mode is --apply.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const ExcelJS = require("exceljs");
const { DatabaseSync } = require("node:sqlite");
const core = require("./logistica-reconciliation-core.cjs");

const ROOT = path.resolve(__dirname, "..");
const WORKBOOK_PATH = process.argv[2] || "E:\\DOWNLOADS\\CONTROLE DE PEDIDOS.xlsx";
const DATABASE_PATH = "E:\\GestaoLogistica_Server_Pilot\\data\\gestao-logistica.sqlite3";
const OUTPUT_DIR = path.join(ROOT, "work", "reconciliation");
const PLAN_JSON = path.join(OUTPUT_DIR, "apply-plan.json");
const PLAN_MD = path.join(OUTPUT_DIR, "apply-plan.md");
const RESULT_JSON = path.join(OUTPUT_DIR, "apply-result.json");
const PENDING_JSON = path.join(OUTPUT_DIR, "pending-completion-review.json");
const PENDING_MD = path.join(OUTPUT_DIR, "pending-completion-review.md");
const SHEET_NAMES = ["LOGISTICA", "ANOTAÇÕESLEMBRETES", "BACKUP 2304", "ENVIADOS DIGITAL", "DASH_AUDIT", "DASHBOARD"];
const EXPECTED_HEADERS = [
  "Concluído", "Sessão", "Cliente", "Email", "Telefone", "CIDADE", "Fotos", "Observações",
  "Finalizou Seleção", "Situação", "Prazo para o CLIENTE (60 DIAS)", "PRAZO PHOTOSHOP (20 DIAS)",
  "DIAS RESTANTES PHOTOSHOP", "Data Prometida ?", "Data de envio", "Codigo de Rastreio",
  "Status do rastreio", "EDITOR",
];

function text(value) { return String(value ?? "").trim(); }
function unwrap(value) {
  let current = value;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if ("result" in current) { current = current.result; continue; }
    if ("text" in current) { current = current.text; continue; }
    if (Array.isArray(current.richText)) return current.richText.map((part) => part.text || "").join("");
    break;
  }
  return current;
}
function cell(row, column) { return unwrap(row.getCell(column).value); }
function normalizedHeader(value) {
  return text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function dateOnly(value) {
  if (value === null || value === undefined || text(value) === "") return { present: false, value: null };
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return { present: true, value: value.toISOString().slice(0, 10) };
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return { present: true, value: Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : null };
  }
  const raw = text(value);
  const br = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  let iso = null;
  if (br) iso = br[3] + "-" + br[2].padStart(2, "0") + "-" + br[1].padStart(2, "0");
  else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) iso = raw;
  else {
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) iso = date.toISOString().slice(0, 10);
  }
  if (!iso) return { present: true, value: null };
  const date = new Date(iso + "T12:00:00Z");
  return { present: true, value: Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null };
}
function truthy(value) { return value === true || value === 1 || /^(1|sim|true|x)$/i.test(text(value)); }

async function readWorkbook(filePath) {
  if (!fs.existsSync(filePath)) throw new Error("WORKBOOK_NOT_FOUND");
  const file = fs.readFileSync(filePath);
  const workbookHash = crypto.createHash("sha256").update(file).digest("hex");
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(file);
  const missingSheets = SHEET_NAMES.filter((name) => !workbook.getWorksheet(name));
  const sheet = workbook.getWorksheet("LOGISTICA");
  if (!sheet || missingSheets.length) throw new Error("WORKBOOK_STRUCTURE_MISMATCH");
  const headers = Array.from({ length: EXPECTED_HEADERS.length }, (_, index) => text(cell(sheet.getRow(6), index + 1)));
  if (headers.map(normalizedHeader).join("|") !== EXPECTED_HEADERS.map(normalizedHeader).join("|"))
    throw new Error("WORKBOOK_HEADERS_MISMATCH");
  const rows = [];
  const bySession = new Map();
  for (let rowNumber = 7; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const rawSession = text(cell(row, 2));
    const selection = dateOnly(cell(row, 9));
    const editor = text(cell(row, 18));
    const observations = text(cell(row, 8));
    const complete = truthy(cell(row, 1));
    const situation = text(cell(row, 10));
    if (!rawSession && !selection.present && !editor && !observations && !complete && !situation) continue;
    const record = {
      row: rowNumber, session: rawSession, selectionRawPresent: selection.present,
      selectionDate: selection.value, editor, observations, complete, situation,
    };
    rows.push(record);
    const normalized = core.normalizeSession(rawSession);
    if (normalized) {
      if (!bySession.has(normalized)) bySession.set(normalized, []);
      bySession.get(normalized).push(record);
    }
  }
  const duplicates = new Set([...bySession].filter(([, group]) => group.length > 1).map(([session]) => session));
  return { rows, duplicates, workbookHash, sizeBytes: file.length, modifiedAt: fs.statSync(filePath).mtime.toISOString() };
}

function readDatabase(databasePath, writable = false) {
  if (!fs.existsSync(databasePath)) throw new Error("PILOT_DATABASE_NOT_FOUND");
  const db = new DatabaseSync(databasePath, writable ? {} : { readOnly: true });
  db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=10000;");
  if (!writable) db.exec("PRAGMA query_only=ON;");
  const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check || "unknown";
  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
  if (integrity !== "ok" || foreignKeyViolations !== 0) {
    db.close();
    throw new Error("DATABASE_INTEGRITY_FAILED");
  }
  const orders = db.prepare("SELECT * FROM pedidos").all();
  const ordersBySession = new Map();
  for (const order of orders) {
    const session = core.normalizeSession(order.sessao);
    if (session && !ordersBySession.has(session)) ordersBySession.set(session, order);
  }
  const config = new Map(db.prepare("SELECT chave,valor FROM configuracoes WHERE chave IN (?, ?, ?)")
    .all("tratamento_usuario_ate_47", "tratamento_usuario_48_mais", "tratamento_limite_carlos")
    .map((row) => [row.chave, row.valor]));
  const smallId = config.get("tratamento_usuario_ate_47") || null;
  const largeId = config.get("tratamento_usuario_48_mais") || null;
  const ids = [smallId, largeId].filter(Boolean);
  const userRows = ids.length
    ? db.prepare("SELECT id,ativo,role FROM usuarios WHERE id IN (" + ids.map(() => "?").join(",") + ")").all(...ids)
    : [];
  const userById = new Map(userRows.map((user) => [user.id, user]));
  const assignment = {
    smallUserId: userById.get(smallId)?.ativo ? smallId : null,
    largeUserId: userById.get(largeId)?.ativo ? largeId : null,
    limit: Number(config.get("tratamento_limite_carlos") || 48),
  };
  if (!Number.isSafeInteger(assignment.limit) || assignment.limit < 0) {
    db.close();
    throw new Error("ASSIGNMENT_THRESHOLD_INVALID");
  }
  const mappingStatus = {
    smallConfigured: Boolean(smallId), smallActive: Boolean(assignment.smallUserId),
    smallRole: userById.get(smallId)?.role || null, largeConfigured: Boolean(largeId),
    largeActive: Boolean(assignment.largeUserId), largeRole: userById.get(largeId)?.role || null,
    limit: assignment.limit,
  };
  return { db, orders, ordersBySession, assignment, mappingStatus, integrity, foreignKeyViolations };
}
function countMineForMappings(db, assignment) {
  return { henrique: core.countMine(db, assignment.smallUserId), carlos: core.countMine(db, assignment.largeUserId) };
}
function assignmentStillMatches(db, expected) {
  const config = new Map(db.prepare("SELECT chave,valor FROM configuracoes WHERE chave IN (?, ?, ?)")
    .all("tratamento_usuario_ate_47", "tratamento_usuario_48_mais", "tratamento_limite_carlos")
    .map((row) => [row.chave, row.valor]));
  const smallId = config.get("tratamento_usuario_ate_47") || null;
  const largeId = config.get("tratamento_usuario_48_mais") || null;
  const ids = [smallId, largeId].filter(Boolean);
  const users = ids.length
    ? db.prepare("SELECT id,ativo FROM usuarios WHERE id IN (" + ids.map(() => "?").join(",") + ")").all(...ids)
    : [];
  const byId = new Map(users.map((user) => [user.id, user]));
  const current = {
    smallUserId: byId.get(smallId)?.ativo ? smallId : null,
    largeUserId: byId.get(largeId)?.ativo ? largeId : null,
    limit: Number(config.get("tratamento_limite_carlos") || 48),
  };
  return JSON.stringify(current) === JSON.stringify(expected);
}
function photoSnapshot(db) {
  return db.prepare("SELECT id,fotos_quantidade FROM pedidos ORDER BY id").all()
    .map((row) => [row.id, row.fotos_quantidade ?? null]);
}
function writePlan(plan, context) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const visible = core.publicPlan(plan, context);
  visible.pendingCompletionWithoutDate = context.pendingCompletionWithoutDate;
  fs.writeFileSync(PLAN_JSON, JSON.stringify(visible, null, 2) + "\n", "utf8");
  const lines = [
    "# Plano seletivo da reconciliação", "",
    "- Modo: dry-run; nenhuma escrita executada.",
    "- Banco: " + context.databasePath,
    "- Planilha: " + context.workbookPath,
    "- Pedidos no banco: " + visible.databaseOrderCount,
    "- Limites: seleções " + visible.limits.selections + ", editores " + visible.limits.editors + ", observações " + visible.limits.observations + ".",
    "- Seleções elegíveis: " + visible.selectionToApply.length + "; bloqueadas: " + visible.selectionBlocked.length + ".",
    "- Editores a preencher: " + visible.editorToApply.length + "; observações a preencher: " + visible.observationsToApply.length + ".",
    "- Pedidos com alteração: " + visible.ordersTouched + ".",
    "- Previsão de novas atribuições: Henrique " + visible.henriqueAfterSelection + ", Carlos " + visible.carlosAfterSelection
      + ", sem responsável " + visible.unassignedAfterSelection + ".",
    "- Linhas de conclusão sem data exata mantidas pendentes: " + context.pendingCompletionWithoutDate + ".",
    "- Novos pedidos: 0; writes: 0.", "", "## Bloqueios de seleção", "",
  ];
  for (const item of visible.selectionBlocked)
    lines.push("- " + (item.session || "sessão inválida") + " (linha " + item.row + "): " + item.reason);
  lines.push("");
  fs.writeFileSync(PLAN_MD, lines.join("\n"), "utf8");
  return visible;
}
function backupDatabase(db) {
  const backupDirectory = path.join(path.dirname(DATABASE_PATH), "backups");
  fs.mkdirSync(backupDirectory, { recursive: true });
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(FULL)").get();
  if (checkpoint && Number(checkpoint.busy) !== 0) throw new Error("WAL_CHECKPOINT_BUSY");
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  const backupPath = path.join(backupDirectory, "antes-reconciliacao-planilha-legada-" + stamp + ".sqlite3");
  db.exec("VACUUM INTO '" + backupPath.replace(/'/g, "''") + "'");
  const verification = new DatabaseSync(backupPath, { readOnly: true });
  try {
    verification.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    const integrity = verification.prepare("PRAGMA integrity_check").get()?.integrity_check || "unknown";
    const violations = verification.prepare("PRAGMA foreign_key_check").all().length;
    const orders = Number(verification.prepare("SELECT COUNT(*) count FROM pedidos").get().count);
    const liveOrders = Number(db.prepare("SELECT COUNT(*) count FROM pedidos").get().count);
    if (integrity !== "ok" || violations !== 0 || orders !== liveOrders) throw new Error("BACKUP_VALIDATION_FAILED");
  } finally { verification.close(); }
  return { path: backupPath, checkpoint: checkpoint || null };
}
function safeHealth() {
  return Promise.allSettled([
    fetch("http://127.0.0.1:8787/health", { signal: AbortSignal.timeout(6000) }).then((response) => response.ok),
    (async () => {
      const logPath = "E:\\GestaoLogistica_Server_Pilot\\tools\\logs\\cloudflared.stderr.log";
      if (!fs.existsSync(logPath)) return false;
      const log = fs.readFileSync(logPath, "utf8");
      const matches = [...log.matchAll(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/gi)];
      const origin = matches.at(-1)?.[0];
      if (!origin) return false;
      const response = await fetch(origin + "/health", { signal: AbortSignal.timeout(8000) });
      return response.ok;
    })(),
  ]).then((results) => ({
    local: results[0].status === "fulfilled" && results[0].value,
    remote: results[1].status === "fulfilled" && results[1].value,
  }));
}
function completionPendingCount(rows, ordersBySession, duplicates) {
  const later = ["impressao_enviada_em", "impressao_recebida_em", "etiqueta_criada_em", "remessa_id", "postado_em", "entregue_em"];
  let count = 0;
  for (const row of rows) {
    if (!row.complete && !/conclu/i.test(row.situation)) continue;
    const session = core.normalizeSession(row.session);
    if (!session || duplicates.has(session)) continue;
    const order = ordersBySession.get(session);
    if (!order || order.tratamento_concluido_em || later.some((field) => order[field])) continue;
    count += 1;
  }
  return count;
}
function databaseStage(order) {
  if (order.entregue_em) return "entregue";
  if (order.postado_em) return "postado";
  if (order.remessa_id) return "em_remessa";
  if (order.etiqueta_criada_em) return "etiqueta_criada";
  if (order.impressao_recebida_em) return "impressoes_recebidas";
  if (order.impressao_enviada_em) return "em_impressao";
  if (order.tratamento_concluido_em) return "tratamento_concluido";
  if (order.selecao_finalizada_em) return "em_tratamento";
  if (order.link_enviado_em) return "aguardando_selecao";
  if (order.galeria_publicada_em || order.galeria_url) return "galeria_publicada";
  return "sessao_criada";
}
function pendingCompletionRecords(rows, ordersBySession, duplicates) {
  const later = ["impressao_enviada_em", "impressao_recebida_em", "etiqueta_criada_em", "remessa_id", "postado_em", "entregue_em"];
  const records = [];
  for (const row of rows) {
    if (!row.complete && !/conclu/i.test(row.situation)) continue;
    const session = core.normalizeSession(row.session);
    if (!session || duplicates.has(session)) continue;
    const order = ordersBySession.get(session);
    if (!order || order.tratamento_concluido_em || later.some((field) => order[field])) continue;
    records.push({ session, databaseState: databaseStage(order), hasLaterMilestones: later.some((field) => Boolean(order[field])) });
  }
  return records;
}
function writePendingCompletionReport(records) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  const report = { generatedAt: new Date().toISOString(), count: records.length, pending: records };
  fs.writeFileSync(PENDING_JSON, JSON.stringify(report, null, 2) + "\n", "utf8");
  fs.writeFileSync(PENDING_MD, ["# Conclusões legadas sem data exata", "",
    "Casos mantidos pendentes; nenhuma data de conclusão foi inferida.", "",
    "| Sessão | Estado atual no banco | Há milestone posterior |", "|---|---|---|",
    ...records.map((item) => "| " + item.session + " | " + item.databaseState + " | " + (item.hasLaterMilestones ? "sim" : "não") + " |"), ""].join("\n"), "utf8");
  return { json: PENDING_JSON, markdown: PENDING_MD };
}

async function main() {
  const args = process.argv.slice(3);
  const wantsApply = args.includes("--apply");
  const wantsDryRun = args.includes("--dry-run");
  const wantsPostAudit = args.includes("--post-audit");
  if ((wantsApply && wantsDryRun) || (wantsPostAudit && (wantsApply || wantsDryRun)))
    throw new Error("USAGE: node scripts/apply-logistica-reconciliation.cjs [workbook.xlsx] [--dry-run|--apply|--post-audit]");
  const mode = wantsPostAudit ? "post-audit" : wantsApply ? "apply" : "dry-run";
  const [sheet, healthBefore] = await Promise.all([readWorkbook(WORKBOOK_PATH), safeHealth()]);
  const database = readDatabase(DATABASE_PATH, false);
  if (mode === "post-audit") {
    const records = pendingCompletionRecords(sheet.rows, database.ordersBySession, sheet.duplicates);
    const files = writePendingCompletionReport(records);
    let healthReportUpdated = false;
    if (fs.existsSync(RESULT_JSON)) {
      const prior = JSON.parse(fs.readFileSync(RESULT_JSON, "utf8"));
      prior.healthBefore = { local: prior.healthBefore?.local === true, remote: null, remoteVerified: false };
      prior.healthAfter = healthBefore;
      prior.healthAfterObservedAt = new Date().toISOString();
      prior.reports.pendingCompletionJson = files.json;
      prior.reports.pendingCompletionMarkdown = files.markdown;
      fs.writeFileSync(RESULT_JSON, JSON.stringify(prior, null, 2) + "\n", "utf8");
      healthReportUpdated = true;
    }
    if (fs.existsSync(PLAN_JSON)) {
      const priorPlan = JSON.parse(fs.readFileSync(PLAN_JSON, "utf8"));
      priorPlan.healthBefore = { local: priorPlan.healthBefore?.local === true, remote: null, remoteVerified: false };
      priorPlan.healthAfterReconciled = healthBefore;
      priorPlan.healthAfterObservedAt = new Date().toISOString();
      fs.writeFileSync(PLAN_JSON, JSON.stringify(priorPlan, null, 2) + "\n", "utf8");
    }
    const summary = { mode, pendingCompletionWithoutDate: records.length, health: healthBefore, healthReportUpdated, files };
    database.db.close();
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  const mineBefore = countMineForMappings(database.db, database.assignment);
  const photosBefore = photoSnapshot(database.db);
  const dbCount = database.orders.length;
  const pendingCompletionWithoutDate = completionPendingCount(sheet.rows, database.ordersBySession, sheet.duplicates);
  const plan = core.buildPlan({
    rows: sheet.rows, ordersBySession: database.ordersBySession, duplicates: sheet.duplicates,
    assignment: database.assignment, workbookHash: sheet.workbookHash, databaseOrderCount: dbCount,
    databaseIntegrity: database.integrity, foreignKeyViolations: database.foreignKeyViolations,
  });
  const context = {
    workbookPath: WORKBOOK_PATH, databasePath: DATABASE_PATH, workbookHash: sheet.workbookHash,
    workbookSizeBytes: sheet.sizeBytes, workbookModifiedAt: sheet.modifiedAt,
    generatedAt: new Date().toISOString(), mappingStatus: database.mappingStatus,
    pendingCompletionWithoutDate, healthBefore,
  };
  let previousPlan = null;
  if (mode === "apply" && fs.existsSync(PLAN_JSON)) previousPlan = JSON.parse(fs.readFileSync(PLAN_JSON, "utf8"));
  const visiblePlan = writePlan(plan, context);
  if (mode === "dry-run") {
    database.db.close();
    console.log(JSON.stringify({ mode, ...visiblePlan, files: { json: PLAN_JSON, markdown: PLAN_MD } }, null, 2));
    return;
  }
  if (!previousPlan) { database.db.close(); throw new Error("DRY_RUN_PLAN_REQUIRED"); }
  if (previousPlan.planSignature !== plan.planSignature || previousPlan.workbookHash !== sheet.workbookHash) {
    database.db.close();
    throw new Error("PLAN_CHANGED_SINCE_DRY_RUN");
  }
  database.db.close();
  const backupConnection = readDatabase(DATABASE_PATH, true);
  let backup;
  try { backup = backupDatabase(backupConnection.db); } finally { backupConnection.db.close(); }

  const writable = readDatabase(DATABASE_PATH, true);
  const beforeCount = writable.orders.length;
  let applied;
  let appliedPlan;
  try {
    const freshPlan = core.buildPlan({
      rows: sheet.rows, ordersBySession: writable.ordersBySession, duplicates: sheet.duplicates,
      assignment: writable.assignment, workbookHash: sheet.workbookHash, databaseOrderCount: writable.orders.length,
      databaseIntegrity: writable.integrity, foreignKeyViolations: writable.foreignKeyViolations,
    });
    if (freshPlan.planSignature !== previousPlan.planSignature) throw new Error("PLAN_CHANGED_BEFORE_TRANSACTION");
    appliedPlan = freshPlan;
    applied = core.applyPlan(writable.db, freshPlan, {
      validateBeforeApply: (transactionDb) => assignmentStillMatches(transactionDb, writable.assignment),
    });
  } finally { writable.db.close(); }

  const verified = readDatabase(DATABASE_PATH, false);
  const mineAfter = countMineForMappings(verified.db, verified.assignment);
  const photosAfter = photoSnapshot(verified.db);
  const photosUnchanged = JSON.stringify(photosBefore) === JSON.stringify(photosAfter);
  const noNewOrders = beforeCount === verified.orders.length;
  const mineRows = [];
  for (const userId of [verified.assignment.smallUserId, verified.assignment.largeUserId].filter(Boolean)) {
    mineRows.push(...verified.db.prepare("SELECT id,selecao_finalizada_em,tratamento_concluido_em,acompanhamento_status FROM pedidos WHERE tratamento_responsavel_usuario_id=? AND selecao_finalizada_em IS NOT NULL AND tratamento_concluido_em IS NULL AND acompanhamento_status='ativo'")
      .all(userId));
  }
  const mineCountsMatch = mineRows.length === mineAfter.henrique + mineAfter.carlos;
  const noUnselectedOrIneligibleInMine = mineCountsMatch && mineRows.every((row) =>
    Boolean(row.selecao_finalizada_em) && !row.tratamento_concluido_em && row.acompanhamento_status === "ativo");
  const appliedAssignmentsMatch = appliedPlan.selectionCandidates.every((candidate) => {
    const current = verified.db.prepare("SELECT tratamento_responsavel_usuario_id FROM pedidos WHERE id=?").get(candidate.orderId);
    return current && (current.tratamento_responsavel_usuario_id || null) === candidate.assignmentOutcome.assigneeId;
  });
  verified.db.close();
  if (!photosUnchanged || !noNewOrders || !noUnselectedOrIneligibleInMine || !appliedAssignmentsMatch)
    throw new Error("POST_APPLY_INVARIANT_FAILED");
  const healthAfter = await safeHealth();
  const result = {
    mode: "applied", generatedAt: new Date().toISOString(), backup,
    planSignature: plan.planSignature, workbookHash: sheet.workbookHash, result: applied,
    databaseOrderCountBefore: beforeCount, databaseOrderCountAfter: beforeCount,
    photosUnchanged, noNewOrders, noUnselectedOrIneligibleInMine, appliedAssignmentsMatch, mineBefore, mineAfter,
    healthBefore, healthAfter, zeroNonAuthorizedWrites: true,
    reports: { planJson: PLAN_JSON, planMarkdown: PLAN_MD, resultJson: RESULT_JSON },
  };
  fs.writeFileSync(RESULT_JSON, JSON.stringify(result, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(result, null, 2));
}
main().catch((error) => {
  console.error("BLOQUEADO: " + (error && error.message ? error.message : "UNKNOWN_ERROR"));
  process.exitCode = 1;
});
