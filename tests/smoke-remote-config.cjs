const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { loadClientConfig, validateApiUrl } = require("../electron/client-config.cjs");
const { OFFICIAL_REMOTE_CONFIG_URL, checkRemoteApiHealth, fetchRemoteConfig, resolveRemoteConfig, validateRemoteConfig } = require("../electron/remote-config.cjs");
const { loadClientBuild } = require("../electron/client-build.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-remote-config-"));
  try {
    const configPath = path.join(root, "gestao-client.json");
    const environment = { GESTAO_CLIENT_CONFIG: configPath };
    assert.throws(() => loadClientConfig({ configPath, environment }), /não encontrado/);
    fs.writeFileSync(configPath, JSON.stringify({ transport: "http", apiUrl: "https://gestao.example.com", mode: "https-remote" }));
    assert.equal(loadClientConfig({ configPath, environment }).apiUrl, "https://gestao.example.com");
    for (const apiUrl of ["http://gestao.example.com:8787", "https://user:pass@gestao.example.com", "https://gestao.example.com/api", "https://gestao.example.com?x=1"]) {
      assert.throws(() => validateApiUrl(apiUrl, "https-remote"));
    }
    assert.equal(validateApiUrl("http://192.168.1.2:8787", "lan-pilot"), "lan-pilot");
    assert.deepEqual(loadClientBuild({ isPackaged: false, resourcesPath: root }), { variant: "development" });
    assert.throws(() => loadClientBuild({ isPackaged: true, resourcesPath: root }), /não foi provisionado/);
    fs.writeFileSync(path.join(root, "client-build.json"), JSON.stringify({ variant: "local" }));
    assert.deepEqual(loadClientBuild({ isPackaged: true, resourcesPath: root }), { variant: "local" });
    fs.writeFileSync(path.join(root, "client-build.json"), JSON.stringify({ variant: "remote", remoteConfigUrl: OFFICIAL_REMOTE_CONFIG_URL }));
    assert.equal(loadClientBuild({ isPackaged: true, resourcesPath: root }).variant, "remote");
    fs.writeFileSync(path.join(root, "client-build.json"), JSON.stringify({ variant: "remote", remoteConfigUrl: "https://attacker.example/config.json" }));
    assert.throws(() => loadClientBuild({ isPackaged: true, resourcesPath: root }), /não é aprovado/);
    const remote = { apiBaseUrl: "https://pilot-123.trycloudflare.com", environment: "pilot", enabled: true };
    assert.deepEqual(validateRemoteConfig(remote), remote);
    for (const apiBaseUrl of ["http://pilot.trycloudflare.com", "https://pilot.example.com", "https://pilot.trycloudflare.com/api", "https://u:p@pilot.trycloudflare.com", "https://pilot.trycloudflare.com?x=1"]) {
      assert.throws(() => validateRemoteConfig({ ...remote, apiBaseUrl }));
    }
    assert.throws(() => validateRemoteConfig({ ...remote, environment: "production" }));
    assert.throws(() => validateRemoteConfig({ ...remote, enabled: false }), (error) => error.code === "REMOTE_CONFIG_DISABLED");
    await assert.rejects(fetchRemoteConfig({ configUrl: "https://example.org/remote-config.json" }), /Origem de configuração/);
    const freshFetch = async (url, init) => {
      assert.equal(url, OFFICIAL_REMOTE_CONFIG_URL);
      assert.equal(init.redirect, "error");
      return new Response(JSON.stringify(remote), { status: 200, headers: { "content-type": "application/json" } });
    };
    assert.deepEqual(await fetchRemoteConfig({ fetchImpl: freshFetch }), remote);
    await assert.rejects(fetchRemoteConfig({ fetchImpl: async () => new Response("x".repeat(5000)) }), /tamanho permitido/);
    assert.deepEqual(await checkRemoteApiHealth(remote.apiBaseUrl, { fetchImpl: async (url) => {
      assert.equal(url, `${remote.apiBaseUrl}/health`);
      return new Response(JSON.stringify({ ok: true, database: "available" }), { status: 200 });
    } }), { ok: true });
    assert.equal((await checkRemoteApiHealth(remote.apiBaseUrl, { fetchImpl: async () => { throw new TypeError("offline"); } })).ok, false);
    assert.equal((await checkRemoteApiHealth("https://attacker.example", { fetchImpl: async () => { throw new Error("must not fetch"); } })).ok, false);
    const cachePath = path.join(root, "profile", "gestao-client-cache.json");
    const fresh = await resolveRemoteConfig({ cachePath, fetchImpl: freshFetch });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.source, "github");
    assert.deepEqual(JSON.parse(fs.readFileSync(cachePath, "utf8")), remote);
    const cached = await resolveRemoteConfig({ cachePath, fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(cached.ok, true);
    assert.equal(cached.source, "cache");
    const disabled = await resolveRemoteConfig({ cachePath, fetchImpl: async () => new Response(JSON.stringify({ environment: "pilot", enabled: false })) });
    assert.equal(disabled.ok, false, "disabled remote config must not use stale cache");
    fs.rmSync(cachePath, { force: true });
    const noCache = await resolveRemoteConfig({ cachePath, fetchImpl: async () => { throw new Error("offline"); } });
    assert.equal(noCache.ok, false);
    const source = fs.readFileSync(path.join(__dirname, "../src/services/dataService.ts"), "utf8");
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const calls = [];
    const fetchStub = async (url, init) => {
      calls.push({ url, init });
      return { status: 200, headers: { get: () => "application/json" }, json: async () => ({ ok: true, dashboard: { total: 1 } }) };
    };
    const context = { exports: {}, fetch: fetchStub, URL, AbortSignal, window: { gestaoConfig: { dataTransport: "http", apiUrl: "https://gestao.example.com" } } };
    vm.runInNewContext(compiled, context);
    assert.equal((await context.exports.dataService.dashboard()).dashboard.total, 1);
    assert.equal(calls[0].url, "https://gestao.example.com/api/dashboard");
    assert(calls[0].init.signal);
    assert.throws(() => validateApiUrl("https://gestao.example.com", "lan-pilot"));
    console.log("Configuração remota: origem oficial, HTTPS, esquema, limite de tamanho, cache, GitHub offline e desativação aprovados.");
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("gestao-remote-config-"));
    assert(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
