const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const core = require("../scripts/logistica-reconciliation-core.cjs");

function makeDb() {
  const db = new DatabaseSync(":memory:");
  db.exec([
    "CREATE TABLE pedidos (id TEXT PRIMARY KEY, sessao TEXT NOT NULL, revisao INTEGER NOT NULL DEFAULT 0,",
    "selecao_finalizada_em TEXT, prazo_tratamento_em TEXT, prazo_maximo_em TEXT, editor TEXT, observacoes TEXT,",
    "tratamento_atribuicao_modo TEXT, tratamento_responsavel_usuario_id TEXT, fotos_quantidade INTEGER,",
    "acompanhamento_status TEXT, tratamento_concluido_em TEXT, remessa_id TEXT, impressao_enviada_em TEXT,",
    "impressao_recebida_em TEXT, etiqueta_criada_em TEXT, postado_em TEXT, entregue_em TEXT, atualizado_em TEXT);",
    "CREATE TABLE eventos (id TEXT PRIMARY KEY, pedido_id TEXT NOT NULL REFERENCES pedidos(id), tipo TEXT NOT NULL,",
    "descricao TEXT NOT NULL, usuario_id TEXT, criado_em TEXT NOT NULL)",
  ].join("\n"));
  return db;
}
function insertOrder(db, overrides = {}) {
  const order = {
    id: "order-1", sessao: "M50001", revisao: 0, selecao_finalizada_em: null,
    prazo_tratamento_em: null, prazo_maximo_em: null, editor: null, observacoes: null,
    tratamento_atribuicao_modo: "auto", tratamento_responsavel_usuario_id: null,
    fotos_quantidade: 12, acompanhamento_status: "ativo", tratamento_concluido_em: null,
    remessa_id: null, impressao_enviada_em: null, impressao_recebida_em: null,
    etiqueta_criada_em: null, postado_em: null, entregue_em: null, atualizado_em: "before",
    ...overrides,
  };
  const keys = Object.keys(order);
  db.prepare("INSERT INTO pedidos (" + keys.join(",") + ") VALUES (" + keys.map(() => "?").join(",") + ")")
    .run(...keys.map((key) => order[key]));
  return db.prepare("SELECT * FROM pedidos WHERE id=?").get(order.id);
}
function makePlan(order, rowOverrides = {}, options = {}) {
  const row = {
    row: 7, session: order.sessao, selectionRawPresent: true, selectionDate: "2026-01-01",
    editor: "", observations: "", ...rowOverrides,
  };
  return core.buildPlan({
    rows: [row], ordersBySession: new Map([[core.normalizeSession(order.sessao), order]]),
    duplicates: options.duplicates || new Set(),
    assignment: options.assignment || { smallUserId: "henrique-id", largeUserId: "carlos-id", limit: 48 },
    workbookHash: "fixture-hash", databaseOrderCount: 1,
  });
}
function apply(db, plan, opts = {}) {
  return core.applyPlan(db, plan, {
    now: () => "2026-01-02T12:00:00.000Z",
    id: (() => { let value = 0; return () => "event-" + (++value); })(),
    ...opts,
  });
}

test("selection derives deadlines and automatic assignment with one revision", () => {
  const db = makeDb();
  const order = insertOrder(db, { fotos_quantidade: 47 });
  const result = apply(db, makePlan(order));
  const after = db.prepare("SELECT * FROM pedidos").get();
  assert.equal(after.selecao_finalizada_em, "2026-01-01");
  assert.equal(after.prazo_tratamento_em, "2026-01-21");
  assert.equal(after.prazo_maximo_em, "2026-03-02");
  assert.equal(after.tratamento_responsavel_usuario_id, "henrique-id");
  assert.equal(after.revisao, 1);
  assert.equal(result.selectionsApplied, 1);
  assert.equal(result.assignmentsChanged, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pedidos").get().count, 1);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM eventos").get().count, 2);
  db.close();
});

test("48 photos maps to Carlos; null photos stays unassigned; manual assignment is preserved", () => {
  for (const [photos, expected, mode, assigned] of [
    [48, "carlos-id", "auto", null], [null, null, "auto", null], [5, "manual-id", "manual", "manual-id"],
  ]) {
    const db = makeDb();
    const order = insertOrder(db, { fotos_quantidade: photos, tratamento_atribuicao_modo: mode,
      tratamento_responsavel_usuario_id: assigned });
    apply(db, makePlan(order));
    assert.equal(db.prepare("SELECT tratamento_responsavel_usuario_id value FROM pedidos").get().value, expected);
    db.close();
  }
});

