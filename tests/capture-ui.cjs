const fs = require("node:fs");
const path = require("node:path");
const { app, BrowserWindow } = require("electron");

const projectRoot = path.join(__dirname, "..");
const profilePath = path.join(projectRoot, "work", "visual-profile");
const outputPath = process.env.GESTAO_CAPTURE_PATH || path.join(projectRoot, "work", "gestao-logistica-ui.png");
const menuOutputPath = outputPath.replace(/\.png$/i, "-menu.png");
const detailOutputPath = outputPath.replace(/\.png$/i, "-pedido.png");
const detailTabs = ["selection", "production", "shipping", "history"];
const nativeSetTimeout = global.setTimeout;
const nativeSetInterval = global.setInterval;

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

fs.mkdirSync(profilePath, { recursive: true });
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
app.setPath("userData", profilePath);

// O teste visual deve permanecer invisível e nunca disputar o foco com o usuário.
BrowserWindow.prototype.show = function suppressVisualTestWindow() {};
require("../electron/main.cjs");

app.whenReady().then(() => {
  const poll = nativeSetInterval(() => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.webContents.isLoading()) return;
    clearInterval(poll);
    nativeSetTimeout(async () => {
      try {
        await waitForSelector(window, ".session-link");
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

        process.stdout.write(`${generatedPaths.join("\n")}\n`);
      } finally {
        app.quit();
      }
    }, 2200);
  }, 25);
});
