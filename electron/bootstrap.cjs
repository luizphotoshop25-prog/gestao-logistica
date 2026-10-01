const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
if (process.platform === "win32") {
  app.setAppUserModelId("br.com.manoelguimaraes.gestaologistica");
  app.setToastActivatorCLSID("{9C070A34-2C33-41B1-83F3-41262D1E71B2}");
}
const { autoUpdater } = require("electron-updater");
const { createUpdaterController } = require("./updater.cjs");

const UPDATER_KEY = Symbol.for("gestao-logistica.updater-controller");
let updaterController;
let recoveryWindow;
let startupFailureReported = false;
const smokeDirectory = resolveSmokeDirectory(process.env.GESTAO_PACKAGED_RUNTIME_SMOKE_DIR);
const interactiveSmoke = Boolean(smokeDirectory) && process.env.GESTAO_PACKAGED_RUNTIME_INTERACTIVE_SMOKE === "1";

function resolveSmokeDirectory(candidate) {
  if (!candidate) return "";
  const resolved = path.resolve(candidate);
  const relative = path.relative(os.tmpdir(), resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Diretório de smoke packaged fora do diretório temporário.");
  }
  return resolved;
}

function writeSmokeMarker(name, value = {}) {
  if (!smokeDirectory) return;
  try {
    fs.mkdirSync(smokeDirectory, { recursive: true });
    fs.writeFileSync(path.join(smokeDirectory, `${name}.json`), JSON.stringify(value), "utf8");
  } catch { /* Smoke markers must never affect normal startup. */ }
}

function getFailureDetails(error) {
  const code = error?.code === "MODULE_NOT_FOUND" ? "MODULE_NOT_FOUND" : "APPLICATION_STARTUP_FAILED";
  const message = String(error?.message || "Erro inesperado ao iniciar o aplicativo.");
  const missing = code === "MODULE_NOT_FOUND"
    ? message.match(/Cannot find module ['"]([^'"]+)['"]/)?.[1] || "módulo operacional"
    : "";
  return { code, missing };
}

function recordFailure(error) {
  const details = getFailureDetails(error);
  try {
    const logDirectory = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(path.join(logDirectory, "startup-recovery.log"),
      `${new Date().toISOString()} ${details.code}${details.missing ? ` missing=${details.missing}` : ""}\n`, "utf8");
  } catch { /* Recovery reporting must not block the updater. */ }
  return details;
}

function trustedRecoveryWindow(event) {
  return recoveryWindow && !recoveryWindow.isDestroyed()
    && event.sender.id === recoveryWindow.webContents.id;
}

function showRecovery(error) {
  if (startupFailureReported) return;
  startupFailureReported = true;
  const details = recordFailure(error);
  writeSmokeMarker("recovery-error", details);
  try {
    if (!recoveryWindow || recoveryWindow.isDestroyed()) {
      recoveryWindow = new BrowserWindow({
        width: 540,
        height: 390,
        resizable: false,
        autoHideMenuBar: true,
        title: "Recuperação do Gestão Logística",
        webPreferences: {
          preload: path.join(__dirname, "recovery-preload.cjs"),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      recoveryWindow.loadFile(path.join(__dirname, "recovery.html"));
      recoveryWindow.webContents.once("did-finish-load", () => {
        writeSmokeMarker("recovery-window-ready", { updaterEnabled: Boolean(updaterController?.enabled) });
        if (smokeDirectory) setTimeout(() => app.quit(), 3500);
      });
      recoveryWindow.on("closed", () => { recoveryWindow = null; });
    }
  } catch (windowError) {
    writeSmokeMarker("recovery-window-error", { code: windowError?.code || "RECOVERY_WINDOW_FAILED" });
  }
}

ipcMain.handle("recovery:state", (event) => trustedRecoveryWindow(event)
  ? { ok: true, startupFailure: startupFailureReported, updaterEnabled: Boolean(updaterController?.enabled), state: updaterController?.getState() || { status: "idle" } }
  : { ok: false });
ipcMain.handle("recovery:check", (event) => trustedRecoveryWindow(event)
  ? updaterController?.checkSilently() || { ok: false }
  : { ok: false });
ipcMain.handle("recovery:download", (event) => trustedRecoveryWindow(event)
  ? updaterController?.download() || { ok: false }
  : { ok: false });
ipcMain.handle("recovery:install", (event) => trustedRecoveryWindow(event)
  ? updaterController?.install() || { ok: false }
  : { ok: false });

process.on("uncaughtException", (error) => showRecovery(error));
process.on("unhandledRejection", (error) => showRecovery(error));
globalThis[Symbol.for("gestao-logistica.show-recovery")] = showRecovery;

app.whenReady().then(() => {
  if (smokeDirectory) {
    fs.mkdirSync(smokeDirectory, { recursive: true });
    app.setPath("userData", path.join(smokeDirectory, "profile"));
  }

  updaterController = createUpdaterController({
    app,
    autoUpdater,
    resourcesPath: process.resourcesPath,
    send: (state) => {
      if (recoveryWindow && !recoveryWindow.isDestroyed()) {
        recoveryWindow.webContents.send("recovery:state", { updaterEnabled: Boolean(updaterController?.enabled), state });
      }
      writeSmokeMarker("updater-state", state);
    },
  });
  globalThis[UPDATER_KEY] = updaterController;
  writeSmokeMarker("updater-initialized", { enabled: updaterController.enabled });
  if (!interactiveSmoke) void updaterController.checkSilently();

  app.on("browser-window-created", (_event, window) => {
    window.webContents.once("did-finish-load", () => {
      if (window === recoveryWindow) return;
      writeSmokeMarker("application-window-ready");
      if (smokeDirectory && !interactiveSmoke) setTimeout(() => app.quit(), 100);
    });
  });
  app.on("window-all-closed", (event) => {
    if (startupFailureReported) event.preventDefault();
  });

  try {
    require("./main.cjs");
    writeSmokeMarker("main-entry-loaded");
  } catch (error) {
    showRecovery(error);
  }
}).catch((error) => showRecovery(error));
