const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { test } = require("node:test");
const { spawn } = require("node:child_process");
const { digitalOptions, discoverSigiConfiguration } = require("../server/integrations/digital/sigi-config.cjs");
const { SigiClient, redact, decode } = require("../server/integrations/digital/sigi-client.cjs");
const { loadCredential, saveCredential, credentialPath } = require("../server/integrations/digital/credential-store.cjs");
const { buildDryRun, makeSnapshot, planDetail, readDatabaseState, scanRecent } = require("../server/integrations/digital/digital-sync-planner.cjs");
const { DigitalSyncService, writeDryRunReports } = require("../server/integrations/digital/digital-sync-service.cjs");

const wrapper = (object, extra = {}, status = 200) => new Response(JSON.stringify(JSON.stringify({
  Status: 0, Zid: "z-test", Chave: "key-test", DadosRepositorioSerializado: "repo-test", ObjetoRetorno: object, ...extra
})), { status, headers: { "content-type": "application/json" } });
const listing = (orders) => ({ Pedidos: orders.map((o) => ({ IdFotoPedido: o.idFotoPedido,
  NumeroPedido: o.numeroPedido, DataPedidoMiliegundos: Date.UTC(2026, 8, 1), Status: o.status || 0,
  DescricaoStatus: o.descricaoStatus || "Não conferido", Itens: o.itens ?? 1 })), TotalRegistros: orders.length });
const meta = (id, number, status = "Não conferido") => ({ idFotoPedido: id, numeroPedido: number,
  status: 0, descricaoStatus: status, itens: 1, dataPedidoMiliegundos: Date.UTC(2026, 8, 1) });
const detail = (number, session = "M50255") => ({ numeroPedidoDigital: number,
  classification: "CANDIDATO", itensInformados: 1, fotosRetornadas: 1,
  arquivosInvalidos: 0, sessoes: [{ sessao: session, arquivos: 1 }] });
const dbState = (existing = []) => ({ sessions: new Map([["M50255", "p1"]]),
  existing: new Map(existing.map((number) => [String(number).toLowerCase(), { id: number }])),
  counts: { envios: 172, relacoes: 780 } });

test("configuração nasce desabilitada e bloqueia versão inesperada", async () => {
  assert.equal(digitalOptions({}).enabled, false);
  assert.equal(digitalOptions({}).writeEnabled, false);
  assert.equal(digitalOptions({}).maxImportsPerCycle, 1);
  assert.equal(digitalOptions({ DIGITAL_SYNC_WRITE_ENABLED: "true" }).enabled, false);
  assert.equal(digitalOptions({ DIGITAL_SYNC_ENABLED: "true" }).writeEnabled, false);
  assert.equal(digitalOptions({}).recentOrders, 50);
  assert.throws(() => digitalOptions({ DIGITAL_SYNC_MAX_SCAN_PAGES: "0" }), /DIGITAL_CONFIG_ERROR/);
  assert.throws(() => digitalOptions({ DIGITAL_SYNC_MAX_IMPORTS_PER_CYCLE: "0" }), /DIGITAL_CONFIG_ERROR/);
  const fetcher = async (url) => new Response(JSON.stringify(String(url).includes("sigi-config")
    ? { Zid: "synthetic" } : { versaoWS: "../../evil" }), { status: 200 });
  await assert.rejects(discoverSigiConfiguration(fetcher), /DIGITAL_CONFIG_ERROR/);
});

