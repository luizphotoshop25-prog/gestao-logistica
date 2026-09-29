const REQUIRED_STATE_FIELDS = ["Zid", "Chave", "DadosRepositorioSerializado"];

function extractStudioSession(filename) {
  if (typeof filename !== "string" || filename.length < 5 || !/^\d{5}/.test(filename)) return null;
  return `M${filename.slice(0, 5)}`;
}

function decodeAnsiQuoted(value) {
  return value.replace(/\\(\\|n|r|t|0|x[0-9a-fA-F]{2}|["'])/g, (_match, code) => {
    if (code === "n") return "\n";
    if (code === "r") return "\r";
    if (code === "t") return "\t";
    if (code === "0") return "\0";
    if (code.startsWith("x")) return String.fromCharCode(parseInt(code.slice(1), 16));
    return code;
  });
}

function tokenizeCurl(command) {
  const source = command.replace(/\^\r?\n/g, "").replace(/\^(["'&|<>^])/g, "$1");
  const tokens = [];
  let token = "";
  let started = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (/\s/.test(ch)) {
      if (started) { tokens.push(token); token = ""; started = false; }
      continue;
    }
    if (ch === "'" && !started) {
      const end = source.indexOf("'", i + 1);
      if (end < 0) throw new Error("seed_shell_syntax");
      token = source.slice(i + 1, end); tokens.push(token); token = ""; i = end; continue;
    }
    if (ch === "$" && source[i + 1] === "'") {
      const end = source.indexOf("'", i + 2);
      if (end < 0) throw new Error("seed_shell_syntax");
      tokens.push(decodeAnsiQuoted(source.slice(i + 2, end))); i = end; continue;
    }
    if (ch === '"') {
      let j = i + 1, quoted = "";
      for (; j < source.length; j++) {
        if (source[j] === '"') break;
        if (source[j] === "\\" && j + 1 < source.length && ['"', "\\", "$", "`"].includes(source[j + 1])) j++;
        quoted += source[j];
      }
      if (j >= source.length) throw new Error("seed_shell_syntax");
      tokens.push(quoted); i = j; continue;
    }
    if (ch === "\\" && i + 1 < source.length) {
      if (source[i + 1] === "\n") { i++; continue; }
      if (source[i + 1] === "\r" && source[i + 2] === "\n") { i += 2; continue; }
      token += source[++i]; started = true; continue;
    }
    token += ch; started = true;
  }
  if (started) tokens.push(token);
  return tokens;
}

function parseMultipart(body, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType || "");
  if (!boundary) throw new Error("seed_multipart_boundary_missing");
  const marker = `--${boundary[1] || boundary[2]}`;
  const fields = Object.create(null);
  for (const rawPart of body.split(marker).slice(1)) {
    const part = rawPart.replace(/^\r?\n/, "").replace(/\r?\n--\s*$/, "");
    if (!part || part === "--" || part.startsWith("--")) continue;
    const split = part.search(/\r?\n\r?\n/);
    if (split < 0) continue;
    const disposition = /content-disposition:\s*form-data;[^\r\n]*name="([^"]+)"/i.exec(part.slice(0, split));
    if (!disposition) continue;
    fields[disposition[1]] = part.slice(split).replace(/^\r?\n\r?\n/, "").replace(/\r?\n$/, "");
  }
  return fields;
}

function parseCurlSeed(command) {
  const tokens = tokenizeCurl(String(command || "").trim());
  if (!tokens.length || !/(?:^|[\\/])curl(?:\.exe)?$/i.test(tokens[0]) && tokens[0].toLowerCase() !== "curl")
    throw new Error("seed_not_curl");
  let url = "", data = "";
  const headers = Object.create(null);
  const withValue = new Set(["-H", "--header", "--data", "--data-raw", "--data-binary", "--url"]);
  for (let i = 1; i < tokens.length; i++) {
    const arg = tokens[i];
    if (["-k", "--insecure", "-L", "--location", "--location-trusted"].includes(arg)) throw new Error("unsafe_curl_option");
    if (withValue.has(arg)) {
      const value = tokens[++i];
      if (value === undefined) throw new Error("seed_shell_syntax");
      if (arg === "-H" || arg === "--header") {
        const colon = value.indexOf(":");
        if (colon > 0) headers[value.slice(0, colon).trim().toLowerCase()] = value.slice(colon + 1).trim();
      } else if (arg === "--url") url = value;
      else data = data ? `${data}&${value}` : value;
      continue;
    }
    if (/^https?:\/\//i.test(arg)) url = arg;
  }
  if (!url || !data) throw new Error("seed_url_or_body_missing");
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch { throw new Error("seed_url_invalid"); }
  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname.toLowerCase() !== "online-ws.sigi.com.br")
    throw new Error("seed_host_invalid");
  if (parsedUrl.search || parsedUrl.hash) throw new Error("seed_url_query_not_supported");
  const route = /^(\/[^/]+)\/Pedido\/Pedidos\/?$/i.exec(parsedUrl.pathname);
  if (!route) throw new Error("seed_endpoint_invalid");
  const contentType = headers["content-type"] || "";
  if (!/^multipart\/form-data\b/i.test(contentType)) throw new Error("seed_content_type_invalid");
  const fields = parseMultipart(data, contentType);
  if (REQUIRED_STATE_FIELDS.some((field) => !fields[field]?.trim())) throw new Error("seed_state_missing");
  const safeHeaders = Object.create(null);
  for (const name of ["accept", "authorization", "cookie", "origin", "referer", "user-agent", "x-requested-with"]) {
    if (headers[name]) safeHeaders[name] = headers[name];
  }
  return { baseUrl: `${parsedUrl.origin}${route[1]}/`, headers: safeHeaders, fields };
}

