const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("gestaoAPI", {
  status: () => ipcRenderer.invoke("app:status"),
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
  updateOrder: (input) => ipcRenderer.invoke("orders:update", input),
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
});

contextBridge.exposeInMainWorld("gestaoConfig", {
  dataTransport: process.env.GESTAO_DATA_TRANSPORT === "http" ? "http" : "ipc",
  apiUrl: process.env.GESTAO_DATA_TRANSPORT === "http" ? process.env.GESTAO_API_URL || "" : "",
});

contextBridge.exposeInMainWorld("gestaoSession", {
  read: () => ipcRenderer.invoke("auth-session:read"),
  write: (token) => ipcRenderer.invoke("auth-session:write", token),
  clear: () => ipcRenderer.invoke("auth-session:clear"),
});
