#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const core = require("./core.cjs");
const importPlan = require("./import-plan.cjs");

const DEFAULT_DELAY_MS = 500;
const MAX_HISTORY_ORDERS = 200;
const LIST_PAGE_SIZE = 25;
const MAX_LIST_PAGES = Math.ceil(MAX_HISTORY_ORDERS / LIST_PAGE_SIZE);
const MAX_RETRIES = 2;

function parseArgs(args) {
  const result = { seedStdin: false, dbPath: "", outputDir: path.resolve("work/digital-history"), delayMs: DEFAULT_DELAY_MS, mode: "sample", sampleOrders: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--seed-stdin") result.seedStdin = true;
    else if (arg === "--db") result.dbPath = args[++i] || "";
    else if (arg === "--out") result.outputDir = path.resolve(args[++i] || "work/digital-history");
    else if (arg === "--delay-ms") result.delayMs = Number(args[++i]);
    else if (arg === "--mode") result.mode = args[++i] || "";
    else if (arg === "--sample-orders") result.sampleOrders = (args[++i] || "").split(",").map((value) => value.trim()).filter(Boolean);
    else throw new Error("cli_argument_invalid");
  }
  if (!result.dbPath || !["sample", "list", "details", "import-plan"].includes(result.mode)
    || (result.mode !== "import-plan" && !result.seedStdin)
    || !Number.isSafeInteger(result.delayMs) || result.delayMs < 400 || result.delayMs > 750
    || (result.mode === "sample" && (result.sampleOrders.length !== 3 || result.sampleOrders.some((value) => !/^\d+$/.test(value)) || new Set(result.sampleOrders).size !== 3)))
    throw new Error("cli_arguments_required");
  return result;
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; if (input.length > 2_000_000) reject(new Error("seed_too_large")); });
    process.stdin.on("end", () => resolve(input));
    process.stdin.on("error", () => reject(new Error("seed_read_failed")));
  });
}

function atomicWrite(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, content, { encoding: "utf8", flag: "wx" });
  fs.renameSync(temporary, filePath);
}

function saveCheckpoint(outputDir, payload) {
  atomicWrite(path.join(outputDir, "checkpoint.json"), `${JSON.stringify(payload, null, 2)}\n`);
}

function pause(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function buildForm(fields) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
  return form;
}

function safeFetchError(error) {
  if (error?.name === "TimeoutError" || error?.name === "AbortError") return "API_TIMEOUT";
  return "API_NETWORK_ERROR";
}

async function post(baseUrl, route, headers, fields, delayMs) {
  const endpoint = new URL(route, baseUrl);
  if (endpoint.hostname !== "online-ws.sigi.com.br" || !endpoint.pathname.startsWith(new URL(baseUrl).pathname))
    throw new Error("request_endpoint_invalid");
  const requestHeaders = { ...headers };
  delete requestHeaders["content-type"];
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST", headers: requestHeaders, body: buildForm(fields),
        redirect: "error", signal: AbortSignal.timeout(30_000)
      });
    } catch (error) {
      const code = safeFetchError(error);
      if (attempt < MAX_RETRIES) { await pause(1000 * (attempt + 1)); continue; }
      throw new Error(code);
    }
    const classification = core.classifyApiStatus(response.status);
    if (classification === "SESSION_EXPIRED") throw new Error("SESSION_EXPIRED");
    if (classification === "RATE_LIMITED") throw new Error("RATE_LIMITED");
    if (classification === "UPSTREAM_ERROR" && attempt < MAX_RETRIES) { await pause(1000 * (attempt + 1)); continue; }
    if (classification !== "OK") throw new Error(classification);
    const setCookies = typeof response.headers.getSetCookie === "function" ? response.headers.getSetCookie() : [];
    if (setCookies.length) {
      const cookies = new Map(String(headers.cookie || "").split(/;\s*/).filter(Boolean).map((pair) => {
        const index = pair.indexOf("="); return index > 0 ? [pair.slice(0, index), pair.slice(index + 1)] : [pair, ""];
      }));
      for (const value of setCookies) {
        const pair = value.split(";", 1)[0];
        const index = pair.indexOf("=");
        if (index > 0) cookies.set(pair.slice(0, index), pair.slice(index + 1));
      }
      headers.cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join("; ");
    }
    let raw;
    try { raw = await response.text(); } catch { throw new Error("API_RESPONSE_READ_FAILED"); }
    return core.parseResponsePayload(raw);
  }
  throw new Error("API_RETRY_LIMIT");
}

function fieldsForListing(state, page, count, pageSize = LIST_PAGE_SIZE) {
  return { ...state, pagina: String(page), registrosPorPagina: String(pageSize), isContarRegistros: count ? "true" : "false" };
}

