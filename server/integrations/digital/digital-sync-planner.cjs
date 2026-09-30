const { DatabaseSync } = require("node:sqlite");
const history = require("../../../tools/digital-history/core.cjs");

const identity = (order) => `${String(order.idFotoPedido)}|${String(order.numeroPedido).toLowerCase()}`;
const orderNumber = (value) => String(value ?? "").trim().toLowerCase();
const cancelled = (order) => /cancelad/i.test(`${order.status ?? ""} ${order.descricaoStatus ?? ""}`);

function readDatabaseState(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON");
    const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name));
    if (!["pedidos", "digital_envios", "digital_envio_itens"].every((name) => tables.has(name)))
      throw new Error("DIGITAL_DB_SCHEMA_ERROR");
    const sessions = new Map(db.prepare("SELECT id,sessao FROM pedidos").all()
      .map((row) => [String(row.sessao).toUpperCase(), row.id]));
    const existing = new Map(db.prepare("SELECT id,numero_pedido_digital,itens_digital FROM digital_envios").all()
      .map((row) => [orderNumber(row.numero_pedido_digital), { id: row.id, total: row.itens_digital }]));
    const counts = db.prepare("SELECT (SELECT count(*) FROM digital_envios) envios, (SELECT count(*) FROM digital_envio_itens) relacoes").get();
    return { sessions, existing, counts };
  } finally { db.close(); }
}

function makeSnapshot(listing, pendingIds = []) {
  return { schema: 1, createdAt: new Date().toISOString(),
    orders: listing.map((o) => ({ idFotoPedido: String(o.idFotoPedido), numeroPedido: String(o.numeroPedido),
      status: String(o.status), descricaoStatus: String(o.descricaoStatus), itens: o.itens })),
    pendingIds: [...new Set(pendingIds.map(String))] };
}

function planDetail(meta, detail, dbState) {
  const number = String(meta.numeroPedido);
  if (dbState.existing.has(orderNumber(number))) return { numeroPedido: number, category: "EXISTING" };
  if (cancelled(meta) || detail.classification === "CANCELADO") return { numeroPedido: number, category: "SKIP_CANCELLED" };
  const total = Number.isSafeInteger(detail.itensInformados) && detail.itensInformados >= 0 ? detail.itensInformados : null;
  const photos = Number.isSafeInteger(detail.fotosRetornadas) ? detail.fotosRetornadas : null;
  const recognized = detail.sessoes.reduce((sum, s) => sum + Number(s.arquivos || 0), 0);
  const found = [], missing = [];
  for (const session of detail.sessoes) {
    const name = String(session.sessao).toUpperCase();
    const pedidoId = dbState.sessions.get(name);
    (pedidoId ? found : missing).push({ sessao: name,
      quantidadeEnviada: Number.isSafeInteger(session.arquivos) && session.arquivos >= 0 ? session.arquivos : null,
      ...(pedidoId ? { pedidoId } : {}) });
  }
  const base = { numeroPedido: number, idFotoPedido: String(meta.idFotoPedido),
    itensDigital: total, fotosRetornadas: photos, arquivosInvalidos: detail.arquivosInvalidos,
    relations: found, missingSessions: missing };
  if (total === null || photos === null) return { ...base, category: "REVIEW_QUANTITY_UNKNOWN" };
  if (total !== photos) return { ...base, category: "REVIEW_ITEM_PHOTO_MISMATCH" };
  if (recognized > total) return { ...base, category: "REVIEW_OVER_TOTAL" };
  if (!detail.sessoes.length) return { ...base, category: "PENDING_NO_SESSION" };
  if (missing.length) return { ...base, category: "PENDING_MISSING_SESSION" };
  if (detail.classification !== "CANDIDATO") return { ...base, category: "REVIEW_STATUS" };
  return { ...base, category: recognized < total ? "CANDIDATE_UNDER_TOTAL" : "CANDIDATE" };
}

