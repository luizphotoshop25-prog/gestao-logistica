const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { app, BrowserWindow, Notification, dialog, ipcMain, safeStorage, shell, Tray, Menu, screen } = require("electron");
const database = require("./database.cjs");
const { previewSpreadsheet } = require("./importer.cjs");
const siwin = require("./siwin.cjs");
const thunderbird = require("./thunderbird.cjs");
const { loadClientConfig } = require("./client-config.cjs");
const { checkRemoteApiHealth, resolveRemoteConfig } = require("./remote-config.cjs");
const { loadClientBuild } = require("./client-build.cjs");
const { autoUpdater } = require("electron-updater");
const { createUpdaterController } = require("./updater.cjs");
const { readUiPreferences, writeUiPreferences } = require("./ui-preferences.cjs");
const { showNativeSolicitationNotification } = require("./solicitation-native-notifications.cjs");
const { createSolicitationPopupController } = require("./solicitation-popup-window.cjs");
const { createRemoteTray } = require("./remote-tray.cjs");
const { isBackgroundStartup, configureWindowsLoginItem } = require("./windows-login-item.cjs");
const { showWindowsNotificationTest } = require("./windows-notification-test.cjs");
const UPDATER_KEY = Symbol.for("gestao-logistica.updater-controller");

const buildMarker = loadClientBuild({ isPackaged: app.isPackaged, resourcesPath: process.resourcesPath });
const remoteClientBuild = buildMarker.variant === "remote";
let clientConfig = remoteClientBuild
  ? { transport: "http", apiUrl: "", mode: "https-remote" }
  : loadClientConfig({ configPath: process.env.GESTAO_CLIENT_CONFIG || path.join(app.getPath("userData"), "gestao-client.json") });
let httpMode = remoteClientBuild || clientConfig.transport === "http";
const isolatedSmoke = Boolean(process.env.GESTAO_PACKAGED_RUNTIME_SMOKE_DIR);
const popupVisualTest = process.argv.includes("--gestao-popup-test");
const startupBackground = remoteClientBuild && isBackgroundStartup(process.argv);
let backgroundOffline = false;
let remoteConfigTimer;
let popupController;
let trayController;
process.env.GESTAO_REMOTE_CLIENT_BUILD = remoteClientBuild ? "1" : "0";
process.env.GESTAO_BACKGROUND_START = startupBackground ? "1" : "0";
function configureHttpTransport(apiUrl) {
  const profile = process.env.GESTAO_HTTP_TEST_PROFILE;
  const target = new URL(apiUrl);
  if (target.protocol === "http:" && (target.hostname === "127.0.0.1" || target.hostname === "localhost")) {
    if (app.isPackaged || !profile || !path.isAbsolute(profile)) throw new Error("HTTP loopback exige desenvolvimento com perfil temporário explícito.");
    const parent = fs.realpathSync(path.dirname(profile));
    const temporary = fs.realpathSync(os.tmpdir());
    const relative = path.relative(temporary, parent);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("Perfil HTTP fora do diretório temporário.");
    if (fs.existsSync(profile) && fs.lstatSync(profile).isSymbolicLink()) throw new Error("Perfil HTTP não pode ser link.");
    app.setPath("userData", profile);
  }
  process.env.GESTAO_DATA_TRANSPORT = "http";
  process.env.GESTAO_API_URL = apiUrl;
}
if (remoteClientBuild) process.env.GESTAO_DATA_TRANSPORT = "http";
else if (httpMode) configureHttpTransport(clientConfig.apiUrl);

