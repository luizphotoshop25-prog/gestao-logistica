const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const { loadClientConfig, validateApiUrl } = require("../electron/client-config.cjs");

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
    console.log("Configuração HTTPS: origem explícita, rejeições, transporte e timeout aprovados.");
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert(path.basename(root).startsWith("gestao-remote-config-"));
    assert(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