test("cliente Node faz bootstrap, validação, login lógico e uma página sem Cookie", async () => {
  const routes = [];
  const fetcher = async (url, init = {}) => {
    if (!init.method) return new Response(JSON.stringify(String(url).includes("sigi-config")
      ? { Zid: "z-test" } : { versaoWS: "24.3.27.2" }), { status: 200 });
    const route = new URL(url).pathname.split("/").slice(2).join("/");
    routes.push(route);
    assert.equal(init.headers?.Cookie, undefined);
    assert.ok(init.body instanceof FormData);
    if (route === "App/ObterViewModel") return wrapper({ ok: true });
    if (route === "Login/ValidarEmail" || route === "Login/ValidarSenha") return wrapper(true);
    if (route === "Login/VerificarLogin") return wrapper({ Status: 1, Cliente: { IDCliente: 1 } },
      { DadosRepositorioSerializado: "repo-after-login" });
    if (route === "Pedido/Pedidos") {
      assert.equal(init.body.get("pagina"), "1");
      assert.equal(init.body.get("registrosPorPagina"), "1");
      assert.equal(init.body.get("DadosRepositorioSerializado"), "repo-after-login");
      return wrapper(listing([meta(101, "118700")]));
    }
    throw Error("unexpected route");
  };
  const client = new SigiClient({ fetchImpl: fetcher, credentialProvider: async () =>
    ({ username: "fixture@example.invalid", password: "synthetic" }), delayMs: 0 });
  const result = await client.listOrders(1, 1);
  assert.equal(result.orders.length, 1);
  assert.deepEqual(routes, ["App/ObterViewModel", "Login/ValidarEmail", "Login/ValidarSenha",
    "Login/VerificarLogin", "Pedido/Pedidos"]);
  assert.equal(client.credentials, null);
  client.close();
});

test("login inválido para antes de ValidarSenha; 429 não repete", async () => {
  let calls = 0;
  const config = async () => ({ baseUrl: new URL("https://online-ws.sigi.com.br/1.2.3.4/"), zid: "z" });
  const invalid = new SigiClient({ discover: config, delayMs: 0, credentialProvider: async () =>
    ({ username: "fixture@example.invalid", password: "synthetic" }), fetchImpl: async () => {
      calls++; return calls === 1 ? wrapper({}) : wrapper(false);
    } });
  await assert.rejects(invalid.login(), /DIGITAL_LOGIN_INVALID/);
  assert.equal(calls, 2);
  const limited = new SigiClient({ discover: config, delayMs: 0, credentialProvider: async () =>
    ({ username: "fixture@example.invalid", password: "synthetic" }), fetchImpl: async () => {
      calls++; return new Response("", { status: 429 });
    } });
  await assert.rejects(limited.login(), /DIGITAL_RATE_LIMIT/);
  assert.equal(calls, 3);
});

test("renovação controlada faz no máximo um novo login e repete somente leitura", async () => {
  let bootstraps = 0, orderCalls = 0;
  const client = new SigiClient({ delayMs: 0, discover: async () =>
    ({ baseUrl: new URL("https://online-ws.sigi.com.br/1.2.3.4/"), zid: "z" }),
    credentialProvider: async () => ({ username: "fixture@example.invalid", password: "synthetic" }),
    fetchImpl: async (url) => {
      const route = new URL(url).pathname.split("/").slice(2).join("/");
      if (route === "App/ObterViewModel") { bootstraps++; return wrapper({}); }
      if (route === "Login/ValidarEmail" || route === "Login/ValidarSenha") return wrapper(true);
      if (route === "Login/VerificarLogin") return wrapper({ Status: 1, Cliente: { IDCliente: 1 } });
      orderCalls++; return orderCalls === 1 ? new Response("", { status: 401 })
        : wrapper(listing([meta(1, "118700")]));
    } });
  assert.equal((await client.listOrders(1, 1)).orders.length, 1);
  assert.equal(bootstraps, 2);
  assert.equal(orderCalls, 2);
  client.close();
});

test("dupla serialização, redação e timeout limitado", async () => {
  assert.equal(decode(JSON.stringify(JSON.stringify({ Status: 0 }))).Status, 0);
  const redacted = redact({ Username: "private", Senha: "private", Cookie: "private",
    nested: { Chave: "private", ok: true } });
  assert.equal(JSON.stringify(redacted).includes("private"), false);
  const client = new SigiClient({ delayMs: 0, pause: async () => {}, fetchImpl: async () => { throw Error("timeout"); } });
  client.baseUrl = new URL("https://online-ws.sigi.com.br/1.2.3.4/");
  client.state = { Zid: "z", Chave: "k", DadosRepositorioSerializado: "r" };
  await assert.rejects(client.post("Pedido/Pedidos"), /DIGITAL_API_UNAVAILABLE/);
});