let mainWindow;
let siwinTimer;
let thunderbirdTimer;
let updaterController;
const sessionFile = () => path.join(app.getPath("userData"), `gestao-http-session-${crypto.createHash("sha256").update(clientConfig.apiUrl).digest("hex").slice(0, 16)}.bin`);
function registerSessionIpc() {
  ipcMain.handle("auth-session:read", (event) => {
    if (!trusted(event) || !safeStorage.isEncryptionAvailable() || !fs.existsSync(sessionFile())) return "";
    try { return safeStorage.decryptString(fs.readFileSync(sessionFile())); } catch { return ""; }
  });
  ipcMain.handle("auth-session:write", (event, token) => {
    if (!trusted(event) || !safeStorage.isEncryptionAvailable() || typeof token !== "string" || !token) return { ok: false };
    fs.mkdirSync(path.dirname(sessionFile()), { recursive: true });
    fs.writeFileSync(sessionFile(), safeStorage.encryptString(token));
    return { ok: true };
  });
  ipcMain.handle("auth-session:clear", (event) => {
    if (!trusted(event)) return { ok: false };
    fs.rmSync(sessionFile(), { force: true });
    return { ok: true };
  });
  ipcMain.handle("remote-config:retry", async (event) => {
    if (!trusted(event) || !remoteClientBuild) return { ok: false, message: "Nova tentativa remota indisponível." };
    const result = await loadReadyRemoteConfig();
    if (!result.ok) return { ok: false, message: result.message };
    clientConfig.apiUrl = result.config.apiBaseUrl;
    configureHttpTransport(clientConfig.apiUrl);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    return { ok: true };
  });
}

function trusted(event) {
  return mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id;
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (httpMode) return { ok: false, message: "IPC local indisponível no transporte HTTP." };
    if (!trusted(event)) return { ok: false, message: "Origem não autorizada." };
    try {
      return await callback(...args);
    } catch (error) {
      return { ok: false, message: error?.message || "Erro inesperado." };
    }
  });
}

function registerUpdaterIpc() {
  ipcMain.handle("updater:get-state", (event) => {
    if (!trusted(event)) return { ok: false };
    return { ok: true, enabled: Boolean(updaterController?.enabled), state: updaterController?.getState() || { status: "idle" } };
  });
  ipcMain.handle("updater:download", (event) => {
    if (!trusted(event)) return { ok: false };
    return updaterController?.download() || { ok: false };
  });
  ipcMain.handle("updater:install", (event) => {
    if (!trusted(event)) return { ok: false };
    return updaterController?.install() || { ok: false };
  });
}

function registerUiPreferencesIpc() {
  ipcMain.handle("ui-preferences:get", (event) => {
    if (!trusted(event)) return { ok: false, fontScale: 1 };
    return { ok: true, ...readUiPreferences(app.getPath("userData"), { defaultStartWithWindows: remoteClientBuild }) };
  });
  ipcMain.handle("ui-preferences:set", (event, input) => {
    if (!trusted(event)) return { ok: false, fontScale: 1, startWithWindows: false };
    const previous = readUiPreferences(app.getPath("userData"), { defaultStartWithWindows: remoteClientBuild });
    const saved = writeUiPreferences(app.getPath("userData"), input, { defaultStartWithWindows: remoteClientBuild });
    if (!saved.ok || !Object.hasOwn(input || {}, "startWithWindows")) return saved;
    const configured = configureWindowsLoginItem({ app, enabled: saved.startWithWindows, disabled: isolatedSmoke || !remoteClientBuild });
    if (!configured.ok) {
      writeUiPreferences(app.getPath("userData"), { startWithWindows: previous.startWithWindows }, { defaultStartWithWindows: remoteClientBuild });
      return { ok: false, ...previous, message: "O Windows não confirmou a preferência de inicialização." };
    }
    return { ...saved, startWithWindows: configured.openAtLogin };
  });
}

