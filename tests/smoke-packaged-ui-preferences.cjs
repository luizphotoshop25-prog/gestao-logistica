const assert = require("node:assert/strict");
const fs = require("node:fs");
const net = require("node:net");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const timeoutMs = 30000;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitFor(check, label, timeout = timeoutMs) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try { const value = await check(); if (value) return value; } catch (error) { lastError = error; }
    await sleep(120);
  }
  throw new Error(`PACKAGED_UI_PREFERENCES_TIMEOUT: ${label}${lastError ? ` (${lastError.message})` : ""}`);
}

async function connect(port) {
  const target = await waitFor(async () => {
    const response = await fetch(`http://127.0.0.1:${port}/json`);
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((item) => item.type === "page" && item.url.includes("index.html"));
  }, "janela empacotada no CDP");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const callbacks = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) callbacks.reject(new Error(message.error.message));
    else callbacks.resolve(message.result);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
  await send("Runtime.enable");
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.text || "Falha de avaliação no runtime empacotado.");
    return response.result?.value;
  };
  return { socket, send, evaluate };
}

async function launch(executable, smokeDirectory) {
  const port = await freePort();
  const env = { ...process.env, GESTAO_PACKAGED_RUNTIME_SMOKE_DIR: smokeDirectory, GESTAO_PACKAGED_RUNTIME_INTERACTIVE_SMOKE: "1" };
  for (const name of ["GESTAO_DATA_TRANSPORT", "GESTAO_API_URL", "GESTAO_CLIENT_CONFIG", "GESTAO_HTTP_TEST_PROFILE", "GESTAO_CLIENT_MODE", "ELECTRON_RUN_AS_NODE"]) delete env[name];
  const child = spawn(executable, [`--remote-debugging-port=${port}`, "--remote-allow-origins=*"], { cwd: path.dirname(executable), env, stdio: "ignore", windowsHide: true });
  const runtime = await connect(port);
  await waitFor(async () => child.exitCode === null && await runtime.evaluate("document.querySelector('.app-navigation') !== null"), "interface autenticada empacotada");
  return { child, runtime };
}