async function scanRecent(client, snapshot, options) {
  const previous = new Map((snapshot?.orders || []).map((o) => [identity(o), o]));
  const orders = [], seen = new Set(), numbers = new Set();
  let overlap = false, pages = 0, available = null, pageShort = false, inconsistent = false;
  for (let page = 1; page <= options.maxScanPages; page++) {
    const result = await client.listOrders(page, options.pageSize, page === 1);
    if (!Array.isArray(result.orders) || result.orders.length > options.pageSize) throw new Error("DIGITAL_LIST_SCHEMA_ERROR");
    if (page === 1) available = result.totalRegistros;
    else if (available != null && result.totalRegistros != null && result.totalRegistros !== available) inconsistent = true;
    pages++;
    for (const order of result.orders) {
      const key = identity(order), number = orderNumber(order.numeroPedido);
      if (!order.idFotoPedido || !number || seen.has(key) || numbers.has(number))
        throw new Error("DIGITAL_LIST_DUPLICATE_OR_INVALID");
      seen.add(key); numbers.add(number); orders.push(order);
      if (previous.has(key)) overlap = true;
    }
    pageShort = result.orders.length < options.pageSize
      || (Number.isSafeInteger(available) && orders.length >= available);
    if (pageShort || (orders.length >= options.recentOrders && (!snapshot || overlap))) break;
  }
  const gap = !!snapshot && !overlap && !pageShort;
  if (inconsistent) throw new Error("DIGITAL_LIST_INCONSISTENT");
  return { orders, pages, available, overlap, gap, reachedPageLimit: pages === options.maxScanPages && !pageShort };
}

async function buildDryRun({ client, snapshot, options, dbState }) {
  const scan = await scanRecent(client, snapshot, options);
  const prior = new Map((snapshot?.orders || []).map((o) => [identity(o), o]));
  const pending = new Set((snapshot?.pendingIds || []).map(String));
  const planned = [], changes = [];
  for (const meta of scan.orders) {
    const key = identity(meta), old = prior.get(key);
    const exists = dbState.existing.has(orderNumber(meta.numeroPedido));
    if (old && (old.status !== meta.status || old.descricaoStatus !== meta.descricaoStatus || old.itens !== meta.itens))
      changes.push({ numeroPedido: meta.numeroPedido, occurrence: "DIGITAL_ORDER_CHANGED" });
    if (!snapshot) {
      planned.push({ numeroPedido: meta.numeroPedido, category: exists ? "BASELINE_EXISTING" : "BASELINE_OBSERVED" });
      continue;
    }
    if (exists) { planned.push({ numeroPedido: meta.numeroPedido, category: "EXISTING" }); continue; }
    if (cancelled(meta)) { planned.push({ numeroPedido: meta.numeroPedido, category: "SKIP_CANCELLED" }); continue; }
    if (old && !pending.has(String(meta.idFotoPedido))) continue;
    const detail = await client.getOrderDetail(meta);
    planned.push(planDetail(meta, detail, dbState));
  }
  const observedIds = new Set(scan.orders.map((o) => String(o.idFotoPedido)));
  const pendingIds = [
    ...[...pending].filter((id) => !observedIds.has(id)),
    ...planned.filter((p) => p.category.startsWith("PENDING_")).map((p) => p.idFotoPedido)
  ];
  const nextSnapshot = makeSnapshot(scan.orders, pendingIds);
  return { mode: snapshot ? "incremental" : "baseline", scan: {
    listed: scan.orders.length, pages: scan.pages, available: scan.available,
    overlap: scan.overlap, possibleGap: scan.gap, reachedPageLimit: scan.reachedPageLimit },
    planned, changes, nextSnapshot, databaseCounts: dbState.counts, databaseWrites: 0,
    complete: !scan.gap };
}

module.exports = { buildDryRun, cancelled, identity, makeSnapshot, planDetail, readDatabaseState, scanRecent };
