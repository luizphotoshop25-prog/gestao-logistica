import { useEffect, useState } from "react";
import { dataService } from "../services/dataService";
import { formatSolicitationDeadline, sortSolicitationsByUrgency } from "../utils/solicitation-date";
import { ViewState } from "./ui";

type Props = { currentUser: AuthUser; onOrders: (filter: string) => void; onOrder: (id: string) => void; onSolicitations: (item?: Solicitation) => void; queue: string; onQueue: (value: string) => void };
export function Central({ currentUser, onOrders, onOrder, onSolicitations, queue, onQueue }: Props) {
  const [retry, setRetry] = useState(0);
  const [orders, setOrders] = useState<Order[]>([]);
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [tasks, setTasks] = useState<Solicitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [taskLoading, setTaskLoading] = useState(true);
  const [error, setError] = useState("");
  const [taskError, setTaskError] = useState("");
  useEffect(() => {
    let active = true;
    setLoading(true); setError("");
    Promise.all([dataService.listOrders({ filter: queue, search: "" }), dataService.dashboard()]).then(([list, dashboard]) => {
      if (!list.ok || !dashboard.ok) throw new Error();
      if (active) { setOrders(list.rows); setSummary(dashboard.dashboard); }
    }).catch(() => { if (active) setError("Não foi possível carregar a fila operacional."); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [queue, retry]);
  useEffect(() => {
    let active = true;
    setTaskLoading(true); setTaskError("");
    dataService.listSolicitations().then(result => {
      if (!result.ok) throw new Error();
      if (active) setTasks(sortSolicitationsByUrgency(result.rows.filter(task => (task.status === "pending" || task.status === "in_progress") && (currentUser.role !== "employee" || task.responsavel_usuario_id === currentUser.id))));
    }).catch(() => { if (active) setTaskError("Não foi possível carregar as solicitações."); }).finally(() => { if (active) setTaskLoading(false); });
    return () => { active = false; };
  }, [currentUser.id, currentUser.role, retry]);
  const employee = currentUser.role === "employee";
  const taskPanel = <section className="central-panel central-tasks"><div className="central-panel-heading"><div><span className="section-kicker">{employee ? "SEU TRABALHO" : "EQUIPE"}</span><h2>{employee ? "Minhas solicitações" : "Solicitações da equipe"}</h2></div><button className="ui-button" onClick={() => onSolicitations()}>Ver todas →</button></div>
    {taskLoading ? <ViewState kind="loading" title="Carregando solicitações…" /> : taskError ? <ViewState kind="error" title={taskError} onRetry={() => setRetry(x => x + 1)} /> : !tasks.length ? <ViewState kind="empty" title="Nenhuma solicitação aberta" description="Consulte as concluídas na área de Solicitações." /> : <div className="central-task-list">{tasks.slice(0, 6).map(task => <button className="central-task" key={task.id} onClick={() => onSolicitations(task)}><strong>{task.descricao}</strong><span>{task.responsavel_nome} · {task.sessao_codigo || "Sem sessão vinculada"}</span><div><span className="ui-badge">{task.status === "pending" ? "Pendente" : "Em andamento"}</span><span className={task.atrasada ? "central-overdue" : ""}>{formatSolicitationDeadline(task.prazo_em, task.atrasada)}</span></div></button>)}</div>}
  </section>;
  return <section className="central-page"><div className="central-heading"><div><span className="section-kicker">CENTRAL OPERACIONAL</span><h1>O que exige sua atenção agora?</h1><p>{employee ? "Comece pelas suas solicitações e consulte a operação da equipe." : "Prioridades da operação e trabalho da equipe, em um só lugar."}</p></div><button className="ui-button" onClick={() => setRetry(x => x + 1)} disabled={loading || taskLoading}>Atualizar</button></div>
    <div className="central-signals">{([['new_selections', 'Novas seleções', summary?.queues.newSelections], ['due_3', 'Vencem em até 3 dias', summary?.queues.due3], ['alerts', 'Alertas operacionais', summary?.queues.alerts], ['ready_label', 'Prontas para etiqueta', summary?.queues.readyLabel]] as const).map(([key, label, count]) => <button key={key} onClick={() => onOrders(key)} disabled={loading || !!error} className={'central-signal signal-' + key}><span>{label}</span><strong>{loading || error ? '—' : count}</strong><small>Ver pedidos →</small></button>)}</div>
    <div className={'central-columns ' + (employee ? 'employee' : '')}>
      {employee && taskPanel}
      <section className="central-panel central-operation"><div className="central-panel-heading"><div><span className="section-kicker">PEDIDOS</span><h2>Fila operacional</h2></div><button className="ui-button" onClick={() => onOrders(queue)}>Ver fila completa →</button></div><div className="ui-tabs" aria-label="Filas operacionais">{[['needs_me', 'Ação da equipe'], ['waiting', 'Aguardando terceiros'], ['alerts', 'Alertas']].map(([key, label]) => <button key={key} aria-pressed={queue === key} onClick={() => onQueue(key)}>{label}</button>)}</div>
      {loading ? <ViewState kind="loading" title="Carregando fila…" /> : error ? <ViewState kind="error" title={error} onRetry={() => setRetry(x => x + 1)} /> : !orders.length ? <ViewState kind="empty" title="Nenhuma pendência nesta fila" description="Escolha outra fila para consultar o restante da operação." /> : <div className="central-order-list">{orders.slice(0, 8).map(order => <article className="central-order" key={order.id}><div><button className="session-link" onClick={() => onOrder(order.id)}>{order.sessao}</button><span>{order.cliente_nome || "Cliente não identificado"}</span></div><div><strong>{order.acao_recomendada}</strong><span>Depende de: {order.responsavel_atual === "Você" ? "Equipe" : order.responsavel_atual}</span></div><div className="central-deadline"><span>{order.urgencia_texto || "Prazo de tratamento"}</span><strong>{order.prazo_tratamento_em ? order.prazo_tratamento_em.slice(0, 10).split('-').reverse().join('/') : "Sem prazo registrado"}</strong></div><button className="ui-button" onClick={() => onOrder(order.id)} aria-label={'Abrir ficha ' + order.sessao}>Abrir ficha</button></article>)}</div>}
      </section>{!employee && taskPanel}
    </div>
  </section>;
}