function parseResponsePayload(raw) {
  let value = raw;
  for (let depth = 0; depth < 2 && typeof value === "string"; depth++) {
    try { value = JSON.parse(value); } catch { throw new Error("response_json_invalid"); }
  }
  if (typeof value === "string" || !value || typeof value !== "object" || Array.isArray(value))
    throw new Error("response_schema_invalid");
  return value;
}

function responseObject(payload) {
  let value = payload;
  if (typeof value.ObjetoRetorno === "object" && value.ObjetoRetorno) return value.ObjetoRetorno;
  if (typeof value.ObjetoRetorno === "string") {
    try {
      const parsed = parseResponsePayload(value.ObjetoRetorno);
      return parsed.ObjetoRetorno && typeof parsed.ObjetoRetorno === "object" ? parsed.ObjetoRetorno : parsed;
    } catch { throw new Error("response_schema_invalid"); }
  }
  return value;
}

function updateDigitalSessionState(state, payload) {
  const next = { ...state };
  let unwrapped;
  try { unwrapped = responseObject(payload); } catch { unwrapped = null; }
  const sources = [payload, payload?.ObjetoRetorno, unwrapped];
  for (const source of sources) {
    if (!source || typeof source !== "object") continue;
    for (const field of REQUIRED_STATE_FIELDS) {
      if (typeof source[field] === "string" && source[field].trim()) next[field] = source[field];
    }
  }
  return next;
}

function firstDefined(object, names) {
  for (const name of names) if (object?.[name] !== undefined && object[name] !== null) return object[name];
  return undefined;
}

function parseOrderList(payload) {
  const root = responseObject(payload);
  const orders = firstDefined(root, ["Pedidos", "pedidos"]);
  if (!Array.isArray(orders)) throw new Error("orders_schema_invalid");
  const totalRaw = firstDefined(root, ["TotalRegistros", "totalRegistros"])
    ?? firstDefined(payload, ["TotalRegistros", "totalRegistros"]);
  const total = Number(totalRaw);
  return {
    orders: orders.map((order) => ({
      idFotoPedido: firstDefined(order, ["IdFotoPedido", "idFotoPedido"]),
      numeroPedido: String(firstDefined(order, ["NumeroPedido", "numeroPedido"]) ?? ""),
      dataPedidoMiliegundos: Number(firstDefined(order, ["DataPedidoMiliegundos", "DataPedidoMilissegundos", "dataPedidoMiliegundos"])),
      status: String(firstDefined(order, ["Status", "status"]) ?? ""),
      descricaoStatus: String(firstDefined(order, ["DescricaoStatus", "descricaoStatus"]) ?? ""),
      itens: Number(firstDefined(order, ["Itens", "itens"]) ?? 0)
    })),
    totalRegistros: Number.isSafeInteger(total) && total >= 0 ? total : null
  };
}

function extractDetail(payload, orderMeta) {
  const root = responseObject(payload);
  const id = firstDefined(root, ["IdFotoPedido", "idFotoPedido"]);
  const number = String(firstDefined(root, ["NumeroPedido", "numeroPedido"]) ?? "");
  if (!number) throw new Error("detail_schema_invalid");
  if ((id !== undefined && String(id) !== String(orderMeta.idFotoPedido)) || number !== String(orderMeta.numeroPedido))
    throw new Error("detail_identity_mismatch");
  const groups = firstDefined(root, ["GruposFoto", "gruposFoto"]) || [];
  if (!Array.isArray(groups)) throw new Error("detail_groups_invalid");
  const counts = Object.create(null);
  let validFiles = 0, invalidFiles = 0, invalidFileCopies = 0, photosReturned = 0;
  for (const group of groups) {
    const photos = firstDefined(group, ["Fotos", "fotos"]) || [];
    if (!Array.isArray(photos)) continue;
    for (const photo of photos) {
      photosReturned++;
      const filename = firstDefined(photo, ["NomeArquivo", "nomeArquivo"]);
      const copiesRaw = Number(firstDefined(photo, ["Copias", "Cópias", "copias"]) ?? 1);
      const copies = Number.isSafeInteger(copiesRaw) && copiesRaw > 0 ? copiesRaw : 1;
      const session = extractStudioSession(filename);
      if (!session) { invalidFiles++; invalidFileCopies += copies; continue; }
      counts[session] = (counts[session] || 0) + copies;
      validFiles += copies;
    }
  }
  const sessions = Object.entries(counts).map(([sessao, arquivos]) => ({ sessao, arquivos })).sort((a, b) => a.sessao.localeCompare(b.sessao));
  const items = Number(firstDefined(root, ["Itens", "itens"]) ?? orderMeta.itens ?? 0);
  const status = String(firstDefined(root, ["DescricaoStatus", "descricaoStatus"]) ?? orderMeta.descricaoStatus ?? "");
  let classification = /cancelad/i.test(status) ? "CANCELADO" : items === 0 ? "SEM_CONTEUDO"
    : !/não conferido|nao conferido/i.test(status) ? "OUTRO_STATUS"
      : sessions.length ? "CANDIDATO" : "SEM_SESSAO_EXTRAIVEL";
  return {
    numeroPedidoDigital: number,
    idFotoPedido: id ?? orderMeta.idFotoPedido,
    dataPedidoMiliegundos: Number(firstDefined(root, ["DataPedidoMiliegundos", "DataPedidoMilissegundos", "dataPedidoMiliegundos"]) ?? orderMeta.dataPedidoMiliegundos),
    statusCodigo: firstDefined(root, ["Status", "status"]) ?? orderMeta.status,
    status,
    itensInformados: items,
    fotosRetornadas: photosReturned,
    sessoes: sessions,
    arquivosValidos: validFiles,
    arquivosInvalidos: invalidFiles,
    arquivosInvalidosCopias: invalidFileCopies,
    arquivosExtraidos: validFiles + invalidFileCopies,
    classification
  };
}