test("baseline e ciclo seguinte classificam apenas dois novos ativos", async () => {
  const first = [meta(1, "118596"), meta(2, "118569"), meta(3, "118489")];
  const options = { pageSize: 4, recentOrders: 4, maxScanPages: 2 };
  const client1 = { listOrders: async () => ({ orders: first, totalRegistros: 3 }),
    getOrderDetail: async () => { throw Error("baseline must not request details"); } };
  const baseline = await buildDryRun({ client: client1, snapshot: null, options, dbState: dbState(["118596"]) });
  assert.equal(baseline.mode, "baseline");
  assert.equal(baseline.databaseWrites, 0);
  const second = [meta(10, "118700"), meta(11, "118699"), meta(1, "118596"), meta(12, "118698", "Cancelado")];
  const detailed = [];
  const client2 = { listOrders: async () => ({ orders: second, totalRegistros: 4 }),
    getOrderDetail: async (o) => { detailed.push(o.numeroPedido); return detail(o.numeroPedido); } };
  const result = await buildDryRun({ client: client2, snapshot: baseline.nextSnapshot, options,
    dbState: dbState(["118596"]) });
  assert.deepEqual(detailed, ["118700", "118699"]);
  assert.equal(result.planned.filter((p) => p.category === "CANDIDATE").length, 2);
  assert.equal(result.planned.filter((p) => p.category === "SKIP_CANCELLED").length, 1);
  assert.equal(result.databaseWrites, 0);
});

test("pendência reconsiderada, reenvio legítimo, UNDER/OVER e divergência 112097", () => {
  const order = meta(10, "118700"), missing = detail("118700", "M50261");
  assert.equal(planDetail(order, missing, dbState()).category, "PENDING_MISSING_SESSION");
  const nowPresent = dbState(); nowPresent.sessions.set("M50261", "p2");
  assert.equal(planDetail(order, missing, nowPresent).category, "CANDIDATE");
  assert.equal(planDetail(meta(11, "118699"), detail("118699"), dbState()).category, "CANDIDATE");
  const under = { ...detail("118700"), itensInformados: 2, fotosRetornadas: 2 };
  assert.equal(planDetail(order, under, dbState()).category, "CANDIDATE_UNDER_TOTAL");
  assert.equal(planDetail(order, under, dbState()).quantityClassification, "UNDER_TOTAL");
  const over = { ...detail("118700"), itensInformados: 1, fotosRetornadas: 1,
    sessoes: [{ sessao: "M50255", arquivos: 2 }] };
  assert.equal(planDetail(order, over, dbState()).category, "REVIEW_OVER_TOTAL");
  assert.equal(planDetail(order, over, dbState()).quantityClassification, "OVER_TOTAL");
  const divergent = { ...detail("112097"), itensInformados: 100, fotosRetornadas: 1 };
  assert.equal(planDetail(meta(12, "112097"), divergent, dbState()).category, "REVIEW_ITEM_PHOTO_MISMATCH");
  assert.equal(planDetail(order, { ...detail("118700"), sessoes: [], arquivosInvalidos: 1 }, dbState()).category, "PENDING_NO_SESSION");
  assert.equal(planDetail(order, detail("118700"), dbState()).quantityClassification, "MATCH");
  assert.equal(planDetail(order, { ...detail("118700"), itensInformados: null }, dbState()).quantityClassification, "UNKNOWN");
  const multi = { ...detail("118700"), itensInformados: 2, fotosRetornadas: 2,
    sessoes: [{ sessao: "M50255", arquivos: 1 }, { sessao: "M50261", arquivos: 1 }] };
  assert.equal(planDetail(order, multi, nowPresent).relations.length, 2);
});