test("selection is blocked by preexisting selection, conflicting deadline, or chronology", () => {
  const cases = [
    [{ selecao_finalizada_em: "2025-12-01" }, null],
    [{ prazo_tratamento_em: "2026-01-22" }, "BLOCK_DEADLINE_CONFLICT"],
    [{ postado_em: "2025-12-31" }, "BLOCK_CHRONOLOGY"],
  ];
  for (const [overrides, expected] of cases) {
    const db = makeDb();
    const order = insertOrder(db, overrides);
    const plan = makePlan(order);
    assert.equal(plan.selectionCandidates.length, 0);
    if (expected) assert.equal(plan.blockedSelections[0].reason, expected);
    else assert.equal(plan.selectedMisses.alreadySet, 1);
    const before = db.prepare("SELECT * FROM pedidos").get();
    apply(db, plan);
    assert.deepEqual(db.prepare("SELECT * FROM pedidos").get(), before);
    db.close();
  }
});

test("unrelated workbook conflicts do not block selection or replace database photos", () => {
  const db = makeDb();
  const order = insertOrder(db, { fotos_quantidade: 16 });
  const plan = makePlan(order, { photos: 999, clientConflict: true, situationConflict: true });
  assert.equal(plan.selectionCandidates.length, 1);
  apply(db, plan);
  assert.equal(db.prepare("SELECT fotos_quantidade value FROM pedidos").get().value, 16);
  assert.equal(db.prepare("SELECT selecao_finalizada_em value FROM pedidos").get().value, "2026-01-01");
  db.close();
});

test("fills blank editor/observations together and never plans over existing values", () => {
  const db = makeDb();
  const blank = insertOrder(db);
  const plan = core.buildPlan({
    rows: [{ row: 7, session: blank.sessao, editor: "PAI/FILHO", observations: "Nota legada" }],
    ordersBySession: new Map([[blank.sessao, blank]]), assignment: { limit: 48 },
    workbookHash: "fixture-hash", databaseOrderCount: 1,
  });
  assert.equal(plan.editors.length, 1);
  assert.equal(plan.observations.length, 1);
  apply(db, plan);
  assert.deepEqual({ ...db.prepare("SELECT editor,observacoes,revisao FROM pedidos").get() },
    { editor: "PAI/FILHO", observacoes: "Nota legada", revisao: 1 });

  const occupied = insertOrder(db, { id: "order-2", sessao: "M50002", editor: "FILHO", observacoes: "Atual" });
  const preservePlan = core.buildPlan({
    rows: [{ row: 8, session: occupied.sessao, editor: "PAI", observations: "Outra" }],
    ordersBySession: new Map([[occupied.sessao, occupied]]), assignment: { limit: 48 },
    workbookHash: "fixture-hash", databaseOrderCount: 2,
  });
  assert.equal(preservePlan.editors.length, 0);
  assert.equal(preservePlan.observations.length, 0);
  db.close();
});

test("duplicate and invalid sessions are never write candidates", () => {
  const db = makeDb();
  const order = insertOrder(db);
  const duplicatePlan = makePlan(order, {}, { duplicates: new Set([order.sessao]) });
  assert.equal(duplicatePlan.selectionCandidates.length, 0);
  assert.equal(duplicatePlan.blockedSelections[0].reason, "BLOCKED_DUPLICATE");
  const invalid = core.buildPlan({
    rows: [{ row: 135, session: "8", selectionRawPresent: true, selectionDate: null, editor: "PAI", observations: "x" }],
    ordersBySession: new Map(), assignment: { limit: 48 }, workbookHash: "fixture-hash", databaseOrderCount: 1,
  });
  assert.equal(invalid.selectionCandidates.length, 0);
  assert.equal(invalid.editors.length, 0);
  assert.equal(invalid.observations.length, 0);
  db.close();
});