function summarizeOrderList(orders, expectedTotal) {
  const numbers = new Set(), ids = new Set(), duplicates = [], duplicateNumbers = [], duplicateIds = [];
  for (const order of orders) {
    const id = String(order.idFotoPedido ?? "");
    const number = String(order.numeroPedido ?? "");
    if (!id || !number || !Number.isFinite(order.dataPedidoMiliegundos) || !Number.isFinite(order.itens)) throw new Error("orders_schema_invalid");
    if (ids.has(id)) duplicateIds.push(id);
    if (numbers.has(number)) duplicateNumbers.push(number);
    if (ids.has(id) || numbers.has(number)) duplicates.push({ idFotoPedido: id, numeroPedido: number });
    ids.add(id); numbers.add(number);
  }
  return { count: orders.length, uniqueNumbers: numbers.size, uniqueIds: ids.size, duplicates,
    duplicateNumbers, duplicateIds, expectedTotal };
}

function classifyApiStatus(status) {
  if (status === 401 || status === 403) return "SESSION_EXPIRED";
  if (status === 429) return "RATE_LIMITED";
  if (status >= 500) return "UPSTREAM_ERROR";
  if (status < 200 || status >= 300) return "HTTP_ERROR";
  return "OK";
}

async function collectLatestOrderWindow(fetchPage, { pageSize, maxOrders, onPage = () => {} } = {}) {
  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || !Number.isSafeInteger(maxOrders) || maxOrders < 1)
    throw new Error("pagination_limits_invalid");
  const maxPages = Math.ceil(maxOrders / pageSize);
  const orders = [];
  let availableTotal = null;
  let pagesConsulted = 0;
  for (let page = 1; page <= maxPages; page++) {
    const result = await fetchPage(page, page === 1);
    if (!result || !Array.isArray(result.orders)) throw new Error("orders_schema_invalid");
    if (result.orders.length > pageSize) throw new Error("orders_page_size_invalid");
    if (page === 1) availableTotal = result.totalRegistros;
    else if (Number.isSafeInteger(result.totalRegistros) && result.totalRegistros >= 0
      && availableTotal !== null && result.totalRegistros !== availableTotal) throw new Error("pagination_total_changed");
    pagesConsulted++;
    const remaining = maxOrders - orders.length;
    orders.push(...result.orders.slice(0, remaining));
    onPage({ page, pagesLimit: maxPages, received: result.orders.length, processed: orders.length, limit: maxOrders });
    if (orders.length >= maxOrders || result.orders.length === 0 || result.orders.length < pageSize) break;
    if (page === maxPages) throw new Error("pagination_safety_limit");
  }
  const expectedConsidered = availableTotal === null ? orders.length : Math.min(availableTotal, maxOrders);
  if (orders.length !== expectedConsidered) throw new Error("pagination_total_mismatch");
  const summary = summarizeOrderList(orders, availableTotal);
  if (summary.duplicates.length) throw new Error("orders_duplicate_ids_or_numbers");
  return { orders, availableTotal, considered: orders.length, pagesConsulted,
    ignoredByLimit: availableTotal === null ? null : Math.max(0, availableTotal - orders.length), summary };
}

function toIsoDateWithoutLocalShift(milliseconds) {
  if (!Number.isFinite(milliseconds)) return null;
  const date = new Date(milliseconds);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

module.exports = {
  REQUIRED_STATE_FIELDS, classifyApiStatus, extractDetail, extractStudioSession, parseCurlSeed,
  collectLatestOrderWindow, parseMultipart, parseOrderList, parseResponsePayload, responseObject, summarizeOrderList,
  toIsoDateWithoutLocalShift, updateDigitalSessionState
};
