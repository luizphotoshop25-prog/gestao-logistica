const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, session } = require("electron");

const projectRoot = path.join(__dirname, "..");
const realProfilePath = path.resolve(app.getPath("userData"));
const profilePath = process.env.GESTAO_CAPTURE_PROFILE;
if (!profilePath) throw new Error("Execute npm run capture:ui para preparar o perfil isolado.");
const resolvedProfilePath = path.resolve(profilePath);
const devServerUrl = process.env.GESTAO_DEV_SERVER_URL;
if (!devServerUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(devServerUrl)) throw new Error("Origem local dinâmica ausente ou inválida.");
const devServerHost = new URL(devServerUrl).host;
const outputPath = process.env.GESTAO_CAPTURE_PATH || path.join(projectRoot, "work", "gestao-logistica-ui.png");
const menuOutputPath = outputPath.replace(/\.png$/i, "-menu.png");
const detailOutputPath = outputPath.replace(/\.png$/i, "-pedido.png");
const detailTabs = ["selection", "production", "shipping", "history"];
const nativeSetTimeout = global.setTimeout;
const nativeSetInterval = global.setInterval;
const database = require("../electron/database.cjs");
const initializeDatabase = database.initialize;

if (resolvedProfilePath === realProfilePath || !resolvedProfilePath.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
  throw new Error(`Captura visual recusada: userData temporário inválido (${resolvedProfilePath}).`);
}

database.initialize = (electronApp) => {
  const activeProfilePath = path.resolve(electronApp.getPath("userData"));
  if (activeProfilePath !== resolvedProfilePath) throw new Error(`Captura visual recusada: userData inesperado (${activeProfilePath}).`);
  initializeDatabase(electronApp);
  const fixture = database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M99999", clienteNome: "Cliente Teste Visual", clienteEmail: "teste-visual@example.invalid", clienteTelefone: "00000000000", clienteCidade: "Curitiba - TESTE", fotosQuantidade: 25, observacoes: "Fixture sintético da captura visual.", editor: "Editor Teste", selecaoFinalizadaEm: null, tratamentoConcluido: false }] });
  if (!fixture.ok || fixture.imported !== 1) throw new Error(`Não foi possível preparar o fixture visual: ${fixture.message || "resultado inesperado"}.`);
};



const delay = (milliseconds) => new Promise((resolve) => nativeSetTimeout(resolve, milliseconds));

async function waitForSelector(window, selector, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if (found) return;
    await delay(80);
  }
  throw new Error(`A captura visual não encontrou ${selector} em ${timeout} ms.`);
}

async function capture(window, destination) {
  await window.webContents.executeJavaScript("window.scrollTo(0, 0); document.documentElement.scrollLeft = 0; document.body.scrollLeft = 0");
  await window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await delay(220);
  const image = await window.webContents.capturePage();
  fs.writeFileSync(destination, image.toPNG());
}

// O teste valida somente a interface; sincronizações automáticas ficam desligadas.
global.setTimeout = (callback, delay, ...args) => delay === 1500 ? 0 : nativeSetTimeout(callback, delay, ...args);
global.setInterval = () => 0;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
app.setPath("userData", profilePath);

// O teste visual deve permanecer invisível e nunca disputar o foco com o usuário.
BrowserWindow.prototype.show = function suppressVisualTestWindow() {};
const allowedChannels = new Set(["app:status", "orders:list", "orders:get", "clients:list", "dashboard:get", "siwin:status"]);
const registerHandler = ipcMain.handle.bind(ipcMain);
ipcMain.handle = (channel, handler) => registerHandler(channel, allowedChannels.has(channel) ? handler : () => {
  fail(new Error(`IPC externo ou de escrita bloqueado: ${channel}`));
  return { ok: false, message: "Bloqueado pelo smoke visual." };
});
function fail(error) {
  console.error(error);
  database.close();
  app.exit(1);
}
process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _file, error) => fail(error));
  contents.on("render-process-gone", (_event, details) => fail(new Error(JSON.stringify(details))));
  contents.on("did-fail-load", (_event, code, description) => fail(new Error(`Renderer: ${code} ${description}`)));
  contents.on("console-message", (details) => { if (details.level === 3) fail(new Error(details.message)); });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const allowed = ["http:", "ws:"].includes(url.protocol) && url.host === devServerHost;
    callback({ cancel: !allowed && !["data:", "devtools:"].includes(url.protocol) });
  });
});
require("../electron/main.cjs");

app.whenReady().then(() => {
  const poll = nativeSetInterval(() => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.webContents.isLoading()) return;
    clearInterval(poll);
    nativeSetTimeout(async () => {
      try {
        await waitForSelector(window, ".session-link");
        const visible = await window.webContents.executeJavaScript("document.body.innerText.includes('M99999') && document.body.innerText.includes('Cliente Teste Visual') && typeof window.gestaoAPI.getOrder === 'function'");
        if (!visible) throw new Error("Fixture ou preload ausente.");
        await capture(window, outputPath);
        await window.webContents.executeJavaScript("document.querySelector('.integration-trigger')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))");
        await waitForSelector(window, ".app-menu-content");
        await capture(window, menuOutputPath);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await delay(180);
        await window.webContents.executeJavaScript("document.querySelector('.session-link').click()");
        await waitForSelector(window, ".detail-modal");
        await capture(window, detailOutputPath);

        const generatedPaths = [outputPath, menuOutputPath, detailOutputPath];
        for (const tab of detailTabs) {
          const tabSelector = `.detail-nav button:nth-child(${detailTabs.indexOf(tab) + 2})`;
          await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(tabSelector)}).click()`);
          await waitForSelector(window, `.detail-modal[data-tab="${tab}"]`);
          const tabOutputPath = outputPath.replace(/\.png$/i, `-pedido-${tab}.png`);
          await capture(window, tabOutputPath);
          generatedPaths.push(tabOutputPath);
        }

        process.stdout.write(`userData=${resolvedProfilePath}\n${generatedPaths.join("\n")}\n`);
        database.close();
        app.exit(0);
      } catch (error) {
        fail(error);
      }
    }, 2200);
  }, 25);
});
