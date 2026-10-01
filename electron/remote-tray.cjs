function createRemoteTray({ app, Tray, Menu, getMainWindow, getPopup, beforeExit = () => {}, enabled = false }) {
  let tray = null;
  let quitting = false;
  let connectionStatus = "Aguardando conexão";

  function showMainWindow() {
    const window = getMainWindow();
    if (!window || window.isDestroyed()) return false;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
    return true;
  }

  function updateTooltip() {
    if (tray && !tray.isDestroyed()) tray.setToolTip(`Gestão Logística · ${connectionStatus}`);
  }

  function quit() {
    if (quitting) return;
    quitting = true;
    try { getPopup()?.close(); } catch { /* A saída explícita não depende do popup. */ }
    try { tray?.destroy(); } catch { /* Best effort during shutdown. */ }
    tray = null;
    beforeExit();
    app.quit();
  }

  async function initialize(icon) {
    if (!enabled || tray) return { ok: Boolean(tray), disabled: !enabled };
    try {
      tray = new Tray(icon);
      tray.setToolTip(`Gestão Logística · ${connectionStatus}`);
      tray.setContextMenu(Menu.buildFromTemplate([
        { label: "Abrir Gestão Logística", click: showMainWindow },
        { type: "separator" },
        { label: "Sair do Gestão Logística", click: quit },
      ]));
      tray.on("double-click", showMainWindow);
      tray.on("click", showMainWindow);
      return { ok: true };
    } catch {
      try { tray?.destroy(); } catch { /* The tray is optional if Windows rejects the icon. */ }
      tray = null;
      return { ok: false };
    }
  }

  function attachWindow(window) {
    if (!enabled || !window || window.isDestroyed()) return;
    window.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      window.hide();
    });
  }

  function setConnectionStatus(status) {
    connectionStatus = status === "connected" ? "Conectado" : status === "login" ? "Aguardando login" : "Aguardando conexão";
    updateTooltip();
  }

  function open() { return showMainWindow(); }
  function markQuitting() { quitting = true; }
  function isQuitting() { return quitting; }

  return { initialize, attachWindow, showMainWindow, setConnectionStatus, open, quit, markQuitting, isQuitting, getTray: () => tray };
}

module.exports = { createRemoteTray };