function countInPayload(payload) {
  const root = core.responseObject(payload);
  const raw = root.TotalRegistros ?? root.totalRegistros ?? payload.TotalRegistros ?? payload.totalRegistros;
  const count = Number(raw);
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function locateDigitalShipments(db) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name));
  if (!tables.has("pedidos")) throw new Error("gestao_orders_table_missing");
  const sessions = db.prepare("SELECT sessao FROM pedidos").all().map((row) => String(row.sessao).toUpperCase());
  const existingSessions = new Set(sessions);
  const existingDigitalOrders = new Map();
  const existingAssociations = new Set();
  if (tables.has("digital_envios")) {
    for (const row of db.prepare("SELECT id,numero_pedido_digital,data_envio FROM digital_envios").all())
      existingDigitalOrders.set(String(row.numero_pedido_digital).toLowerCase(), { id: row.id, date: row.data_envio });
  }
  if (tables.has("digital_envios") && tables.has("digital_envio_itens")) {
    const rows = db.prepare(`SELECT s.numero_pedido_digital,p.sessao FROM digital_envios s
      JOIN digital_envio_itens i ON i.digital_envio_id=s.id JOIN pedidos p ON p.id=i.pedido_id`).all();
    for (const row of rows) existingAssociations.add(`${String(row.numero_pedido_digital).toLowerCase()}|${String(row.sessao).toUpperCase()}`);
  }
  return { tables, existingSessions, existingDigitalOrders, existingAssociations };
}

function annotateAgainstDatabase(order, dbState) {
  const normalizedNumber = order.numeroPedidoDigital.toLowerCase();
  const prior = dbState.existingDigitalOrders.get(normalizedNumber);
  const existingLinks = order.sessoes.filter((entry) => dbState.existingAssociations.has(`${normalizedNumber}|${entry.sessao.toUpperCase()}`));
  const existingSessionsCount = order.sessoes.filter((entry) => dbState.existingSessions.has(entry.sessao.toUpperCase())).length;
  const sessionCount = order.sessoes.length;
  let idempotency = "NOVO";
  if (prior) idempotency = existingLinks.length === sessionCount && prior.date === order.data ? "NO_OP" : "CONFLITO";
  return {
    ...order,
    data: core.toIsoDateWithoutLocalShift(order.dataPedidoMiliegundos),
    sessoes: order.sessoes.map((entry) => ({ ...entry, existeNoGestao: dbState.existingSessions.has(entry.sessao.toUpperCase()) })),
    sessoesEncontradasNoGestao: existingSessionsCount,
    sessoesNaoEncontradasNoGestao: sessionCount - existingSessionsCount,
    pedidoDigitalJaExiste: Boolean(prior),
    associacoesExistentes: existingLinks.length,
    associacoesNovas: sessionCount - existingLinks.length,
    idempotencia: idempotency
  };
}

function makeSummary(orders, expectedTotal) {
  const statuses = { ativos: 0, cancelados: 0, semConteudo: 0, semSessaoExtraivel: 0, outrosStatus: 0 };
  const allSessions = new Set(), foundSessions = new Set(), missingSessions = new Set(), sessionOrders = new Map();
  let files = 0, invalidFiles = 0;
  let digitalExisting = 0, digitalNew = 0, noOp = 0, conflicts = 0, associations = 0;
  for (const order of orders) {
    if (order.classification === "CANCELADO") statuses.cancelados++;
    else if (order.classification === "SEM_CONTEUDO") statuses.semConteudo++;
    else if (order.classification === "CANDIDATO") statuses.ativos++;
    else if (order.classification === "SEM_SESSAO_EXTRAIVEL") statuses.semSessaoExtraivel++;
    else statuses.outrosStatus++;
    files += order.arquivosValidos;
    invalidFiles += order.arquivosInvalidos;
    associations += order.sessoes.length;
    if (order.pedidoDigitalJaExiste) digitalExisting++; else digitalNew++;
    if (order.idempotencia === "NO_OP") noOp++;
    if (order.idempotencia === "CONFLITO") conflicts++;
    for (const session of order.sessoes) {
      allSessions.add(session.sessao);
      (session.existeNoGestao ? foundSessions : missingSessions).add(session.sessao);
      sessionOrders.set(session.sessao, (sessionOrders.get(session.sessao) || 0) + 1);
    }
  }
  return {
    pedidosEncontrados: expectedTotal,
    pedidosProcessados: orders.length,
    pedidosConsiderados: orders.length,
    ...statuses,
    sessoesUnicas: allSessions.size,
    sessoesEncontradasNoGestao: foundSessions.size,
    sessoesNaoEncontradasNoGestao: missingSessions.size,
    associacoesDigitalSessao: associations,
    pedidosDigitalJaExistentes: digitalExisting,
    pedidosDigitalNovos: digitalNew,
    pedidosNoOp: noOp,
    pedidosConflitantes: conflicts,
    arquivosValidos: files,
    arquivosInvalidos: invalidFiles,
    sessoesEmMultiplosPedidos: [...sessionOrders.values()].filter((n) => n > 1).length,
    errosApi: 0,
    alteracoesNoBanco: 0
  };
}

