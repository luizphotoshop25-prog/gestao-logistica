const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

function nextFridayInSaoPaulo() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const value = (type) => parts.find((part) => part.type === type)?.value;
  const date = new Date(`${value("year")}-${value("month")}-${value("day")}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + (5 - date.getUTCDay() + 7) % 7);
  return date.toISOString().slice(0, 10);
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-logistica-smoke-"));
  const tempRoot = `${path.resolve(os.tmpdir())}${path.sep}`;
  const resolvedRoot = path.resolve(root);
  assert(resolvedRoot.startsWith(tempRoot), "Smoke recusado fora do diretório temporário.");
  assert(path.basename(resolvedRoot).startsWith("gestao-logistica-smoke-"), "Smoke recusado para diretório inesperado.");
  assert(!fs.lstatSync(resolvedRoot).isSymbolicLink());
  const targetPath = path.join(root, "GestaoLogistica", "gestao-logistica.sqlite3");
  const database = require("../electron/database.cjs");
  try {
    database.initialize({ getPath: () => root });
    const imported = database.importSafeRows({ rows: [{
      eligible: true, linha: 1, sessao: "M99998", clienteNome: "Cliente Smoke Database",
      clienteEmail: "smoke-database@example.invalid", clienteTelefone: "00000000000",
      clienteCidade: "Curitiba - TESTE", fotosQuantidade: 8, selecaoFinalizadaEm: null, tratamentoConcluido: false,
    }] });
    assert.equal(imported.ok, true);
    assert.equal(imported.imported, 1);
    const order = database.listOrders({ search: "M99998", filter: "all" })[0];
    assert(order, "Pedido sintético não localizado.");
    const orderId = order.id;
    const steps = [
      ["galeria_publicada_em", "2026-08-20"], ["link_enviado_em", "2026-08-20"],
      ["selecao_finalizada_em", "2026-08-22"], ["tratamento_concluido_em", "2026-08-22"],
      ["impressao_enviada_em", "2026-08-22"], ["impressao_recebida_em", "2026-08-22"],
      ["etiqueta_criada_em", "2026-08-22"],
    ];
    for (const [field, value] of steps) {
      const result = database.updateMilestone({ id: orderId, field, value });
      assert.equal(result.ok, true, `${field}: ${result.message || "falhou"}`);
    }
    assert.equal(database.updateOrder({ id: orderId, values: { codigo_rastreio: "AB123456789BR" } }).ok, true);
    const unchanged = database.updateOrder({ id: orderId, values: { codigo_rastreio: "AB123456789BR" } });
    assert.equal(unchanged.unchanged, true);
    const shipped = database.bulkUpdateOrders({ ids: [orderId], action: "add_shipment" });
    assert.equal(shipped.ok, true);
    assert.equal(shipped.updated, 1);
    const finalOrder = database.getOrder(orderId).order;
    const finalListOrder = database.listOrders({ search: "M99998", filter: "all" })[0];
    assert.equal(finalOrder.prazo_tratamento_em, "2026-09-11");
    assert.equal(finalOrder.prazo_maximo_em, "2026-10-21");
    assert.equal(finalListOrder.remessa_data_planejada, nextFridayInSaoPaulo());
    assert.equal(finalOrder.fornecedor_impressao, "Digital Fotos");
    database.close();
    const check = new DatabaseSync(targetPath, { readOnly: true });
    try {
      assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    } finally {
      check.close();
    }
    console.log(JSON.stringify({ ok: true, database: targetPath, fixture: "M99998",
      deadline20: finalOrder.prazo_tratamento_em, deadline60: finalOrder.prazo_maximo_em,
      nextShipment: finalListOrder.remessa_data_planejada, unchangedHistorySuppressed: unchanged.unchanged }, null, 2));
  } finally {
    database.close();
    if (!resolvedRoot.startsWith(tempRoot) || !path.basename(resolvedRoot).startsWith("gestao-logistica-smoke-")) {
      throw new Error(`Limpeza recusada: ${resolvedRoot}`);
    }
    assert(!fs.lstatSync(resolvedRoot).isSymbolicLink());
    fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    console.log("Temporário removido:", resolvedRoot);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