test("baseline inicial não é substituído pelo snapshot incremental", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digital-sync-baseline-"));
  const makeReport = (mode, snapshot) => ({ mode, scan: { listed: 1, pages: 1, possibleGap: false },
    planned: [], nextSnapshot: snapshot, summary: { existing: 0, baselineObserved: 1,
      newObserved: 0, cancelled: 0, pending: 0, missingSessions: 0, quantityDivergences: 0 },
    loginSucceeded: true, sigiVersion: "1.2.3.4", durationMs: 1 });
  try {
    writeDryRunReports(dir, makeReport("baseline", makeSnapshot([meta(1, "OLD")])));
    const before = fs.readFileSync(path.join(dir, "baseline-preview.json"), "utf8");
    writeDryRunReports(dir, makeReport("incremental", makeSnapshot([meta(2, "NEW")])));
    assert.equal(fs.readFileSync(path.join(dir, "baseline-preview.json"), "utf8"), before);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "latest-snapshot-preview.json"))).orders[0].numeroPedido, "NEW");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("janela sem sobreposição sinaliza lacuna e limita páginas", async () => {
  let calls = 0;
  const client = { listOrders: async (page) => {
    calls++; return { orders: [meta(page, `NEW${page}`)], totalRegistros: 10 };
  } };
  const result = await scanRecent(client, makeSnapshot([meta(99, "OLD")]),
    { pageSize: 1, recentOrders: 1, maxScanPages: 2 });
  assert.equal(calls, 2);
  assert.equal(result.gap, true);
});

test("total exato encerra paginação sem falsa lacuna", async () => {
  const client = { listOrders: async (page) => {
    assert.equal(page, 1);
    return { orders: [meta(1, "118700")], totalRegistros: 1 };
  } };
  const result = await scanRecent(client, makeSnapshot([meta(99, "OLD")]),
    { pageSize: 1, recentOrders: 1, maxScanPages: 4 });
  assert.equal(result.pages, 1);
  assert.equal(result.gap, false);
});

test("pendência fora da janela permanece no snapshot seguinte", async () => {
  const prior = makeSnapshot([meta(1, "118596")], ["777"]);
  const client = { listOrders: async () => ({ orders: [meta(1, "118596")], totalRegistros: 1 }),
    getOrderDetail: async () => { throw Error("unexpected detail"); } };
  const result = await buildDryRun({ client, snapshot: prior,
    options: { pageSize: 1, recentOrders: 1, maxScanPages: 1 }, dbState: dbState() });
  assert.deepEqual(result.nextSnapshot.pendingIds, ["777"]);
});

