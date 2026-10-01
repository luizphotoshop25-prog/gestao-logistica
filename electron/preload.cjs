const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gestaoAPI", {
  status: () => ipcRenderer.invoke("app:status"),
  localCurrentUser: () => ipcRenderer.invoke("auth:local-current"),
  dashboard: () => ipcRenderer.invoke("dashboard:get"),
  siwinStatus: () => ipcRenderer.invoke("siwin:status"),
  syncSiwin: () => ipcRenderer.invoke("siwin:sync"),
  syncThunderbird: () => ipcRenderer.invoke("thunderbird:sync"),
  onSiwinUpdated: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("siwin:updated", listener);
    return () => ipcRenderer.removeListener("siwin:updated", listener);
  },
  onThunderbirdUpdated: (callback) => {
    const listener = (_event, result) => callback(result);
    ipcRenderer.on("thunderbird:updated", listener);
    return () => ipcRenderer.removeListener("thunderbird:updated", listener);
  },
  prepareSelection: (emailId) => ipcRenderer.invoke("thunderbird:prepare-selection", emailId),
  listOrders: (options) => ipcRenderer.invoke("orders:list", options),
  getOrder: (orderId) => ipcRenderer.invoke("orders:get", orderId),
  getOrderClientProfile: (orderId) => ipcRenderer.invoke("orders:client-profile", orderId),
  updateOrder: (input) => ipcRenderer.invoke("orders:update", input),
  listTreatmentAssignees: () => ipcRenderer.invoke("orders:treatment-assignees"),
  updateTreatmentAssignee: (input) => ipcRenderer.invoke("orders:treatment-assignee", input),
  restoreAutomaticTreatmentAssignee: (input) => ipcRenderer.invoke("orders:treatment-assignee-automatic", input),
  bulkUpdateOrders: (input) => ipcRenderer.invoke("orders:bulk-update", input),
  markSelectionEmail: (input) => ipcRenderer.invoke("selection-email:mark", input),
  listClients: (options) => ipcRenderer.invoke("clients:list", options),
  updateMilestone: (input) => ipcRenderer.invoke("orders:milestone", input),
  selectSpreadsheet: () => ipcRenderer.invoke("import:select"),
  confirmImport: (preview) => ipcRenderer.invoke("import:confirm", preview),
  addAttachment: (orderId, type) => ipcRenderer.invoke("attachments:add", orderId, type),
  openAttachment: (attachmentId) => ipcRenderer.invoke("attachments:open", attachmentId),
  openExternal: (url) => ipcRenderer.invoke("external:open", url),
  listSolicitations: () => ipcRenderer.invoke("solicitations:list"),
  getSolicitation: (id) => ipcRenderer.invoke("solicitations:get", id),
  listSolicitationAssignees: () => ipcRenderer.invoke("solicitations:assignees"),
  createSolicitation: (input) => ipcRenderer.invoke("solicitations:create", input),
  updateSolicitation: (input) => ipcRenderer.invoke("solicitations:update", input),
  transitionSolicitation: (input) => ipcRenderer.invoke("solicitations:transition", input),
  pollSolicitationNotifications: () => ipcRenderer.invoke("notifications:poll"),
  listSolicitationNotifications: () => ipcRenderer.invoke("notifications:list"),
  updateSolicitationNotification: (input) => ipcRenderer.invoke("notifications:update", input),
  presentSolicitationNotifications: (rows) => ipcRenderer.invoke("notifications:present-popup", rows),
  showNativeSolicitationNotification: (input) => ipcRenderer.invoke("notifications:native", input),
  onNativeSolicitationOpen: (callback) => {
    const listener = (_event, solicitationId) => callback(solicitationId);
    ipcRenderer.on("notifications:open", listener);
    return () => ipcRenderer.removeListener("notifications:open", listener);
  },
  onNativeSolicitationFallback: (callback) => {
    const listener = (_event, input) => callback(input);
    ipcRenderer.on("notifications:fallback", listener);
    return () => ipcRenderer.removeListener("notifications:fallback", listener);
  },
  onSolicitationPopupPresented: (callback) => {
    const listener = (_event, ids) => callback(ids);
    ipcRenderer.on("notifications:popup-presented", listener);
    return () => ipcRenderer.removeListener("notifications:popup-presented", listener);
  },
  onSolicitationPopupAction: (callback) => {
    const listener = (_event, input) => callback(input);
    ipcRenderer.on("notifications:popup-action", listener);
    return () => ipcRenderer.removeListener("notifications:popup-action", listener);
  },
  onOpenNotificationCenter: (callback) => {
    const listener = () => callback();
    ipcRenderer.on("notifications:open-center", listener);
    return () => ipcRenderer.removeListener("notifications:open-center", listener);
  },
  listDigitalShipments: (options) => ipcRenderer.invoke("digital-shipments:list", options),
  getDigitalShipment: (id) => ipcRenderer.invoke("digital-shipments:get", id),
  getDigitalShipmentsForOrder: (orderId) => ipcRenderer.invoke("digital-shipments:for-order", orderId),
  resolveDigitalShipmentSessions: (input) => ipcRenderer.invoke("digital-shipments:resolve-sessions", input),
  createDigitalShipment: (input) => ipcRenderer.invoke("digital-shipments:create", input),
  updateDigitalShipment: (input) => ipcRenderer.invoke("digital-shipments:update", input),
  getUpdaterState: () => ipcRenderer.invoke("updater:get-state"),
  downloadAppUpdate: () => ipcRenderer.invoke("updater:download"),
  installAppUpdate: () => ipcRenderer.invoke("updater:install"),
  onUpdaterState: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on("updater:state", listener);
    return () => ipcRenderer.removeListener("updater:state", listener);
  },
});

contextBridge.exposeInMainWorld("gestaoConfig", {
  dataTransport: process.env.GESTAO_DATA_TRANSPORT === "http" ? "http" : "ipc",
  apiUrl: process.env.GESTAO_DATA_TRANSPORT === "http" ? process.env.GESTAO_API_URL || "" : "",
  remoteClientBuild: process.env.GESTAO_REMOTE_CLIENT_BUILD === "1",
  backgroundStart: process.env.GESTAO_BACKGROUND_START === "1",
});

contextBridge.exposeInMainWorld("gestaoApp", {
  showAuthenticationWindow: () => ipcRenderer.send("app:show-authentication"),
  setConnectionStatus: (status) => ipcRenderer.send("app:connection-status", status),
});

contextBridge.exposeInMainWorld("gestaoSession", {
  read: () => ipcRenderer.invoke("auth-session:read"),
  write: (token) => ipcRenderer.invoke("auth-session:write", token),
  clear: () => ipcRenderer.invoke("auth-session:clear"),
  retryRemoteConfig: () => ipcRenderer.invoke("remote-config:retry"),
});

contextBridge.exposeInMainWorld("gestaoUiPreferences", {
  get: () => ipcRenderer.invoke("ui-preferences:get"),
  set: (preferences) => ipcRenderer.invoke("ui-preferences:set", preferences),
});
