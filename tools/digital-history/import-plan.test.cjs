const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fs = require("node:fs");
const { DatabaseSync } = require("node:sqlite");
const { buildImportPlan, generateImportPlan } = require("./import-plan.cjs");
const { parseArgs } = require("./extractor.cjs");

function fixture() {
  const listingOrders = [];
  const detailOrders = [];
  const sessions = new Map();
  for (let i = 0; i < 200; i++) {
    const number = String(300000 + i);
    const listed = { idFotoPedido: 700000 + i, numeroPedido: number, dataPedidoMiliegundos: 1790640000000,
      status: "1", descricaoStatus: "Não conferido", itens: 2 };
    const name = `M${String(i + 1).padStart(5, "0")}`;
    let orderSessions = [{ sessao: name, arquivos: 2, existeNoGestao: true }];
    if (i !== 2) sessions.set(name, { id: `pedido-${name}` });
    if (i === 0) listed.descricaoStatus = "Cancelado";
    if (i === 1) { listed.status = 0; listed.descricaoStatus = "Conferido"; }
    if (i === 2) orderSessions = [{ sessao: "M00999", arquivos: 2, existeNoGestao: false }];
    if (i === 3) orderSessions = [];
    if (i === 4) orderSessions = [{ sessao: "M00005", arquivos: 1, existeNoGestao: true }];
    if (i === 5) orderSessions = [{ sessao: "M00002", arquivos: 2, existeNoGestao: true }];
    if (i === 6) orderSessions = [{ sessao: "M00007", arquivos: 1, existeNoGestao: true }, { sessao: "M00007", arquivos: 1, existeNoGestao: true }];
    if (i === 7 || i === 8) orderSessions = [{ sessao: `M${String(i + 1).padStart(5, "0")}`, arquivos: 2, existeNoGestao: true }];
    if (i === 112097 - 300000) orderSessions = [];
    const detailNumber = i === 4 ? "112097" : number;
    const order = { numeroPedidoDigital: detailNumber, idFotoPedido: listed.idFotoPedido, data: "2026-09-29", dataListagem: "2026-09-29",
      dataDivergente: false, status: listed.descricaoStatus, statusCodigo: listed.status, itensInformados: listed.itens,
      fotosRetornadas: listed.itens, sessoes: orderSessions, arquivosInvalidos: i === 3 ? 3 : 0 };
    if (i === 4) listed.numeroPedido = "112097";
    if (i === 7) listed.numeroPedido = detailNumber;
    if (i === 8) listed.numeroPedido = detailNumber;
    if (i === 4) { listed.itens = 100; order.fotosRetornadas = 1; }
    listingOrders.push(listed);
    detailOrders.push(order);
  }
  listingOrders[7].numeroPedido = "300007";
  listingOrders[8].numeroPedido = "300008";
  detailOrders[7].numeroPedidoDigital = "300007";
  detailOrders[8].numeroPedidoDigital = "300008";
  listingOrders[4].numeroPedido = "112097";
  detailOrders[4].numeroPedidoDigital = "112097";
  const listing = { stage: "list", summary: { pedidosConsiderados: 200, duplicatas: 0, pedidosDisponiveis: 1049 }, orders: listingOrders };
  const details = { stage: "details", summary: { falhas: 0, pedidosProcessados: 200 }, orders: detailOrders };
  const existingDigitalOrders = new Map([["300007", { id: "envio-7", date: "2026-09-29" }], ["300008", { id: "envio-8", date: "2026-09-28" }]]);
  const existingAssociations = new Set(["300007|M00008"]);
  return { listing, details, dbState: { sessions, existingDigitalOrders, existingAssociations } };
}

function run() {
  const { listing, details, dbState } = fixture();
  const plan = buildImportPlan(listing, details, dbState);
  assert.equal(plan.summary.sourceOrders, 200);
  assert.equal(plan.summary.excludedCancelled, 1);
  assert.equal(plan.summary.manualReviewOrders, 1);
  assert.equal(plan.manualReview[0].numeroPedidoDigital, "112097");
  assert.equal(plan.manualReview[0].validRelationsForReview[0].sessao, "M00005");
  assert.equal(plan.summary.sessionsNotFound, 1);
  assert.equal(plan.missingSessions[0].sessao, "M00999");
  assert.equal(plan.excluded.find((order) => order.numeroPedidoDigital === "300003").reason, "NO_IMPORTABLE_RELATIONS");
  assert.equal(plan.summary.invalidFilenamesIgnored, 3);
  const conferido = plan.eligible.find((order) => order.numeroPedidoDigital === "300001");
  assert.equal(conferido.descricaoStatus, "Conferido");
  assert.equal(conferido.classification, "NEW_DIGITAL_ORDER");
  const resend = plan.eligible.find((order) => order.numeroPedidoDigital === "300005");
  assert.equal(resend.relations[0].sessao, "M00002");
  assert.equal(plan.summary.resendSessionsPreserved, 1);
  const dedup = plan.eligible.find((order) => order.numeroPedidoDigital === "300006");
  assert.equal(dedup.relations.length, 1);
  assert.equal(plan.eligible.find((order) => order.numeroPedidoDigital === "300007").classification, "EXISTING_DIGITAL_ORDER");
  assert.equal(plan.eligible.find((order) => order.numeroPedidoDigital === "300007").relations[0].disposition, "NO_OP");
  assert.equal(plan.conflicts.length, 1);
  assert.equal(plan.conflicts[0].numeroPedidoDigital, "300008");
  assert.equal(plan.summary.databaseWrites, 0);
  assert.throws(() => parseArgs(["--mode", "import-plan"]), /cli_arguments_required/);
  assert.equal(parseArgs(["--mode", "import-plan", "--db", "x"]).mode, "import-plan");

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "import-plan-test-"));
  try {
    const dbPath = path.join(tmp, "pilot.sqlite3");
    const writable = new DatabaseSync(dbPath);
    writable.exec(`CREATE TABLE pedidos(id TEXT PRIMARY KEY,sessao TEXT NOT NULL);
      CREATE TABLE digital_envios(id TEXT PRIMARY KEY,numero_pedido_digital TEXT,data_envio TEXT,criado_por_usuario_id TEXT,criado_em TEXT,atualizado_em TEXT,revision INTEGER);
      CREATE TABLE digital_envio_itens(id TEXT PRIMARY KEY,digital_envio_id TEXT,pedido_id TEXT,criado_em TEXT);
      INSERT INTO pedidos VALUES('p1','M00001');`);
    writable.close();
    const db = new DatabaseSync(dbPath, { readOnly: true });
    db.exec("PRAGMA query_only=ON");
    const out = path.join(tmp, "work", "digital-history");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, "listing.json"), JSON.stringify(listing));
    fs.writeFileSync(path.join(out, "details.json"), JSON.stringify(details));
    const before = db.prepare("SELECT count(*) n FROM pedidos").get().n;
    const generated = generateImportPlan({ db, outputDir: out });
    assert.equal(generated.summary.databaseWrites, 0);
    assert.ok(fs.existsSync(path.join(out, "import-plan.json")));
    assert.ok(fs.existsSync(path.join(out, "import-plan.txt")));
    assert.throws(() => db.exec("INSERT INTO pedidos VALUES('p2','M00002')"));
    assert.equal(db.prepare("SELECT count(*) n FROM pedidos").get().n, before);
    db.close();
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
  process.stdout.write("digital history import-plan tests passed\n");
}

run();