test("SQLite sintético é aberto somente para leitura, sem mutação", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digital-sync-db-"));
  const file = path.join(dir, "test.sqlite3");
  try {
    const db = new DatabaseSync(file);
    db.exec("CREATE TABLE pedidos(id TEXT,sessao TEXT,revisao INTEGER); CREATE TABLE digital_envios(id TEXT,numero_pedido_digital TEXT,itens_digital INTEGER); CREATE TABLE digital_envio_itens(id TEXT)");
    db.exec("INSERT INTO pedidos VALUES('p1','M50255',1); INSERT INTO digital_envios VALUES('d1','118596',1); INSERT INTO digital_envio_itens VALUES('i1')");
    db.close();
    const before = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    assert.deepEqual({ ...readDatabaseState(file).counts }, { envios: 1, relacoes: 1 });
    const after = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    assert.equal(before, after);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("trava bloqueia execução concorrente", async () => {
  let release;
  const barrier = new Promise((resolve) => { release = resolve; });
  let entered;
  const arrived = new Promise((resolve) => { entered = resolve; });
  const dbPath = path.resolve("synthetic.sqlite3"), dataDir = path.dirname(dbPath);
  const make = () => new DigitalSyncService({ dbPath, dataDir, options: { pageSize: 1,
    recentOrders: 1, maxScanPages: 1 }, dbReader: () => dbState(),
    clientFactory: () => ({ close() {}, async listOrders() { entered(); await barrier;
      return { orders: [meta(1, "118700")], totalRegistros: 1 }; } }) });
  const first = make().runDryRun({ snapshot: null, writeReports: false });
  await arrived;
  await assert.rejects(make().runDryRun({ snapshot: null, writeReports: false }), /DIGITAL_SYNC_BUSY/);
  release();
  await first;
});

test("trava entre processos bloqueia PID ativo e é removida ao terminar", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digital-sync-lock-"));
  try {
    fs.writeFileSync(path.join(dir, "digital-sync.lock"), JSON.stringify({ pid: process.pid, token: "other" }));
    const dbPath = path.join(dir, "synthetic.sqlite3");
    const service = new DigitalSyncService({ dbPath, dataDir: dir, outputDir: dir,
      options: { pageSize: 1, recentOrders: 1, maxScanPages: 1 }, dbReader: () => dbState(),
      clientFactory: () => ({ close() {}, listOrders: async () => ({ orders: [], totalRegistros: 0 }) }) });
    await assert.rejects(service.runDryRun({ snapshot: null }), /DIGITAL_SYNC_BUSY/);
    fs.rmSync(path.join(dir, "digital-sync.lock"));
    await service.runDryRun({ snapshot: null });
    assert.equal(fs.existsSync(path.join(dir, "digital-sync.lock")), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("credencial ausente falha sem iniciar sincronização", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digital-sync-credential-"));
  try { await assert.rejects(loadCredential(dir), /DIGITAL_CREDENTIAL_MISSING/); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("DPAPI protege fixture sintética no Windows", { skip: process.platform !== "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digital-sync-dpapi-"));
  try {
    await saveCredential(dir, { username: "fixture@example.invalid", password: "synthetic-only" });
    assert.equal(fs.readFileSync(credentialPath(dir), "utf8").includes("synthetic-only"), false);
    const value = await loadCredential(dir);
    assert.equal(value.password, "synthetic-only");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("provisionador local exige Origin e CSRF e grava só DPAPI", { skip: process.platform !== "win32" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "digital-provision-ui-"));
  const child = spawn(process.execPath, [path.resolve("scripts/provision-digital-credential-local.cjs")], {
    cwd: path.resolve("."), env: { ...process.env, GESTAO_SERVER_DATA: dir,
      DIGITAL_PROVISION_LOGIN: "fixture@example.invalid" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true
  });
  try {
    const origin = await new Promise((resolve, reject) => {
      let output = "";
      const timeout = setTimeout(() => reject(new Error("provisioner timeout")), 10000);
      child.stdout.on("data", (chunk) => {
        output += chunk.toString("utf8");
        const match = output.match(/DIGITAL_PROVISION_URL=(http:\/\/127\.0\.0\.1:\d+\/)/);
        if (match) { clearTimeout(timeout); resolve(match[1]); }
      });
      child.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`provisioner exited ${code}`)); });
    });
    const page = await fetch(origin);
    const html = await page.text();
    const token = html.match(/name="csrf" value="([a-f0-9]+)"/)?.[1];
    const cookie = page.headers.get("set-cookie")?.split(";")[0];
    assert.ok(token && cookie);
    const body = new URLSearchParams({ csrf: token, password: "synthetic-only" });
    const bad = await fetch(new URL("provision", origin), { method: "POST", headers: {
      Origin: "http://evil.invalid", Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded"
    }, body });
    assert.equal(bad.status, 403);
    const opaqueCrossSite = await fetch(new URL("provision", origin), { method: "POST", headers: {
      Origin: "null", "Sec-Fetch-Site": "cross-site", Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded"
    }, body });
    assert.equal(opaqueCrossSite.status, 403);
    const good = await fetch(new URL("provision", origin), { method: "POST", headers: {
      Origin: "null", "Sec-Fetch-Site": "same-origin", Cookie: cookie,
      "Content-Type": "application/x-www-form-urlencoded"
    }, body });
    assert.equal(good.status, 200);
    assert.equal(fs.readFileSync(credentialPath(dir), "utf8").includes("synthetic-only"), false);
    assert.equal((await loadCredential(dir)).password, "synthetic-only");
  } finally { child.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
});