function buildDetailsSummary(orders, listingOrders) {
  const listingByNumber = new Map(listingOrders.map((order) => [String(order.numeroPedido), order]));
  const sessions = new Map();
  const divergences = [], invalidByOrder = [], otherStatusOrders = [], dateMismatches = [];
  const activeSessions = new Set(), cancelledSessions = new Set();
  let activeProcessed = 0, cancelledProcessed = 0, otherProcessed = 0;
  let files = 0, photoRows = 0, invalidFiles = 0, associations = 0, cancelledWithPhotos = 0;
  let equalItemsPhotos = 0, divergentItemsPhotos = 0;
  for (const order of orders) {
    const listed = listingByNumber.get(String(order.numeroPedidoDigital));
    if (!listed) throw new Error("details_listing_order_missing");
    const category = classifyListedOrder(listed);
    const orderFiles = order.arquivosExtraidos;
    files += orderFiles;
    photoRows += order.fotosRetornadas;
    invalidFiles += order.arquivosInvalidos;
    associations += order.sessoes.length;
    if (order.arquivosInvalidos) invalidByOrder.push({ numeroPedidoDigital: order.numeroPedidoDigital, arquivosInvalidos: order.arquivosInvalidos });
    if (order.dataDivergente) dateMismatches.push({ numeroPedidoDigital: order.numeroPedidoDigital, dataListagem: order.dataListagem, dataDetalhe: order.data });
    if (listed.itens === order.fotosRetornadas) equalItemsPhotos++;
    else {
      divergentItemsPhotos++;
      divergences.push({ numeroPedidoDigital: order.numeroPedidoDigital, itens: listed.itens,
        fotos: order.fotosRetornadas, diferenca: order.fotosRetornadas - listed.itens });
    }
    if (category === "ATIVO_CANDIDATO") activeProcessed++;
    else if (category === "CANCELADO") {
      cancelledProcessed++;
      if (order.fotosRetornadas > 0) cancelledWithPhotos++;
    } else if (category === "OUTRO_STATUS") {
      otherProcessed++;
      const rawStatusCode = order.statusCodigo ?? listed.status;
      otherStatusOrders.push({ numeroPedidoDigital: order.numeroPedidoDigital,
        statusCodigo: Number.isFinite(Number(rawStatusCode)) ? Number(rawStatusCode) : rawStatusCode,
        descricaoStatus: order.status || listed.descricaoStatus,
        data: order.data, itens: listed.itens, fotos: order.fotosRetornadas, sessoes: order.sessoes });
    }
    for (const session of order.sessoes) {
      const existing = sessions.get(session.sessao) || { sessao: session.sessao,
        existeNoGestao: session.existeNoGestao, pedidos: new Set(), dataMaisRecente: null, arquivos: 0 };
      existing.pedidos.add(order.numeroPedidoDigital);
      existing.arquivos += session.arquivos;
      if (!existing.dataMaisRecente || order.data > existing.dataMaisRecente) existing.dataMaisRecente = order.data;
      sessions.set(session.sessao, existing);
      if (category === "ATIVO_CANDIDATO") activeSessions.add(session.sessao);
      if (category === "CANCELADO") cancelledSessions.add(session.sessao);
    }
  }
  const allSessions = [...sessions.values()].map((session) => ({ ...session, pedidos: [...session.pedidos] }));
  const missingSessions = allSessions.filter((session) => !session.existeNoGestao);
  const sessionsAlsoActive = [...cancelledSessions].filter((session) => activeSessions.has(session)).length;
  const sessionsOnlyCancelled = [...cancelledSessions].filter((session) => !activeSessions.has(session)).length;
  return {
    pedidosEsperados: listingOrders.length, pedidosProcessados: orders.length, falhas: listingOrders.length - orders.length,
    ativosProcessados: activeProcessed, canceladosProcessados: cancelledProcessed, outrosProcessados: otherProcessed,
    arquivosEncontrados: files, fotosRetornadas: photoRows, arquivosInvalidos: invalidFiles,
    associacoesDigitalSessao: associations, sessoesUnicas: allSessions.length,
    sessoesEncontradasNoGestao: allSessions.filter((session) => session.existeNoGestao).length,
    sessoesNaoEncontradasNoGestao: missingSessions.length,
    pedidosComMultiplasSessoes: orders.filter((order) => order.sessoes.length > 1).length,
    sessoesEmMultiplosPedidos: allSessions.filter((session) => session.pedidos.length > 1).length,
    pedidosSemSessaoExtraivel: orders.filter((order) => order.sessoes.length === 0).map((order) => order.numeroPedidoDigital),
    arquivosInvalidosPorPedido: invalidByOrder,
    itensFotosIguais: equalItemsPhotos, itensFotosDivergentes: divergentItemsPhotos, divergenciasItensFotos: divergences,
    sessoesNaoEncontradas: missingSessions,
    sessoesEmMultiplosPedidosDetalhe: allSessions.filter((session) => session.pedidos.length > 1),
    cancelados: { processados: cancelledProcessed, comFotos: cancelledWithPhotos,
      sessoesUnicas: cancelledSessions.size, sessoesTambemEmAtivos: sessionsAlsoActive,
      sessoesSomenteEmCancelados: sessionsOnlyCancelled },
    outrosStatus: otherStatusOrders,
    identityMismatches: 0, dateMismatches, errosApi: 0, alteracoesNoBanco: 0
  };
}

