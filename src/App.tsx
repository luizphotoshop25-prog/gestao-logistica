import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { dataService } from "./services/dataService";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronRight,
  ClipboardList,
  Contact,
  Database,
  Image as ImageIcon,
  Layers3,
  ExternalLink,
  Paperclip,
  PackageCheck,
  PackageOpen,
  Save,
  Search,
  Send,
  Users,
  UserCheck,
  X,
} from "lucide-react";
import { OrderPreview } from "./components/OrderPreview";
import { ViewState } from "./components/ui";
import { Central } from "./components/Central";
import { CommandPalette } from "./components/CommandPalette";
import { Hint } from "./components/Hint";
import { IntegrationMenu } from "./components/IntegrationMenu";
import { OrderActionsMenu } from "./components/OrderActionsMenu";
import { OrderClientProfilePopover, type ClientProfileTarget } from "./components/OrderClientProfilePopover";
import { Pagination } from "./components/Pagination";
import { TableSkeleton } from "./components/TableSkeleton";
import { SolicitationsPage } from "./components/SolicitationsPage";
import { SolicitationNotifications } from "./components/SolicitationNotifications";
import { DigitalOrderHistory, DigitalShipmentsPage } from "./components/DigitalShipmentsPage";
import { sortOrdersBySession } from "./utils/session-sort";
import { AppearanceSettings } from "./components/AppearanceSettings";

const stageLabels: Record<string, string> = {
  sessao_criada: "Sessão criada",
  galeria_publicada: "Galeria publicada",
  aguardando_selecao: "Aguardando seleção",
  em_tratamento: "Em tratamento",
  tratamento_concluido: "Tratamento concluído",
  em_impressao: "Em impressão",
  impressoes_recebidas: "Impressões recebidas",
  etiqueta_criada: "Etiqueta criada",
  em_remessa: "Em remessa",
  postado: "Postado",
  entregue: "Entregue",
};

const nextActions: Record<string, { label: string; field: string }> = {
  sessao_criada: { label: "Registrar galeria publicada", field: "galeria_publicada_em" },
  galeria_publicada: { label: "Registrar envio do link", field: "link_enviado_em" },
  aguardando_selecao: { label: "Registrar seleção finalizada", field: "selecao_finalizada_em" },
  em_tratamento: { label: "Registrar tratamento concluído", field: "tratamento_concluido_em" },
  tratamento_concluido: { label: "Registrar envio para Digital Fotos", field: "impressao_enviada_em" },
  em_impressao: { label: "Registrar recebimento das impressões", field: "impressao_recebida_em" },
  impressoes_recebidas: { label: "Registrar etiqueta criada", field: "etiqueta_criada_em" },
  etiqueta_criada: { label: "Registrar postagem", field: "postado_em" },
  postado: { label: "Registrar entrega", field: "entregue_em" },
};

type ConfirmationState = {
  title: string;
  message: string;
  note?: string;
  confirmLabel: string;
  tone?: "default" | "warning";
  onConfirm: () => void | Promise<void>;
};

const filterLabels: Record<string, string> = {
  needs_me: "Ação da equipe",
  waiting: "Aguardando terceiros",
  alerts: "Alertas operacionais",
  new_selections: "Seleções novas",
  due_3: "Prazos próximos",
  ready_label: "Prontas para etiqueta",
};

const formatDate = (value: string | null) => {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-");
  return `${day}/${month}/${year}`;
};

const formatWorkflowDate = (value: string | null | undefined) => {
  if (!value) return null;
  const [year, month, day] = value.slice(0, 10).split("-");
  if (!year || !month || !day) return null;
  return `${day}/${month}/${year.slice(-2)}`;
};

const formatCurrency = (value: number) => new Intl.NumberFormat("pt-BR", {
  style: "currency", currency: "BRL",
}).format(Number(value) || 0);

