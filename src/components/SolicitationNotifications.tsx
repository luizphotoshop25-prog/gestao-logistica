import { useCallback, useEffect, useRef, useState } from "react";
import { Bell, Clock3, X } from "lucide-react";
import { dataService } from "../services/dataService";

const labels: Record<SolicitationNotificationType, string> = {
  ASSIGNED: "Nova solicitação atribuída",
  DUE_TOMORROW: "Solicitação para amanhã",
  DUE_TODAY: "Solicitação para hoje",
  DUE_IN_ONE_HOUR: "Prazo em 1 hora",
  OVERDUE: "Solicitação atrasada",
};

export function SolicitationNotifications({ onOpen }: { onOpen: (id: string) => void }) {
  const [rows, setRows] = useState<SolicitationNotification[]>([]);
  const [toast, setToast] = useState<SolicitationNotification | null>(null);
  const [expanded, setExpanded] = useState(false);
  const polling = useRef(false);

  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const result = await dataService.pollSolicitationNotifications();
      if (!result.ok) return;
      setRows(result.rows);
      const fresh = result.rows.find((row) => result.delivered?.includes(row.id));
      if (!fresh) return;
      if (document.hasFocus() && !document.hidden) setToast(fresh);
      else void window.gestaoAPI.showNativeSolicitationNotification({ solicitationId: fresh.solicitacao_id, type: fresh.tipo }).catch(() => {});
    } catch { /* Notifications must never block the application. */ }
    finally { polling.current = false; }
  }, []);

  useEffect(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), 60000);
    const onFocus = () => void poll();
    window.addEventListener("focus", onFocus);
    const unsubscribe = window.gestaoAPI.onNativeSolicitationOpen((id) => onOpen(id));
    return () => { window.clearInterval(timer); window.removeEventListener("focus", onFocus); unsubscribe(); };
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
    <span className="request-notice-description">{item.sessao_codigo ? `${item.sessao_codigo} · ` : ""}{item.descricao}</span>
    <div className="request-notice-actions">
      <button type="button" onClick={() => void update(item, "open")}>Abrir solicitação</button>
      {!["ASSIGNED", "DUE_TOMORROW"].includes(item.tipo) && <details className="request-notice-snooze-control"><summary>Lembrar depois</summary><div className="request-notice-snooze" aria-label="Lembrar depois">
        {(item.tipo === "DUE_IN_ONE_HOUR" ? [15, 30] : [15, 30, 60]).map((minutes) => <button type="button" key={minutes} onClick={() => void update(item, "snooze", minutes)}>{minutes === 60 ? "1 hora" : `${minutes} min`}</button>)}
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