function detailsHumanReport(summary) {
  const lines = [
    "DIGITAL FOTOS — DETALHES DOS 200",
    `Pedidos esperados: ${summary.pedidosEsperados}`,
    `Pedidos processados: ${summary.pedidosProcessados}`,
    `Falhas: ${summary.falhas}`,
    "",
    `Ativos processados: ${summary.ativosProcessados}`,
    `Cancelados processados: ${summary.canceladosProcessados}`,
    `Outros: ${summary.outrosProcessados}`,
    "",
    `Arquivos encontrados: ${summary.arquivosEncontrados}`,
    `Fotos retornadas: ${summary.fotosRetornadas}`,
    `Sessões únicas: ${summary.sessoesUnicas}`,
    `Associações Digital ↔ Sessão: ${summary.associacoesDigitalSessao}`,
    `Sessões existentes no Gestão: ${summary.sessoesEncontradasNoGestao}`,
    `Sessões não encontradas no Gestão: ${summary.sessoesNaoEncontradasNoGestao}`,
    `Pedidos com múltiplas sessões: ${summary.pedidosComMultiplasSessoes}`,
    `Sessões em múltiplos pedidos: ${summary.sessoesEmMultiplosPedidos}`,
    `Arquivos inválidos: ${summary.arquivosInvalidos}`,
    `Pedidos sem sessão extraível: ${summary.pedidosSemSessaoExtraivel.length}`,
    `Itens/Fotos iguais: ${summary.itensFotosIguais}`,
    `Itens/Fotos divergentes: ${summary.itensFotosDivergentes}`,
    `Identity mismatch: ${summary.identityMismatches}`,
    `Date mismatch: ${summary.dateMismatches.length}`,
    `Erros API: ${summary.errosApi}`,
    "",
    `Cancelados com fotos: ${summary.cancelados.comFotos}`,
    `Sessões únicas nos cancelados: ${summary.cancelados.sessoesUnicas}`,
    `Sessões dos cancelados também em ativos: ${summary.cancelados.sessoesTambemEmAtivos}`,
    `Sessões somente em cancelados: ${summary.cancelados.sessoesSomenteEmCancelados}`,
    "",
    "DIVERGÊNCIAS ITENS/FOTOS (pedido, itens, fotos, diferença):",
    ...summary.divergenciasItensFotos.map((item) => `${item.numeroPedidoDigital}: ${item.itens}, ${item.fotos}, ${item.diferenca}`),
    "",
    "SESSÕES EXTRAÍDAS DA DIGITAL QUE NÃO EXISTEM NO GESTÃO (sessão, pedidos, data mais recente, arquivos):",
    ...summary.sessoesNaoEncontradas.map((item) => `${item.sessao}: ${item.pedidos.join(", ")}; ${item.dataMaisRecente}; ${item.arquivos}`),
    "",
    "SESSÕES PRESENTES EM MÚLTIPLOS PEDIDOS (sessão: pedidos):",
    ...summary.sessoesEmMultiplosPedidosDetalhe.map((item) => `${item.sessao}: ${item.pedidos.join(", ")}`),
    "",
    "ARQUIVOS INVÁLIDOS POR PEDIDO (pedido: quantidade):",
    ...summary.arquivosInvalidosPorPedido.map((item) => `${item.numeroPedidoDigital}: ${item.arquivosInvalidos}`),
    "",
    "OUTRO STATUS (pedido, código, descrição, data, itens, fotos, sessões):",
    ...summary.outrosStatus.map((item) => `${item.numeroPedidoDigital}: ${item.statusCodigo}; ${item.descricaoStatus}; ${item.data}; ${item.itens}; ${item.fotos}; ${item.sessoes.map((s) => `${s.sessao} (${s.arquivos})`).join(", ")}`),
    "",
    "ALTERAÇÕES NO BANCO: 0"
  ];
  return lines.join("\n") + "\n";
}

