const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const WebSocket = globalThis.WebSocket;
assert.equal(typeof WebSocket, "function", "O runtime Node precisa fornecer WebSocket global.");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
async function waitFor(check, label, timeout = 30000) {
  const deadline = Date.now() + timeout;
  let error;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (next) { error = next; }
    await sleep(150);
  }
  throw new Error(`POPUP_VISUAL_SMOKE_TIMEOUT: ${label}${error ? ` (${error.message})` : ""}`);
}
async function connect(port, predicate) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json`);
    if (!response.ok) return null;
    const pages = await response.json();
    return pages.find(predicate);
  }, "popup page no DevTools");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (!message.id || !pending.has(message.id)) return;
    const callbacks = pending.get(message.id); pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message)); else callbacks.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const value = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (value.exceptionDetails) throw new Error(value.exceptionDetails.text);
    return value.result?.value;
  };
  await send("Runtime.enable");
  return { socket, send, evaluate };
}
async function main() {
  const packageDirectory = path.resolve(process.env.GESTAO_PACKAGED_DIR || "release-v018-candidate/win-unpacked");
  const executable = path.join(packageDirectory, "Gestão Logística.exe");
  assert.ok(fs.existsSync(executable), `Runtime candidato não encontrado: ${executable}`);
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-popup-visual-"));
  const smokeDirectory = path.join(tempRoot, "runtime");
  const screenshotPath = path.resolve("work", "v018-popup-desktop.png");
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  const port = await freePort();
  const env = { ...process.env, GESTAO_PACKAGED_RUNTIME_SMOKE_DIR: smokeDirectory, GESTAO_PACKAGED_RUNTIME_INTERACTIVE_SMOKE: "1" };
  for (const key of ["GESTAO_SERVER_DATA", "GESTAO_DATA_TRANSPORT", "GESTAO_API_URL", "GESTAO_CLIENT_CONFIG", "GESTAO_HTTP_TEST_PROFILE", "GESTAO_CLIENT_MODE", "ELECTRON_RUN_AS_NODE"]) delete env[key];
  const child = spawn(executable, ["--gestao-background-start", "--gestao-popup-test", `--remote-debugging-port=${port}`, "--remote-allow-origins=*"], {
    cwd: packageDirectory, env, stdio: "ignore", windowsHide: true,
  });
  let popup;
  try {
    child.on("error", (error) => { throw error; });
    popup = await connect(port, (page) => page.type === "page" && page.url.includes("solicitation-popup.html"));
    const result = await waitFor(async () => {
      const text = await popup.evaluate("document.body.innerText");
      return /Prazo próximo/.test(text) ? text : null;
    }, "popup renderizado");
    assert.match(result, /Prazo próximo/);
    assert.match(result, /Sessão M50258/);
    assert.match(result, /Faltam 5 minutos/);
    assert.doesNotMatch(result, /descrição sintética/i);
    const shot = await popup.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false, fromSurface: true });
    fs.writeFileSync(screenshotPath, Buffer.from(shot.data, "base64"));
    assert.ok(fs.statSync(screenshotPath).size > 10000, "A captura visual deve conter o popup renderizado.");
    console.log(`Popup sintético empacotado exibido sem cadastro operacional; captura=${screenshotPath}`);
  } finally {
    popup?.socket.close();
    if (child.exitCode === null) {
      const killer = spawn(path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      await new Promise((resolve) => killer.once("exit", resolve));
    }
    fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}
main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
