import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Clock3, X } from "lucide-react";
import { dataService } from "../services/dataService";

const labels: Record<SolicitationNotificationType, string> = {
  ASSIGNED: "Nova solicitação atribuída",
  DUE_TOMORROW: "Solicitação para amanhã",
  DUE_TODAY: "Solicitação para hoje",
  DUE_IN_ONE_HOUR: "Prazo em 1 hora",
  DUE_IN_15_MINUTES: "Prazo próximo",
  DUE_NOW: "Prazo agora",
  OVERDUE: "Solicitação atrasada",
};
const snoozeOptions = (item: SolicitationNotification) => {
  const options = item.tipo === "DUE_IN_ONE_HOUR" ? [15, 30]
    : item.tipo === "DUE_IN_15_MINUTES" ? [5, 10, 15]
      : ["DUE_NOW", "OVERDUE"].includes(item.tipo) ? [15, 30, 60]
        : item.tipo === "DUE_TODAY" ? [30, 60] : [];
  if (!["DUE_IN_ONE_HOUR", "DUE_IN_15_MINUTES"].includes(item.tipo) || !item.prazo_em) return options;
  const remaining = Date.parse(item.prazo_em) - Date.now();
  const minimumUsefulDelay = item.tipo === "DUE_IN_ONE_HOUR" ? 15 : 5;
  const latestUsefulDelay = Math.max(minimumUsefulDelay, Math.ceil(remaining / 60000));
  return options.filter((minutes) => minutes <= latestUsefulDelay);
};

export function SolicitationNotifications({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<SolicitationNotification[]>([]);
  const [toast, setToast] = useState<SolicitationNotification | null>(null);
  const [expanded, setExpanded] = useState(false);
  const polling = useRef(false);
  const rowsRef = useRef(rows);
  const presenting = useRef(new Set<string>());
  rowsRef.current = rows;

  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const result = await dataService.pollSolicitationNotifications();
      if (!result.ok) return;
      setRows(result.rows);
      const delivered = new Set(result.delivered || []);
      const fresh = result.rows.filter((row) => delivered.has(row.id) && !presenting.current.has(row.id));
      if (!fresh.length) return;
      fresh.forEach((row) => presenting.current.add(row.id));
      await window.gestaoAPI.presentSolicitationNotifications(fresh);
    } catch { /* Notifications must never block the application. */ }
    finally { presenting.current.clear(); polling.current = false; }
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => void poll(), 10000);
    const onFocus = () => void poll();
    const onSolicitationChanged = () => void poll();
    window.addEventListener("focus", onFocus);
    window.addEventListener("gestao:solicitation-changed", onSolicitationChanged);
    const unsubscribe = window.gestaoAPI.onNativeSolicitationOpen((id) => onOpen(id));
    const unsubscribeFallback = window.gestaoAPI.onNativeSolicitationFallback((input) => {
      const fallback = rowsRef.current.find((row) => row.solicitacao_id === input.solicitationId && row.tipo === input.type);
      if (fallback) setToast(fallback);
    });
    const unsubscribePresented = window.gestaoAPI.onSolicitationPopupPresented((ids) => {
      void Promise.all(ids.map((id) => dataService.updateSolicitationNotification({ id, action: "presented" })))
        .then(() => dataService.listSolicitationNotifications())
        .then((result) => { if (result.ok) setRows(result.rows); })
        .catch(() => {});
    });
    const unsubscribePopupAction = window.gestaoAPI.onSolicitationPopupAction((input) => {
      const item = rowsRef.current.find((row) => row.id === input.id);
      if (item) void update(item, input.action, input.minutes);
    });
    const unsubscribeCenter = window.gestaoAPI.onOpenNotificationCenter(() => { setExpanded(true); void poll(); });
    void poll();
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("gestao:solicitation-changed", onSolicitationChanged);
      unsubscribe(); unsubscribeFallback(); unsubscribePresented(); unsubscribePopupAction(); unsubscribeCenter();
    };
  }, [poll, onOpen]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast((current) => current?.id === toast.id ? null : current), 12000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const update = async (item: SolicitationNotification, action: "seen" | "open" | "resolve" | "snooze", minutes?: number) => {
    try {
      const result = await dataService.updateSolicitationNotification({ id: item.id, action, minutes });
      if (!result.ok) return;
      if (action === "open") onOpen(item.solicitacao_id);
      setToast(null);
      const refreshed = await dataService.listSolicitationNotifications();
      if (refreshed.ok) setRows(refreshed.rows);
    } catch { /* The next poll refreshes state. */ }
  };
  const renderItem = (item: SolicitationNotification, compact = false) => <article className={`request-notice request-notice-${item.tipo.toLowerCase()}`} key={item.id}>
    <div className="request-notice-title"><Clock3 size={18} aria-hidden="true" /><strong>{labels[item.tipo]}</strong>{compact && <button type="button" aria-label="Fechar aviso" onClick={() => setToast(null)}><X size={18} /></button>}</div>
    <span className="request-notice-description">{compact
      ? item.sessao_codigo ? `Sessão ${item.sessao_codigo}` : item.prazo_em ? `Prazo ${new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(new Date(item.prazo_em))}` : "Uma solicitação precisa da sua atenção."
      : `${item.sessao_codigo ? `Sessão ${item.sessao_codigo} · ` : ""}${item.descricao}`}</span>
    <div className="request-notice-actions">
      <button type="button" onClick={() => void update(item, "open")}>Abrir solicitação</button>
      {snoozeOptions(item).length > 0 && <details className="request-notice-snooze-control"><summary>Lembrar depois</summary><div className="request-notice-snooze" aria-label="Lembrar depois">
        {snoozeOptions(item).map((minutes) => <button type="button" key={minutes} onClick={() => void update(item, "snooze", minutes)}>{minutes === 60 ? "1 hora" : `${minutes} min`}</button>)}
      </div></details>}
      {!compact && <button type="button" onClick={() => void update(item, "resolve")}>Dispensar</button>}
    </div>
  </article>;

  return <div className="request-notifications">
    <button type="button" className="request-bell ui-button" aria-label={`Notificações: ${rows.filter((item) => !item.visualizado_em && !item.adiado_ate).length} não vistas`} aria-expanded={expanded} onClick={() => { setExpanded((value) => !value); void poll(); }}>
      <Bell size={18} />{rows.some((item) => !item.visualizado_em && !item.adiado_ate) && <span>{rows.filter((item) => !item.visualizado_em && !item.adiado_ate).length}</span>}
    </button>
    {expanded && <section className="request-notification-center" aria-label="Central de notificações">
      <div className="request-notification-heading"><strong>Notificações</strong><button type="button" aria-label="Fechar notificações" onClick={() => setExpanded(false)}><X size={18} /></button></div>
      {rows.length ? rows.map((item) => renderItem(item)) : <p>Sem avisos pendentes.</p>}
    </section>}
    {toast && !expanded && <div className="request-notification-toast" role="status">{renderItem(toast, true)}</div>}
  </div>;
}
