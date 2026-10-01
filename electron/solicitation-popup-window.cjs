const path = require("node:path");

const WINDOW_WIDTH = 416;
const MAX_CARDS = 3;
const MARGIN = 20;
const FONT_SCALES = Object.freeze([0.9, 1, 1.1, 1.2, 1.3]);
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

function createSolicitationPopupController({ BrowserWindow, screen, directory, onAction = () => {}, onPresented = () => {}, fontScale = 1 }) {
  let popup;
  let closeTimer;
  let pendingState = null;
  let allowedSenderId = null;
  let currentNotices = [];
  let currentFontScale = normalizeFontScale(fontScale);

  function normalizeFontScale(value) {
    return typeof value === "number" && FONT_SCALES.includes(value) ? value : 1;
  }

  function heightFor(visibleCount, totalCount) {
    return 24 + visibleCount * 176 + Math.max(0, visibleCount - 1) * 10 + (totalCount > visibleCount ? 58 : 0);
  }

  function layoutFor(totalCount, display) {
    const area = display.workArea;
    const maxWidth = Math.max(1, area.width - MARGIN * 2);
    const maxHeight = Math.max(1, area.height - MARGIN * 2);
    const scale = Math.max(0.5, Math.min(currentFontScale, maxWidth / WINDOW_WIDTH, maxHeight / heightFor(1, totalCount)));
    let visibleCount = Math.min(MAX_CARDS, totalCount);
    while (visibleCount > 1 && heightFor(visibleCount, totalCount) * scale > maxHeight) visibleCount -= 1;
    const height = heightFor(visibleCount, totalCount);
    return { scale, visibleCount, height, overflow: Math.max(0, totalCount - visibleCount) };
  }

  function boundsFor(height, scale) {
    const main = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.title !== "Gestão Logística · Notificações");
    const targetDisplay = main && !main.isDestroyed()
      ? screen.getDisplayMatching(main.getBounds())
      : screen.getPrimaryDisplay();
    const { x, y, width, height: availableHeight } = targetDisplay.workArea;
    const popupWidth = Math.min(Math.round(WINDOW_WIDTH * scale), width - MARGIN * 2);
    const popupHeight = Math.min(Math.round(height * scale), availableHeight - MARGIN * 2);
    return {
      x: Math.max(x, x + width - popupWidth - MARGIN),
      y: Math.max(y, y + availableHeight - popupHeight - MARGIN),
      width: popupWidth,
      height: popupHeight,
    };
  }

  function ensureWindow(height, scale) {
    if (popup && !popup.isDestroyed()) {
      popup.webContents.setZoomFactor(scale);
      popup.setBounds(boundsFor(height, scale));
      return popup;
    }
    popup = new BrowserWindow({
      title: "Gestão Logística · Notificações",
      width: Math.round(WINDOW_WIDTH * scale),
      height: Math.round(height * scale),
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
    popup.webContents.setZoomFactor(scale);
    popup.setBounds(boundsFor(height, scale));
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
      currentNotices = [];
    });
    void popup.loadFile(path.join(directory, "solicitation-popup.html"));
    return popup;
  }

  function renderCurrent({ markPresented = false, resetTimer = false } = {}) {
    if (!currentNotices.length) return { ok: false, reason: "empty" };
    const main = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.title !== "Gestão Logística · Notificações");
    const display = main ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
    const layout = layoutFor(currentNotices.length, display);
    pendingState = { notices: currentNotices.slice(0, layout.visibleCount), overflow: layout.overflow };
    const host = ensureWindow(layout.height, layout.scale);
    allowedSenderId = host.webContents.id;
    host.setBounds(boundsFor(layout.height, layout.scale));
    host.setAlwaysOnTop(true, "floating");
    if (!host.webContents.isLoading()) host.webContents.send("popup:state", pendingState);
    host.showInactive();
    if (markPresented) onPresented(currentNotices.map((notice) => notice.id));
    if (resetTimer) {
      clearTimeout(closeTimer);
      closeTimer = setTimeout(() => {
        if (popup && !popup.isDestroyed()) popup.close();
      }, lifetimeFor(currentNotices));
    }
    return { ok: true, count: currentNotices.length, visible: pendingState.notices.length, overflow: pendingState.overflow };
  }

  function present(rows, at = new Date()) {
    currentNotices = (Array.isArray(rows) ? rows : []).map((row) => safeNotice(row, at)).filter(Boolean);
    if (!currentNotices.length) return { ok: false, reason: "empty" };
    return renderCurrent({ markPresented: true, resetTimer: true });
  }

  function setFontScale(value) {
    currentFontScale = normalizeFontScale(value);
    if (popup && !popup.isDestroyed() && currentNotices.length) renderCurrent();
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
    else currentNotices = [];
  }

  return { present, acceptAction, close, getWindow: () => popup, setFontScale };
}

module.exports = { createSolicitationPopupController, safeNotice, lifetimeFor, MAX_CARDS, WINDOW_WIDTH, MARGIN };
