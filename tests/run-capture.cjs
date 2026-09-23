const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-logistica-visual-"));
  let server;
  try {
    const { createServer } = await import("vite");
    server = await createServer({ root: path.join(__dirname, ".."), server: { host: "127.0.0.1", port: 0, strictPort: true, open: false } });
    await server.listen();
    const address = server.httpServer.address();
    assert(address && typeof address === "object" && address.address === "127.0.0.1");
    const port = address.port;
    const origin = `http://127.0.0.1:${port}`;
    const env = { ...process.env, GESTAO_CAPTURE_PROFILE: root, GESTAO_DEV_SERVER_URL: origin, GESTAO_CAPTURE_PORT: String(port) };
    delete env.ELECTRON_RUN_AS_NODE;
    await new Promise((resolve, reject) => {
      const electron = spawn(require("electron"), [path.join(__dirname, "capture-ui.cjs")], { env, stdio: "inherit", windowsHide: true });
      let expired = false;
      const timer = setTimeout(() => { expired = true; electron.kill(); }, 60000);
      electron.once("error", (error) => { clearTimeout(timer); reject(error); });
      electron.once("exit", (code) => {
        clearTimeout(timer);
        if (code === 0 && !expired) { console.log(`porta=${port}`); resolve(); }
        else reject(new Error(`Captura falhou: code=${code}, timeout=${expired}`));
      });
    });
  } finally {
    if (server) await server.close();
    assert.equal(path.dirname(root).toLowerCase(), path.resolve(os.tmpdir()).toLowerCase());
    assert(path.basename(root).startsWith("gestao-logistica-visual-"));
    assert(!fs.lstatSync(root).isSymbolicLink());
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    console.log("Perfil temporario removido:", root);
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