async function closeRuntime(child, runtime) {
  if (child.exitCode !== null) { runtime.socket.close(); return; }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const executable = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
  const killer = spawn(executable, ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  await new Promise((resolve, reject) => {
    killer.once("error", reject);
    killer.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`taskkill terminou com código ${code}.`)));
  });
  await Promise.race([exited, sleep(8000)]);
  runtime.socket.close();
  if (child.exitCode === null) throw new Error("Não foi possível encerrar o runtime empacotado do perfil isolado.");
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-packaged-ui-preferences-"));
  const packageDirectory = path.resolve(process.env.GESTAO_PACKAGED_DIR || "release/win-unpacked");
  const executable = path.join(packageDirectory, "Gestão Logística.exe");
  assert.ok(fs.existsSync(executable), `Runtime empacotado não encontrado: ${executable}`);
  const smokeDirectory = path.join(root, "runtime");
  fs.mkdirSync(smokeDirectory, { recursive: true });
  const screenshotDirectory = path.resolve("work");
  fs.mkdirSync(screenshotDirectory, { recursive: true });
  let session;
  try {
    console.log("Runtime UI empacotado: iniciando verificação...");
    session = await launch(executable, smokeDirectory);
    const { runtime } = session;
    const initial = await runtime.evaluate("window.gestaoUiPreferences.get()");
    assert.deepEqual(initial, { ok: true, fontScale: 1 });
    const openSettings = async (target = runtime) => { await target.evaluate("document.querySelector('.appearance-trigger').click(); true"); await waitFor(() => target.evaluate("Boolean(document.querySelector('.appearance-dialog'))"), "diálogo Aparência"); };
    const selectScale = async (percent) => runtime.evaluate(`document.querySelector('.appearance-options button:nth-child(${[90, 100, 110, 120, 130].indexOf(percent) + 1})').click(); true`);
    const apply = async () => { await runtime.evaluate("document.querySelector('.appearance-apply').click(); true"); await waitFor(() => runtime.evaluate("!document.querySelector('.appearance-dialog')"), "fechamento ao aplicar"); };
    const cancel = async () => { await runtime.evaluate("document.querySelector('.appearance-actions .ui-button').click(); true"); await waitFor(() => runtime.evaluate("!document.querySelector('.appearance-dialog')"), "fechamento ao cancelar"); };
    await openSettings(session.runtime);
    await selectScale(130);
    await waitFor(async () => Number(await runtime.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()")) === 1.3, "preview imediato 130%");
    assert.equal((await runtime.evaluate("window.gestaoUiPreferences.get()" )).fontScale, 1);
    await cancel();
    assert.equal(Number(await runtime.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()")), 1);
    await openSettings();
    await selectScale(120);
    await apply();
    assert.equal((await runtime.evaluate("window.gestaoUiPreferences.get()" )).fontScale, 1.2);

    const layoutAudit = async (label) => {
      const result = await runtime.evaluate(`(() => {const vw=document.documentElement.clientWidth,vh=document.documentElement.clientHeight;const visible=e=>{const r=e.getBoundingClientRect(),s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden'&&r.width>0&&r.height>0};const controls=[...document.querySelectorAll('button,input,select,textarea,h1,h2,h3,.section-kicker,.stage,.solicitation-status')].filter(visible);const clipped=controls.filter(e=>{const s=getComputedStyle(e);if(['auto','scroll'].includes(s.overflowX)||['auto','scroll'].includes(s.overflowY))return false;return e.scrollWidth>e.clientWidth+2||e.scrollHeight>e.clientHeight+2}).map(e=>({tag:e.tagName,text:(e.innerText||e.getAttribute('aria-label')||'').trim().slice(0,60),size:[e.clientWidth,e.clientHeight],scroll:[e.scrollWidth,e.scrollHeight]}));const pageOverflow=document.documentElement.scrollWidth>vw+1||document.body.scrollWidth>vw+1;const dialogs=[...document.querySelectorAll('[role=dialog]')].filter(visible).filter(e=>{const r=e.getBoundingClientRect();return r.left<-1||r.right>vw+1||r.top<-1||r.bottom>vh+1}).length;return {pageOverflow,clipped,dialogs}})()`);
      assert.equal(result.pageOverflow, false, `${label}: scroll horizontal na página: ${JSON.stringify(result)}`);
      assert.deepEqual(result.clipped, [], `${label}: texto/controle cortado: ${JSON.stringify(result.clipped)}`);
      assert.equal(result.dialogs, 0, `${label}: modal fora da janela.`);
      return result;
    };
    const screenshot = async (name, width, height) => {
      const data = await runtime.send("Page.captureScreenshot", { format: "png", captureBeyondViewport: false });
      const file = path.join(screenshotDirectory, `packaged-textscale-${name}-130-${width}x${height}.png`);
      fs.writeFileSync(file, Buffer.from(data.data, "base64"));
    };
    for (const [width, height] of [[1366, 768], [1920, 1080]]) {
      await runtime.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
      await openSettings();
      await selectScale(130);
      await runtime.evaluate("document.querySelector('.appearance-apply').click(); true");
      await waitFor(() => runtime.evaluate("!document.querySelector('.appearance-dialog')"), "aplicar 130% para revisão empacotada");
      await layoutAudit(`Aparência ${width}x${height}`);
      await screenshot("aparencia", width, height);
      for (const [name, selector] of [["central", ".app-navigation>button:nth-of-type(1)"], ["pedidos", ".app-navigation>button:nth-of-type(2)"], ["meus-pedidos", ".app-navigation>button:nth-of-type(3)"], ["enviados-digital", ".app-navigation>button:nth-of-type(4)"], ["solicitacoes", ".app-navigation>button:nth-of-type(5)"], ["clientes", ".shell-secondary button"]]) {
        await runtime.evaluate(`document.querySelector(${JSON.stringify(selector)}).click(); true`);
        await sleep(160);
        await layoutAudit(`${name} 130% ${width}x${height}`);
        await screenshot(name, width, height);
      }
    }

    await openSettings(); await selectScale(120); await apply();
    console.log("Runtime UI empacotado: concluídas capturas; verificando reinício...");
    await closeRuntime(session.child, session.runtime); session = null;
    for (const marker of ["application-window-ready", "main-entry-loaded", "updater-initialized", "recovery-error"]) {
      try { fs.rmSync(path.join(smokeDirectory, `${marker}.json`), { force: true }); } catch { }
    }
    session = await launch(executable, smokeDirectory);
    console.log("Runtime UI empacotado: segundo início confirmado.");
    console.log("Runtime UI empacotado: verificando preferência restaurada...");
    let persisted = await session.runtime.evaluate("(async()=>({stored:await window.gestaoUiPreferences.get(),applied:getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()}))()");
    assert.equal(persisted.stored.fontScale, 1.2, "A escala aplicada precisa sobreviver ao reinício do runtime empacotado.");
    assert.equal(Number(persisted.applied), 1.2, "O valor salvo precisa ser aplicado ao abrir o runtime empacotado.");
    console.log("Runtime UI empacotado: escala aplicada confirmada; testando restaurar padrão...");
    await openSettings(session.runtime);
    await session.runtime.evaluate("document.querySelector('.appearance-reset').click(); true");
    assert.equal((await session.runtime.evaluate("window.gestaoUiPreferences.get()" )).fontScale, 1.2, "Restaurar padrão não deve gravar antes de Aplicar.");
    await session.runtime.evaluate("document.querySelector('.appearance-apply').click(); true");
    await waitFor(() => session.runtime.evaluate("!document.querySelector('.appearance-dialog')"), "persistir 100% após restaurar");
    console.log("Runtime UI empacotado: 100% aplicado; reiniciando...");
    await closeRuntime(session.child, session.runtime); session = null;
    for (const marker of ["application-window-ready", "main-entry-loaded", "updater-initialized", "recovery-error"]) {
      try { fs.rmSync(path.join(smokeDirectory, `${marker}.json`), { force: true }); } catch { }
    }
    session = await launch(executable, smokeDirectory);
    console.log("Runtime UI empacotado: terceiro início confirmado.");
    persisted = await session.runtime.evaluate("(async()=>({stored:await window.gestaoUiPreferences.get(),applied:getComputedStyle(document.documentElement).getPropertyValue('--font-scale').trim()}))()");
    assert.equal(persisted.stored.fontScale, 1, "100% restaurado precisa sobreviver ao reinício.");
    assert.equal(Number(persisted.applied), 1);
    await closeRuntime(session.child, session.runtime); session = null;
    console.log("Runtime empacotado: preview/cancel/apply/reset, layout em 1366x768 e 1920x1080 a 130%, persistência após reinício: OK");
  } finally {
    if (session) try { await closeRuntime(session.child, session.runtime); } catch { }
    const resolved = path.resolve(root);
    const relative = path.relative(path.resolve(os.tmpdir()), resolved);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
    fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
