export type DataService = Pick<Window["gestaoAPI"],
  | "dashboard"
  | "siwinStatus"
  | "syncSiwin"
  | "syncThunderbird"
  | "onSiwinUpdated"
  | "onThunderbirdUpdated"
  | "prepareSelection"
  | "listOrders"
  | "getOrder"
  | "updateOrder"
  | "bulkUpdateOrders"
  | "markSelectionEmail"
  | "listClients"
  | "updateMilestone"
  | "selectSpreadsheet"
  | "confirmImport"
  | "addAttachment"
  | "openAttachment"
  | "openExternal"
>;

export const ipcDataService: DataService = {
  dashboard: () => window.gestaoAPI.dashboard(),
  siwinStatus: () => window.gestaoAPI.siwinStatus(),
  syncSiwin: () => window.gestaoAPI.syncSiwin(),
  syncThunderbird: () => window.gestaoAPI.syncThunderbird(),
  onSiwinUpdated: (callback) => window.gestaoAPI.onSiwinUpdated(callback),
  onThunderbirdUpdated: (callback) => window.gestaoAPI.onThunderbirdUpdated(callback),
  prepareSelection: (emailId) => window.gestaoAPI.prepareSelection(emailId),
  listOrders: (options) => window.gestaoAPI.listOrders(options),
  getOrder: (orderId) => window.gestaoAPI.getOrder(orderId),
  updateOrder: (input) => window.gestaoAPI.updateOrder(input),
  bulkUpdateOrders: (input) => window.gestaoAPI.bulkUpdateOrders(input),
  markSelectionEmail: (input) => window.gestaoAPI.markSelectionEmail(input),
  listClients: (options) => window.gestaoAPI.listClients(options),
  updateMilestone: (input) => window.gestaoAPI.updateMilestone(input),
  selectSpreadsheet: () => window.gestaoAPI.selectSpreadsheet(),
  confirmImport: (preview) => window.gestaoAPI.confirmImport(preview),
  addAttachment: (orderId, type) => window.gestaoAPI.addAttachment(orderId, type),
  openAttachment: (attachmentId) => window.gestaoAPI.openAttachment(attachmentId),
  openExternal: (url) => window.gestaoAPI.openExternal(url),
};

export const dataService: DataService = ipcDataService;
