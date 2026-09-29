const fs = require("node:fs");
const path = require("node:path");

const MAX_HISTORY_ORDERS = 200;

function normalizeOrderNumber(value) { return String(value ?? "").trim().toLowerCase(); }
function normalizeSession(value) { return String(value ?? "").trim().toUpperCase(); }
function isCancelled(order) { return String(order.descricaoStatus ?? "").trim().toLowerCase() === "cancelado"; }

function validateFrozenInputs(listing, details) {
  if (!listing || listing.stage !== "list" || !Array.isArray(listing.orders)
    || listing.orders.length !== MAX_HISTORY_ORDERS || listing.summary?.pedidosConsiderados !== MAX_HISTORY_ORDERS
    || listing.summary?.duplicatas !== 0) throw new Error("import_plan_listing_invalid");
  if (!details || details.stage !== "details" || !Array.isArray(details.orders)
    || details.orders.length !== MAX_HISTORY_ORDERS || details.summary?.falhas !== 0
    || details.summary?.pedidosProcessados !== MAX_HISTORY_ORDERS) throw new Error("import_plan_details_invalid");
  const listingByNumber = new Map();
  for (const row of listing.orders) {
    const number = String(row.numeroPedido ?? "");
    if (!/^\d+$/.test(number) || listingByNumber.has(number)) throw new Error("import_plan_listing_identity_invalid");
    listingByNumber.set(number, row);
  }
  const detailsByNumber = new Map();
  for (const row of details.orders) {
    const number = String(row.numeroPedidoDigital ?? "");
    const listed = listingByNumber.get(number);
    if (!listed || detailsByNumber.has(number) || String(row.idFotoPedido) !== String(listed.idFotoPedido))
      throw new Error("import_plan_details_identity_invalid");
    if (row.data !== row.dataListagem || row.dataDivergente === true) throw new Error("import_plan_order_date_mismatch");
    detailsByNumber.set(number, row);
  }
  if (detailsByNumber.size !== listingByNumber.size) throw new Error("import_plan_details_incomplete");
  return { listingByNumber, detailsByNumber };
}

