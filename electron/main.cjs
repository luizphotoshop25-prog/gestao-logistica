const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const crypto = require("node:crypto");
const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const database = require("./database.cjs");
const { previewSpreadsheet } = require("./importer.cjs");
const siwin = require("./siwin.cjs");
const thunderbird = require("./thunderbird.cjs");
const { loadClientConfig } = require("./client-config.cjs");

const clientConfig = loadClientConfig({
  configPath: process.env.GESTAO_CLIENT_CONFIG || path.join(app.getPath("userData"), "gestao-client.json"),
});
const httpMode = clientConfig.transport === "http";
if (httpMode) {
  const profile = process.env.GESTAO_HTTP_TEST_PROFILE;
  const target = new URL(clientConfig.apiUrl);
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
  process.env.GESTAO_API_URL = clientConfig.apiUrl;
}

let mainWindow;
let siwinTimer;
let thunderbirdTimer;
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

function registerIpc() {
  handle("app:status", () => database.getStatus());
  handle("orders:list", (options) => ({ ok: true, rows: database.listOrders(options) }));
  handle("orders:get", (orderId) => database.getOrder(orderId));
  handle("orders:update", (input) => database.updateOrder(input));
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

function createWindow() {
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
    },
  });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = app.isPackaged ? url.startsWith("file:") : url.startsWith(devServerUrl);
    if (!allowed) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  if (app.isPackaged) mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  else mainWindow.loadURL(devServerUrl);
}

app.whenReady().then(() => {
  if (!httpMode) database.initialize(app);
  registerSessionIpc();
  registerIpc();
  createWindow();
  if (httpMode) return;
  setTimeout(async () => {
    await runSiwinSync();
    runThunderbirdSync();
  }, 1500);
  siwinTimer = setInterval(() => void runSiwinSync(), 2 * 60 * 1000);
  thunderbirdTimer = setInterval(() => void runThunderbirdSync(), 2 * 60 * 1000);
});

app.on("window-all-closed", () => {
  if (siwinTimer) clearInterval(siwinTimer);
  if (thunderbirdTimer) clearInterval(thunderbirdTimer);
  if (process.platform !== "darwin") app.quit();
});
