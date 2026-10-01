const TEST_TARGET = "__native_notification_test__";

function showWindowsNotificationTest({ Notification, mainWindow, log = () => {} }) {
  if (!mainWindow || mainWindow.isDestroyed()) return { ok: false, status: "window-unavailable" };
  if (!Notification.isSupported()) return { ok: false, status: "unsupported" };

  const notification = new Notification({
    title: "Gestão Logística",
    body: "Notificação de teste. Clique para abrir o Gestão Logística.",
    silent: true,
  });
  notification.once("failed", () => log("failed"));
  mainWindow.once("focus", () => log("window-focused"));
  notification.once("click", () => {
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("notifications:open", TEST_TARGET);
    log("click-received; window-restored; notifications:open-sent");
  });

  mainWindow.minimize();
  notification.show();
  log("shown; window-minimized");
  return { ok: true, status: "shown" };
}

module.exports = { showWindowsNotificationTest };
