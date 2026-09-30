const { randomUUID } = require("node:crypto");

const normalizeDigitalShipmentNumber = (value) => String(value ?? "").trim().replace(/\s+/g, "");
const validQuantity = (value) => value === null || (Number.isSafeInteger(value) && value >= 0);

function validateShipmentQuantities(total, items) {
  if (!validQuantity(total) || !Array.isArray(items) || !items.length || items.length > 500)
    return "REVIEW_INVALID_PLAN";
  const ids = new Set();
  let sum = 0;
  for (const item of items) {
    if (!item.pedidoId || ids.has(item.pedidoId) || !validQuantity(item.quantidadeEnviada))
      return "REVIEW_INVALID_PLAN";
    ids.add(item.pedidoId);
    if (item.quantidadeEnviada === null) continue;
    sum += item.quantidadeEnviada;
    if (!Number.isSafeInteger(sum)) return "REVIEW_INVALID_PLAN";
  }
  if (total !== null && items.every((item) => item.quantidadeEnviada !== null) && sum > total)
    return "DIGITAL_ITEMS_EXCEEDED";
  return null;
}

// The caller owns BEGIN IMMEDIATE/COMMIT and all business checks within that transaction.
function insertShipmentWithEvent(db, { id = randomUUID(), number, date, total, actorUserId = null,
  items, action, description, timestamp = new Date().toISOString(), afterShipment, afterItems }) {
  const normalizedNumber = normalizeDigitalShipmentNumber(number);
  if (!normalizedNumber || normalizedNumber.length > 80 || !/^\d{4}-\d{2}-\d{2}$/.test(date)
    || validateShipmentQuantities(total, items)) throw new Error("DIGITAL_SHIPMENT_INVALID");
  db.prepare(`INSERT INTO digital_envios(id,numero_pedido_digital,data_envio,criado_por_usuario_id,
    criado_em,atualizado_em,revision,itens_digital) VALUES(?,?,?,?,?,?,1,?)`)
    .run(id, normalizedNumber, date, actorUserId, timestamp, timestamp, total);
  afterShipment?.();
  const add = db.prepare(`INSERT INTO digital_envio_itens
    (id,digital_envio_id,pedido_id,criado_em,quantidade_enviada) VALUES(?,?,?,?,?)`);
  for (const item of items) add.run(randomUUID(), id, item.pedidoId, timestamp, item.quantidadeEnviada);
  afterItems?.();
  db.prepare(`INSERT INTO digital_envio_eventos
    (id,digital_envio_id,usuario_id,acao,descricao,criado_em) VALUES(?,?,?,?,?,?)`)
    .run(randomUUID(), id, actorUserId, action, description, timestamp);
  return id;
}

module.exports = { insertShipmentWithEvent, normalizeDigitalShipmentNumber, validateShipmentQuantities };
