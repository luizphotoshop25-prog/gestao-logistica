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
> & {
  login(input: { usuario: string; senha: string }): Promise<AuthResult>;
  logout(): Promise<{ ok: boolean }>;
  currentUser(): Promise<AuthResult>;
  restoreSession(token: string): void;
};

export const ipcDataService: DataService = {
  login: async () => ({ ok: false, message: "Login não é exigido no modo IPC." }),
  logout: async () => ({ ok: true }),
  currentUser: async () => ({ ok: true, user: { id: "ipc-local", nome: "Usuário local", usuario: "local" } }),
  restoreSession: () => {},
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
  let sessionToken = "";
  const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
    let target: URL;
    try { target = new URL(apiUrl); } catch { throw new Error("URL da API do Gestão Logística não configurada."); }
    if (target.protocol !== "http:" || target.origin !== apiUrl || !target.port) throw new Error("URL da API do Gestão Logística inválida.");
    try {
      const response = await fetch(apiUrl + path, {
        ...init,
        headers: { "Content-Type": "application/json", ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}), ...(init?.headers || {}) },
      });
      return await response.json();
    } catch (error) {
      if (error instanceof TypeError) throw new Error("Não foi possível conectar ao servidor do Gestão Logística.");
      throw error;
    }
  };

  return {
    login: async (input) => {
      const result = await request<AuthResult>("/api/auth/login", { method: "POST", body: JSON.stringify(input) });
      if (result.ok && result.session) sessionToken = result.session;
      return result;
    },
    logout: async () => { const result = await request<{ ok: boolean }>("/api/auth/logout", { method: "POST" }); sessionToken = ""; return result; },
    currentUser: () => request("/api/auth/current"),
    restoreSession: (token) => { sessionToken = token; },
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