function humanReport(report) {
  const s = report.summary;
  const lines = [
    "DIGITAL FOTOS — DRY RUN",
    `Pedidos encontrados: ${s.pedidosEncontrados ?? "não confirmado"}`,
  ];
  if (s.limiteConfigurado !== undefined) lines.push(`Limite configurado: ${s.limiteConfigurado}`);
  if (s.pedidosDisponiveis !== undefined) lines.push(`Pedidos disponíveis na Digital: ${s.pedidosDisponiveis ?? "não informado"}`);
  if (s.pedidosConsiderados !== undefined) lines.push(`Pedidos considerados nesta execução: ${s.pedidosConsiderados}`);
  if (s.pedidosIgnoradosPorLimiteHistorico !== undefined) lines.push(`Pedidos ignorados por limite histórico: ${s.pedidosIgnoradosPorLimiteHistorico ?? "não calculável"}`);
  if (s.paginasConsultadas !== undefined) lines.push(`Páginas consultadas: ${s.paginasConsultadas}`);
  if (s.primeiroPedidoConsiderado !== undefined) lines.push(`Primeiro pedido considerado: ${s.primeiroPedidoConsiderado ?? "nenhum"}`);
  if (s.ultimoPedidoConsiderado !== undefined) lines.push(`Último pedido considerado: ${s.ultimoPedidoConsiderado ?? "nenhum"}`);
  if (s.duplicatasNumeroPedido !== undefined) lines.push(`NumeroPedido duplicados: ${s.duplicatasNumeroPedido}`);
  if (s.duplicatasIdFotoPedido !== undefined) lines.push(`IdFotoPedido duplicados: ${s.duplicatasIdFotoPedido}`);
  if (s.paginasInconsistentes !== undefined) lines.push(`Páginas inconsistentes: ${s.paginasInconsistentes}`);
  lines.push(
    `Pedidos processados: ${s.pedidosProcessados}`,
    `Ativos/candidatos: ${s.ativos}`,
    `Cancelados: ${s.cancelados}`,
    `Sem conteúdo: ${s.semConteudo}`,
    `Sem sessão extraível: ${s.semSessaoExtraivel}`,
    `Outros status: ${s.outrosStatus}`,
    `Sessões únicas: ${s.sessoesUnicas}`,
    `Sessões encontradas no Gestão: ${s.sessoesEncontradasNoGestao}`,
    `Sessões não encontradas: ${s.sessoesNaoEncontradasNoGestao}`,
    `Associações Digital ↔ sessão: ${s.associacoesDigitalSessao}`,
    `Pedidos Digital já existentes: ${s.pedidosDigitalJaExistentes}`,
    `Pedidos Digital novos: ${s.pedidosDigitalNovos}`,
    `No-op: ${s.pedidosNoOp}`,
    `Conflitos: ${s.pedidosConflitantes}`,
    `Sessões em múltiplos pedidos: ${s.sessoesEmMultiplosPedidos}`,
    `Arquivos com sessão inválida: ${s.arquivosInvalidos}`,
    `Erros API: ${s.errosApi}`,
    "ALTERAÇÕES NO BANCO: 0"
  );
  return lines.join("\n") + "\n";
}

function validateSample(detail, listRecord) {
  const expectedDate = core.toIsoDateWithoutLocalShift(listRecord.dataPedidoMiliegundos);
  if (detail.numeroPedidoDigital !== String(listRecord.numeroPedido) || String(detail.idFotoPedido) !== String(listRecord.idFotoPedido)
    || detail.data !== expectedDate || detail.itensInformados !== listRecord.itens
    || detail.arquivosExtraidos !== listRecord.itens)
    throw new Error("sample_reference_mismatch");
}

function classifyListedOrder(order) {
  const statusText = `${order.status} ${order.descricaoStatus}`.toLowerCase();
  if (statusText.includes("cancelad")) return "CANCELADO";
  if (order.itens === 0) return "SEM_CONTEUDO";
  if (statusText.includes("não conferido") || statusText.includes("nao conferido")) return "ATIVO_CANDIDATO";
  return "OUTRO_STATUS";
}

function summarizeListedOrders(orders) {
  const result = { ativos: 0, cancelados: 0, semItens: 0, outrosStatus: 0, pedidosProcessados: orders.length };
  for (const order of orders) {
    const classification = classifyListedOrder(order);
    if (classification === "CANCELADO") result.cancelados++;
    else if (classification === "SEM_CONTEUDO") result.semItens++;
    else if (classification === "ATIVO_CANDIDATO") result.ativos++;
    else result.outrosStatus++;
  }
  return result;
}

async function fetchLatestListing(seed, state, options, onPage = () => {}) {
  let sessionState = { ...state };
  const collected = await core.collectLatestOrderWindow(async (page, count) => {
    if (page > 1) await pause(options.delayMs);
    checkInterrupted();
    const payload = await post(seed.baseUrl, "Pedido/Pedidos", seed.headers,
      fieldsForListing(sessionState, page, count, LIST_PAGE_SIZE), options.delayMs);
    sessionState = core.updateDigitalSessionState(sessionState, payload);
    return core.parseOrderList(payload);
  }, { pageSize: LIST_PAGE_SIZE, maxOrders: MAX_HISTORY_ORDERS, onPage });
  const summary = core.summarizeOrderList(collected.orders, collected.availableTotal);
  if (summary.duplicates.length) throw new Error("orders_duplicate_ids_or_numbers");
  return { ...collected, sessionState, summary };
}

