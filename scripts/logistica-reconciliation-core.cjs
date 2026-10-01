const crypto = require("node:crypto");

const LIMITS = Object.freeze({ selections: 22, editors: 35, observations: 2 });
const LATER_MILESTONES = Object.freeze([
  "tratamento_concluido_em", "impressao_enviada_em", "impressao_recebida_em",
  "etiqueta_criada_em", "postado_em", "entregue_em",
]);

const clean = (value) => String(value ?? "").trim();
const datePart = (value) => clean(value).slice(0, 10);

function normalizeSession(value) {
  const raw = clean(value).toUpperCase().replace(/\s+/g, "");
  const match = raw.match(/^M?(\d{5})$/);
  return match ? `M${match[1]}` : null;
}

function validIsoDate(value) {
  const raw = clean(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return false;
  const date = new Date(`${raw}T12:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === raw;
}

function addCalendarDays(isoDate, days) {
  if (!validIsoDate(isoDate)) return null;
  const date = new Date(`${isoDate}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function snapshotOrder(order) {
  const fields = [
    "id", "revisao", "selecao_finalizada_em", "prazo_tratamento_em", "prazo_maximo_em",
    "editor", "observacoes", "tratamento_atribuicao_modo", "tratamento_responsavel_usuario_id",
    "fotos_quantidade", "acompanhamento_status", "tratamento_concluido_em", "remessa_id",
    ...LATER_MILESTONES,
  ];
  return Object.fromEntries(fields.map((field) => [field, order[field] ?? null]));
}

function selectionBlockReason(record, order) {
  if (record.duplicate) return "BLOCKED_DUPLICATE";
  if (!record.session || !normalizeSession(record.session)) return "BLOCKED_INVALID_SESSION";
  if (!record.selectionDate || !validIsoDate(record.selectionDate)) return "BLOCKED_INVALID_SELECTION_DATE";
  if (!order) return "BLOCKED_ORDER_NOT_FOUND";
  if (order.selecao_finalizada_em) return "BLOCKED_SELECTION_ALREADY_EXISTS";
  const expectedTreatmentDeadline = addCalendarDays(record.selectionDate, 20);
  const expectedMaximumDeadline = addCalendarDays(record.selectionDate, 60);
  for (const [field, expected] of [["prazo_tratamento_em", expectedTreatmentDeadline], ["prazo_maximo_em", expectedMaximumDeadline]]) {
    if (order[field] && datePart(order[field]) !== expected) return "BLOCK_DEADLINE_CONFLICT";
  }
  for (const field of LATER_MILESTONES) {
    if (!order[field]) continue;
    const milestoneDate = datePart(order[field]);
    if (!validIsoDate(milestoneDate) || record.selectionDate > milestoneDate) return "BLOCK_CHRONOLOGY";
  }
  return null;
}

function assignmentOutcome(order, assignment) {
  if (order.acompanhamento_status !== "ativo") return { bucket: "inactive", assigneeId: order.tratamento_responsavel_usuario_id || null, changesAssignee: false };
  if (order.tratamento_concluido_em) return { bucket: "completed", assigneeId: order.tratamento_responsavel_usuario_id || null, changesAssignee: false };
  if (order.tratamento_atribuicao_modo === "manual")
    return { bucket: "manualPreserved", assigneeId: order.tratamento_responsavel_usuario_id || null, changesAssignee: false };
  if (order.tratamento_atribuicao_modo !== "auto")
    return { bucket: "unassigned", assigneeId: null, changesAssignee: Boolean(order.tratamento_responsavel_usuario_id) };
  const rawCount = order.fotos_quantidade;
  const count = rawCount === null || rawCount === undefined || clean(rawCount) === "" ? null : Number(rawCount);
  if (count === null || !Number.isSafeInteger(count) || count < 0)
    return { bucket: "unassigned", assigneeId: null, changesAssignee: Boolean(order.tratamento_responsavel_usuario_id) };
  const assigneeId = count < assignment.limit ? (assignment.smallUserId || null) : (assignment.largeUserId || null);
  if (!assigneeId) return { bucket: "unassigned", assigneeId: null, changesAssignee: Boolean(order.tratamento_responsavel_usuario_id) };
  return { bucket: count < assignment.limit ? "henrique" : "carlos", assigneeId,
    changesAssignee: assigneeId !== (order.tratamento_responsavel_usuario_id || null) };
}

function buildPlan({ rows, ordersBySession, duplicates = new Set(), assignment, workbookHash, databaseOrderCount,
  databaseIntegrity = "ok", foreignKeyViolations = 0 }) {
  if (databaseIntegrity !== "ok" || foreignKeyViolations !== 0)
    throw new Error("DATABASE_INTEGRITY_FAILED");
  const grouped = new Map();
  const blockedSelections = [];
  let rawSelectionCandidateCount = 0;
  let editorCount = 0;
  let observationCount = 0;
  for (const row of rows) {
    const session = normalizeSession(row.session);
    if (!session) {
      if (row.selectionRawPresent || row.selectionDate)
        blockedSelections.push({ session: null, row: row.row, reason: "BLOCKED_INVALID_SESSION" });
      continue;
    }
    if (!grouped.has(session)) grouped.set(session, []);
    grouped.get(session).push({ ...row, session });
  }

  const selectionCandidates = [];
  const editors = [];
  const observations = [];
  const selectedMisses = { duplicates: 0, invalidDates: 0, orderNotFound: 0, alreadySet: 0,
    deadlineConflict: 0, chronology: 0 };
  for (const [session, group] of grouped) {
    const duplicate = duplicates.has(session) || group.length > 1;
    const order = ordersBySession.get(session) || null;
    const row = group.find((item) => item.selectionRawPresent || item.selectionDate) || group[0];
    const hasSelectionInput = group.some((item) => item.selectionRawPresent || item.selectionDate);
    if (duplicate) {
      blockedSelections.push({ session, row: row.row, reason: "BLOCKED_DUPLICATE" });
      selectedMisses.duplicates += 1;
    } else if (hasSelectionInput) {
      if (!row.selectionDate || !validIsoDate(row.selectionDate)) {
        blockedSelections.push({ session, row: row.row, reason: "BLOCKED_INVALID_SELECTION_DATE" });
        selectedMisses.invalidDates += 1;
      } else if (!order) {
        blockedSelections.push({ session, row: row.row, reason: "BLOCKED_ORDER_NOT_FOUND" });
        selectedMisses.orderNotFound += 1;
      } else if (order.selecao_finalizada_em) {
        selectedMisses.alreadySet += 1;
      } else {
        rawSelectionCandidateCount += 1;
        const reason = selectionBlockReason({ ...row, session, duplicate }, order);
        if (reason) {
          blockedSelections.push({ session, row: row.row, reason });
          if (reason === "BLOCK_DEADLINE_CONFLICT") selectedMisses.deadlineConflict += 1;
          if (reason === "BLOCK_CHRONOLOGY") selectedMisses.chronology += 1;
        } else {
          const outcome = assignmentOutcome(order, assignment);
          selectionCandidates.push({
            session, row: row.row, orderId: order.id, expectedRevision: order.revisao,
            selectionDate: row.selectionDate,
            deadlineTreatment: addCalendarDays(row.selectionDate, 20),
            deadlineMaximum: addCalendarDays(row.selectionDate, 60),
            fillTreatmentDeadline: !order.prazo_tratamento_em,
            fillMaximumDeadline: !order.prazo_maximo_em,
            assignmentOutcome: outcome,
            snapshot: snapshotOrder(order),
            sheetValues: row,
            existingData: order,
          });
        }
      }
    }
    if (duplicate || !order) continue;
    if (!clean(order.editor) && clean(row.editor)) {
      editorCount += 1;
      editors.push({ session, row: row.row, orderId: order.id, expectedRevision: order.revisao,
        editorValue: clean(row.editor), snapshot: snapshotOrder(order), sheetValues: row, existingData: order });
    }
    if (!clean(order.observacoes) && clean(row.observations)) {
      observationCount += 1;
      observations.push({ session, row: row.row, orderId: order.id, expectedRevision: order.revisao,
        observationValue: clean(row.observations), snapshot: snapshotOrder(order), sheetValues: row, existingData: order });
    }
  }

  if (rawSelectionCandidateCount > LIMITS.selections) throw new Error("UNEXPECTED_SELECTION_CANDIDATE_COUNT");
  if (editorCount > LIMITS.editors) throw new Error("UNEXPECTED_EDITOR_CANDIDATE_COUNT");
  if (observationCount > LIMITS.observations) throw new Error("UNEXPECTED_OBSERVATION_CANDIDATE_COUNT");

  const touched = new Map();
  for (const candidate of [...selectionCandidates, ...editors, ...observations]) {
    let item = touched.get(candidate.session);
    if (!item) {
      item = { session: candidate.session, orderId: candidate.orderId, expectedRevision: candidate.expectedRevision,
        snapshot: candidate.snapshot, selection: null, editor: null, observations: null };
      touched.set(candidate.session, item);
    }
    if (selectionCandidates.includes(candidate)) item.selection = candidate;
    if (editors.includes(candidate)) item.editor = candidate;
    if (observations.includes(candidate)) item.observations = candidate;
  }
  const outcomeCounts = { henrique: 0, carlos: 0, unassigned: 0, completed: 0, inactive: 0, manualPreserved: 0 };
  for (const candidate of selectionCandidates) outcomeCounts[candidate.assignmentOutcome.bucket] += 1;
  const signaturePayload = {
    workbookHash, databaseOrderCount,
    selections: selectionCandidates.map((item) => [item.session, item.orderId, item.expectedRevision, item.selectionDate,
      item.fillTreatmentDeadline, item.fillMaximumDeadline, item.assignmentOutcome.bucket, item.assignmentOutcome.assigneeId]),
    editors: editors.map((item) => [item.session, item.orderId, item.expectedRevision]),
    observations: observations.map((item) => [item.session, item.orderId, item.expectedRevision]),
    blockedSelections,
  };
  const planSignature = crypto.createHash("sha256").update(JSON.stringify(signaturePayload)).digest("hex");
  return {
    workbookHash, databaseOrderCount, rawSelectionCandidateCount, selectionCandidates, blockedSelections,
    selectedMisses, editors, observations, touchedOrders: [...touched.values()], outcomeCounts, planSignature,
    limits: LIMITS,
    databaseIntegrity, foreignKeyViolations,
  };
}

function publicPlan(plan, context = {}) {
  const selectionToApply = plan.selectionCandidates.map((item) => ({
    session: item.session, sourceRow: item.row, revision: item.expectedRevision,
    selectionDate: item.selectionDate, fillsTreatmentDeadline: item.fillTreatmentDeadline,
    fillsMaximumDeadline: item.fillMaximumDeadline, assignment: item.assignmentOutcome.bucket,
  }));
  return {
    mode: "dry-run",
    generatedAt: new Date().toISOString(),
    ...context,
    limits: plan.limits,
    databaseOrderCount: plan.databaseOrderCount,
    selectionCandidateCountFound: plan.rawSelectionCandidateCount,
    selectionToApply,
    selectionBlocked: plan.blockedSelections,
    selectionBlockedCounts: plan.selectedMisses,
    editorToApply: plan.editors.map((item) => ({ session: item.session, sourceRow: item.row, revision: item.expectedRevision })),
    observationsToApply: plan.observations.map((item) => ({ session: item.session, sourceRow: item.row, revision: item.expectedRevision })),
    ordersTouched: plan.touchedOrders.length,
    assignmentForecast: plan.outcomeCounts,
    henriqueAfterSelection: plan.outcomeCounts.henrique,
    carlosAfterSelection: plan.outcomeCounts.carlos,
    unassignedAfterSelection: plan.outcomeCounts.unassigned,
    completedAfterSelection: plan.outcomeCounts.completed,
    inactiveAfterSelection: plan.outcomeCounts.inactive,
    manualPreservedAfterSelection: plan.outcomeCounts.manualPreserved,
    editorCount: plan.editors.length,
    observationCount: plan.observations.length,
    planSignature: plan.planSignature,
    databaseIntegrity: plan.databaseIntegrity,
    foreignKeyViolations: plan.foreignKeyViolations,
    newOrdersApplied: 0,
    writesExecuted: false,
  };
}

function countMine(db, userId) {
  if (!userId) return 0;
  return Number(db.prepare(`SELECT COUNT(*) total FROM pedidos
    WHERE tratamento_responsavel_usuario_id=? AND selecao_finalizada_em IS NOT NULL
      AND tratamento_concluido_em IS NULL AND acompanhamento_status='ativo'`).get(userId).total || 0);
}

function applyPlan(db, plan, { now = () => new Date().toISOString(), id = () => crypto.randomUUID(),
  beforeEventInsert = null, validateBeforeApply = null } = {}) {
  const result = { ordersTouched: 0, selectionsApplied: 0, editorApplied: 0, observationsApplied: 0,
    assignmentsChanged: 0, changedSincePlan: [], appliedSessions: [], newOrdersApplied: 0 };
  const selectCurrent = db.prepare("SELECT * FROM pedidos WHERE id=? AND sessao=?");
  const eventInsert = db.prepare(`INSERT INTO eventos (id,pedido_id,tipo,descricao,usuario_id,criado_em)
    VALUES (?,?,?,?,NULL,?)`);
  db.exec("BEGIN IMMEDIATE");
  try {
    if (validateBeforeApply && validateBeforeApply(db) !== true) throw new Error("CONFIG_CHANGED_SINCE_PLAN");
    for (const candidate of plan.touchedOrders) {
      const current = selectCurrent.get(candidate.orderId, candidate.session);
      if (!current || current.revisao !== candidate.expectedRevision
        || JSON.stringify(snapshotOrder(current)) !== JSON.stringify(candidate.snapshot)) {
        result.changedSincePlan.push({ session: candidate.session, reason: "CHANGED_SINCE_PLAN" });
        continue;
      }
      const set = [];
      const values = [];
      let assignmentChanged = false;
      if (candidate.selection) {
        if (current.selecao_finalizada_em || !validIsoDate(candidate.selection.selectionDate)) {
          result.changedSincePlan.push({ session: candidate.session, reason: "CHANGED_SINCE_PLAN" });
          continue;
        }
        const block = selectionBlockReason({ session: candidate.session, selectionDate: candidate.selection.selectionDate }, current);
        if (block) {
          result.changedSincePlan.push({ session: candidate.session, reason: "CHANGED_SINCE_PLAN" });
          continue;
        }
        set.push("selecao_finalizada_em=?"); values.push(candidate.selection.selectionDate);
        if (!current.prazo_tratamento_em) { set.push("prazo_tratamento_em=?"); values.push(candidate.selection.deadlineTreatment); }
        if (!current.prazo_maximo_em) { set.push("prazo_maximo_em=?"); values.push(candidate.selection.deadlineMaximum); }
        if (current.tratamento_atribuicao_modo === "auto" && current.acompanhamento_status === "ativo"
          && !current.tratamento_concluido_em) {
          const target = candidate.selection.assignmentOutcome.assigneeId;
          if ((current.tratamento_responsavel_usuario_id || null) !== target) {
            set.push("tratamento_responsavel_usuario_id=?"); values.push(target);
            assignmentChanged = true;
          }
        }
      }
      if (candidate.editor) {
        if (clean(current.editor)) { result.changedSincePlan.push({ session: candidate.session, reason: "CHANGED_SINCE_PLAN" }); continue; }
        set.push("editor=?"); values.push(candidate.editor.editorValue);
      }
      if (candidate.observations) {
        if (clean(current.observacoes)) { result.changedSincePlan.push({ session: candidate.session, reason: "CHANGED_SINCE_PLAN" }); continue; }
        set.push("observacoes=?"); values.push(candidate.observations.observationValue);
      }
      if (!set.length) continue;
      set.push("atualizado_em=?"); values.push(now());
      const update = db.prepare(`UPDATE pedidos SET ${set.join(",")}, revisao=revisao+1 WHERE id=? AND sessao=? AND revisao=?`);
      const updated = update.run(...values, candidate.orderId, candidate.session, candidate.expectedRevision);
      if (Number(updated.changes) !== 1) {
        result.changedSincePlan.push({ session: candidate.session, reason: "CHANGED_SINCE_PLAN" });
        continue;
      }
      result.ordersTouched += 1;
      result.appliedSessions.push(candidate.session);
      if (candidate.selection) {
        result.selectionsApplied += 1;
        const date = candidate.selection.selectionDate.split("-").reverse().join("/");
        beforeEventInsert?.({ type: "reconciliacao_planilha", session: candidate.session });
        eventInsert.run(id(), candidate.orderId, "reconciliacao_planilha",
          `Data de finalização da seleção preenchida pela reconciliação da planilha legada: ${date}.`, now());
      }
      const legacyFields = [];
      if (candidate.editor) { result.editorApplied += 1; legacyFields.push("editor"); }
      if (candidate.observations) { result.observationsApplied += 1; legacyFields.push("observações"); }
      if (legacyFields.length) {
        beforeEventInsert?.({ type: "reconciliacao_planilha", session: candidate.session });
        eventInsert.run(id(), candidate.orderId, "reconciliacao_planilha",
          `Dados legados preenchidos pela reconciliação: ${legacyFields.join(", ")}.`, now());
      }
      if (assignmentChanged) {
        result.assignmentsChanged += 1;
        const description = candidate.selection.assignmentOutcome.assigneeId
          ? current.tratamento_responsavel_usuario_id
            ? "Responsável pelo tratamento recalculado automaticamente conforme a quantidade de fotos."
            : "Responsável pelo tratamento atribuído automaticamente após finalização da seleção."
          : "Atribuição automática removida porque a quantidade confiável de fotos não está disponível.";
        beforeEventInsert?.({ type: "atribuicao_tratamento", session: candidate.session });
        eventInsert.run(id(), candidate.orderId, "atribuicao_tratamento", description, now());
      }
    }
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch {}
    throw error;
  }
}

module.exports = {
  LIMITS, LATER_MILESTONES, normalizeSession, validIsoDate, addCalendarDays,
  snapshotOrder, selectionBlockReason, assignmentOutcome, buildPlan, publicPlan,
  countMine, applyPlan,
};
