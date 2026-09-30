const { cancelled } = require("./digital-sync-planner.cjs");

function reconcileBaseline(snapshot, dbState) {
  if (snapshot?.schema !== 1 || !Array.isArray(snapshot.orders))
    throw new Error("DIGITAL_SNAPSHOT_INVALID");
  const rows = snapshot.orders.map((order) => {
    const numeroPedido = String(order.numeroPedido);
    const existing = dbState.existing.has(numeroPedido.trim().toLowerCase());
    const isCancelled = cancelled(order);
    const otherStatus = !isCancelled && !/^(não conferido|nao conferido)$/i.test(String(order.descricaoStatus).trim());
    const exclusive = existing ? "EXISTING" : isCancelled ? "CANCELLED"
      : otherStatus ? "OTHER_STATUS_ABSENT" : "BASELINE_ABSENT_ACTIVE";
    return { numeroPedido, idFotoPedido: String(order.idFotoPedido), existing,
      cancelled: isCancelled, otherStatus, exclusive };
  });
  const count = (filter) => rows.filter(filter).length;
  const independent = {
    existing: count((row) => row.existing), cancelled: count((row) => row.cancelled),
    otherStatus: count((row) => row.otherStatus),
    absentNonCancelled: count((row) => !row.existing && !row.cancelled),
    existingAndCancelled: count((row) => row.existing && row.cancelled)
  };
  const exclusive = Object.fromEntries([...new Set(rows.map((row) => row.exclusive))]
    .map((category) => [category, count((row) => row.exclusive === category)]));
  if (Object.values(exclusive).reduce((sum, value) => sum + value, 0) !== rows.length)
    throw new Error("DIGITAL_RECONCILIATION_FAILED");
  return { total: rows.length, independent, exclusive, rows,
    limitation: "O baseline e o SQLite não registram o motivo histórico de exclusão dos pedidos ausentes." };
}

module.exports = { reconcileBaseline };