async function runSample(seed, state, dbState, options, checkpointRef) {
  const payload = await post(seed.baseUrl, "Pedido/Pedidos", seed.headers, fieldsForListing(state, 1, true), options.delayMs);
  checkInterrupted();
  let sessionState = core.updateDigitalSessionState(state, payload);
  const page = core.parseOrderList(payload);
  const selected = new Map(page.orders.map((order) => [String(order.numeroPedido), order]));
  if (options.sampleOrders.some((number) => !selected.has(number))) throw new Error("sample_orders_missing");
  const summary = core.summarizeOrderList(page.orders, page.totalRegistros);
  if (summary.duplicates.length) throw new Error("orders_duplicate_ids_or_numbers");
  process.stdout.write(`[LIST] Página 1 — ${page.orders.length} pedidos; total ${page.totalRegistros ?? "não informado"}\n`);
  const extracted = [];
  for (let i = 0; i < options.sampleOrders.length; i++) {
    checkInterrupted();
    if (i > 0) await pause(options.delayMs);
    const meta = selected.get(options.sampleOrders[i]);
    const details = await post(seed.baseUrl, "Pedido/DadosPedido", seed.headers,
      { ...sessionState, idFotoPedido: String(meta.idFotoPedido), isResumo: "false" }, options.delayMs);
    sessionState = core.updateDigitalSessionState(sessionState, details);
    const normalized = core.extractDetail(details, meta);
    normalized.data = core.toIsoDateWithoutLocalShift(normalized.dataPedidoMiliegundos);
    validateSample(normalized, meta);
    const annotated = annotateAgainstDatabase(normalized, dbState);
    extracted.push(annotated);
    checkpointRef.orders = extracted;
    checkpointRef.processed = extracted.length;
    saveCheckpoint(options.outputDir, checkpointRef);
    process.stdout.write(`[DETAIL] ${i + 1}/${options.sampleOrders.length} — Digital ${normalized.numeroPedidoDigital} — ${normalized.arquivosValidos} arquivos — ${normalized.sessoes.length} sessões\n`);
  }
  const report = { generatedAt: new Date().toISOString(), source: "Digital Fotos", stage: "sample", expectedTotal: page.totalRegistros,
    summary: makeSummary(extracted, page.totalRegistros), orders: extracted };
  atomicWrite(path.join(options.outputDir, "dry-run.json"), `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(path.join(options.outputDir, "dry-run.txt"), humanReport(report));
  checkpointRef.completed = true;
  checkpointRef.summary = report.summary;
  saveCheckpoint(options.outputDir, checkpointRef);
  process.stdout.write(humanReport(report));
}

async function runDetails(seed, state, db, options, checkpointRef) {
  const listingPath = path.join(options.outputDir, "listing.json");
  if (!fs.existsSync(listingPath)) throw new Error("details_stage_requires_listing_checkpoint");
  const listing = JSON.parse(fs.readFileSync(listingPath, "utf8"));
  if (!listing?.summary || !Array.isArray(listing.orders) || listing.summary.duplicatas !== 0
    || listing.orders.length !== MAX_HISTORY_ORDERS || listing.summary.pedidosConsiderados !== MAX_HISTORY_ORDERS)
    throw new Error("listing_checkpoint_invalid");
  const dbState = locateDigitalShipments(db);
  const detailsCheckpointPath = path.join(options.outputDir, "details-checkpoint.json");
  let previous = { orders: [] };
  if (fs.existsSync(detailsCheckpointPath)) {
    try { previous = JSON.parse(fs.readFileSync(detailsCheckpointPath, "utf8")); } catch { throw new Error("details_checkpoint_invalid"); }
  }
  const allowedOrders = new Map(listing.orders.map((meta) => [String(meta.numeroPedido), meta]));
  const previousOrders = Array.isArray(previous.orders) ? previous.orders : [];
  if (previousOrders.length > MAX_HISTORY_ORDERS || previousOrders.some((order) => !allowedOrders.has(String(order.numeroPedidoDigital))))
    throw new Error("details_checkpoint_invalid");
  const completed = new Map(previousOrders.map((order) => [String(order.numeroPedidoDigital), order]));
  checkpointRef.stage = "details";
  checkpointRef.processed = completed.size;
  checkpointRef.completed = false;
  checkpointRef.orders = [...completed.values()];
  let sessionState = { ...state };
  let count = 0;
  for (const meta of listing.orders) {
    checkInterrupted();
    if (completed.has(String(meta.numeroPedido))) continue;
    if (count > 0) await pause(options.delayMs);
    const payload = await post(seed.baseUrl, "Pedido/DadosPedido", seed.headers,
      { ...sessionState, idFotoPedido: String(meta.idFotoPedido), isResumo: "false" }, options.delayMs);
    sessionState = core.updateDigitalSessionState(sessionState, payload);
    const detail = core.extractDetail(payload, meta);
    detail.data = core.toIsoDateWithoutLocalShift(detail.dataPedidoMiliegundos);
    detail.dataListagem = core.toIsoDateWithoutLocalShift(meta.dataPedidoMiliegundos);
    detail.dataDivergente = detail.data !== detail.dataListagem;
    detail.itensListagem = meta.itens;
    detail.itensFotosClassificacao = meta.itens === detail.fotosRetornadas ? "IGUAL" : "DIVERGENTE";
    completed.set(detail.numeroPedidoDigital, annotateAgainstDatabase(detail, dbState));
    count++;
    checkpointRef.stage = "details";
    checkpointRef.processed = completed.size;
    checkpointRef.completed = false;
    checkpointRef.orders = [...completed.values()];
    atomicWrite(detailsCheckpointPath, `${JSON.stringify(checkpointRef, null, 2)}\n`);
    process.stdout.write(`[DETAIL] ${completed.size}/${listing.orders.length} — Digital ${detail.numeroPedidoDigital} — ${detail.itensInformados} itens — ${detail.sessoes.length} sessões\n`);
  }
  const resultOrders = listing.orders.map((meta) => completed.get(String(meta.numeroPedido))).filter(Boolean);
  if (resultOrders.length !== listing.orders.length) throw new Error("details_checkpoint_incomplete");
  const detailSummary = buildDetailsSummary(resultOrders, listing.orders);
  const report = { generatedAt: new Date().toISOString(), source: "Digital Fotos", stage: "details",
    expectedTotal: listing.summary.totalRegistros, summary: {
      ...detailSummary, limiteConfigurado: MAX_HISTORY_ORDERS,
      pedidosDisponiveis: listing.summary.pedidosDisponiveis,
      pedidosIgnoradosPorLimiteHistorico: listing.summary.pedidosIgnoradosPorLimiteHistorico
    }, orders: resultOrders };
  atomicWrite(path.join(options.outputDir, "dry-run.json"), `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(path.join(options.outputDir, "details.json"), `${JSON.stringify(report, null, 2)}\n`);
  atomicWrite(path.join(options.outputDir, "details.txt"), detailsHumanReport(report.summary));
  atomicWrite(path.join(options.outputDir, "dry-run.txt"), detailsHumanReport(report.summary));
  atomicWrite(detailsCheckpointPath, `${JSON.stringify({ ...checkpointRef, stage: "details", processed: resultOrders.length,
    completed: true, summary: report.summary, orders: resultOrders }, null, 2)}\n`);
  saveCheckpoint(options.outputDir, { formatVersion: 1, stage: "details", processed: resultOrders.length, completed: true,
    summary: report.summary, orders: resultOrders });
  process.stdout.write(detailsHumanReport(report.summary));
}

function sanitizedError(error) {
  const known = new Set(["SESSION_EXPIRED", "RATE_LIMITED", "UPSTREAM_ERROR", "HTTP_ERROR", "API_TIMEOUT", "API_NETWORK_ERROR", "API_RESPONSE_READ_FAILED", "response_json_invalid", "response_schema_invalid", "orders_schema_invalid", "detail_schema_invalid", "detail_identity_mismatch", "detail_groups_invalid", "orders_duplicate_ids_or_numbers", "sample_orders_missing", "db_read_failed", "cli_arguments_required", "cli_argument_invalid", "seed_too_large", "seed_read_failed", "seed_shell_syntax", "seed_not_curl", "seed_url_or_body_missing", "seed_url_invalid", "seed_host_invalid", "seed_url_query_not_supported", "seed_endpoint_invalid", "seed_content_type_invalid", "seed_multipart_boundary_missing", "seed_state_missing", "unsafe_curl_option", "request_endpoint_invalid", "gestao_orders_table_missing", "USER_INTERRUPTED", "pagination_limits_invalid", "pagination_total_changed", "pagination_early_empty", "pagination_total_mismatch", "pagination_safety_limit", "listing_checkpoint_invalid", "details_checkpoint_invalid", "details_checkpoint_incomplete", "details_listing_order_missing"]);
  return known.has(error?.message) ? error.message : "EXTRACTOR_FAILED";
}

let interrupted = false;
process.on("SIGINT", () => { interrupted = true; process.stderr.write("\nParada solicitada; salvando checkpoint sanitizado.\n"); });
function checkInterrupted() { if (interrupted) throw new Error("USER_INTERRUPTED"); }

async function run() {
  let options, seed, db, orders = [];
  let checkpoint = { formatVersion: 1, stage: "sample", generatedAt: new Date().toISOString(), orders: [], processed: 0 };
  try {
    options = parseArgs(process.argv.slice(2));
    db = new DatabaseSync(path.resolve(options.dbPath), { readOnly: true });
    db.exec("PRAGMA query_only=ON");
    if (options.mode === "import-plan") {
      const plan = importPlan.generateImportPlan({ db, outputDir: options.outputDir });
      process.stdout.write(importPlan.humanReport(plan));
      return;
    }
    seed = core.parseCurlSeed(await readStdin());
    const state = { ...seed.fields };
    const headers = seed.headers;
    const dbState = locateDigitalShipments(db);

    if (options.mode === "sample") {
      await runSample(seed, state, dbState, options, checkpoint);
    } else if (options.mode === "list") {
      const result = await fetchLatestListing(seed, state, options, ({ page, received, processed, limit }) => {
        process.stdout.write(`[LIST] Página ${page}/${MAX_LIST_PAGES} — ${received} recebidos; ${processed}/${limit} considerados\n`);
      });
      const report = { generatedAt: new Date().toISOString(), source: "Digital Fotos", stage: "list", summary: {
        limiteConfigurado: MAX_HISTORY_ORDERS,
        pedidosDisponiveis: result.availableTotal,
        pedidosConsiderados: result.considered,
        pedidosIgnoradosPorLimiteHistorico: result.ignoredByLimit,
        paginasConsultadas: result.pagesConsulted,
        primeiroPedidoConsiderado: result.orders[0]?.numeroPedido ?? null,
        ultimoPedidoConsiderado: result.orders.at(-1)?.numeroPedido ?? null,
        duplicatasNumeroPedido: result.summary.duplicateNumbers.length,
        duplicatasIdFotoPedido: result.summary.duplicateIds.length,
        paginasInconsistentes: 0,
        errosApi: 0,
        ...summarizeListedOrders(result.orders), totalRegistros: result.availableTotal,
        numerosUnicos: result.summary.uniqueNumbers, idsUnicos: result.summary.uniqueIds,
        duplicatas: result.summary.duplicates.length
      }, orders: result.orders };
      atomicWrite(path.join(options.outputDir, "listing.json"), `${JSON.stringify(report, null, 2)}\n`);
      atomicWrite(path.join(options.outputDir, "listing.txt"), humanReport({ summary: {
        pedidosEncontrados: result.availableTotal, pedidosProcessados: result.considered,
        limiteConfigurado: MAX_HISTORY_ORDERS, pedidosDisponiveis: result.availableTotal,
        pedidosConsiderados: result.considered, pedidosIgnoradosPorLimiteHistorico: result.ignoredByLimit,
        paginasConsultadas: result.pagesConsulted,
        primeiroPedidoConsiderado: result.orders[0]?.numeroPedido ?? null,
        ultimoPedidoConsiderado: result.orders.at(-1)?.numeroPedido ?? null,
        duplicatasNumeroPedido: result.summary.duplicateNumbers.length,
        duplicatasIdFotoPedido: result.summary.duplicateIds.length,
        paginasInconsistentes: 0,
        ativos: report.summary.ativos, cancelados: report.summary.cancelados,
        semConteudo: report.summary.semItens, semSessaoExtraivel: 0, outrosStatus: report.summary.outrosStatus,
        sessoesUnicas: 0, sessoesEncontradasNoGestao: 0, sessoesNaoEncontradasNoGestao: 0,
        associacoesDigitalSessao: 0, pedidosDigitalJaExistentes: 0, pedidosDigitalNovos: 0,
        pedidosNoOp: 0, pedidosConflitantes: 0, sessoesEmMultiplosPedidos: 0,
        arquivosInvalidos: 0, errosApi: 0
      } }));
      saveCheckpoint(options.outputDir, { formatVersion: 1, stage: "list", generatedAt: report.generatedAt,
        completed: true, processed: result.orders.length, summary: report.summary, orders: result.orders });
      process.stdout.write(`[LIST] Janela recente validada: ${result.orders.length} pedidos; limite ${MAX_HISTORY_ORDERS}; detalhes não consultados.\n`);
    } else await runDetails(seed, state, db, options, checkpoint);
  } catch (error) {
    const code = sanitizedError(error);
    checkpoint = { ...checkpoint, interrupted: true, error: code, orders: checkpoint.orders?.length ? checkpoint.orders : orders };
    if (options?.outputDir) {
      try { saveCheckpoint(options.outputDir, checkpoint); } catch { /* Never mask the sanitized failure. */ }
    }
    process.stderr.write(`DRY-RUN interrompido: ${code}\n`);
    process.exitCode = 1;
  } finally {
    db?.close();
  }
}

if (require.main === module) run();

module.exports = {
  DEFAULT_DELAY_MS, LIST_PAGE_SIZE, MAX_HISTORY_ORDERS, MAX_LIST_PAGES, MAX_RETRIES, annotateAgainstDatabase,
  buildForm, classifyApiStatus: core.classifyApiStatus, countInPayload, fieldsForListing,
  buildDetailsSummary, classifyListedOrder, detailsHumanReport, fetchLatestListing, humanReport, locateDigitalShipments, makeSummary,
  parseArgs, post, sanitizedError, summarizeListedOrders, validateSample,
  saveCheckpoint, toIsoDateWithoutLocalShift: core.toIsoDateWithoutLocalShift
};
