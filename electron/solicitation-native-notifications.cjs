const TITLES = {
  DUE_TOMORROW: "Solicitação para amanhã",
  DUE_TODAY: "Solicitação com prazo hoje",
  DUE_IN_ONE_HOUR: "Prazo de solicitação em 1 hora",
  OVERDUE: "Solicitação atrasada",
  ASSIGNED: "Nova solicitação atribuída",
};

function showNativeSolicitationNotification(Notification, mainWindow, input) {
  if (!mainWindow || mainWindow.isDestroyed() || (mainWindow.isVisible() && mainWindow.isFocused())) return { ok: false };
  if (!Notification.isSupported() || typeof input?.solicitationId !== "string" || !/^[0-9a-f-]{36}$/i.test(input.solicitationId)) return { ok: false };
  const title = TITLES[input.type];
  if (!title) return { ok: false };
  const notification = new Notification({ title, body: "Abra o Gestão Logística para visualizar.", silent: true });
  notification.on("click", () => {
    if (mainWindow.isDestroyed()) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
    mainWindow.webContents.send("notifications:open", input.solicitationId);
  });
  notification.show();
  return { ok: true };
}

module.exports = { showNativeSolicitationNotification };
