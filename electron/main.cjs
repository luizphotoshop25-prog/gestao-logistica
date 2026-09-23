const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, dialog, ipcMain, shell } = require("electron");
const database = require("./database.cjs");
const { previewSpreadsheet } = require("./importer.cjs");
const siwin = require("./siwin.cjs");
const thunderbird = require("./thunderbird.cjs");

let mainWindow;
let siwinTimer;
let thunderbirdTimer;

function trusted(event) {
  return mainWindow && !mainWindow.isDestroyed() && event.sender.id === mainWindow.webContents.id;
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
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
    const allowed = app.isPackaged ? url.startsWith("file:") : url.startsWith("http://127.0.0.1:8090");
    if (!allowed) event.preventDefault();
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  if (app.isPackaged) mainWindow.loadFile(path.join(app.getAppPath(), "dist", "index.html"));
  else mainWindow.loadURL("http://127.0.0.1:8090");
}

app.whenReady().then(() => {
  database.initialize(app);
  registerIpc();
  createWindow();
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
