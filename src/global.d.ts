type ImportRow = {
  linha: number;
  sessao: string;
  clienteNome: string;
  clienteEmail: string;
  clienteTelefone: string;
  clienteCidade: string;
  fotosQuantidade: number | null;
  observacoes: string;
  selecaoFinalizadaEm: string | null;
  prazoMaximoLegadoEm: string | null;
  tratamentoConcluido: boolean;
  postadoEm: string | null;
  codigoRastreio: string;
  entregue: boolean;
  editor: string;
  warnings: string[];
  eligible: boolean;
};

type ImportPreview = {
  ok: boolean;
  canceled?: boolean;
  message?: string;
  filePath?: string;
  total: number;
  eligible: number;
  blocked: number;
  missingClient: number;
  trackingWithoutDate: number;
  rows: ImportRow[];
};

type Order = Record<string, unknown> & {
  id: string;
  sessao: string;
  cliente_nome: string | null;
  fotos_quantidade: number | null;
  etapa: string;
  selecao_finalizada_em: string | null;
  prazo_tratamento_em: string | null;
  prazo_maximo_em: string | null;
  codigo_rastreio: string | null;
  operacional_bucket: "needs_me" | "waiting" | "alerts" | null;
  responsavel_atual: string;
  acao_recomendada: string;
  urgencia_texto: string | null;
  urgencia_dias: number | null;
  ultima_movimentacao_em: string | null;
  selecoes_pendentes: number;
};

type ClientRow = {
  id: string;
  siwin_cad: number | null;
  nome: string | null;
  email: string | null;
  telefone: string | null;
  celular: string | null;
  cidade: string | null;
  uf: string | null;
  pedidos_quantidade: number;
};

type AttachmentRow = { id: string; tipo: string; nome_arquivo: string; criado_em: string };
type EventRow = { id: string; tipo: string; descricao: string; criado_em: string };
type SiwinObservationRow = { id: string; siwin_ped_obs: number; usuario: string | null; cadastrado_em: string | null; observacao: string };
type SelectionEmailRow = {
  id: string;
  message_id: string;
  sessao: string;
  recebido_em: string;
  data_finalizacao: string;
  quantidade_selecionada: number | null;
  quantidade_total: number | null;
  codigos: string[];
  status: string;
  conferida_em: string | null;
  fotos_separadas_em: string | null;
};
type OrderItemRow = {
  id: string;
  siwin_ped_ms: number;
  produto: string;
  quantidade: number;
  fotos: number;
  valor_unitario: number;
  desconto: number;
  valor_total: number;
  cobrado: number;
  situacao: string | null;
  tipo_foto: string | null;
  ampliacao: string | null;
};
type OrderDetailResult = {
  ok: boolean;
  message?: string;
  unchanged?: boolean;
  order: Order & Record<string, string | number | null>;
  attachments: AttachmentRow[];
  items: OrderItemRow[];
  siwinObservations: SiwinObservationRow[];
  selectionEmails: SelectionEmailRow[];
  events: EventRow[];
};

interface DashboardSummary {
  total: number;
  clientes: number;
  stages: Record<string, number>;
  tratamentoAtrasado: number;
  semCliente: number;
  queues: {
    needsMe: number;
    waiting: number;
    alerts: number;
    work: number;
    newSelections: number;
    due3: number;
    maxOverdue: number;
    treatedReady: number;
    readyLabel: number;
    shipment: number;
    archived: number;
    reviewHistory: number;
  };
}

interface Window {
  gestaoAPI: {
    status(): Promise<Record<string, unknown>>;
    dashboard(): Promise<{ ok: boolean; dashboard: DashboardSummary }>;
    siwinStatus(): Promise<{ ok: boolean; lastCad: number; lastSync: string | null; lastImported: number }>;
    syncSiwin(): Promise<{ ok: boolean; imported: number; updated: number; total: number; importedOrders: number; updatedOrders: number; syncedItems: number; scopedClients: number; linked: number; unmatched: number; message?: string }>;
    syncThunderbird(): Promise<{ ok: boolean; imported: number; linked: number; datesSet: number; unmatched: number; total: number; message?: string }>;
    onSiwinUpdated(callback: (result: { ok: boolean; imported: number; updated: number; total: number; importedOrders: number; updatedOrders: number; syncedItems: number; scopedClients: number; linked: number; unmatched: number }) => void): () => void;
    onThunderbirdUpdated(callback: (result: { ok: boolean; imported: number; linked: number; datesSet: number; unmatched: number; total: number; message?: string }) => void): () => void;
    prepareSelection(emailId: string): Promise<{ ok: boolean; listPath?: string; total?: number; message?: string }>;
    listOrders(options?: { search?: string; filter?: string }): Promise<{ ok: boolean; rows: Order[] }>;
    getOrder(orderId: string): Promise<OrderDetailResult>;
    updateOrder(input: { id: string; values: Record<string, string | number | null> }): Promise<OrderDetailResult>;
    bulkUpdateOrders(input: { ids: string[]; action: string; date?: string }): Promise<{ ok: boolean; updated?: number; skipped?: number; skippedDetails?: string[]; message?: string }>;
    markSelectionEmail(input: { id: string; field: "conferida_em" | "fotos_separadas_em"; value?: string }): Promise<{ ok: boolean; message?: string }>;
    listClients(options?: { search?: string; limit?: number }): Promise<{ ok: boolean; rows: ClientRow[] }>;
    updateMilestone(input: { id: string; field: string; value?: string }): Promise<{ ok: boolean; message?: string }>;
    selectSpreadsheet(): Promise<ImportPreview>;
    confirmImport(preview: ImportPreview): Promise<{ ok: boolean; imported: number; skipped: number; message?: string }>;
    addAttachment(orderId: string, type: string): Promise<{ ok: boolean; canceled?: boolean; message?: string }>;
    openAttachment(attachmentId: string): Promise<{ ok: boolean; message?: string }>;
    openExternal(url: string): Promise<{ ok: boolean; message?: string }>;
  };
}
