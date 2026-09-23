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

const unsupportedMessage = "Indisponível no transporte HTTP de protótipo.";
const unsupported = () => ({ ok: false, message: unsupportedMessage });

export function createHttpDataService(apiUrl: string): DataService {
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    if (!apiUrl.startsWith("http://127.0.0.1:") || !/^[0-9]+$/.test(apiUrl.slice(17))) throw new Error("API HTTP de teste não configurada em loopback.");
    const response = await fetch(apiUrl + path, {
      ...init,
      headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    });
    const body = await response.json();
    return body;
  };

  return {
    dashboard: () => request("/api/dashboard"),
    siwinStatus: async () => ({ ok: false, lastCad: 0, lastSync: null, lastImported: 0 }),
    syncSiwin: async () => ({ ...unsupported(), imported: 0, updated: 0, total: 0, importedOrders: 0, updatedOrders: 0, syncedItems: 0, scopedClients: 0, linked: 0, unmatched: 0 }),
    syncThunderbird: async () => ({ ...unsupported(), imported: 0, linked: 0, datesSet: 0, unmatched: 0, total: 0 }),
    onSiwinUpdated: () => () => {},
    onThunderbirdUpdated: () => () => {},
    prepareSelection: async () => unsupported(),
    listOrders: (options) => request(`/api/orders?search=${encodeURIComponent(options?.search || "")}&filter=${encodeURIComponent(options?.filter || "all")}`),
    getOrder: (orderId) => request(`/api/orders/${encodeURIComponent(orderId)}`),
    updateOrder: (input) => request(`/api/orders/${encodeURIComponent(input.id)}`, { method: "PATCH", body: JSON.stringify({ revisao: input.revisao, values: input.values }) }),
    bulkUpdateOrders: async () => unsupported(),
    markSelectionEmail: async () => unsupported(),
    listClients: async () => ({ ...unsupported(), rows: [] }),
    updateMilestone: async () => unsupported(),
    selectSpreadsheet: async () => ({ ...unsupported(), total: 0, eligible: 0, blocked: 0, missingClient: 0, trackingWithoutDate: 0, rows: [] }),
    confirmImport: async () => ({ ...unsupported(), imported: 0, skipped: 0 }),
    addAttachment: async () => unsupported(),
    openAttachment: async () => unsupported(),
    openExternal: async () => unsupported(),
  };
}

export const httpDataService: DataService = createHttpDataService(window.gestaoConfig?.apiUrl || "");
export const dataService: DataService = window.gestaoConfig?.dataTransport === "http" ? httpDataService : ipcDataService;
