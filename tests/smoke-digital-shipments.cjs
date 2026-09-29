const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const ts = require("typescript");
const database = require("../electron/database.cjs");
const { applyDigitalQuantitiesMigration } = require("../electron/digital-quantities-migration.cjs");
const { startApiServer, createPasswordHash } = require("../server/api-server.cjs");

const row = (session, photos, name = `Cliente Exemplo ${session}`) => ({
  eligible: true, linha: Number(session.slice(1)), sessao: session, clienteNome: name,
  clienteEmail: `${session.toLowerCase()}@example.invalid`, clienteTelefone: session.slice(1).padStart(10, "0"),
  clienteCidade: "Fixture", fotosQuantidade: photos, observacoes: "", selecaoFinalizadaEm: null,
  tratamentoConcluido: false, postadoEm: null, codigoRastreio: "", entregue: false,
  editor: "", warnings: [],
});

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-digital-"));
  let api;
  try {
    const legacyDirectory = path.join(root, "legacy");
    database.initializeDataDirectory(legacyDirectory);
    database.close();
    const legacyPath = path.join(legacyDirectory, "gestao-logistica.sqlite3");
    const oldDb = new DatabaseSync(legacyPath);
    oldDb.exec("DROP TABLE digital_envio_eventos; DROP TABLE digital_envio_itens; DROP TABLE digital_envios;");
    oldDb.close();
    database.initializeDataDirectory(legacyDirectory);
    const migrated = new DatabaseSync(legacyPath, { readOnly: true });
    for (const table of ["digital_envios", "digital_envio_itens", "digital_envio_eventos"]) {
      assert.ok(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table), `migration creates ${table}`);
    }
    assert.equal(migrated.prepare("PRAGMA foreign_key_check").all().length, 0);
    assert.ok(migrated.prepare("PRAGMA table_info(digital_envios)").all().some((column) => column.name === "itens_digital"));
    assert.ok(migrated.prepare("PRAGMA table_info(digital_envio_itens)").all().some((column) => column.name === "quantidade_enviada"));
    assert.equal(applyDigitalQuantitiesMigration(migrated), false, "versioned migration is idempotent");
    migrated.close();
    assert.ok(fs.readdirSync(path.join(legacyDirectory, "backups")).some((name) => name.startsWith("antes-enviados-digital-")), "legacy schema gets a safety backup");
    database.close();

    api = await startApiServer({ userDataPath: path.join(root, "api") });
    const password = "Sintetica-Digital-2026!";
    const addUser = (usuario, role) => {
      const result = database.createUser({ nome: usuario === "coord" ? "Coordenador Fixture" : usuario, usuario, role, senhaHash: createPasswordHash(password) });
      if (!result.ok) throw new Error(result.message);
      return result.user;
    };
    const coordinator = addUser("coord", "coordinator");
    const employee = addUser("func-a", "employee");
    addUser("func-b", "employee");
    assert.equal(database.importSafeRows({ rows: [
      row("M60001", 120, "Cliente Exemplo A"), row("M60002", 12), row("M60003", 10),
      row("M60004", 7), row("M60005", 11), row("M60006", 9), row("M60007", 4),
      row("M60008", null), row("M60009", 2), row("M60010", 6),
    ] }).imported, 10);
    const orderId = (session) => database.listOrders({ search: session })[0]?.id;
    const orderIds = Object.fromEntries(Array.from({ length: 10 }, (_, index) => {
      const session = `M${60001 + index}`;
      return [session, orderId(session)];
    }));

    const first = database.createDigitalShipment({ numeroPedidoDigital: " 900001 ", dataEnvio: "2026-09-29", pedidoIds: [orderIds.M60001, orderIds.M60001], itensDigital: 40, quantidadesEnviadas: { [orderIds.M60001]: 40 }, actorUserId: coordinator.id, actorRole: "coordinator" });
    assert.equal(first.ok, true, first.message);
    assert.equal(first.shipment.numero_pedido_digital, "900001", "number is trimmed while preserving string format");
    assert.equal(first.shipment.sessoes_quantidade, 1, "duplicate items in a payload are deduplicated");
    assert.equal(first.shipment.itens_digital, 40);
    assert.equal(first.shipment.items[0].quantidade_enviada, 40);
    assert.equal(first.shipment.items[0].fotos_quantidade, 40, "legacy alias returns Digital quantity, not Management total");
    assert.equal(database.getOrder(orderIds.M60001).order.fotos_quantidade, 120, "fixture has 120 photos in Gestão and 40 sent to Digital");
    assert.equal(first.shipment.items[0].cliente_nome, "Cliente Exemplo A");
    const validationDb = new DatabaseSync(path.join(root, "api", "GestaoLogistica", "gestao-logistica.sqlite3"));
    assert.throws(() => validationDb.prepare("UPDATE digital_envios SET itens_digital=-1 WHERE id=?").run(first.shipment.id), /CHECK constraint failed/);
    assert.throws(() => validationDb.prepare("UPDATE digital_envio_itens SET quantidade_enviada=1.5 WHERE digital_envio_id=?").run(first.shipment.id), /CHECK constraint failed/);
    validationDb.close();

    const batch = database.createDigitalShipment({ numeroPedidoDigital: "900002", dataEnvio: "2026-09-29", pedidoIds: [orderIds.M60002, orderIds.M60003, orderIds.M60004, orderIds.M60005, orderIds.M60006], actorUserId: coordinator.id, actorRole: "coordinator" });
    assert.equal(batch.ok, true, batch.message);
    assert.equal(batch.shipment.sessoes_quantidade, 5);
    assert.equal(batch.shipment.itens_digital, null, "unspecified Digital total stays unknown");
    const duplicateNumber = database.createDigitalShipment({ numeroPedidoDigital: " 900001 ", dataEnvio: "2026-09-30", pedidoIds: [orderIds.M60007], actorUserId: employee.id, actorRole: "employee" });
    assert.equal(duplicateNumber.error, "DUPLICATE_DIGITAL_ORDER");
    assert.equal(duplicateNumber.existingId, first.shipment.id);

    const oneSession = database.createDigitalShipment({ numeroPedidoDigital: "900003", dataEnvio: "2026-09-30", pedidoIds: [orderIds.M60001], actorUserId: employee.id, actorRole: "employee" });
    assert.equal(oneSession.error, "DUPLICATE_SESSIONS");
    assert.equal(oneSession.priorShipments[0].numero_pedido_digital, "900001");
    const resent = database.createDigitalShipment({ numeroPedidoDigital: "900003", dataEnvio: "2026-09-30", pedidoIds: [orderIds.M60001], confirmReenvio: true, actorUserId: employee.id, actorRole: "employee" });
    assert.equal(resent.ok, true, resent.message);
    const history = database.getDigitalShipmentsForOrder(orderIds.M60001);
    assert.equal(history.rows.length, 2);
    assert.deepEqual(history.rows.map((item) => item.data_envio), ["2026-09-29", "2026-09-30"]);

    const resolvedDuplicates = database.resolveDigitalShipmentSessions({ sessions: ["m60001", "M60001", "60001", "M69999"] });
    assert.equal(resolvedDuplicates.ok, true);
    assert.equal(resolvedDuplicates.rows.filter((item) => !item.notFound).length, 1);
    assert.deepEqual(resolvedDuplicates.notFound, ["M69999"]);
    const existingWithoutShipment = database.listDigitalShipments({ search: "60009" });
    assert.equal(existingWithoutShipment.session.found, true);
    assert.equal(existingWithoutShipment.session.shipments.length, 0);
    const unknownSession = database.listDigitalShipments({ search: "M69999" });
    assert.equal(unknownSession.session.found, false);
    const byExternalOrder = database.listDigitalShipments({ search: "900002" });
    assert.equal(byExternalOrder.total, 1);
    const byClient = database.listDigitalShipments({ search: "Exemplo A" });
    assert.equal(byClient.total, 2);
    assert.equal(database.listDigitalShipments({ search: "90000" }).total, 0, "numeric identifiers are exact, never fuzzy");

    const nullable = database.createDigitalShipment({ numeroPedidoDigital: "900004", dataEnvio: "2026-09-28", pedidoIds: [orderIds.M60008], actorUserId: employee.id, actorRole: "employee" });
    assert.equal(nullable.ok, true, nullable.message);
    assert.equal(nullable.shipment.fotos_quantidade_soma, null);
    assert.equal(nullable.shipment.fotos_quantidade_desconhecida, 1);
    assert.equal(nullable.shipment.itens_digital, null);
    assert.equal(nullable.shipment.items[0].quantidade_enviada, null);

    const exact = database.createDigitalShipment({ numeroPedidoDigital: "900040", dataEnvio: "2026-09-29", pedidoIds: [orderIds.M60009], itensDigital: 12, quantidadesEnviadas: { [orderIds.M60009]: 12 }, actorUserId: coordinator.id, actorRole: "coordinator" });
    assert.equal(exact.ok, true);
    assert.equal(database.createDigitalShipment({ numeroPedidoDigital: "900041", dataEnvio: "2026-09-29", pedidoIds: [orderIds.M60009], itensDigital: 11, quantidadesEnviadas: { [orderIds.M60009]: 12 }, confirmReenvio: true, actorUserId: coordinator.id, actorRole: "coordinator" }).error, "DIGITAL_ITEMS_EXCEEDED");
    assert.equal(database.getDigitalShipment(first.shipment.id).items[0].quantidade_enviada, 40, "regression: Digital count stays 40 despite the session's Gestão count");
    const legacyEdit = database.updateDigitalShipment({ id: first.shipment.id, revision: 1, numeroPedidoDigital: "900001", dataEnvio: "2026-09-29", pedidoIds: [orderIds.M60001], actorUserId: coordinator.id, actorRole: "coordinator" });
    assert.equal(legacyEdit.shipment.itens_digital, 40, "old client omission preserves Digital total");

    const forbidden = database.updateDigitalShipment({ id: first.shipment.id, revision: 1, numeroPedidoDigital: "900011", dataEnvio: "2026-10-01", pedidoIds: [orderIds.M60001], actorUserId: employee.id, actorRole: "employee" });
    assert.equal(forbidden.error, "FORBIDDEN");
    const employeeUpdate = database.updateDigitalShipment({ id: nullable.shipment.id, revision: 1, numeroPedidoDigital: "900014", dataEnvio: "2026-09-28", pedidoIds: [orderIds.M60008], actorUserId: employee.id, actorRole: "employee" });
    assert.equal(employeeUpdate.ok, true, employeeUpdate.message);
    const edited = database.updateDigitalShipment({ id: batch.shipment.id, revision: batch.shipment.revision, numeroPedidoDigital: " 900020 ", dataEnvio: "2026-09-30", pedidoIds: [orderIds.M60002, orderIds.M60003, orderIds.M60004, orderIds.M60005], actorUserId: coordinator.id, actorRole: "coordinator" });
    assert.equal(edited.ok, true, edited.message);
    assert.equal(edited.shipment.numero_pedido_digital, "900020");
    assert.equal(edited.shipment.items.length, 4);
    assert.ok(edited.shipment.events.some((event) => event.acao === "number_changed"));
    assert.ok(edited.shipment.events.some((event) => event.acao === "date_changed"));
    assert.ok(edited.shipment.events.some((event) => event.acao === "item_removed"));
    assert.equal(database.updateDigitalShipment({ id: batch.shipment.id, revision: 1, numeroPedidoDigital: "900021", dataEnvio: "2026-10-01", pedidoIds: [orderIds.M60002, orderIds.M60003, orderIds.M60004, orderIds.M60005], actorUserId: coordinator.id, actorRole: "coordinator" }).error, "REVISION_CONFLICT");

    const paged = database.listDigitalShipments({ page: 1, pageSize: 1, sort: "number-asc" });
    assert.equal(paged.rows.length, 1);
    assert.equal(paged.page, 1);
    assert.ok(paged.totalPages >= 2);
    assert.equal(database.listDigitalShipments({ from: "2026-09-30", to: "2026-09-30" }).rows.every((item) => item.data_envio === "2026-09-30"), true);
    assert.equal(database.listDigitalShipments({ from: "2026-10-01", to: "2026-09-01" }).error, "INVALID_DATE_RANGE");

    const perfDb = new DatabaseSync(path.join(root, "api", "GestaoLogistica", "gestao-logistica.sqlite3"));
    perfDb.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE");
    const insertShipment = perfDb.prepare("INSERT INTO digital_envios (id,numero_pedido_digital,data_envio,criado_por_usuario_id,criado_em,atualizado_em,revision) VALUES (?,?,?,?,?,?,1)");
    const insertItem = perfDb.prepare("INSERT INTO digital_envio_itens (id,digital_envio_id,pedido_id,criado_em) VALUES (?,?,?,?)");
    for (let index = 0; index < 1200; index += 1) {
      const id = `perf-${index}`;
      const stamp = `2026-09-${String(index % 28 + 1).padStart(2, "0")}T12:00:00.000Z`;
      insertShipment.run(id, `9001${String(index).padStart(4, "0")}`, stamp.slice(0, 10), coordinator.id, stamp, stamp);
      insertItem.run(`perf-item-${index}`, id, orderIds.M60001, stamp);
    }
    perfDb.exec("COMMIT");
    perfDb.close();
    const started = performance.now();
    const performanceSearch = database.listDigitalShipments({ search: "60001", page: 1, pageSize: 20 });
    const elapsed = performance.now() - started;
    assert.equal(performanceSearch.total, 1202);
    assert.equal(performanceSearch.rows.length, 20);
    assert.ok(elapsed < 3000, `indexed search/pagination took ${elapsed.toFixed(1)}ms`);

    const serviceSource = fs.readFileSync(path.join(__dirname, "../src/services/dataService.ts"), "utf8");
    const compiled = ts.transpileModule(serviceSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const serviceContext = { exports: {}, fetch, URL, URLSearchParams, AbortSignal, Event,
      window: { gestaoAPI: {}, gestaoConfig: { dataTransport: "http", apiUrl: api.origin }, dispatchEvent() {} } };
    vm.runInNewContext(compiled, serviceContext);
    const { createHttpDataService } = serviceContext.exports;
    const worker = createHttpDataService(api.origin);
    const workerLogin = await worker.login({ usuario: "func-a", senha: password });
    assert.equal(workerLogin.ok, true);
    assert.equal((await worker.listDigitalShipments({ search: "M60008" })).total, 1);
    const httpCreated = await worker.createDigitalShipment({ numeroPedidoDigital: "900030", dataEnvio: "2026-10-01", pedidoIds: [orderIds.M60010] });
    assert.equal(httpCreated.ok, true, httpCreated.message);
    const workerOwnEdit = await worker.updateDigitalShipment({ id: httpCreated.shipment.id, revision: 1, numeroPedidoDigital: "900031", dataEnvio: "2026-10-02", pedidoIds: [orderIds.M60010] });
    assert.equal(workerOwnEdit.ok, true, workerOwnEdit.message);
    assert.equal((await worker.updateDigitalShipment({ id: first.shipment.id, revision: 1, numeroPedidoDigital: "900032", dataEnvio: "2026-10-02", pedidoIds: [orderIds.M60001] })).error, "FORBIDDEN");
    const manager = createHttpDataService(api.origin);
    assert.equal((await manager.login({ usuario: "coord", senha: password })).ok, true);
    assert.equal((await manager.updateDigitalShipment({ id: httpCreated.shipment.id, revision: 2, numeroPedidoDigital: "900033", dataEnvio: "2026-10-02", pedidoIds: [orderIds.M60010] })).ok, true, "coordinator may edit any shipment");
    const unauthorized = await fetch(`${api.origin}/api/digital-shipments`, { headers: { Authorization: "Bearer invalid" } });
    assert.equal(unauthorized.status, 401);
    assert.ok(elapsed < 3000);
    const httpDigital = await manager.createDigitalShipment({ numeroPedidoDigital: "900050", dataEnvio: "2026-10-02", pedidoIds: [orderIds.M60001], itensDigital: 5, quantidadesEnviadas: { [orderIds.M60001]: 5 }, confirmReenvio: true });
    assert.equal(httpDigital.ok, true, httpDigital.message);
    assert.equal((await manager.listDigitalShipments({ search: "900050" })).rows[0].itens_digital, 5, "HTTP list serializes the Digital order total");
    assert.equal((await manager.getDigitalShipment(httpDigital.shipment.id)).shipment.items[0].quantidade_enviada, 5);
    assert.equal((await manager.updateDigitalShipment({ id: httpDigital.shipment.id, revision: 1, numeroPedidoDigital: "900050", dataEnvio: "2026-10-02", pedidoIds: [orderIds.M60001], itensDigital: 4, quantidadesEnviadas: { [orderIds.M60001]: 5 } })).error, "DIGITAL_ITEMS_EXCEEDED");
    const oldClientEdit = await manager.updateDigitalShipment({ id: first.shipment.id, revision: 2, numeroPedidoDigital: "900001", dataEnvio: "2026-09-29", pedidoIds: [orderIds.M60001] });
    assert.equal(oldClientEdit.ok, true);
    assert.equal(oldClientEdit.shipment.itens_digital, 40, "HTTP 0.1.11 omission preserves Digital total");
    assert.equal(oldClientEdit.shipment.items[0].quantidade_enviada, 40, "HTTP 0.1.11 omission preserves session Digital quantity");
    console.log(`Enviados Digital: migration, nullable counts, 40-vs-120 regression, validation, create/edit/audit/revision, permissions and HTTP/DataService (${elapsed.toFixed(1)}ms).`);
  } finally {
    if (api) await api.close(); else database.close();
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
    catch (error) { if (error.code !== "EPERM") throw error; }
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
