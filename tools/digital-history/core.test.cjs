const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { DatabaseSync } = require("node:sqlite");
const core = require("./core.cjs");
const extractor = require("./extractor.cjs");

function fixtureOrder(number, id, count = 1) {
  return { IdFotoPedido: id, NumeroPedido: String(number), DataPedidoMiliegundos: 1790640000000, Status: 1,
    DescricaoStatus: "Não conferido", Itens: count, idFotoPedido: id, numeroPedido: String(number),
    dataPedidoMiliegundos: 1790640000000, status: 1, descricaoStatus: "Não conferido", itens: count };
}

function curlSeed() {
  const boundary = "----WebKitFormBoundaryFixture";
  const fields = { Zid: "secret-zid", Chave: "secret-key", DadosRepositorioSerializado: "secret-repository", pagina: "2", registrosPorPagina: "25", isContarRegistros: "false" };
  const body = Object.entries(fields).map(([key, value]) => `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`).join("") + `--${boundary}--\r\n`;
  return { boundary, fields, command: `curl 'https://online-ws.sigi.com.br/24.3.27.2/Pedido/Pedidos' -H 'content-type: multipart/form-data; boundary=${boundary}' -H 'cookie: secret-cookie' --data-raw $'${body.replace(/\\/g, "\\\\").replace(/\r/g, "\\r").replace(/\n/g, "\\n").replace(/'/g, "\\'")}'` };
}

function removeTree(target) {
  if (!fs.existsSync(target)) return;
  const stat = fs.lstatSync(target);
  if (!stat.isDirectory()) { fs.unlinkSync(target); return; }
  for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
  fs.rmdirSync(target);
}