function buildImportPlan(listing, details, dbState) {
  const { listingByNumber, detailsByNumber } = validateFrozenInputs(listing, details);
  const excluded = [], eligible = [], manualReview = [], conflicts = [];
  const missingBySession = new Map();
  const eligibleSessionOrders = new Map();
  let cancelledCount = 0, invalidFilenameCount = 0;
  const sourceOrders = listing.orders.map((meta) => detailsByNumber.get(String(meta.numeroPedido)));

  for (const source of sourceOrders) {
    const meta = listingByNumber.get(String(source.numeroPedidoDigital));
    const base = {
      numeroPedidoDigital: String(source.numeroPedidoDigital), data: source.data,
      descricaoStatus: String(meta.descricaoStatus ?? ""), statusCodigo: meta.status,
      arquivosInvalidos: Number(source.arquivosInvalidos) || 0
    };
    invalidFilenameCount += base.arquivosInvalidos;
    if (isCancelled(meta)) {
      cancelledCount++;
      excluded.push({ ...base, reason: "CANCELLED" });
      continue;
    }
    const uniqueSessions = new Map();
    for (const session of source.sessoes || []) {
      const name = normalizeSession(session.sessao);
      if (!/^M\d{5}$/.test(name)) continue;
      const previous = uniqueSessions.get(name);
      if (previous) previous.arquivos += Number(session.arquivos) || 0;
      else uniqueSessions.set(name, { sessao: name, arquivos: Number(session.arquivos) || 0 });
    }
    const relations = [];
    const missingRelations = [];
    for (const session of uniqueSessions.values()) {
      const orderSessionKey = `${normalizeOrderNumber(base.numeroPedidoDigital)}|${session.sessao}`;
      const dbOrder = dbState.sessions.get(session.sessao);
      if (!dbOrder) {
        missingRelations.push({ ...session, classification: "SESSION_NOT_FOUND" });
        const aggregate = missingBySession.get(session.sessao) || { sessao: session.sessao, pedidos: [], arquivos: 0 };
        aggregate.pedidos.push(base.numeroPedidoDigital);
        aggregate.arquivos += session.arquivos;
        missingBySession.set(session.sessao, aggregate);
        continue;
      }
      const existing = dbState.existingAssociations.has(orderSessionKey);
      relations.push({ pedidoId: dbOrder.id, sessao: session.sessao, arquivos: session.arquivos,
        classification: existing ? "EXISTING_RELATION" : "NEW_RELATION", disposition: existing ? "NO_OP" : "INSERT" });
    }
    if (base.numeroPedidoDigital === "112097") {
      manualReview.push({ ...base, reason: "ITEMS_PHOTOS_DIVERGENCE", listedItems: meta.itens,
        returnedPhotos: source.fotosRetornadas, difference: Number(source.fotosRetornadas) - Number(meta.itens),
        validRelationsForReview: relations.map(({ pedidoId, ...relation }) => relation),
        missingRelationsForReview: missingRelations });
      continue;
    }
    if (!relations.length) {
      excluded.push({ ...base, reason: "NO_IMPORTABLE_RELATIONS", missingRelations });
      continue;
    }
    const prior = dbState.existingDigitalOrders.get(normalizeOrderNumber(base.numeroPedidoDigital));
    if (prior && prior.date !== base.data) {
      const conflict = { ...base, reason: "DIGITAL_ORDER_DATE_MISMATCH", existingDate: prior.date,
        relations: relations.map(({ pedidoId, ...relation }) => relation), missingRelations };
      conflicts.push(conflict);
      excluded.push(conflict);
      continue;
    }
    eligible.push({ ...base, classification: prior ? "EXISTING_DIGITAL_ORDER" : "NEW_DIGITAL_ORDER",
      existingDigitalEnvioId: prior?.id ?? null, relations, missingRelations });
    for (const relation of relations) {
      const linkedOrders = eligibleSessionOrders.get(relation.sessao) || new Set();
      linkedOrders.add(base.numeroPedidoDigital);
      eligibleSessionOrders.set(relation.sessao, linkedOrders);
    }
  }

  const relationRows = eligible.flatMap((order) => order.relations);
  const consideredSessions = new Set([...eligibleSessionOrders.keys(), ...missingBySession.keys()]);
  const uniqueMissingSessions = [...missingBySession.values()].map((entry) => ({ ...entry, pedidos: [...new Set(entry.pedidos)].sort() }))
    .sort((a, b) => a.sessao.localeCompare(b.sessao));
  const summary = {
    sourceOrders: sourceOrders.length,
    eligibleOrders: eligible.length,
    excludedCancelled: cancelledCount,
    manualReviewOrders: manualReview.length,
    sessionsNotFound: uniqueMissingSessions.length,
    newDigitalOrders: eligible.filter((order) => order.classification === "NEW_DIGITAL_ORDER").length,
    existingDigitalOrders: eligible.filter((order) => order.classification === "EXISTING_DIGITAL_ORDER").length,
    newRelations: relationRows.filter((relation) => relation.classification === "NEW_RELATION").length,
    existingRelations: relationRows.filter((relation) => relation.classification === "EXISTING_RELATION").length,
    conflicts: conflicts.length,
    sessionsConsidered: consideredSessions.size,
    sessionsFoundInGestao: new Set(relationRows.map((relation) => relation.sessao)).size,
    uniqueMissingSessions: uniqueMissingSessions.length,
    resendSessionsPreserved: [...eligibleSessionOrders.values()].filter((orders) => orders.size > 1).length,
    invalidFilenamesIgnored: invalidFilenameCount,
    excludedWithoutRelations: excluded.filter((order) => order.reason === "NO_IMPORTABLE_RELATIONS").length,
    databaseWrites: 0
  };
  return { generatedAt: new Date().toISOString(), source: "Digital Fotos frozen listing/details", stage: "import-plan",
    summary, eligible, excluded, manualReview, missingSessions: uniqueMissingSessions, conflicts };
}

function readImportPlanDatabase(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  for (const table of ["pedidos", "digital_envios", "digital_envio_itens"])
    if (!tables.has(table)) throw new Error("import_plan_schema_missing");
  const requiredColumns = {
    pedidos: ["id", "sessao"],
    digital_envios: ["id", "numero_pedido_digital", "data_envio", "criado_por_usuario_id", "criado_em", "atualizado_em", "revision"],
    digital_envio_itens: ["id", "digital_envio_id", "pedido_id", "criado_em"]
  };
  for (const [table, required] of Object.entries(requiredColumns)) {
    const columns = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((row) => row.name));
    if (required.some((column) => !columns.has(column))) throw new Error("import_plan_schema_incompatible");
  }
  const sessions = new Map();
  for (const row of db.prepare("SELECT id,sessao FROM pedidos").all()) {
    const key = normalizeSession(row.sessao);
    if (sessions.has(key)) throw new Error("import_plan_session_ambiguous");
    sessions.set(key, { id: row.id });
  }
  const existingDigitalOrders = new Map(db.prepare("SELECT id,numero_pedido_digital,data_envio FROM digital_envios").all()
    .map((row) => [normalizeOrderNumber(row.numero_pedido_digital), { id: row.id, date: row.data_envio }]));
  const existingAssociations = new Set(db.prepare(`SELECT s.numero_pedido_digital,p.sessao FROM digital_envios s
    JOIN digital_envio_itens i ON i.digital_envio_id=s.id JOIN pedidos p ON p.id=i.pedido_id`).all()
    .map((row) => `${normalizeOrderNumber(row.numero_pedido_digital)}|${normalizeSession(row.sessao)}`));
  return { sessions, existingDigitalOrders, existingAssociations };
}

