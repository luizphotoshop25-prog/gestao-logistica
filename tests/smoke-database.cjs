const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");

async function main() {
  const sourcePath = process.env.GESTAO_TEST_SOURCE_DB;
  assert(sourcePath && fs.existsSync(sourcePath), "Informe uma copia-fonte SQLite valida.");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-logistica-smoke-"));
  const dataPath = path.join(root, "GestaoLogistica");
  const targetPath = path.join(dataPath, "gestao-logistica.sqlite3");
  fs.mkdirSync(dataPath, { recursive: true });

  const source = new DatabaseSync(sourcePath, { readOnly: true });
  await backup(source, targetPath);
  source.close();

  const database = require("../electron/database.cjs");
  database.initialize({ getPath: () => root });

  const session = `MTEST${Date.now()}`;
  const imported = database.importSafeRows({ rows: [{
    eligible: true,
    linha: 1,
    sessao: session,
    clienteNome: "Cliente de teste isolado",
    clienteEmail: "isolado@example.invalid",
    clienteTelefone: "41999999999",
    clienteCidade: "Curitiba",
    fotosQuantidade: 8,
    selecaoFinalizadaEm: null,
    tratamentoConcluido: false,
  }] });
  assert.equal(imported.ok, true);

  const order = database.listOrders({ search: session, filter: "all" })[0];
  assert(order, "Pedido sintetico nao localizado.");
  const orderId = order.id;
  const steps = [
    ["galeria_publicada_em", "2026-08-20"],
    ["link_enviado_em", "2026-08-20"],
    ["selecao_finalizada_em", "2026-08-22"],
    ["tratamento_concluido_em", "2026-08-22"],
    ["impressao_enviada_em", "2026-08-22"],
    ["impressao_recebida_em", "2026-08-22"],
    ["etiqueta_criada_em", "2026-08-22"],
  ];
  for (const [field, value] of steps) {
    const result = database.updateMilestone({ id: orderId, field, value });
    assert.equal(result.ok, true, `${field}: ${result.message || "falhou"}`);
  }

  const saved = database.updateOrder({ id: orderId, values: { codigo_rastreio: "AB123456789BR" } });
  assert.equal(saved.ok, true);
  const unchanged = database.updateOrder({ id: orderId, values: { codigo_rastreio: "AB123456789BR" } });
  assert.equal(unchanged.unchanged, true);

  const shipped = database.bulkUpdateOrders({ ids: [orderId], action: "add_shipment" });
  assert.equal(shipped.ok, true);
  assert.equal(shipped.updated, 1);

  const finalOrder = database.getOrder(orderId).order;
  const finalListOrder = database.listOrders({ search: session, filter: "all" })[0];
  assert.equal(finalOrder.prazo_tratamento_em, "2026-09-11");
  assert.equal(finalOrder.prazo_maximo_em, "2026-10-21");
  assert.equal(finalListOrder.remessa_data_planejada, "2026-08-28");
  assert.equal(finalOrder.fornecedor_impressao, "Digital Fotos");

  const check = new DatabaseSync(targetPath, { readOnly: true });
  assert.equal(check.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
  check.close();

  console.log(JSON.stringify({
    ok: true,
    deadline20: finalOrder.prazo_tratamento_em,
    deadline60: finalOrder.prazo_maximo_em,
    nextShipment: finalListOrder.remessa_data_planejada,
    unchangedHistorySuppressed: unchanged.unchanged,
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