function registerNotificationIpc() {
  ipcMain.handle("notifications:native", (event, input) => {
    if (!trusted(event)) return { ok: false };
    const showFallback = () => {
      if (!mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send("notifications:fallback", {
        solicitationId: input?.solicitationId,
        type: input?.type,
      });
    };
    return showNativeSolicitationNotification(Notification, mainWindow, input, showFallback);
  });
  ipcMain.handle("notifications:present-popup", (event, rows) => {
    if (!trusted(event) || !popupController) return { ok: false, reason: "unauthorized-or-unavailable" };
    const result = popupController.present(rows);
    if (result.ok) return result;
    for (const row of Array.isArray(rows) ? rows.slice(0, 3) : []) {
      const fallback = () => {
        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("notifications:fallback", { solicitationId: row?.solicitacao_id, type: row?.tipo });
      };
      const native = showNativeSolicitationNotification(Notification, mainWindow, { solicitationId: row?.solicitacao_id, type: row?.tipo }, fallback);
      if (!native.ok) fallback();
    }
    return result;
  });
  ipcMain.on("popup:action", (event, input) => {
    if (!popupController?.acceptAction(event, input)) return;
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (["open", "open-center"].includes(input?.action)) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
    if (["open", "snooze"].includes(input?.action)) mainWindow.webContents.send("notifications:popup-action", input);
    else if (input?.action === "open-center") mainWindow.webContents.send("notifications:open-center");
  });
  ipcMain.on("app:show-authentication", (event) => {
    if (!trusted(event) || !startupBackground) return;
    trayController?.setConnectionStatus("login");
    if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  });
  ipcMain.on("app:connection-status", (event, status) => {
    if (!trusted(event) || !["connected", "login", "waiting"].includes(status)) return;
    trayController?.setConnectionStatus(status);
  });
}

function runWindowsNotificationTest() {
  if (process.platform !== "win32" || !app.isPackaged || !process.argv.includes("--gestao-native-notification-test")) return;
  setTimeout(() => {
    const result = showWindowsNotificationTest({
      Notification,
      mainWindow,
      log: (event) => writeUpdaterLog(`native-notification-test ${event}`),
    });
    if (!result.ok) writeUpdaterLog(`native-notification-test ${result.status}`);
  }, 1500);
}

function writeUpdaterLog(message) {
  try {
    const logDirectory = path.join(app.getPath("userData"), "logs");
    fs.mkdirSync(logDirectory, { recursive: true });
    fs.appendFileSync(path.join(logDirectory, "updater.log"), `${new Date().toISOString()} ${message}\n`, "utf8");
  } catch { /* Update logging must not affect application availability. */ }
}

function registerIpc() {
  handle("app:status", () => database.getStatus());
  handle("auth:local-current", () => ({ ok: true, user: database.getLocalOperator() }));
  handle("orders:list", (options = {}) => {
    const scoped = options.scope === "mine" ? { ...options, userId: database.getLocalOperatorId() } : options;
    return { ok: true, rows: database.listOrders(scoped) };
  });
  handle("orders:get", (orderId) => database.getOrder(orderId));
  handle("orders:client-profile", (orderId) => database.getOrderClientProfile(orderId));
  handle("orders:update", (input) => database.updateOrder(input));
  handle("orders:treatment-assignees", () => ({ ok: true, rows: database.listActiveUsers() }));
  handle("orders:treatment-assignee", (input) => database.updateTreatmentAssignee({ ...input, actorUserId: database.getLocalOperatorId(), actorRole: "coordinator" }));
  handle("orders:treatment-assignee-automatic", (input) => database.restoreAutomaticTreatmentAssignee({ ...input, actorUserId: database.getLocalOperatorId(), actorRole: "coordinator" }));
  handle("orders:bulk-update", (input) => database.bulkUpdateOrders(input));
  handle("selection-email:mark", (input) => database.markSelectionEmail(input));
  handle("clients:list", (options) => ({ ok: true, rows: database.listClients(options) }));
  handle("dashboard:get", () => ({ ok: true, dashboard: database.getDashboard() }));
  handle("solicitations:list", () => ({ ok: true, rows: database.listSolicitations({ role: "coordinator" }) }));
  handle("solicitations:get", (id) => {
    const solicitation = database.getSolicitation(id, { role: "coordinator" });
    return solicitation ? { ok: true, solicitation } : { ok: false, message: "Solicitação não encontrada." };
  });
  handle("solicitations:assignees", () => ({ ok: true, rows: database.listActiveUsers() }));
  handle("solicitations:create", (input) => database.createSolicitation({
    ...input,
    criado_por_usuario_id: null,
    criado_por_nome: "Usuário local",
  }));
  handle("solicitations:update", (input) => database.updateSolicitation(input));
  handle("solicitations:transition", (input) => database.transitionSolicitation({ ...input, actorRole: "coordinator" }));
  handle("notifications:poll", () => database.pollSolicitationNotifications(database.getLocalOperatorId()));
  handle("notifications:list", () => database.listSolicitationNotifications(database.getLocalOperatorId()));
  handle("notifications:update", (input) => database.updateSolicitationNotification(database.getLocalOperatorId(), input));
  handle("digital-shipments:list", (options) => database.listDigitalShipments(options));
  handle("digital-shipments:get", (id) => {
    const shipment = database.getDigitalShipment(id);
    return shipment ? { ok: true, shipment } : { ok: false, error: "NOT_FOUND", message: "Pedido Digital não encontrado." };
  });
  handle("digital-shipments:for-order", (orderId) => database.getDigitalShipmentsForOrder(orderId));
  handle("digital-shipments:resolve-sessions", (input) => database.resolveDigitalShipmentSessions(input));
  handle("digital-shipments:create", (input) => database.createDigitalShipment({
    ...input, actorUserId: database.getLocalOperatorId(), actorRole: "coordinator",
  }));
  handle("digital-shipments:update", (input) => database.updateDigitalShipment({
    ...input, actorUserId: database.getLocalOperatorId(), actorRole: "coordinator",
  }));
  handle("siwin:status", () => database.getSiwinStatus());
  handle("siwin:sync", () => runSiwinSync());
  handle("thunderbird:sync", () => runThunderbirdSync());
  handle("thunderbird:prepare-selection", async (emailId) => {
    const selection = database.getSelectionEmail(emailId);
    if (!selection) return { ok: false, message: "Seleção recebida por e-mail não encontrada." };
    if (!selection.codigos.length) return { ok: false, message: "O e-mail não contém códigos de fotos." };
    const managerDirectory = "C:\\GerenciadorFotos";
    const launcher = path.join(managerDirectory, "INICIAR_GERENCIADOR.bat");
    if (!fs.existsSync(launcher)) return { ok: false, message: "GerenciadorFotos não encontrado em C:\\GerenciadorFotos." };
    const listPath = path.join(managerDirectory, "lista_formatada.txt");
    fs.writeFileSync(listPath, `${selection.codigos.join("\r\n")}\r\n`, "utf8");
    const message = await shell.openPath(launcher);
    return message ? { ok: false, message } : { ok: true, listPath, total: selection.codigos.length };
  });
  handle("orders:milestone", (input) => database.updateMilestone(input));
  handle("import:select", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Selecionar planilha de pedidos",
      properties: ["openFile"],
      filters: [{ name: "Planilha de pedidos", extensions: ["xlsx", "csv"] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    return previewSpreadsheet(result.filePaths[0]);
  });
  handle("import:confirm", (preview) => database.importSafeRows(preview));
  handle("attachments:add", async (orderId, type) => {
    const result = await dialog.showOpenDialog(mainWindow, {
      title: "Selecionar comprovante",
      properties: ["openFile"],
      filters: [
        { name: "Imagens e PDF", extensions: ["png", "jpg", "jpeg", "webp", "pdf"] },
        { name: "Todos os arquivos", extensions: ["*"] },
      ],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };
    return database.addAttachment(orderId, type, result.filePaths[0]);
  });
  handle("attachments:open", async (attachmentId) => {
    const filePath = database.getAttachmentPath(attachmentId);
    if (!filePath) return { ok: false, message: "Anexo não encontrado." };
    const message = await shell.openPath(filePath);
    return message ? { ok: false, message } : { ok: true };
  });
  handle("external:open", async (url) => {
    const target = String(url || "").trim();
    if (!/^https?:\/\//i.test(target)) return { ok: false, message: "Endereço inválido." };
    await shell.openExternal(target);
    return { ok: true };
  });
}

async function runSiwinSync() {
  try {
    const result = await siwin.syncClients(database);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("siwin:updated", result);
    return result;
  } catch (error) {
    return { ok: false, message: siwin.safeError(error) };
  }
}

function runThunderbirdSync() {
  try {
    const result = thunderbird.sync(database);
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("thunderbird:updated", result);
    return result;
  } catch (error) {
    return { ok: false, message: error?.message || "Não foi possível ler os e-mails da EPICS." };
  }
}

function createWindow({ showOnReady = true } = {}) {
  const devServerUrl = process.env.GESTAO_DEV_SERVER_URL || "http://127.0.0.1:8090";
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 940,
    minWidth: 1100,
    minHeight: 700,
    show: false,
    backgroundColor: "#f5f7fb",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = app.isPackaged ? url.startsWith("file:") : url.startsWith(devServerUrl);
    if (!allowed) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => { if (showOnReady) mainWindow.show(); });
  trayController?.attachWindow(mainWindow);
  mainWindow.on("closed", () => { mainWindow = null; });
  if (app.isPackaged) mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  else mainWindow.loadURL(devServerUrl);
}

async function loadReadyRemoteConfig() {
  const cachePath = path.join(app.getPath("userData"), "gestao-client-cache.json");
  const result = await resolveRemoteConfig({ cachePath });
  if (!result.ok) return result;
  const health = await checkRemoteApiHealth(result.config.apiBaseUrl);
  if (!health.ok) return { ok: false, error: "REMOTE_API_UNAVAILABLE", message: health.message, config: result.config };
  return result;
}

async function prepareRemoteClient({ background = false } = {}) {
  if (background) {
    const result = await loadReadyRemoteConfig();
    if (result.ok) {
      clientConfig.apiUrl = result.config.apiBaseUrl;
      configureHttpTransport(clientConfig.apiUrl);
      return true;
    }
    if (result.config?.apiBaseUrl) {
      clientConfig.apiUrl = result.config.apiBaseUrl;
      configureHttpTransport(clientConfig.apiUrl);
    }
    backgroundOffline = true;
    return true;
  }
  while (true) {
    const result = await loadReadyRemoteConfig();
    if (result.ok) {
      clientConfig.apiUrl = result.config.apiBaseUrl;
      configureHttpTransport(clientConfig.apiUrl);
      return true;
    }
    const choice = await dialog.showMessageBox({
      type: "error",
      title: "Gestão Logística",
      message: "Não foi possível conectar ao servidor da empresa.",
      detail: result.message,
      buttons: ["Tentar novamente", "Fechar"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (choice.response !== 0) {
      app.quit();
      return false;
    }
  }
}

function initializeRemoteDesktop() {
  if (!remoteClientBuild || process.platform !== "win32" || isolatedSmoke) return;
  trayController = createRemoteTray({
    app, Tray, Menu,
    getMainWindow: () => mainWindow,
    getPopup: () => popupController?.getWindow(),
    enabled: true,
    beforeExit: () => {
      if (remoteConfigTimer) clearInterval(remoteConfigTimer);
      if (siwinTimer) clearInterval(siwinTimer);
      if (thunderbirdTimer) clearInterval(thunderbirdTimer);
    },
  });
  void app.getFileIcon(process.execPath, { size: "small" }).then((icon) => trayController?.initialize(icon)).catch(() => {});
  const saved = readUiPreferences(app.getPath("userData"), { defaultStartWithWindows: true });
  configureWindowsLoginItem({ app, enabled: saved.startWithWindows });
  app.on("before-quit", () => {
    trayController?.markQuitting();
    popupController?.close();
  });
  globalThis[Symbol.for("gestao-logistica.show-main")] = () => trayController?.showMainWindow();
}

function initializePopupController() {
  popupController = createSolicitationPopupController({
    BrowserWindow, screen, directory: __dirname,
    onPresented: (ids) => {
      if (!process.argv.includes("--gestao-popup-test") && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send("notifications:popup-presented", ids);
      }
    },
  });
}

function monitorBackgroundRemoteClient() {
  if (!startupBackground || !remoteClientBuild) return;
  remoteConfigTimer = setInterval(async () => {
    const result = await loadReadyRemoteConfig();
    if (!result.ok) {
      trayController?.setConnectionStatus("waiting");
      return;
    }
    const changed = clientConfig.apiUrl !== result.config.apiBaseUrl;
    clientConfig.apiUrl = result.config.apiBaseUrl;
    configureHttpTransport(clientConfig.apiUrl);
    if (backgroundOffline || changed) {
      backgroundOffline = false;
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }
  }, 60000);
}

app.whenReady().then(async () => {
  if (remoteClientBuild && !(await prepareRemoteClient({ background: startupBackground || popupVisualTest }))) return;
  initializeRemoteDesktop();
  if (!httpMode) database.initialize(app);
  registerSessionIpc();
  registerIpc();
  registerUpdaterIpc();
  registerUiPreferencesIpc();
  registerNotificationIpc();
  initializePopupController();
  updaterController = globalThis[UPDATER_KEY] || createUpdaterController({
    app,
    autoUpdater,
    resourcesPath: process.resourcesPath,
    logError: writeUpdaterLog,
  });
  globalThis[UPDATER_KEY] = updaterController;
  updaterController.setSend?.((state) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send("updater:state", state);
  });
  createWindow({ showOnReady: !startupBackground });
  if (startupBackground && backgroundOffline) trayController?.setConnectionStatus("waiting");
  monitorBackgroundRemoteClient();
  if (app.isPackaged && process.platform === "win32" && process.argv.includes("--gestao-popup-test")) {
    setTimeout(() => popupController?.present([{
      id: "48c9f2d1-5b09-41b7-92ed-1a38dc53de23",
      solicitacao_id: "48c9f2d1-5b09-41b7-92ed-1a38dc53de23",
      tipo: "DUE_IN_15_MINUTES",
      sessao_codigo: "M50258",
      prazo_em: new Date(Date.now() + 5 * 60000).toISOString(),
      descricao: "A descrição sintética não deve aparecer no popup.",
    }]), 1700);
  }
  runWindowsNotificationTest();
  const interactiveSmoke = app.isPackaged && process.env.GESTAO_PACKAGED_RUNTIME_INTERACTIVE_SMOKE === "1";
  if (interactiveSmoke) setTimeout(() => app.quit(), 8000);
  if (!interactiveSmoke) setTimeout(() => { void updaterController.checkSilently(); }, 10000);
  if (httpMode || interactiveSmoke) return;
  setTimeout(async () => {
    await runSiwinSync();
    runThunderbirdSync();
  }, 1500);
  siwinTimer = setInterval(() => void runSiwinSync(), 2 * 60 * 1000);
  thunderbirdTimer = setInterval(() => void runThunderbirdSync(), 2 * 60 * 1000);
}).catch((error) => {
  const recover = globalThis[Symbol.for("gestao-logistica.show-recovery")];
  if (typeof recover === "function") recover(error);
  else throw error;
});

app.on("window-all-closed", () => {
  if (siwinTimer) clearInterval(siwinTimer);
  if (thunderbirdTimer) clearInterval(thunderbirdTimer);
  if (process.platform !== "darwin" && !remoteClientBuild) app.quit();
});