async function run() {
  assert.equal(core.extractStudioSession("98765432.JPG"), "M98765");
  assert.equal(core.extractStudioSession("00001111.jpg"), "M00001");
  assert.equal(core.extractStudioSession("76543.jpg"), "M76543");
  for (const filename of ["IMG_98765.JPG", "A98765432.JPG", "1234.JPG", "", null, 12345])
    assert.equal(core.extractStudioSession(filename), null);

  const seed = curlSeed();
  const parsedSeed = core.parseCurlSeed(seed.command);
  assert.equal(parsedSeed.baseUrl, "https://online-ws.sigi.com.br/24.3.27.2/");
  assert.deepEqual({ ...parsedSeed.fields }, seed.fields);
  assert.equal(parsedSeed.headers.cookie, "secret-cookie");
  assert.equal(core.parseCurlSeed(seed.command.replace(" -H 'content-type", " \\\n -H 'content-type")).fields.Zid, "secret-zid");
  assert.throws(() => core.parseCurlSeed(seed.command.replace("online-ws.sigi.com.br", "evil.example")), /seed_host_invalid/);
  assert.throws(() => core.parseCurlSeed(seed.command.replace("Pedido/Pedidos", "Pedido/DadosPedido")), /seed_endpoint_invalid/);
  assert.throws(() => core.parseCurlSeed(seed.command.replace("--data-raw", "--insecure --data-raw")), /unsafe_curl_option/);

  const inner = { Zid: "new-zid", Chave: "new-key", DadosRepositorioSerializado: "new-state", ObjetoRetorno: {
    TotalRegistros: 2, Pedidos: [fixtureOrder("900001", 9001), fixtureOrder("900002", 9002)]
  } };
  const doubleSerialized = JSON.stringify(JSON.stringify(inner));
  const parsed = core.parseResponsePayload(doubleSerialized);
  assert.equal(core.parseOrderList(parsed).orders.length, 2);
  assert.equal(core.parseOrderList(parsed).totalRegistros, 2);
  assert.equal(core.updateDigitalSessionState(seed.fields, parsed).Zid, "new-zid");
  assert.equal(core.updateDigitalSessionState(seed.fields, parsed).Chave, "new-key");
  assert.equal(core.updateDigitalSessionState(seed.fields, parsed).DadosRepositorioSerializado, "new-state");
  assert.throws(() => core.parseResponsePayload(JSON.stringify(JSON.stringify(JSON.stringify({ x: 1 })))), /response_schema_invalid/);

  const detail = { ObjetoRetorno: {
    IdFotoPedido: 9001, NumeroPedido: "900001", DataPedidoMiliegundos: 1790640000000,
    Status: 1, DescricaoStatus: "Não conferido", Itens: 5,
    GruposFoto: [{ Fotos: [
      { NomeArquivo: "99999111.JPG", Copias: 1 }, { NomeArquivo: "99999375.JPG", Copias: 2 },
      { NomeArquivo: "99998247.jpg", Copias: 1 }, { NomeArquivo: "IMG_99999.JPG", Copias: 1 }
    ] }]
  } };
  const extracted = core.extractDetail(detail, { idFotoPedido: 9001, numeroPedido: "900001", itens: 5 });
  assert.equal(extracted.classification, "CANDIDATO");
  assert.deepEqual(extracted.sessoes, [{ sessao: "M99998", arquivos: 1 }, { sessao: "M99999", arquivos: 3 }]);
  assert.equal(extracted.arquivosValidos, 4);
  assert.equal(extracted.arquivosInvalidos, 1);
  assert.equal(extracted.arquivosInvalidosCopias, 1);
  assert.equal(extracted.arquivosExtraidos, 5);
  assert.equal(extracted.fotosRetornadas, 4);
  assert.equal(extracted.statusCodigo, 1);
  const detailWithoutId = { ObjetoRetorno: { ...detail.ObjetoRetorno } };
  delete detailWithoutId.ObjetoRetorno.IdFotoPedido;
  assert.equal(core.extractDetail(detailWithoutId, { ...detail.ObjetoRetorno, idFotoPedido: 9001, numeroPedido: "900001", itens: 5 }).idFotoPedido, 9001);
  const canceled = core.extractDetail({ ObjetoRetorno: { ...detail.ObjetoRetorno, DescricaoStatus: "Cancelado" } }, { idFotoPedido: 9001, numeroPedido: "900001", itens: 3 });
  assert.equal(canceled.classification, "CANCELADO");
  const empty = core.extractDetail({ ObjetoRetorno: { IdFotoPedido: 9002, NumeroPedido: "900002", Itens: 0, GruposFoto: [] } }, { idFotoPedido: 9002, numeroPedido: "900002", itens: 0 });
  assert.equal(empty.classification, "SEM_CONTEUDO");
  const noSession = core.extractDetail({ ObjetoRetorno: { IdFotoPedido: 9003, NumeroPedido: "900003", DescricaoStatus: "Não conferido", Itens: 1, GruposFoto: [{ Fotos: [{ NomeArquivo: "IMG_X.jpg" }] }] } }, { idFotoPedido: 9003, numeroPedido: "900003", itens: 1 });
  assert.equal(noSession.classification, "SEM_SESSAO_EXTRAIVEL");
  extracted.data = core.toIsoDateWithoutLocalShift(extracted.dataPedidoMiliegundos);
  assert.equal(extractor.validateSample(extracted, { numeroPedido: "900001", idFotoPedido: 9001, itens: 5, dataPedidoMiliegundos: 1790640000000 }), undefined);
  assert.throws(() => core.extractDetail({ ObjetoRetorno: { ...detail.ObjetoRetorno, NumeroPedido: "other" } }, { idFotoPedido: 9001, numeroPedido: "900001" }), /detail_identity_mismatch/);

  assert.equal(core.classifyApiStatus(200), "OK");
  assert.equal(core.classifyApiStatus(401), "SESSION_EXPIRED");
  assert.equal(core.classifyApiStatus(403), "SESSION_EXPIRED");
  assert.equal(core.classifyApiStatus(429), "RATE_LIMITED");
  assert.equal(core.classifyApiStatus(500), "UPSTREAM_ERROR");
  assert.equal(extractor.summarizeListedOrders([
    { status: "1", descricaoStatus: "Não conferido", itens: 1 },
    { status: "2", descricaoStatus: "Cancelado", itens: 3 },
    { status: "1", descricaoStatus: "Não conferido", itens: 0 },
    { status: "3", descricaoStatus: "Em produção", itens: 2 }
  ]).ativos, 1);
  assert.equal(extractor.summarizeListedOrders([
    { status: "1", descricaoStatus: "Não conferido", itens: 1 },
    { status: "2", descricaoStatus: "Cancelado", itens: 3 },
    { status: "1", descricaoStatus: "Não conferido", itens: 0 },
    { status: "3", descricaoStatus: "Em produção", itens: 2 }
  ]).cancelados, 1);
  const detailSummary = extractor.buildDetailsSummary([
    { numeroPedidoDigital: "900101", arquivosExtraidos: 2, fotosRetornadas: 2, arquivosInvalidos: 0,
      arquivosValidos: 2, sessoes: [{ sessao: "M99998", arquivos: 2, existeNoGestao: true }],
      data: "2026-09-29", dataListagem: "2026-09-29", dataDivergente: false },
    { numeroPedidoDigital: "900102", arquivosExtraidos: 1, fotosRetornadas: 1, arquivosInvalidos: 0,
      arquivosValidos: 1, sessoes: [{ sessao: "M99998", arquivos: 1, existeNoGestao: true }],
      data: "2026-09-28", dataListagem: "2026-09-28", dataDivergente: false },
    { numeroPedidoDigital: "900103", arquivosExtraidos: 1, fotosRetornadas: 1, arquivosInvalidos: 0,
      arquivosValidos: 1, statusCodigo: 4, status: "Produção",
      sessoes: [{ sessao: "M99999", arquivos: 1, existeNoGestao: false }],
      data: "2026-09-27", dataListagem: "2026-09-27", dataDivergente: false }
  ], [
    { numeroPedido: "900101", status: "1", descricaoStatus: "Não conferido", itens: 2 },
    { numeroPedido: "900102", status: "2", descricaoStatus: "Cancelado", itens: 2 },
    { numeroPedido: "900103", status: "4", descricaoStatus: "Produção", itens: 1 }
  ]);
  assert.equal(detailSummary.pedidosProcessados, 3);
  assert.equal(detailSummary.cancelados.comFotos, 1);
  assert.equal(detailSummary.cancelados.sessoesTambemEmAtivos, 1);
  assert.equal(detailSummary.itensFotosIguais, 2);
  assert.equal(detailSummary.itensFotosDivergentes, 1);
  assert.equal(detailSummary.sessoesNaoEncontradas[0].sessao, "M99999");
  assert.equal(detailSummary.sessoesEmMultiplosPedidosDetalhe[0].sessao, "M99998");
  assert.equal(detailSummary.outrosStatus[0].statusCodigo, 4);
  assert.equal(extractor.sanitizedError(new Error("secret-cookie=bad")), "EXTRACTOR_FAILED");
  const safeError = extractor.sanitizedError(new Error("SESSION_EXPIRED"));
  assert.equal(safeError, "SESSION_EXPIRED");

  let pageCalls = 0;
  const pages = await core.collectLatestOrderWindow(async (page, count) => {
    pageCalls++;
    return { totalRegistros: count ? 1049 : null,
      orders: Array.from({ length: 25 }, (_, i) => fixtureOrder(String(100000 + (page - 1) * 25 + i), (page - 1) * 25 + i + 1)) };
  }, { pageSize: extractor.LIST_PAGE_SIZE, maxOrders: extractor.MAX_HISTORY_ORDERS });
  assert.equal(pages.orders.length, extractor.MAX_HISTORY_ORDERS);
  assert.equal(pages.considered, extractor.MAX_HISTORY_ORDERS);
  assert.equal(pages.availableTotal, 1049);
  assert.equal(pages.ignoredByLimit, 849);
  assert.equal(pages.pagesConsulted, extractor.MAX_LIST_PAGES);
  assert.equal(pageCalls, extractor.MAX_LIST_PAGES);
  assert.equal(extractor.MAX_LIST_PAGES, 8);
  const listReport = extractor.humanReport({ summary: {
    pedidosEncontrados: pages.availableTotal, pedidosDisponiveis: pages.availableTotal,
    limiteConfigurado: extractor.MAX_HISTORY_ORDERS, pedidosConsiderados: pages.considered,
    pedidosIgnoradosPorLimiteHistorico: pages.ignoredByLimit, pedidosProcessados: pages.considered,
    paginasConsultadas: pages.pagesConsulted, primeiroPedidoConsiderado: pages.orders[0].numeroPedido,
    ultimoPedidoConsiderado: pages.orders.at(-1).numeroPedido, duplicatasNumeroPedido: 0,
    duplicatasIdFotoPedido: 0, paginasInconsistentes: 0,
    ativos: 0, cancelados: 0, semConteudo: 0, semSessaoExtraivel: 0, outrosStatus: 0,
    sessoesUnicas: 0, sessoesEncontradasNoGestao: 0, sessoesNaoEncontradasNoGestao: 0,
    associacoesDigitalSessao: 0, pedidosDigitalJaExistentes: 0, pedidosDigitalNovos: 0,
    pedidosNoOp: 0, pedidosConflitantes: 0, sessoesEmMultiplosPedidos: 0, arquivosInvalidos: 0, errosApi: 0
  } });
  assert.match(listReport, /Limite configurado: 200/);
  assert.match(listReport, /Pedidos disponíveis na Digital: 1049/);
  assert.match(listReport, /Pedidos considerados nesta execução: 200/);
  assert.match(listReport, /Pedidos ignorados por limite histórico: 849/);
  assert.match(listReport, /Páginas consultadas: 8/);
  assert.match(listReport, /Primeiro pedido considerado: 100000/);
  assert.match(listReport, /Último pedido considerado: 100199/);
  assert.match(listReport, /NumeroPedido duplicados: 0/);
  assert.match(listReport, /IdFotoPedido duplicados: 0/);

  let truncationCalls = 0;
  const truncated = await core.collectLatestOrderWindow(async (page, count) => {
    truncationCalls++;
    return { totalRegistros: count ? 137 : null,
      orders: Array.from({ length: 25 }, (_, i) => fixtureOrder(String(200000 + (page - 1) * 25 + i), (page - 1) * 25 + i + 1)) };
  }, { pageSize: 25, maxOrders: 27 });
  assert.equal(truncated.orders.length, 27);
  assert.equal(truncated.orders.at(-1).numeroPedido, "200026");
  assert.equal(truncationCalls, 2);

  await assert.rejects(core.collectLatestOrderWindow(async () => ({ totalRegistros: 25, orders: [fixtureOrder("100000", 1)] }), { pageSize: 25, maxOrders: 50 }), /pagination_total_mismatch/);
  const noCount = await core.collectLatestOrderWindow(async () => ({ totalRegistros: null, orders: [fixtureOrder("100000", 1)] }), { pageSize: 25, maxOrders: 50 });
  assert.equal(noCount.orders.length, 1);
  const duplicateSummary = core.summarizeOrderList([fixtureOrder("100000", 1), fixtureOrder("100000", 2)]);
  assert.equal(duplicateSummary.duplicates.length, 1);
  assert.equal(duplicateSummary.duplicateNumbers.length, 1);
  assert.equal(duplicateSummary.duplicateIds.length, 0);
  await assert.rejects(core.collectLatestOrderWindow(async () => ({ totalRegistros: 2,
    orders: [fixtureOrder("100000", 1), fixtureOrder("100000", 2)] }), { pageSize: 25, maxOrders: 2 }), /orders_duplicate_ids_or_numbers/);

  assert.equal(extractor.countInPayload(parsed), 2);
  assert.equal(extractor.toIsoDateWithoutLocalShift(1790640000000), new Date(1790640000000).toISOString().slice(0, 10));
  assert.throws(() => extractor.parseArgs(["--seed-stdin", "--db", "foo", "--delay-ms", "399"]), /cli_arguments_required/);
  assert.equal(extractor.parseArgs(["--seed-stdin", "--db", "foo", "--sample-orders", "900001,900002,900003"]).delayMs, 500);
  assert.equal(extractor.parseArgs(["--seed-stdin", "--db", "foo", "--mode", "list"]).mode, "list");
  assert.match(extractor.humanReport({ summary: extractor.makeSummary([extracted], 1) }), /ALTERAÇÕES NO BANCO: 0/);

  const originalFetch = global.fetch;
  try {
    let calls = 0;
    global.fetch = async (_url, init) => {
      calls++;
      assert.equal(init.method, "POST");
      assert.equal(init.body.get("pagina"), "1");
      return new Response(JSON.stringify({ ObjetoRetorno: { Pedidos: [] }, Zid: "refreshed" }), {
        status: 200, headers: { "content-type": "application/json", "set-cookie": "rotated=abc; Path=/; HttpOnly" }
      });
    };
    const requestHeaders = { cookie: "old=value" };
    await extractor.post("https://online-ws.sigi.com.br/24.3.27.2/", "Pedido/Pedidos", requestHeaders,
      { pagina: "1", Zid: "z", Chave: "k", DadosRepositorioSerializado: "d" }, 400);
    assert.equal(requestHeaders.cookie.includes("rotated=abc"), true);
    assert.equal(calls, 1);
    calls = 0;
    global.fetch = async () => { calls++; return new Response("{}", { status: 429 }); };
    await assert.rejects(extractor.post("https://online-ws.sigi.com.br/24.3.27.2/", "Pedido/Pedidos", {}, { pagina: "1" }, 400), /RATE_LIMITED/);
    assert.equal(calls, 1);
    calls = 0;
    global.fetch = async () => { calls++; return new Response("{}", { status: 500 }); };
    await assert.rejects(extractor.post("https://online-ws.sigi.com.br/24.3.27.2/", "Pedido/Pedidos", {}, { pagina: "1" }, 400), /UPSTREAM_ERROR/);
    assert.equal(calls, 3);
  } finally { global.fetch = originalFetch; }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "digital-history-test-"));
  try {
    const dbPath = path.join(temp, "fixture.sqlite3");
    const writable = new DatabaseSync(dbPath);
    writable.exec("CREATE TABLE pedidos (id TEXT, sessao TEXT); CREATE TABLE digital_envios (id TEXT, numero_pedido_digital TEXT, data_envio TEXT); CREATE TABLE digital_envio_itens (digital_envio_id TEXT, pedido_id TEXT);");
    writable.exec("INSERT INTO pedidos VALUES ('p1','M99991'); INSERT INTO digital_envios VALUES ('d1','900001','2026-01-01'); INSERT INTO digital_envio_itens VALUES ('d1','p1');");
    writable.close();
    const readonlyCode = `const {DatabaseSync}=require('node:sqlite');const x=require(process.argv[2]);const db=new DatabaseSync(process.argv[1],{readOnly:true});db.exec('PRAGMA query_only=ON');const s=x.locateDigitalShipments(db);const a=x.annotateAgainstDatabase({numeroPedidoDigital:'900001',data:'2026-01-01',sessoes:[{sessao:'M99991',arquivos:3}]},s);let blocked=false;try{db.exec(\"INSERT INTO pedidos VALUES ('p2','M00001')\")}catch{blocked=true}db.close();process.stdout.write(JSON.stringify({a,blocked}));`;
    const readonlyOutput = execFileSync(process.execPath, ["-e", readonlyCode, dbPath, path.resolve(__dirname, "extractor.cjs")], { encoding: "utf8" });
    const readonlyResult = JSON.parse(readonlyOutput);
    assert.equal(readonlyResult.a.pedidoDigitalJaExiste, true);
    assert.equal(readonlyResult.a.idempotencia, "NO_OP");
    assert.equal(readonlyResult.blocked, true);
    const outputDir = path.join(temp, "work", "digital-history");
    extractor.saveCheckpoint(outputDir, { processed: 1, orders: [{ numeroPedidoDigital: "900001" }] });
    const saved = fs.readFileSync(path.join(outputDir, "checkpoint.json"), "utf8");
    assert.doesNotMatch(saved, /secret-zid|secret-key|secret-repository|secret-cookie/);
    assert.equal(JSON.parse(saved).processed, 1);
  } finally { removeTree(temp); }

  process.stdout.write("digital-history unit tests passed\n");
}

run().catch((error) => { process.stderr.write(`${error.stack}\n`); process.exitCode = 1; });