export function App({ currentUser, onLogout, fontScale, onFontScalePreview, onFontScaleApply }: { currentUser: AuthUser; onLogout?: () => void; fontScale: number; onFontScalePreview: (scale: number) => void; onFontScaleApply: (scale: number) => Promise<boolean> }) {
  const [centralQueue, setCentralQueue] = useState("needs_me");
  const [centralTask, setCentralTask] = useState<Solicitation | null>(null);
  const openNotifiedSolicitation = useCallback(async (id: string) => {
    try {
      const result = await dataService.getSolicitation(id);
      if (!result.ok || !result.solicitation) return;
      setCentralTask(result.solicitation);
      setWorkspacePage("solicitations");
    } catch { /* The notification stays available in the bell for a retry. */ }
  }, []);
  const [orderPreviewId, setOrderPreviewId] = useState<string | null>(null);
  const [clientProfileTarget, setClientProfileTarget] = useState<ClientProfileTarget | null>(null);
  const [clientProfileCacheVersion, setClientProfileCacheVersion] = useState(0);
  const [listError, setListError] = useState("");
  const [searchScope, setSearchScope] = useState<"queue" | "all">("queue");
  const [orders, setOrders] = useState<Order[]>([]);
  const [dashboard, setDashboard] = useState<DashboardSummary>({
    total: 0,
    clientes: 0,
    stages: {},
    tratamentoAtrasado: 0,
    semCliente: 0,
    queues: { needsMe: 0, waiting: 0, alerts: 0, work: 0, newSelections: 0, due3: 0, maxOverdue: 0, treatedReady: 0, readyLabel: 0, shipment: 0, archived: 0, reviewHistory: 0 },
  });
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState(() => window.localStorage.getItem("gestao:last-filter") || "needs_me");
  const [sortMode, setSortMode] = useState(() => window.localStorage.getItem("gestao:last-sort") || "priority");
  const [page, setPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [bulkMode, setBulkMode] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [detail, setDetail] = useState<OrderDetailResult | null>(null);
  const [detailTab, setDetailTab] = useState<"summary" | "operation" | "history">("summary");
  const [form, setForm] = useState<Record<string, string>>({});
  const [savedForm, setSavedForm] = useState<Record<string, string>>({});
  const [clientSearch, setClientSearch] = useState("");
  const [clients, setClients] = useState<ClientRow[]>([]);
  const [clientsLoading, setClientsLoading] = useState(false);
  const [clientsError, setClientsError] = useState("");
  const [clientsRefresh, setClientsRefresh] = useState(0);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [workspacePage, setWorkspacePage] = useState<"central" | "orders" | "myOrders" | "digital" | "solicitations" | "clients">("central");
  const [treatmentAssignees, setTreatmentAssignees] = useState<ActiveUser[]>([]);
  const [lastSiwinSync, setLastSiwinSync] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<ConfirmationState | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [commandOpen, setCommandOpen] = useState(false);
  const [commandQuery, setCommandQuery] = useState("");
  const [commandResults, setCommandResults] = useState<Order[]>([]);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const detailReturnFocusRef = useRef<HTMLElement | null>(null);
  const clientProfileTargetRef = useRef<ClientProfileTarget | null>(null);
  const listRequestRef = useRef(0);
  const formDirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(savedForm), [form, savedForm]);
  const pageSize = 50;
  const closeClientProfile = useCallback((restoreFocus = false) => {
    const target = clientProfileTargetRef.current;
    const anchor = target?.anchor;
    clientProfileTargetRef.current = null;
    setClientProfileTarget(null);
    if (restoreFocus && target) window.requestAnimationFrame(() => {
      const currentAnchor = anchor?.isConnected ? anchor : [...document.querySelectorAll<HTMLElement>("[data-order-profile-trigger]")].find((button) => button.dataset.orderProfileTrigger === target.orderId);
      currentAnchor?.focus();
    });
  }, []);
  const toggleClientProfile = (order: Order, anchor: HTMLElement) => {
    if (!order.cliente_id) return;
    if (clientProfileTargetRef.current?.orderId === order.id) return closeClientProfile(true);
    const target = { orderId: order.id, clientName: order.cliente_nome || "Cliente", anchor };
    clientProfileTargetRef.current = target;
    setClientProfileTarget(target);
  };
  const dismissOrder = () => {
    const previousFocus = detailReturnFocusRef.current;
    setDetail(null);
    window.requestAnimationFrame(() => { if (previousFocus?.isConnected) previousFocus.focus(); });
  };
  useEffect(() => {
    if (detail) window.requestAnimationFrame(() => document.querySelector<HTMLElement>(".detail-head button[aria-label='Fechar ficha']")?.focus());
  }, [detail?.order.id]);

  const closeOrder = () => {
    if (formDirty) {
      setConfirmation({
        title: "Descartar alterações?",
        message: "A ficha possui alterações que ainda não foram salvas.",
        note: "Ao fechar, essas alterações serão perdidas.",
        confirmLabel: "Descartar e fechar",
        tone: "warning",
        onConfirm: dismissOrder,
      });
      return;
    }
    dismissOrder();
  };

  const reload = useCallback(async () => {
    const requestId = ++listRequestRef.current;
    setInitialLoading(true);
    setListError("");
    try {
      const [ordersResult, dashboardResult] = await Promise.all([
        dataService.listOrders({ search, filter: search.trim() && searchScope === "all" ? "all" : filter, ...(workspacePage === "myOrders" ? { scope: "mine" as const } : {}) }),
        dataService.dashboard(),
      ]);
      if (requestId !== listRequestRef.current) return;
      if (!ordersResult.ok) throw new Error("Não foi possível carregar os pedidos.");
      setOrders(ordersResult.rows);
      if (dashboardResult.ok) setDashboard(dashboardResult.dashboard);
      setSelectedIds([]);
    } catch (error) {
      if (requestId === listRequestRef.current) setListError(error instanceof Error ? error.message : "Não foi possível carregar os dados.");
    } finally {
      if (requestId === listRequestRef.current) setInitialLoading(false);
    }
  }, [search, filter, searchScope, workspacePage, currentUser.id]);

  useEffect(() => {
    window.localStorage.setItem("gestao:last-filter", filter);
    window.localStorage.setItem("gestao:last-sort", sortMode);
    setPage(1);
  }, [filter, search, sortMode, searchScope]);

  useEffect(() => {
    if (!commandOpen) return;
    let current = true;
    const timer = window.setTimeout(async () => {
      if (!commandQuery.trim()) return setCommandResults([]);
      const result = await dataService.listOrders({ search: commandQuery, filter: "all" });
      if (current && result.ok) setCommandResults(result.rows.slice(0, 8));
    }, 140);
    return () => { current = false; window.clearTimeout(timer); };
  }, [commandOpen, commandQuery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setCommandOpen(true);
        return;
      }
      if (event.key === "/" && !editing) {
        event.preventDefault();
        if (workspacePage === "digital") document.getElementById("digital-search")?.focus();
        else searchInputRef.current?.focus();
        return;
      }
      if (event.key !== "Escape") return;
      if (commandOpen) return setCommandOpen(false);
      if (confirmation) return setConfirmation(null);
      if (preview) return setPreview(null);
      if (detail) closeOrder();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [commandOpen, confirmation, preview, detail, formDirty, workspacePage]);

  useEffect(() => {
    if (workspacePage !== "clients") return;
    let active = true;
    setClientsLoading(true);
    setClientsError("");
    const timer = window.setTimeout(async () => {
      try {
        const result = await dataService.listClients({ search: clientSearch, limit: 200 });
        if (!active) return;
        if (result.ok) setClients(result.rows);
        else setClientsError("Não foi possível carregar os clientes.");
      } catch (error) {
        if (active) setClientsError(error instanceof Error ? error.message : "Não foi possível carregar os clientes.");
      } finally { if (active) setClientsLoading(false); }
    }, 180);
    return () => { active = false; window.clearTimeout(timer); };
  }, [workspacePage, clientSearch, clientsRefresh]);

  useEffect(() => {
    const timer = window.setTimeout(() => void reload(), 180);
    return () => window.clearTimeout(timer);
  }, [reload]);

  useEffect(() => {
    void dataService.siwinStatus().then((result) => {
      if (result.ok) setLastSiwinSync(result.lastSync);
    });
  }, []);

  useEffect(() => dataService.onSiwinUpdated((result) => {
    if (result.ok) setClientProfileCacheVersion((value) => value + 1);
    if (result.ok && (result.imported > 0 || result.importedOrders > 0 || result.linked > 0)) {
      setNotice(`${result.imported} cliente(s) novo(s), ${result.importedOrders} sessão(ões) nova(s) e ${result.linked} vínculo(s) pelo SIWIN.`);
      void reload();
    }
  }), [reload]);

  useEffect(() => dataService.onThunderbirdUpdated((result) => {
    if (result.ok && result.imported > 0) {
      setNotice(`${result.imported} nova(s) seleção(ões) recebida(s) por e-mail; ${result.datesSet} data(s) registrada(s).`);
      void reload();
    }
  }), [reload]);

  const syncSiwin = async () => {
    setBusy(true);
    setNotice("");
    const result = await dataService.syncSiwin();
    setBusy(false);
    if (!result.ok) return setNotice(result.message || "Não foi possível sincronizar com o SIWIN.");
    setClientProfileCacheVersion((value) => value + 1);
    setLastSiwinSync(new Date().toISOString());
    setNotice(result.imported || result.importedOrders || result.linked
      ? `${result.imported} cliente(s) novo(s), ${result.importedOrders} sessão(ões) nova(s) e ${result.linked} vínculo(s) pelo SIWIN.`
      : "SIWIN conferido: nenhum cliente ou vínculo novo encontrado.");
    await reload();
  };

  const syncThunderbird = async () => {
    setBusy(true);
    setNotice("");
    const result = await dataService.syncThunderbird();
    setBusy(false);
    if (!result.ok) return setNotice(result.message || "Não foi possível verificar os e-mails da EPICS.");
    setNotice(result.imported
      ? `${result.imported} nova(s) seleção(ões) recebida(s); ${result.datesSet} data(s) registrada(s).`
      : "Thunderbird conferido: nenhum e-mail novo de seleção.");
    await reload();
  };

  const prepareSelection = async (emailId: string) => {
    setBusy(true);
    const result = await dataService.prepareSelection(emailId);
    setBusy(false);
    if (!result.ok) return setNotice(result.message || "Não foi possível preparar a lista de fotos.");
    setNotice(`${result.total} código(s) enviados ao GerenciadorFotos.`);
  };

  const markSelection = async (emailId: string, field: "conferida_em" | "fotos_separadas_em") => {
    if (!detail) return;
    setBusy(true);
    const result = await dataService.markSelectionEmail({ id: emailId, field });
    setBusy(false);
    if (!result.ok) return setNotice(result.message || "Não foi possível atualizar a seleção.");
    await openOrder(detail.order.id);
    await reload();
  };

  const performBulkAction = async (action: string, ids = selectedIds) => {
    setBusy(true);
    const result = await dataService.bulkUpdateOrders({ ids, action });
    setBusy(false);
    setNotice(result.message || (result.ok ? "Pedidos atualizados." : "Não foi possível atualizar os pedidos."));
    if (result.ok) await reload();
  };

  const runBulkAction = (action: string) => {
    if (!selectedIds.length) return;
    const labels: Record<string, { title: string; verb: string; button: string }> = {
      printing_sent: { title: "Registrar envio para impressão", verb: "já foram enviados à Digital Fotos", button: "Registrar envios" },
      prints_received: { title: "Registrar recebimento", verb: "já foram recebidos da Digital Fotos", button: "Registrar recebimentos" },
      add_shipment: { title: "Incluir na remessa de sexta", verb: "devem ser incluídos na próxima remessa", button: "Incluir na remessa" },
      posted: { title: "Registrar postagem", verb: "já foram postados nos Correios", button: "Registrar postagens" },
      archive: { title: "Arquivar pedidos", verb: "devem sair da mesa diária", button: "Arquivar pedidos" },
      conclude_previous: { title: "Concluir pedidos anteriores", verb: "devem ser marcados como concluídos anteriormente", button: "Marcar como concluídos" },
      activate: { title: "Reativar pedidos", verb: "devem voltar para a mesa diária", button: "Reativar pedidos" },
    };
    const copy = labels[action] || { title: "Confirmar ação", verb: "devem ser atualizados", button: "Confirmar" };
    const ids = [...selectedIds];
    setConfirmation({
      title: copy.title,
      message: `Confirma que ${ids.length} pedido(s) ${copy.verb}?`,
      note: "Pedidos que não estiverem na etapa correta serão ignorados e continuarão inalterados.",
      confirmLabel: copy.button,
      tone: ["archive", "conclude_previous"].includes(action) ? "warning" : "default",
      onConfirm: () => performBulkAction(action, ids),
    });
  };

  const openImport = async () => {
    setBusy(true);
    setNotice("");
    const result = await dataService.selectSpreadsheet();
    setBusy(false);
    if (result.ok) setPreview(result);
    else if (!result.canceled) setNotice(result.message || "Não foi possível ler a planilha.");
  };

  const confirmImport = async () => {
    if (!preview) return;
    setBusy(true);
    const result = await dataService.confirmImport(preview);
    setBusy(false);
    if (!result.ok) return setNotice(result.message || "A importação falhou.");
    setNotice(`${result.imported} sessões importadas; ${result.skipped} já existentes ignoradas.`);
    setPreview(null);
    await reload();
  };

  const performAdvance = async (order: Order) => {
    const action = nextActions[order.etapa];
    if (!action) return;
    setBusy(true);
    const result = await dataService.updateMilestone({ id: order.id, field: action.field });
    setBusy(false);
    setNotice(result.ok ? `${action.label} na sessão ${order.sessao}.` : result.message || "Não foi possível atualizar a etapa.");
    if (result.ok) await reload();
  };

  const advance = (order: Order) => {
    const action = nextActions[order.etapa];
    if (!action) return;
    void performAdvance(order);
  };

  const openOrder = async (orderId: string) => {
    detailReturnFocusRef.current = document.querySelector<HTMLElement>(".orders-table .order-selected .session-link")
      || (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setBusy(true);
    let result: OrderDetailResult;
    try { result = await dataService.getOrder(orderId); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Não foi possível abrir o pedido."); return; }
    finally { setBusy(false); }
    if (!result.ok) return setNotice(result.message || "Não foi possível abrir o pedido.");
    setDetail(result);
    if (currentUser.role === "coordinator") {
      const assignees = await dataService.listTreatmentAssignees().catch(() => ({ ok: false, rows: [] as ActiveUser[] }));
      if (assignees.ok) setTreatmentAssignees(assignees.rows);
    }
    setDetailTab("summary");
    const editable = [
      "galeria_url", "galeria_publicada_em", "link_enviado_em", "selecao_finalizada_em",
      "tratamento_concluido_em", "impressao_enviada_em", "fornecedor_impressao",
      "impressao_recebida_em", "etiqueta_criada_em", "postado_em", "codigo_rastreio",
      "entregue_em", "observacoes", "fotos_quantidade",
    ];
    setForm(Object.fromEntries(editable.map((field) => {
      const value = String(result.order[field] ?? "");
      return [field, field.endsWith("_em") ? value.slice(0, 10) : value];
    })));
    setSavedForm(Object.fromEntries(editable.map((field) => {
      const value = String(result.order[field] ?? "");
      return [field, field.endsWith("_em") ? value.slice(0, 10) : value];
    })));
  };

  const saveTreatmentAssignee = async (responsavelUsuarioId: string | null) => {
    if (!detail || currentUser.role !== "coordinator") return;
    setBusy(true);
    try {
      const result = await dataService.updateTreatmentAssignee({ id: detail.order.id, revisao: detail.order.revisao, responsavelUsuarioId });
      if (!result.ok) { setNotice(result.message || "Não foi possível alterar o responsável."); return; }
      setDetail(result);
      setNotice("Responsável pelo tratamento atualizado.");
      await reload();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Não foi possível alterar o responsável."); }
    finally { setBusy(false); }
  };

  const restoreTreatmentAssignee = async () => {
    if (!detail || currentUser.role !== "coordinator") return;
    setBusy(true);
    try {
      const result = await dataService.restoreAutomaticTreatmentAssignee({ id: detail.order.id, revisao: detail.order.revisao });
      if (!result.ok) { setNotice(result.message || "Não foi possível restaurar a atribuição automática."); return; }
      setDetail(result);
      setNotice("Atribuição automática restaurada.");
      await reload();
    } catch (error) { setNotice(error instanceof Error ? error.message : "Não foi possível restaurar a atribuição automática."); }
    finally { setBusy(false); }
  };

  const openSolicitationSession = async (session: string) => {
    try {
      const result = await dataService.listOrders({ search: session, filter: "all" });
      const order = result.ok ? result.rows.find((row) => row.sessao.toUpperCase() === session.toUpperCase()) : undefined;
      if (order) await openOrder(order.id);
      else setNotice(`A sessão ${session} não foi encontrada.`);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Não foi possível abrir a ficha da sessão."); }
  };

  const saveOrder = async () => {
    if (!detail) return;
    setBusy(true);
    let result: OrderDetailResult;
    try { result = await dataService.updateOrder({ id: detail.order.id, revisao: detail.order.revisao, values: form }); }
    catch (error) { setNotice(error instanceof Error ? error.message : "Não foi possível salvar o pedido."); return; }
    finally { setBusy(false); }
    if (!result.ok) return setNotice(result.message || "Não foi possível salvar o pedido.");
    setDetail(result);
    setSavedForm({ ...form });
    setNotice(result.unchanged ? "Nenhuma alteração para salvar." : `Sessão ${result.order.sessao} atualizada.`);
    await reload();
  };

  const executeRecommended = (order: Order) => {
    if (window.gestaoConfig.dataTransport === "http") return openOrder(order.id);
    if (order.etapa === "tratamento_concluido") return advance(order);
    const action = order.etapa === "etiqueta_criada" ? "add_shipment"
      : order.etapa === "em_remessa" && order.acao_recomendada === "Postar remessa" ? "posted" : null;
    if (!action) return openOrder(order.id);
    const isShipment = action === "add_shipment";
    setConfirmation({
      title: isShipment ? "Incluir na remessa de sexta" : "Registrar postagem",
      message: isShipment
        ? `Confirma a inclusão da sessão ${order.sessao} na próxima remessa de sexta-feira?`
        : `Confirma que a sessão ${order.sessao} já foi postada nos Correios?`,
      note: isShipment
        ? "A inclusão apenas agrupa o pedido. A postagem continuará sendo registrada separadamente."
        : "A data de postagem será registrada na Gestão Logística.",
      confirmLabel: isShipment ? "Incluir na remessa" : "Registrar postagem",
      onConfirm: () => performBulkAction(action, [order.id]),
    });
  };

  const confirmCurrentAction = async () => {
    const action = confirmation?.onConfirm;
    setConfirmation(null);
    if (action) await action();
  };

  const rowActionLabel = (order: Order) => {
    if (window.gestaoConfig.dataTransport === "http") return "Abrir ficha";
    if (order.etapa === "tratamento_concluido") return "Registrar envio";
    if (order.etapa === "etiqueta_criada") return "Incluir na remessa";
    if (order.etapa === "em_remessa" && order.acao_recomendada === "Postar remessa") return "Registrar postagem";
    return "Abrir ficha";
  };

  const attach = async (type: string) => {
    if (!detail) return;
    const result = await dataService.addAttachment(detail.order.id, type);
    if (!result.ok && !result.canceled) return setNotice(result.message || "Não foi possível anexar o arquivo.");
    if (result.ok) await openOrder(detail.order.id);
  };

  const copySession = async (session: string) => {
    try {
      await navigator.clipboard.writeText(session);
      setNotice(`Sessão ${session} copiada.`);
    } catch {
      setNotice("Não foi possível copiar o código da sessão.");
    }
  };

  const sortedOrders = useMemo(() => {
    const rows = [...orders];
    if (sortMode === "deadline") return rows.sort((a, b) => String(a.prazo_tratamento_em || "9999").localeCompare(String(b.prazo_tratamento_em || "9999")));
    if (sortMode === "recent") return rows.sort((a, b) => String(b.ultima_movimentacao_em || "").localeCompare(String(a.ultima_movimentacao_em || "")));
    if (sortMode === "client") return rows.sort((a, b) => String(a.cliente_nome || "").localeCompare(String(b.cliente_nome || ""), "pt-BR"));
    if (sortMode === "session-desc") return sortOrdersBySession(rows, "descending");
    if (sortMode === "session-asc") return sortOrdersBySession(rows, "ascending");
    return rows;
  }, [orders, sortMode]);
  const totalPages = Math.max(1, Math.ceil(sortedOrders.length / pageSize));
  useEffect(() => { setPage(current => Math.min(current, totalPages)); }, [totalPages]);
  const visibleOrders = sortedOrders.slice((page - 1) * pageSize, page * pageSize);
  const visibleOrderIds = visibleOrders.map((order) => order.id);
  const allVisibleSelected = visibleOrderIds.length > 0 && visibleOrderIds.every((id) => selectedIds.includes(id));

  const toggleVisibleOrders = () => {
    if (allVisibleSelected) {
      setSelectedIds(selectedIds.filter((id) => !visibleOrderIds.includes(id)));
      return;
    }
    setSelectedIds(Array.from(new Set([...selectedIds, ...visibleOrderIds])));
  };

  const openFromCommand = async (order: Order) => {
    if (detail && formDirty) {
      setCommandOpen(false);
      setNotice("Salve ou descarte as alterações da ficha atual antes de abrir outro pedido.");
      return;
    }
    setCommandOpen(false);
    setCommandQuery("");
    await openOrder(order.id);
  };

  const applyCommandFilter = (nextFilter: string) => {
    setCommandOpen(false);
    setCommandQuery("");
    setSearch("");
    setWorkspacePage("orders");
    setFilter(nextFilter);
  };

  const workflowSteps = detail ? [
    { label: "Galeria", hint: "Publicada na EPICS", done: Boolean(form.galeria_publicada_em), date: formatWorkflowDate(form.galeria_publicada_em) },
    { label: "Seleção", hint: "Finalizada pela cliente", done: Boolean(form.selecao_finalizada_em), date: formatWorkflowDate(form.selecao_finalizada_em) },
    { label: "Tratamento", hint: "Fotos tratadas", done: Boolean(form.tratamento_concluido_em), date: formatWorkflowDate(form.tratamento_concluido_em) },
    { label: "Impressão", hint: "Recebida da Digital Fotos", done: Boolean(form.impressao_recebida_em), date: formatWorkflowDate(form.impressao_recebida_em) },
    { label: "Etiqueta", hint: "Etiqueta criada", done: Boolean(form.etiqueta_criada_em), date: formatWorkflowDate(form.etiqueta_criada_em) },
    { label: "Remessa", hint: "Incluída na sexta-feira", done: Boolean(detail.order.remessa_id), date: formatWorkflowDate(detail.order.remessa_data_planejada as string | null) },
    { label: "Correios", hint: "Entregue à cliente", done: Boolean(form.entregue_em), date: formatWorkflowDate(form.entregue_em) },
  ] : [];
  const workflowStageIndex: Record<string, number> = {
    sessao_criada: 0,
    galeria_publicada: 1,
    aguardando_selecao: 1,
    em_tratamento: 2,
    tratamento_concluido: 3,
    em_impressao: 3,
    impressoes_recebidas: 4,
    etiqueta_criada: 5,
    em_remessa: 6,
    postado: 6,
    entregue: -1,
  };
  const currentWorkflowIndex = detail ? (workflowStageIndex[detail.order.etapa] ?? workflowSteps.findIndex((step) => !step.done)) : -1;
  const suggestedSection = currentWorkflowIndex <= 1 ? "selection" : currentWorkflowIndex <= 3 ? "production" : "shipping";
  const jumpToOperation = () => {
    setDetailTab("operation");
    window.requestAnimationFrame(() => document.getElementById(`detail-${suggestedSection}`)?.scrollIntoView({ block: "start" }));
  };
  const navigateWorkspace = (page: "central" | "orders" | "myOrders" | "digital" | "solicitations" | "clients") => {
    if (detail && formDirty) {
      setConfirmation({ title: "Descartar alterações?", message: "A ficha possui alterações que ainda não foram salvas.", confirmLabel: "Descartar e continuar", tone: "warning", onConfirm: () => { setDetail(null); setWorkspacePage(page); } });
      return;
    }
    setDetail(null);
    setWorkspacePage(page);
  };

  return (
    <div className="app-shell" aria-busy={busy}>
      <nav className="app-navigation" aria-label="Navegação principal">
        <div className="shell-brand"><Layers3 size={25} /><div><strong>Gestão Logística</strong><small>Estúdio Manoel Guimarães</small></div></div>
        <span className="section-kicker">OPERAÇÃO</span>
        {([['central', 'Central', Activity], ['orders', 'Pedidos', PackageOpen], ['myOrders', 'Meus Pedidos', UserCheck], ['digital', 'Enviados Digital', Send], ['solicitations', 'Solicitações', ClipboardList]] as const).map(([key, label, Icon]) => <button key={key} className={workspacePage === key ? 'shell-active' : undefined} aria-current={workspacePage === key ? 'page' : undefined} onClick={() => { setCentralTask(null); if (key === "myOrders") { setSearch(""); setFilter("all"); setSearchScope("all"); } navigateWorkspace(key); }}><Icon size={18} />{label}</button>)}
        {window.gestaoConfig.dataTransport !== 'http' && <div className="shell-secondary"><span className="section-kicker">CONSULTAS</span><button className={workspacePage === "clients" ? "shell-active" : undefined} aria-current={workspacePage === "clients" ? "page" : undefined} onClick={() => navigateWorkspace("clients")}><Users size={18} />Clientes</button></div>}
        <div className="shell-preferences"><AppearanceSettings fontScale={fontScale} onPreview={onFontScalePreview} onApply={onFontScaleApply} /></div>
        <div className="shell-version">Gestão Logística · v{__APP_VERSION__}</div>
      </nav>
      <header className="shell-header">
        <Hint label="Buscar pedidos e acessar atalhos (Ctrl+K)"><button className="shell-search ui-button" onClick={() => setCommandOpen(true)}><Search size={16} />Buscar pedidos e atalhos <kbd>Ctrl K</kbd></button></Hint>
        <SolicitationNotifications onOpen={openNotifiedSolicitation} />
        <div className="shell-account"><span className="shell-connection">{window.gestaoConfig.dataTransport === 'http' ? 'Acesso remoto' : 'Acesso local'}</span><div><strong>{currentUser.nome}</strong><small>{currentUser.role === 'employee' ? 'Funcionário' : 'Coordenador'}</small></div>{onLogout && <button className="ui-button" onClick={() => { if (detail && formDirty) setConfirmation({ title: "Sair sem salvar?", message: "A ficha possui alterações que ainda não foram salvas.", confirmLabel: "Descartar e sair", tone: "warning", onConfirm: () => onLogout() }); else onLogout(); }}>Sair</button>}</div>
        {window.gestaoConfig.dataTransport !== 'http' && <IntegrationMenu busy={busy} lastSync={lastSiwinSync} onThunderbird={() => void syncThunderbird()} onSiwin={() => void syncSiwin()} onImport={() => void openImport()} />}
      </header>

      <main>
        {notice && <div className="notice" role="status">{notice}<button aria-label="Fechar aviso" onClick={() => setNotice("")}><X size={15} /></button></div>}
        {workspacePage === "central" ? <Central queue={centralQueue} onQueue={setCentralQueue} currentUser={currentUser} onOrder={(id) => void openOrder(id)} onOrders={(value) => { setSearch(""); setFilter(value); setWorkspacePage("orders"); }} onSolicitations={(item) => { setCentralTask(item || null); setWorkspacePage("solicitations"); }} /> : workspacePage === "digital" ? <DigitalShipmentsPage currentUser={currentUser} onOpenOrder={(id) => setOrderPreviewId(id)} /> : workspacePage === "solicitations" ? <SolicitationsPage
          currentUser={currentUser}
          onNotice={setNotice}
          onOpenOrder={(session) => void openSolicitationSession(session)}
          initialSelection={centralTask}
        /> : workspacePage === "clients" ? <section className="clients-screen">
          <div className="central-heading"><div><span className="section-kicker">CONSULTAS</span><h1>Clientes</h1><p>Cadastros sincronizados com sessões locais.</p></div></div>
          <div className="clients-panel">
            <div className="clients-toolbar"><label className="orders-search"><Search size={17} /><input value={clientSearch} onChange={(event) => setClientSearch(event.target.value)} placeholder="Nome, telefone, e-mail ou código CAD" aria-label="Buscar clientes" /></label><span>Até 200 resultados por consulta</span></div>
            {clientsError ? <ViewState kind="error" title={clientsError} onRetry={() => setClientsRefresh((value) => value + 1)} /> : <div className="clients-table-wrap">
              <table className="clients-table"><caption className="sr-only">Clientes sincronizados</caption><thead><tr><th scope="col">CAD</th><th scope="col">Cliente</th><th scope="col">Contato</th><th scope="col">Cidade</th><th scope="col">Pedidos locais</th></tr></thead><tbody>
                {!clientsLoading && clients.map((client) => <tr key={client.id}><td>{client.siwin_cad || "—"}</td><td><strong>{client.nome || "Sem nome"}</strong><small>{client.email || "Sem e-mail"}</small></td><td>{client.celular || client.telefone || "—"}</td><td>{[client.cidade, client.uf].filter(Boolean).join("/") || "—"}</td><td>{client.pedidos_quantidade}</td></tr>)}
              </tbody></table>
              {clientsLoading && <div className="clients-state"><span className="ui-spinner" /><strong>Carregando clientes…</strong></div>}
              {!clientsLoading && !clients.length && <ViewState kind="empty" title={clientSearch ? "Nenhum cliente encontrado" : "Nenhum cliente sincronizado"} description={clientSearch ? "Revise o termo da busca." : "Os cadastros aparecem após a sincronização local."} />}
            </div>}
          </div>
        </section> : <>
        <section className="orders-screen">
          <div className="central-heading"><div><span className="section-kicker">OPERAÇÃO</span><h1>{workspacePage === "myOrders" ? "Meus Pedidos" : "Pedidos"}</h1><p>{workspacePage === "myOrders" ? "Pedidos atribuídos a você para tratamento." : "Sessões, próximas ações e prazos da equipe."}</p></div><button className="ui-button" onClick={() => void reload()} disabled={initialLoading}>Atualizar</button></div>
          <section className="orders-panel">
            {workspacePage !== "myOrders" && <div className="ui-tabs orders-queues" aria-label="Filas de pedidos">
              {[["needs_me", "Ação da equipe"], ["waiting", "Aguardando terceiros"], ["alerts", "Alertas"], ["all", "Todos os pedidos"]].map(([key, label]) => <button key={key} aria-pressed={filter === key} onClick={() => { setFilter(key); setSearchScope("queue"); }}>{label}</button>)}
            </div>}
            <div className="orders-toolbar">
              <label className="orders-search"><Search size={17} /><input ref={searchInputRef} value={search} onChange={event => setSearch(event.target.value)} placeholder="Sessão, cliente, telefone, CAD ou rastreio" aria-label="Buscar pedidos" /><kbd>/</kbd></label>
              <label className="orders-control">Buscar em<select value={searchScope} onChange={event => setSearchScope(event.target.value as "queue" | "all")}><option value="queue">Fila selecionada</option><option value="all">Todos os pedidos</option></select></label>
              <label className="orders-control">Ordenar por<select value={sortMode} onChange={event => setSortMode(event.target.value)}><option value="priority">Prioridade da fila</option><option value="deadline">Prazo mais próximo</option><option value="recent">Movimentação recente</option><option value="client">Nome do cliente</option><option value="session-desc">Sessão: maior para menor</option><option value="session-asc">Sessão: menor para maior</option></select></label>
              {window.gestaoConfig.dataTransport !== "http" && <button className="ui-button" onClick={() => { setBulkMode(!bulkMode); setSelectedIds([]); }}>{bulkMode ? "Cancelar seleção" : "Selecionar vários"}</button>}
            </div>
            <div className="orders-context"><span>{workspacePage === "myOrders" ? "Atribuídos a você" : search.trim() && searchScope === "all" ? "Busca em todos os pedidos" : filterLabels[filter] || "Todos os pedidos"} · {initialLoading ? "Carregando…" : listError ? "Consulta indisponível" : orders.length + " pedidos"}</span>{search && <button className="orders-clear" onClick={() => setSearch("")}>Limpar busca</button>}{workspacePage !== "myOrders" && !["needs_me", "waiting", "alerts", "all"].includes(filter) && <button className="orders-clear" onClick={() => setFilter("all")}>Remover filtro</button>}</div>
            {bulkMode && <div className="bulk-bar">
              <button className="bulk-select-all" onClick={toggleVisibleOrders}>{allVisibleSelected ? "Desmarcar página" : `Selecionar página (${visibleOrderIds.length})`}</button>
              <strong>{selectedIds.length} selecionado(s)</strong>
              <button onClick={() => runBulkAction("printing_sent")} disabled={busy || !selectedIds.length}>Registrar envio à Digital Fotos</button>
              <button onClick={() => runBulkAction("prints_received")} disabled={busy || !selectedIds.length}>Registrar impressões recebidas</button>
              <button onClick={() => runBulkAction("add_shipment")} disabled={busy || !selectedIds.length}>Incluir na remessa de sexta</button>
              <button onClick={() => runBulkAction("posted")} disabled={busy || !selectedIds.length}>Registrar postagem</button>
              <button onClick={() => runBulkAction("archive")} disabled={busy || !selectedIds.length}>Arquivar</button>
              <button onClick={() => runBulkAction("conclude_previous")} disabled={busy || !selectedIds.length}>Concluído anteriormente</button>
              <button onClick={() => runBulkAction("activate")} disabled={busy || !selectedIds.length}>Reativar</button>
            </div>}
            {listError ? <ViewState kind="error" title={listError} onRetry={() => void reload()} /> : <div className="table-wrap orders-table-wrap">
              <table className="orders-table">
                <caption className="sr-only">{workspacePage === "myOrders" ? "Pedidos atribuídos a você. Clique na sessão para consultar a prévia." : "Pedidos da fila selecionada. Clique na sessão para consultar a prévia."}</caption>
                <thead><tr>{bulkMode && <th scope="col">Selecionar</th>}<th scope="col">Sessão / cliente</th><th scope="col">Próxima ação / etapa</th><th scope="col">Prazo de tratamento</th><th scope="col">Depende de</th><th scope="col">Fotos</th><th scope="col">Ações</th></tr></thead>
                <tbody>
                  {initialLoading && <TableSkeleton rows={7} columns={bulkMode ? 7 : 6} />}
                  {!initialLoading && visibleOrders.map(order => <tr key={order.id} className={orderPreviewId === order.id ? "order-selected" : ""}>
                    {bulkMode && <td><input type="checkbox" aria-label={"Selecionar sessão " + order.sessao} checked={selectedIds.includes(order.id)} onChange={event => setSelectedIds(event.target.checked ? [...selectedIds, order.id] : selectedIds.filter(id => id !== order.id))} /></td>}
                    <td><button className="session-link" onClick={() => setOrderPreviewId(order.id)} aria-label={"Consultar sessão " + order.sessao}>{order.sessao}</button><div className="order-client-line"><span className="order-secondary">{order.cliente_nome || "Cliente não identificado"}</span><Hint label="Dados do cliente"><button type="button" className="client-profile-trigger" data-order-profile-trigger={order.id} disabled={!order.cliente_id} title={order.cliente_id ? "Dados do cliente" : "Cliente não vinculado"} aria-label={order.cliente_id ? `Ver dados cadastrais de ${order.cliente_nome || "cliente"}` : "Cliente não vinculado"} aria-expanded={clientProfileTarget?.orderId === order.id} aria-controls={clientProfileTarget?.orderId === order.id ? `client-profile-${order.id.replace(/[^a-zA-Z0-9_-]/g, "")}` : undefined} onClick={(event) => toggleClientProfile(order, event.currentTarget)}><Contact size={15} /></button></Hint></div></td>
                    <td><strong className="order-next">{order.acao_recomendada}</strong><span className="order-secondary">{stageLabels[order.etapa] || order.etapa}</span></td>
                    <td><strong className="order-date">{formatDate(order.prazo_tratamento_em)}</strong>{order.urgencia_texto && <span className="order-warning">{order.urgencia_texto}</span>}</td>
                    <td>{order.responsavel_atual === "Você" ? "Equipe" : order.responsavel_atual}</td>
                    <td>{order.fotos_quantidade ?? "—"}</td>
                    <td><div className="orders-actions"><button className="ui-button" onClick={() => setOrderPreviewId(order.id)}>Consultar</button><OrderActionsMenu session={order.sessao} actionLabel={rowActionLabel(order)} disabled={busy} onOpen={() => void openOrder(order.id)} onExecute={() => void executeRecommended(order)} onCopy={() => void copySession(order.sessao)} /></div></td>
                  </tr>)}
                </tbody>
              </table>
              {!initialLoading && !orders.length && <ViewState kind="empty" title={workspacePage === "myOrders" ? "Nenhum pedido atribuído a você no momento." : search ? "Nenhum pedido encontrado" : "Nenhuma pendência nesta fila"} description={workspacePage === "myOrders" ? "Quando houver pedidos ativos atribuídos a você, eles aparecerão aqui." : search ? "Revise o termo ou escolha buscar em todos os pedidos." : "Selecione outra fila para continuar."} />}
            </div>}
            {!initialLoading && !listError && orders.length > 0 && <Pagination page={page} totalPages={totalPages} totalItems={orders.length} pageSize={pageSize} onChange={setPage} />}
          </section>
        </section>
        </>}
      </main>

      {orderPreviewId && <OrderPreview orderId={orderPreviewId} onClose={() => setOrderPreviewId(null)} onOpenFull={id => { setOrderPreviewId(null); void openOrder(id); }} />}
      <OrderClientProfilePopover target={clientProfileTarget} cacheVersion={clientProfileCacheVersion} onClose={closeClientProfile} />

      {preview && (
        <div className="modal-backdrop">
          <section className="modal" role="dialog" aria-modal="true" aria-label="Prévia da importação da planilha">
            <div className="modal-head"><div><span className="eyebrow">PRÉVIA SEGURA</span><h2>Importação da planilha</h2></div><button className="icon-button" onClick={() => setPreview(null)}><X /></button></div>
            <p>Nenhum dado foi gravado. Sessões duplicadas ficam bloqueadas para revisão manual.</p>
            <div className="preview-grid">
              <div><strong>{preview.total}</strong><span>Linhas reconhecidas</span></div>
              <div className="good"><strong>{preview.eligible}</strong><span>Seguras para importar</span></div>
              <div className="bad"><strong>{preview.blocked}</strong><span>Duplicadas/bloqueadas</span></div>
              <div><strong>{preview.missingClient}</strong><span>Sem identificação do cliente</span></div>
              <div><strong>{preview.trackingWithoutDate}</strong><span>Rastreios sem postagem</span></div>
            </div>
            <div className="sample-list">
              {preview.rows.filter((row) => row.warnings.length).slice(0, 12).map((row) => (
                <div key={`${row.linha}-${row.sessao}`}><span>{row.sessao}</span><small>Linha {row.linha}: {row.warnings.join(", ")}</small></div>
              ))}
            </div>
            <footer><button className="secondary" onClick={() => setPreview(null)}>Cancelar</button><button className="primary" onClick={confirmImport} disabled={busy}><Check size={18} /> Importar somente as {preview.eligible} seguras</button></footer>
          </section>
        </div>
      )}

      {detail && (
        <div className="detail-backdrop">
          <section className="detail-modal" data-tab={detailTab} role="region" aria-label={`Ficha do pedido ${detail.order.sessao}`}>
            <div className="modal-head detail-head">
              <div className="detail-identity"><span className="session-badge">{detail.order.sessao}</span><div><span className="eyebrow">FICHA DO PEDIDO</span><h2>{detail.order.cliente_nome || "Cliente não identificado"}</h2><p>Informações logísticas, produção e entrega em um só lugar.</p></div></div>
              <button className="ui-button" aria-label="Fechar ficha" onClick={closeOrder}>← Voltar à lista</button>
            </div>
            <div className="detail-summary">
              <div className="summary-status"><span className={`stage stage-${detail.order.etapa}`}>{stageLabels[detail.order.etapa] || detail.order.etapa}</span></div>
              <div className="summary-item"><Database size={15} /><span><small>Cadastro SIWIN</small><strong>CAD {detail.order.cliente_siwin_cad || "—"}</strong></span></div>
              <div className="summary-item"><Users size={15} /><span><small>Contato</small><strong>{detail.order.cliente_celular || detail.order.cliente_telefone || "Sem telefone"}</strong></span></div>
              <div className="summary-item"><PackageOpen size={15} /><span><small>Localidade</small><strong>{[detail.order.cliente_cidade, detail.order.cliente_uf].filter(Boolean).join("/") || "Sem cidade"}</strong></span></div>
              <div className="summary-item"><ImageIcon size={15} /><span><small>Fotos cobradas</small><strong>{form.fotos_quantidade === "" ? "Não informado" : `${form.fotos_quantidade} fotos`}</strong></span></div>
            </div>
            <section className="workflow-block" aria-label="Andamento do pedido">
              <div className="workflow-heading"><strong>Andamento do pedido</strong><span>A etapa destacada é a próxima que falta registrar</span></div>
              <div className="workflow-rail">
                {workflowSteps.map((step, index) => {
                  const state = step.done ? "done" : index === currentWorkflowIndex ? "current" : "pending";
                  return <div className={`workflow-step ${state}`} key={step.label} aria-current={state === "current" ? "step" : undefined}>
                    <span className="workflow-dot">{step.done ? <Check size={13} /> : index + 1}</span>
                    <span className="workflow-copy"><strong>{step.label}</strong><small>{step.hint}</small>{step.date && <time className="workflow-date">{step.date}</time>}</span>
                  </div>;
                })}
              </div>
            </section>
            <nav className="detail-nav" aria-label="Seções do pedido">
              <button className={detailTab === "summary" ? "active" : ""} aria-current={detailTab === "summary" ? "page" : undefined} onClick={() => setDetailTab("summary")}><strong>Resumo</strong><small>Cliente e produtos</small></button>
              <button className={detailTab === "operation" ? "active" : ""} aria-current={detailTab === "operation" ? "page" : undefined} onClick={() => setDetailTab("operation")}><strong>Operação</strong><small>Seleção, produção e envio</small></button>
              <button className={detailTab === "history" ? "active" : ""} aria-current={detailTab === "history" ? "page" : undefined} onClick={() => setDetailTab("history")}><strong>Histórico</strong><small>Anexos e eventos</small></button>
            </nav>

            <section className="next-action-card detail-pane pane-summary" aria-label="Próxima ação recomendada">
              <div><span className="section-kicker">PRÓXIMA AÇÃO</span><strong>{detail.order.acao_recomendada || "Consultar próxima ação"}</strong><p>Etapa atual: {stageLabels[detail.order.etapa] || detail.order.etapa}. Confira os dados antes de registrar alterações.</p></div>
              <button className="ui-button ui-button-primary" onClick={jumpToOperation}>Ir para operação<ChevronRight size={16} /></button>
            </section>

            <section className="purchased-section detail-pane pane-summary">
              <div className="section-title">
                <div><h3>Produtos e serviços do pedido</h3><p>Lista completa do SIWIN, incluindo itens cobrados e não cobrados. Somente os cobrados entram na soma de fotos.</p></div>
                <div className="product-totals">
                  <strong>{form.fotos_quantidade || 0} fotos cobradas</strong>
                  <span>{detail.items.filter((item) => item.cobrado).length} cobrados</span>
                  <span>{detail.items.filter((item) => !item.cobrado).length} não cobrados</span>
                </div>
              </div>
              {detail.items.length ? <div className="products-table-wrap"><table className="products-table">
                <thead><tr><th>Produto / serviço</th><th>Qtd.</th><th>Fotos</th><th>Valor unitário</th><th>Valor total</th><th>Cobrança</th><th>Detalhes</th></tr></thead>
                <tbody>{detail.items.map((item) => <tr key={item.id} className={item.cobrado ? "charged" : "free-item"}>
                  <td><strong>{item.produto}</strong><small>{item.situacao}</small></td>
                  <td>{item.quantidade}</td><td>{item.fotos}</td><td>{formatCurrency(item.valor_unitario)}</td><td>{formatCurrency(item.valor_total)}</td>
                  <td><span className={`billing ${item.cobrado ? "paid" : "free"}`}>{item.cobrado ? "Cobrado" : "Não cobrado"}</span></td>
                  <td>{[item.tipo_foto, item.ampliacao].filter(Boolean).join(" · ") || "—"}</td>
                </tr>)}</tbody>
              </table></div> : <p className="no-products">Nenhum produto sincronizado para este pedido.</p>}
            </section>

            <DigitalOrderHistory orderId={detail.order.id} />

            <section className="siwin-observations-section detail-pane pane-summary">
              <div className="section-title">
                <div><h3>Observações do pedido no SIWIN</h3><p>Informações registradas pelo financeiro e por outros setores. Este histórico é somente para consulta.</p></div>
                <strong>{detail.siwinObservations?.length || 0} registro(s)</strong>
              </div>
              {detail.siwinObservations?.length ? <div className="siwin-observation-list">
                {detail.siwinObservations.map((item) => <article key={item.id}>
                  <header><strong>{item.usuario || "Usuário não informado"}</strong><time>{item.cadastrado_em ? new Date(item.cadastrado_em).toLocaleString("pt-BR") : "Data não informada"}</time></header>
                  <p>{item.observacao}</p>
                </article>)}
              </div> : <p className="no-products">Nenhuma observação registrada no SIWIN para este pedido.</p>}
            </section>

            <section className="selection-email-section detail-pane pane-selection" id="detail-selection">
              <div className="section-title">
                <div><h3>Seleções recebidas pelo Thunderbird</h3><p>E-mails da EPICS vinculados automaticamente a esta sessão.</p></div>
                <strong>{detail.selectionEmails?.length || 0} e-mail(s)</strong>
              </div>
              {detail.selectionEmails?.length ? <div className="selection-email-list">
                {detail.selectionEmails.map((email, index) => <article key={email.id}>
                  <header>
                    <div><strong>{index === 0 ? "Seleção mais recente" : "Finalização anterior"}</strong><span>{email.quantidade_selecionada ?? email.codigos.length} foto(s) selecionada(s)</span></div>
                    <time>{new Date(email.recebido_em).toLocaleString("pt-BR")}</time>
                  </header>
                  <textarea readOnly rows={3} value={email.codigos.join(", ")} aria-label={`Códigos da seleção ${email.sessao}`} />
                  {window.gestaoConfig.dataTransport !== "http" && <div className="selection-actions">
                    <button className="attachment-button" onClick={() => prepareSelection(email.id)} disabled={busy}><Send size={15} /> Preparar no GerenciadorFotos</button>
                    <button className={`attachment-button ${email.conferida_em ? "done" : ""}`} onClick={() => markSelection(email.id, "conferida_em")} disabled={busy}><Check size={15} /> {email.conferida_em ? "Seleção conferida" : "Marcar conferida"}</button>
                    <button className={`attachment-button ${email.fotos_separadas_em ? "done" : ""}`} onClick={() => markSelection(email.id, "fotos_separadas_em")} disabled={busy}><PackageCheck size={15} /> {email.fotos_separadas_em ? "Fotos separadas" : "Marcar fotos separadas"}</button>
                  </div>}
                </article>)}
              </div> : <p className="no-products">Nenhum e-mail de seleção vinculado a este pedido.</p>}
            </section>

            <div className="detail-grid">
              <section className="form-section span-2 detail-pane pane-selection">
                <h3>Galeria e envio ao cliente</h3>
                <div className="field-grid three">
                  <label className="span-2">URL da galeria<div className="input-action"><input value={form.galeria_url || ""} onChange={(event) => setForm({ ...form, galeria_url: event.target.value })} placeholder="https://..." />{form.galeria_url && window.gestaoConfig.dataTransport !== "http" && <button onClick={() => dataService.openExternal(form.galeria_url)} title="Abrir link"><ExternalLink size={17} /></button>}</div></label>
                  <label>Galeria publicada em<input type="date" value={form.galeria_publicada_em || ""} onChange={(event) => setForm({ ...form, galeria_publicada_em: event.target.value })} /></label>
                  <label>Link enviado à cliente em<input type="date" value={form.link_enviado_em || ""} onChange={(event) => setForm({ ...form, link_enviado_em: event.target.value })} /></label>
                  {window.gestaoConfig.dataTransport !== "http" && <button className="attachment-button" onClick={() => attach("comprovante_whatsapp")}><Paperclip size={16} /> Anexar comprovante do WhatsApp</button>}
                </div>
              </section>

              <section className="form-section detail-pane pane-selection">
                <h3>Seleção finalizada</h3>
                <label>Seleção finalizada em<input type="date" value={form.selecao_finalizada_em || ""} onChange={(event) => setForm({ ...form, selecao_finalizada_em: event.target.value })} /></label>
                <div className="calculated-dates"><span>Tratamento: {formatDate(detail.order.prazo_tratamento_em)}</span><span>Máximo: {formatDate(detail.order.prazo_maximo_em)}</span></div>
                {window.gestaoConfig.dataTransport !== "http" && <button className="attachment-button" onClick={() => attach("arquivo_selecao")}><Paperclip size={16} /> Anexar arquivo da seleção</button>}
              </section>

              <section className="form-section detail-pane pane-production" id="detail-production">
                <h3>Tratamento</h3>
                <div className="treatment-owner">
                  <strong>Responsável pelo tratamento</strong>
                  {currentUser.role === "coordinator" ? <label className="treatment-owner-control"><span className="sr-only">Responsável pelo tratamento</span><select aria-label="Responsável pelo tratamento" value={detail.order.tratamento_responsavel_usuario_id || ""} disabled={busy} onChange={(event) => void saveTreatmentAssignee(event.target.value || null)}><option value="">Não atribuído</option>{treatmentAssignees.map(user => <option key={user.id} value={user.id}>{user.nome}</option>)}</select></label> : <span>{detail.order.tratamento_responsavel_nome || "Não atribuído"}</span>}
                  <small>{detail.order.tratamento_atribuicao_modo === "manual" ? "Atribuição manual" : "Atribuição automática"}</small>
                  {currentUser.role === "coordinator" && detail.order.tratamento_atribuicao_modo === "manual" && <button type="button" className="attachment-button" disabled={busy} onClick={() => void restoreTreatmentAssignee()}>Usar atribuição automática</button>}
                </div>
                <label>Tratamento concluído em<input type="date" value={form.tratamento_concluido_em || ""} onChange={(event) => setForm({ ...form, tratamento_concluido_em: event.target.value })} /></label>
                <div className="calculated-dates"><span>Prazo interno: {formatDate(detail.order.prazo_tratamento_em)}</span><span>Prazo máximo: {formatDate(detail.order.prazo_maximo_em)}</span></div>
              </section>

              <section className="form-section detail-pane pane-production">
                <h3>Impressão · Digital Fotos</h3>
                <label>Fotos enviadas à Digital Fotos em<input type="date" value={form.impressao_enviada_em || ""} onChange={(event) => setForm({ ...form, impressao_enviada_em: event.target.value })} /></label>
                <label>Laboratório / fornecedor<input value={form.fornecedor_impressao || ""} onChange={(event) => setForm({ ...form, fornecedor_impressao: event.target.value })} /></label>
                <label>Impressões recebidas em<input type="date" value={form.impressao_recebida_em || ""} onChange={(event) => setForm({ ...form, impressao_recebida_em: event.target.value })} /></label>
              </section>

              <section className="form-section detail-pane pane-shipping" id="detail-shipping">
                <h3>Etiqueta e entrega</h3>
                <label>Etiqueta dos Correios criada em<input type="date" value={form.etiqueta_criada_em || ""} onChange={(event) => setForm({ ...form, etiqueta_criada_em: event.target.value })} /></label>
                <label>Código de rastreio<input value={form.codigo_rastreio || ""} onChange={(event) => setForm({ ...form, codigo_rastreio: event.target.value.toUpperCase() })} /></label>
                <div className="field-grid two"><label>Postado nos Correios em<input type="date" value={form.postado_em || ""} onChange={(event) => setForm({ ...form, postado_em: event.target.value })} /></label><label>Entregue à cliente em<input type="date" value={form.entregue_em || ""} onChange={(event) => setForm({ ...form, entregue_em: event.target.value })} /></label></div>
                {window.gestaoConfig.dataTransport !== "http" && <button className="attachment-button" onClick={() => attach("etiqueta_correios")}><Paperclip size={16} /> Anexar etiqueta dos Correios</button>}
              </section>

              <section className="form-section detail-pane pane-summary">
                <h3>Dados e observações</h3>
                <label>Quantidade de fotos cobradas<input type="number" min="0" value={form.fotos_quantidade || ""} onChange={(event) => setForm({ ...form, fotos_quantidade: event.target.value })} /></label>
                <label>Observações<textarea value={form.observacoes || ""} onChange={(event) => setForm({ ...form, observacoes: event.target.value })} rows={4} /></label>
                <p className="address">{[detail.order.cliente_logradouro, detail.order.cliente_numero, detail.order.cliente_complemento, detail.order.cliente_bairro, detail.order.cliente_cidade, detail.order.cliente_uf, detail.order.cliente_cep].filter(Boolean).join(", ") || "Endereço não informado"}</p>
              </section>
            </div>

            <div className="detail-bottom detail-pane pane-history">
              <section><h3>Anexos</h3>{detail.attachments.length ? detail.attachments.map((item) => <button className="file-row" key={item.id} onClick={() => dataService.openAttachment(item.id)}><Paperclip size={14} /><span>{item.nome_arquivo}</span><small>{item.tipo}</small></button>) : <p>Nenhum arquivo anexado.</p>}</section>
              <section><h3>Histórico</h3><div className="event-list">{detail.events.length ? detail.events.map((item) => <div key={item.id}><span>{item.descricao}</span><small>{new Date(item.criado_em).toLocaleString("pt-BR")}{item.usuario_nome ? ` · ${item.usuario_nome}` : ""}</small></div>) : <p>Nenhum evento registrado.</p>}</div></section>
            </div>
            <footer><span className={`save-state ${formDirty ? "dirty" : ""}`}>{formDirty ? "Alterações não salvas" : "Dados salvos"}</span><button className="ui-button" onClick={closeOrder}>Voltar</button><button className="ui-button ui-button-primary" onClick={saveOrder} disabled={busy || !formDirty}><Save size={17} /> Salvar alterações</button></footer>
          </section>
        </div>
      )}

      <CommandPalette
        open={commandOpen}
        query={commandQuery}
        results={commandResults}
        onQueryChange={setCommandQuery}
        onClose={() => { setCommandOpen(false); setCommandQuery(""); }}
        onOpenOrder={(order) => void openFromCommand(order)}
        onFilter={applyCommandFilter}
        onClients={window.gestaoConfig.dataTransport === "http" ? undefined : () => { setCommandOpen(false); setCommandQuery(""); navigateWorkspace("clients"); }}
      />

      {confirmation && (
        <div className="modal-backdrop confirmation-backdrop">
          <section className={`confirmation-modal ${confirmation.tone === "warning" ? "warning" : ""}`} role="dialog" aria-modal="true" aria-labelledby="confirmation-title">
            <div className="confirmation-icon">{confirmation.tone === "warning" ? <AlertTriangle size={23} /> : <Check size={23} />}</div>
            <div className="confirmation-copy">
              <span className="eyebrow">CONFIRMAÇÃO DE REGISTRO</span>
              <h2 id="confirmation-title">{confirmation.title}</h2>
              <p>{confirmation.message}</p>
              {confirmation.note && <div className="confirmation-note"><AlertTriangle size={16} /><span>{confirmation.note}</span></div>}
            </div>
            <footer>
              <button className="secondary" onClick={() => setConfirmation(null)} disabled={busy}>Cancelar</button>
              <button className="primary" onClick={() => void confirmCurrentAction()} disabled={busy}><Check size={17} /> {confirmation.confirmLabel}</button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
