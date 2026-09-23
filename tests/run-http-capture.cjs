const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const database = require("../electron/database.cjs");
const { startApiServer } = require("../server/api-server.cjs");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-logistica-http-visual-"));
  const resolvedRoot = path.resolve(root);
  const tempRoot = path.resolve(os.tmpdir()) + path.sep;
  assert(resolvedRoot.startsWith(tempRoot));
  assert(path.basename(resolvedRoot).startsWith("gestao-logistica-http-visual-"));
  assert(!fs.lstatSync(resolvedRoot).isSymbolicLink());
  let vite;
  let api;
  try {
    const { createServer } = await import("vite");
    vite = await createServer({ root: path.join(__dirname, ".."), server: { host: "127.0.0.1", port: 0, strictPort: true, open: false } });
    await vite.listen();
    const address = vite.httpServer.address();
    assert(address && typeof address === "object" && address.address === "127.0.0.1");
    const viteOrigin = `http://127.0.0.1:${address.port}`;
    api = await startApiServer({ userDataPath: path.join(root, "api-user-data"), allowedOrigin: viteOrigin });
    const imported = database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M99997", clienteNome: "Cliente HTTP Teste", clienteEmail: "http-visual@example.invalid", clienteTelefone: "00000000000", clienteCidade: "Curitiba - TESTE", fotosQuantidade: 12, observacoes: "Fixture visual HTTP sintético.", editor: "Editor HTTP", selecaoFinalizadaEm: null, tratamentoConcluido: false }] });
    assert.equal(imported.ok, true);
    assert.equal(imported.imported, 1);
    const probe = await fetch(api.origin + "/api/orders?search=M99997&filter=all", { headers: { Origin: viteOrigin } });
    assert.equal(probe.ok, true);
    assert.equal(probe.headers.get("access-control-allow-origin"), viteOrigin);
    assert.equal((await probe.json()).rows[0].sessao, "M99997");
    const output = path.join(path.join(__dirname, ".."), "work", "gestao-logistica-http-ui.png");
    const env = { ...process.env, GESTAO_CAPTURE_PROFILE: path.join(root, "client-profile"), GESTAO_DEV_SERVER_URL: viteOrigin, GESTAO_DATA_TRANSPORT: "http", GESTAO_API_URL: api.origin, GESTAO_CAPTURE_SESSION: "M99997", GESTAO_CAPTURE_CLIENT_NAME: "Cliente HTTP Teste", GESTAO_CAPTURE_PATH: output };
    delete env.ELECTRON_RUN_AS_NODE;
    env.GESTAO_HTTP_TEST_PROFILE = env.GESTAO_CAPTURE_PROFILE;
    await new Promise((resolve, reject) => {
      const electron = spawn(require("electron"), [path.join(__dirname, "capture-ui.cjs")], { env, stdio: "inherit", windowsHide: true });
      let expired = false;
      const timer = setTimeout(() => { expired = true; electron.kill(); }, 60000);
      electron.once("error", (error) => { clearTimeout(timer); reject(error); });
      electron.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 && !expired) resolve();
        else reject(new Error(`Captura HTTP falhou: code=${code}, timeout=${expired}`));
      });
    });
    console.log(`API HTTP visual aprovada: ${api.origin}`);
  } finally {
    if (vite) await vite.close();
    if (api) await api.close(); else database.close();
    assert(resolvedRoot.startsWith(tempRoot));
    assert(path.basename(resolvedRoot).startsWith("gestao-logistica-http-visual-"));
    assert(!fs.lstatSync(resolvedRoot).isSymbolicLink());
    fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    console.log("Perfil HTTP temporário removido:", resolvedRoot);
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