function humanReport(plan) {
  const s = plan.summary;
  return [
    "PLANO DE IMPORTAÇÃO HISTÓRICA — DIGITAL FOTOS",
    `Pedidos analisados: ${s.sourceOrders}`,
    `Elegíveis automaticamente: ${s.eligibleOrders}`,
    `Cancelados excluídos: ${s.excludedCancelled}`,
    `Revisão manual: ${s.manualReviewOrders}`,
    `Pedidos novos: ${s.newDigitalOrders}`,
    `Pedidos já existentes: ${s.existingDigitalOrders}`,
    `Conflitos: ${s.conflicts}`,
    `Sem relações importáveis: ${s.excludedWithoutRelations}`,
    "",
    `Sessões únicas consideradas: ${s.sessionsConsidered}`,
    `Encontradas no Gestão: ${s.sessionsFoundInGestao}`,
    `Ausentes: ${s.uniqueMissingSessions}`,
    `Relações novas: ${s.newRelations}`,
    `Relações existentes / no-op: ${s.existingRelations}`,
    `Sessões reenviadas preservadas: ${s.resendSessionsPreserved}`,
    `Nomes de arquivo inválidos ignorados: ${s.invalidFilenamesIgnored}`,
    "",
    "EXCLUSÕES",
    `Cancelados: ${s.excludedCancelled}`,
    `Pedido 112097 em revisão manual: ${plan.manualReview.map((order) => order.numeroPedidoDigital).join(", ") || "nenhum"}`,
    `Sessões inexistentes: ${plan.missingSessions.map((session) => `${session.sessao} (${session.pedidos.join(", ")})`).join("; ") || "nenhuma"}`,
    `Conflitos: ${plan.conflicts.map((order) => order.numeroPedidoDigital).join(", ") || "nenhum"}`,
    `Pedidos sem relações importáveis: ${plan.excluded.filter((order) => order.reason === "NO_IMPORTABLE_RELATIONS").map((order) => order.numeroPedidoDigital).join(", ") || "nenhum"}`,
    "",
    "SCHEMA / IMPORTAÇÃO FUTURA",
    "digital_envios: numero_pedido_digital, data_envio, criado_por_usuario_id nullable, timestamps e revision.",
    "digital_envio_itens: digital_envio_id e pedido_id por FK; não há campo de quantidade de arquivos.",
    "Não existe coluna própria para historical_digital_import; auditoria pode usar digital_envio_eventos (acao/descricao), sem nova coluna.",
    "Futura execução: backup e PRAGMA integrity_check antes da escrita; transação com rollback; reutilizar pedidos existentes; preservar workflow de pedidos; reexecução idempotente.",
    "",
    `ALTERAÇÕES REALIZADAS: ${s.databaseWrites}`,
    "BANCO CONSULTADO: somente leitura",
    ""
  ].join("\n");
}

function generateImportPlan({ db, outputDir }) {
  const listingPath = path.join(outputDir, "listing.json");
  const detailsPath = path.join(outputDir, "details.json");
  if (!fs.existsSync(listingPath) || !fs.existsSync(detailsPath)) throw new Error("import_plan_sources_missing");
  const listing = JSON.parse(fs.readFileSync(listingPath, "utf8"));
  const details = JSON.parse(fs.readFileSync(detailsPath, "utf8"));
  const plan = buildImportPlan(listing, details, readImportPlanDatabase(db));
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(path.join(outputDir, "import-plan.json"), `${JSON.stringify(plan, null, 2)}\n`, { encoding: "utf8" });
  fs.writeFileSync(path.join(outputDir, "import-plan.txt"), humanReport(plan), { encoding: "utf8" });
  return plan;
}

module.exports = { MAX_HISTORY_ORDERS, buildImportPlan, generateImportPlan, humanReport, readImportPlanDatabase, validateFrozenInputs };
