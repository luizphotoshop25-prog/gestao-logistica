const assert = require("node:assert/strict");
const { classifyTotal, sourceMaps } = require("./backfill-quantities.cjs");

assert.equal(classifyTotal(48, [40, 8]), "MATCH");
assert.equal(classifyTotal(50, [40, 8]), "UNDER_TOTAL");
assert.equal(classifyTotal(47, [40, 8]), "OVER_TOTAL");
assert.equal(classifyTotal(48, [40, null]), "UNKNOWN");

const eligible = Array.from({ length: 172 }, (_, index) => ({ numeroPedidoDigital: String(10000 + index), relations: [{ sessao: `M${20000 + index}`, arquivos: 1 }] }));
const plan = { stage: "import-plan", summary: { eligibleOrders: 172 }, eligible };
const details = { stage: "details", summary: { pedidosProcessados: 200 }, orders: eligible.map((order) => ({ numeroPedidoDigital: order.numeroPedidoDigital, itensInformados: 1, sessoes: [{ sessao: order.relations[0].sessao, arquivos: 1 }] })) };
assert.equal(sourceMaps(plan, details).size, 172, "the saved plan and detail counts reconcile by Digital order/session");
assert.throws(() => sourceMaps({ ...plan, eligible: [...eligible, eligible[0]] }, details), /plan_mismatch/);
assert.throws(() => sourceMaps(plan, { ...details, orders: [...details.orders, details.orders[0]] }), /duplicate_or_missing_detail_number/);
console.log("Digital quantities backfill planning: MATCH, UNDER_TOTAL, OVER_TOTAL blocked classification, NULL, and source identity integrity passed.");