test("changed revision is skipped; failure during event insert rolls back all fields", () => {
  const db = makeDb();
  const order = insertOrder(db);
  const changedPlan = makePlan(order);
  db.prepare("UPDATE pedidos SET revisao=revisao+1, editor='changed' WHERE id=?").run(order.id);
  const changed = apply(db, changedPlan);
  assert.equal(changed.changedSincePlan[0].reason, "CHANGED_SINCE_PLAN");
  assert.equal(db.prepare("SELECT selecao_finalizada_em value FROM pedidos").get().value, null);

  db.prepare("UPDATE pedidos SET revisao=0, editor=NULL WHERE id=?").run(order.id);
  const fresh = db.prepare("SELECT * FROM pedidos WHERE id=?").get(order.id);
  assert.throws(() => apply(db, makePlan(fresh), {
    beforeEventInsert: () => { throw new Error("forced event failure"); },
  }), /forced event failure/);
  assert.equal(db.prepare("SELECT selecao_finalizada_em value FROM pedidos").get().value, null);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM eventos").get().count, 0);
  db.close();
});

test("assignment configuration change is rejected inside the write transaction", () => {
  const db = makeDb();
  const order = insertOrder(db);
  const plan = makePlan(order);
  assert.throws(() => apply(db, plan, { validateBeforeApply: () => false }), /CONFIG_CHANGED_SINCE_PLAN/);
  assert.equal(db.prepare("SELECT selecao_finalizada_em value FROM pedidos").get().value, null);
  db.close();
});

test("candidate hard cap aborts plan generation before a transaction", () => {
  const orders = new Map();
  const rows = [];
  for (let index = 1; index <= 23; index += 1) {
    const session = "M" + String(50000 + index).padStart(5, "0");
    const order = {
      id: "id-" + index, sessao: session, revisao: 0, selecao_finalizada_em: null,
      prazo_tratamento_em: null, prazo_maximo_em: null, editor: null, observacoes: null,
      tratamento_atribuicao_modo: "auto", tratamento_responsavel_usuario_id: null,
      fotos_quantidade: 1, acompanhamento_status: "ativo", tratamento_concluido_em: null,
    };
    orders.set(session, order);
    rows.push({ row: index + 6, session, selectionRawPresent: true, selectionDate: "2026-01-01" });
  }
  assert.throws(() => core.buildPlan({
    rows, ordersBySession: orders, assignment: { smallUserId: "h", largeUserId: "c", limit: 48 },
    workbookHash: "fixture-hash", databaseOrderCount: 23,
  }), /UNEXPECTED_SELECTION_CANDIDATE_COUNT/);

  for (const [field, limit, expected] of [["editor", 36, /UNEXPECTED_EDITOR_CANDIDATE_COUNT/],
    ["observations", 3, /UNEXPECTED_OBSERVATION_CANDIDATE_COUNT/]]) {
    const rows2 = [];
    const orders2 = new Map();
    for (let index = 1; index <= limit; index += 1) {
      const session = "M" + String(51000 + index).padStart(5, "0");
      orders2.set(session, { id: "legacy-" + index, sessao: session, revisao: 0, editor: null, observacoes: null });
      rows2.push({ row: index + 6, session, selectionRawPresent: false, selectionDate: null,
        editor: field === "editor" ? "PAI" : "", observations: field === "observations" ? "nota" : "" });
    }
    assert.throws(() => core.buildPlan({ rows: rows2, ordersBySession: orders2, assignment: { limit: 48 },
      workbookHash: "fixture-hash", databaseOrderCount: limit }), expected);
  }
});

test("dry-run planning makes no database writes and tooling cannot insert orders or delete rows", () => {
  const db = makeDb();
  const order = insertOrder(db);
  const beforeOrder = { ...db.prepare("SELECT * FROM pedidos").get() };
  const beforeEvents = db.prepare("SELECT COUNT(*) count FROM eventos").get().count;
  const plan = makePlan(order);
  assert.equal(plan.selectionCandidates.length, 1);
  assert.deepEqual({ ...db.prepare("SELECT * FROM pedidos").get() }, beforeOrder);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM eventos").get().count, beforeEvents);
  assert.equal(db.prepare("SELECT COUNT(*) count FROM pedidos").get().count, 1);
  const sources = [
    fs.readFileSync(require.resolve("../scripts/apply-logistica-reconciliation.cjs"), "utf8"),
    fs.readFileSync(require.resolve("../scripts/logistica-reconciliation-core.cjs"), "utf8"),
  ].join("\n");
  assert.doesNotMatch(sources, /\bINSERT(?:\s+OR\s+\w+)?\s+INTO\s+pedidos\b/i);
  assert.doesNotMatch(sources, /\bDELETE\s+FROM\b/i);
  db.close();
});
