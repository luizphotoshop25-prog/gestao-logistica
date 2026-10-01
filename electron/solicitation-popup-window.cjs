const path = require("node:path");

const WINDOW_WIDTH = 416;
const MAX_CARDS = 3;
const MARGIN = 20;
const SNOOZE_OPTIONS = Object.freeze({ DUE_TODAY: [30, 60], DUE_IN_ONE_HOUR: [15, 30], DUE_IN_15_MINUTES: [5, 10, 15], DUE_NOW: [15, 30, 60], OVERDUE: [15, 30, 60] });
const TITLES = Object.freeze({
  ASSIGNED: "Nova solicitação atribuída",
  DUE_TOMORROW: "Prazo amanhã",
  DUE_TODAY: "Prazo hoje",
  DUE_IN_ONE_HOUR: "Prazo próximo",
  DUE_IN_15_MINUTES: "Prazo próximo",
  DUE_NOW: "Prazo agora",
  OVERDUE: "Solicitação atrasada",
});

function safeNotice(row, now = new Date()) {
  if (!row || typeof row.id !== "string" || !/^[0-9a-f-]{36}$/i.test(row.id)
    || typeof row.solicitacao_id !== "string" || !/^[0-9a-f-]{36}$/i.test(row.solicitacao_id)
    || !Object.hasOwn(TITLES, row.tipo)) return null;
  const due = row.prazo_em ? new Date(row.prazo_em) : null;
  let detail = row.tipo === "ASSIGNED" ? "Uma nova tarefa foi atribuída a você." : "Uma solicitação precisa da sua atenção.";
  let deadline = "";
  if (due && Number.isFinite(due.getTime())) {
    deadline = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(due);
    const difference = due.getTime() - now.getTime();
    const minutes = Math.max(1, Math.ceil(Math.abs(difference) / 60000));
    if (row.tipo === "OVERDUE") detail = `Atrasada há ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
    else if (row.tipo === "DUE_NOW") detail = "Prazo agora";
    else if (["DUE_IN_ONE_HOUR", "DUE_IN_15_MINUTES"].includes(row.tipo)) detail = `Faltam ${minutes} ${minutes === 1 ? "minuto" : "minutos"}`;
    else if (["DUE_TOMORROW", "DUE_TODAY"].includes(row.tipo)) detail = `${row.tipo === "DUE_TOMORROW" ? "Amanhã" : "Hoje"} às ${deadline}`;
  }
  let snoozeMinutes = SNOOZE_OPTIONS[row.tipo] || [];
  if (["DUE_IN_ONE_HOUR", "DUE_IN_15_MINUTES"].includes(row.tipo) && due && Number.isFinite(due.getTime())) {
    const minimumUsefulDelay = row.tipo === "DUE_IN_ONE_HOUR" ? 15 : 5;
    const latestUsefulDelay = Math.max(minimumUsefulDelay, Math.ceil((due.getTime() - now.getTime()) / 60000));
    snoozeMinutes = snoozeMinutes.filter((minutes) => minutes <= latestUsefulDelay);
  }
  return {
    id: row.id,
    solicitationId: row.solicitacao_id,
    type: row.tipo,
    title: TITLES[row.tipo],
    session: typeof row.sessao_codigo === "string" ? row.sessao_codigo.slice(0, 32) : "",
    detail,
    deadline,
    snoozeMinutes,
  };
}

function lifetimeFor(notices) {
  const types = notices.map((notice) => notice.type);
  if (types.includes("OVERDUE")) return 60000;
  if (types.includes("DUE_NOW")) return 30000;
  if (types.includes("DUE_IN_15_MINUTES")) return 15000;
  if (types.includes("DUE_IN_ONE_HOUR")) return 12000;
  if (types.includes("DUE_TODAY")) return 10000;
  return 8000;
}

function createSolicitationPopupController({ BrowserWindow, screen, directory, onAction = () => {}, onPresented = () => {} }) {
  let popup;
  let closeTimer;
  let pendingState = null;
  let allowedSenderId = null;

  function boundsFor(height) {
    const main = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.title !== "Gestão Logística · Notificações");
    const targetDisplay = main && !main.isDestroyed()
      ? screen.getDisplayMatching(main.getBounds())
      : screen.getPrimaryDisplay();
    const { x, y, width, height: availableHeight } = targetDisplay.workArea;
    return {
      x: Math.max(x, x + width - WINDOW_WIDTH - MARGIN),
      y: Math.max(y, y + availableHeight - height - MARGIN),
      width: WINDOW_WIDTH,
      height: Math.min(height, availableHeight - MARGIN * 2),
    };
  }

  function ensureWindow(height) {
    if (popup && !popup.isDestroyed()) {
      popup.setBounds(boundsFor(height));
      return popup;
    }
    popup = new BrowserWindow({
      title: "Gestão Logística · Notificações",
      width: WINDOW_WIDTH,
      height,
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: "#00000000",
      hasShadow: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      webPreferences: {
        preload: path.join(directory, "solicitation-popup-preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    popup.setMenu(null);
    popup.setAlwaysOnTop(true, "floating");
    popup.setBounds(boundsFor(height));
    popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    popup.webContents.on("will-navigate", (event, url) => {
      if (!url.startsWith("file:")) event.preventDefault();
    });
    popup.webContents.on("did-finish-load", () => {
      if (pendingState && popup && !popup.isDestroyed()) popup.webContents.send("popup:state", pendingState);
    });
    popup.on("closed", () => {
      clearTimeout(closeTimer);
      closeTimer = null;
      popup = null;
      allowedSenderId = null;
    });
    void popup.loadFile(path.join(directory, "solicitation-popup.html"));
    return popup;
  }

  function present(rows, at = new Date()) {
    const notices = (Array.isArray(rows) ? rows : []).map((row) => safeNotice(row, at)).filter(Boolean);
    if (!notices.length) return { ok: false, reason: "empty" };
    const visible = notices.slice(0, MAX_CARDS);
    const height = Math.min(660, 24 + visible.length * 176 + (visible.length - 1) * 10 + (notices.length > MAX_CARDS ? 58 : 0));
    pendingState = { notices: visible, overflow: Math.max(0, notices.length - MAX_CARDS) };
    const host = ensureWindow(height);
    allowedSenderId = host.webContents.id;
    host.setBounds(boundsFor(height));
    host.setAlwaysOnTop(true, "floating");
    if (!host.webContents.isLoading()) host.webContents.send("popup:state", pendingState);
    host.showInactive();
    onPresented(notices.map((notice) => notice.id));
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      if (popup && !popup.isDestroyed()) popup.close();
    }, lifetimeFor(notices));
    return { ok: true, count: notices.length, visible: visible.length, overflow: pendingState.overflow };
  }

  function acceptAction(event, input) {
    if (!popup || popup.isDestroyed() || event.sender.id !== allowedSenderId || event.sender.id !== popup.webContents.id) return false;
    if (!input || !["open", "snooze", "close", "open-center"].includes(input.action)) return false;
    if (input.action === "open" || input.action === "snooze") {
      const notice = pendingState?.notices.find((item) => item.id === input.id);
      if (!notice) return false;
      if (input.action === "snooze" && !notice.snoozeMinutes.includes(input.minutes)) return false;
      onAction({ action: input.action, id: notice.id, solicitationId: notice.solicitationId, minutes: input.minutes });
    } else if (input.action === "open-center") onAction({ action: "open-center" });
    if (input.action !== "open-center" && popup && !popup.isDestroyed()) popup.close();
    return true;
  }

  function close() {
    clearTimeout(closeTimer);
    closeTimer = null;
    if (popup && !popup.isDestroyed()) popup.close();
  }

  return { present, acceptAction, close, getWindow: () => popup };
}

module.exports = { createSolicitationPopupController, safeNotice, lifetimeFor, MAX_CARDS, WINDOW_WIDTH, MARGIN };
