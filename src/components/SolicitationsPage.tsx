import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Check, CircleCheck, ClipboardList, Clock3, Pencil, Plus, RotateCcw, Search, X } from "lucide-react";
import { dataService } from "../services/dataService";
import { formatSolicitationDate, formatSolicitationDeadline, isSolicitationDueToday, sortSolicitationsByUrgency, toLocalDateTimeInput } from "../utils/solicitation-date";

type Props = {
  initialSelection?: Solicitation | null;
  currentUser: AuthUser;
  onBack: () => void;
  onNotice: (message: string) => void;
  onOpenOrder: (session: string) => void;
};

type SolicitationForm = {
  descricao: string;
  observacao: string;
  sessao_codigo: string;
  responsavel_usuario_id: string;
  prazo_em: string;
};

const emptyForm: SolicitationForm = { descricao: "", observacao: "", sessao_codigo: "", responsavel_usuario_id: "", prazo_em: "" };
const statusLabels: Record<SolicitationStatus, string> = {
  pending: "Pendente",
  in_progress: "Em andamento",
  completed: "Concluída",
  cancelled: "Cancelada",
};
const statusFilters = [
  ["open", "Abertas"],
  ["pending", "Pendentes"],
  ["in_progress", "Em andamento"],
  ["completed", "Concluídas"],
  ["cancelled", "Canceladas"],
] as const;

function SolicitationFields({
  form,
  assignees,
  sessionOptions,
  onChange,
  onSessionQuery,
}: {
  form: SolicitationForm;
  assignees: ActiveUser[];
  sessionOptions: string[];
  onChange: (values: SolicitationForm) => void;
  onSessionQuery: (value: string) => void;
}) {
  return <div className="solicitation-fields">
    <label>Solicitação <span className="required-mark">Obrigatória</span>
      <textarea autoFocus required maxLength={2000} rows={3} value={form.descricao} onChange={(event) => onChange({ ...form, descricao: event.target.value })} placeholder="Descreva a tarefa de forma direta" />
    </label>
    <label>Responsável <span className="required-mark">Obrigatório</span>
      <select required value={form.responsavel_usuario_id} onChange={(event) => onChange({ ...form, responsavel_usuario_id: event.target.value })}>
        <option value="">Selecione uma pessoa ativa</option>
        {assignees.map((person) => <option key={person.id} value={person.id}>{person.nome} · {person.usuario}</option>)}
      </select>
      {!assignees.length && <small className="solicitation-field-hint">Cadastre usuários ativos no banco para definir responsáveis.</small>}
    </label>
    <div className="solicitation-field-row">
      <label>Sessão <span>Opcional</span>
        <input value={form.sessao_codigo} list="solicitation-sessions" onChange={(event) => { onChange({ ...form, sessao_codigo: event.target.value.toUpperCase() }); onSessionQuery(event.target.value); }} placeholder="M49999" />
        <datalist id="solicitation-sessions">{sessionOptions.map((session) => <option key={session} value={session} />)}</datalist>
      </label>
      <label>Prazo <span>Opcional</span><input type="datetime-local" value={form.prazo_em} onChange={(event) => onChange({ ...form, prazo_em: event.target.value })} /></label>
    </div>
    <label>Observação <span>Opcional</span>
      <textarea maxLength={4000} rows={2} value={form.observacao} onChange={(event) => onChange({ ...form, observacao: event.target.value })} placeholder="Contexto adicional para a equipe" />
    </label>
  </div>;
}

export function SolicitationIndicator({ onOpen }: { onOpen: () => void }) {
  const [items, setItems] = useState<Solicitation[]>([]);
  useEffect(() => {
    let active = true;
    void dataService.listSolicitations().then((result) => { if (active && result.ok) setItems(result.rows); }).catch(() => {});
    return () => { active = false; };
  }, []);
  const pending = items.filter((item) => item.status === "pending").length;
  const dueToday = items.filter((item) => !["completed", "cancelled"].includes(item.status) && isSolicitationDueToday(item.prazo_em)).length;
  return <button className="solicitation-indicator" onClick={onOpen}>
    <ClipboardList size={16} />
    <span><strong>Minhas solicitações</strong><small>{pending} pendente{pending === 1 ? "" : "s"} · {dueToday} {dueToday === 1 ? "vence" : "vencem"} hoje</small></span>
    <ArrowLeft className="solicitation-indicator-arrow" size={15} />
  </button>;
}

export function SolicitationsPage({ currentUser, onBack, onNotice, onOpenOrder, initialSelection }: Props) {
  const isCoordinator = currentUser.role === "coordinator";
  const [items, setItems] = useState<Solicitation[]>([]);
  const [assignees, setAssignees] = useState<ActiveUser[]>([]);
  const [filter, setFilter] = useState<(typeof statusFilters)[number][0]>("open");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Solicitation | null>(initialSelection || null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<SolicitationForm>(emptyForm);
  const [sessionOptions, setSessionOptions] = useState<string[]>([]);
  const [sessionQuery, setSessionQuery] = useState("");
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async () => {
    try {
      const result = await dataService.listSolicitations();
      if (result.ok) setItems(result.rows);
      else onNotice(result.message || "Não foi possível carregar as solicitações.");
      if (isCoordinator) {
        const users = await dataService.listSolicitationAssignees();
        if (users.ok) setAssignees(users.rows);
        else onNotice(users.message || "Não foi possível carregar os responsáveis.");
      }
    } catch (error) { onNotice(error instanceof Error ? error.message : "Não foi possível conectar às solicitações."); }
  }, [isCoordinator, onNotice]);

  useEffect(() => { void reload(); }, [reload]);
  useEffect(() => {
    const query = sessionQuery.trim();
    if (query.length < 2) { setSessionOptions([]); return; }
    let active = true;
    const timer = window.setTimeout(() => {
      void dataService.listOrders({ search: query, filter: "all" }).then((result) => {
        if (active && result.ok) setSessionOptions(result.rows.map((order) => order.sessao).filter((session) => session.toUpperCase().includes(query.toUpperCase())).slice(0, 12));
      }).catch(() => { if (active) setSessionOptions([]); });
    }, 250);
    return () => { active = false; window.clearTimeout(timer); };
  }, [sessionQuery]);

  const visibleItems = useMemo(() => sortSolicitationsByUrgency(items.filter((item) => {
    const matchesFilter = filter === "open" ? ["pending", "in_progress"].includes(item.status) : item.status === filter;
    const query = search.trim().toLocaleLowerCase("pt-BR");
    const matchesSearch = !query || item.descricao.toLocaleLowerCase("pt-BR").includes(query)
      || (item.sessao_codigo || "").toLocaleLowerCase("pt-BR").includes(query)
      || item.responsavel_nome.toLocaleLowerCase("pt-BR").includes(query);
    return matchesFilter && matchesSearch;
  })), [filter, items, search]);
  const counts = useMemo(() => ({
    open: items.filter((item) => ["pending", "in_progress"].includes(item.status)).length,
    pending: items.filter((item) => item.status === "pending").length,
    in_progress: items.filter((item) => item.status === "in_progress").length,
    completed: items.filter((item) => item.status === "completed").length,
    cancelled: items.filter((item) => item.status === "cancelled").length,
    overdue: items.filter((item) => item.atrasada).length,
  }), [items]);
  const emptyFilterLabel = statusFilters.find(([key]) => key === filter)?.[1].toLocaleLowerCase("pt-BR") || "solicitações";

  const openDetail = async (item: Solicitation) => {
    setBusy(true);
    try {
      const result = await dataService.getSolicitation(item.id);
      if (!result.ok || !result.solicitation) return onNotice(result.message || "Solicitação não encontrada.");
      setSelected(result.solicitation);
      setEditing(false);
    } catch (error) { onNotice(error instanceof Error ? error.message : "Não foi possível abrir a solicitação."); }
    finally { setBusy(false); }
  };

  const beginEdit = () => {
    if (!selected) return;
    setForm({
      descricao: selected.descricao,
      observacao: selected.observacao || "",
      sessao_codigo: selected.sessao_codigo || "",
      responsavel_usuario_id: selected.responsavel_usuario_id,
      prazo_em: toLocalDateTimeInput(selected.prazo_em),
    });
    setSessionQuery(selected.sessao_codigo || "");
    setEditing(true);
  };

  const saveCreate = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      const result = await dataService.createSolicitation({
        descricao: form.descricao,
        observacao: form.observacao || undefined,
        sessao_codigo: form.sessao_codigo || undefined,
        responsavel_usuario_id: form.responsavel_usuario_id,
        prazo_em: form.prazo_em ? new Date(form.prazo_em).toISOString() : undefined,
      });
      if (!result.ok) return onNotice(result.message || "Não foi possível criar a solicitação.");
      setCreateOpen(false);
      setForm(emptyForm);
      onNotice("Solicitação criada.");
      await reload();
      if (result.solicitation) setSelected(result.solicitation);
    } catch (error) { onNotice(error instanceof Error ? error.message : "Não foi possível criar a solicitação."); }
    finally { setBusy(false); }
  };

  const saveEdit = async (event: FormEvent) => {
    event.preventDefault();
    if (!selected) return;
    setBusy(true);
    try {
      const result = await dataService.updateSolicitation({
        id: selected.id,
        revision: selected.revision,
        values: {
          descricao: form.descricao,
          observacao: form.observacao || null,
          sessao_codigo: form.sessao_codigo || null,
          responsavel_usuario_id: form.responsavel_usuario_id,
          prazo_em: form.prazo_em ? new Date(form.prazo_em).toISOString() : null,
        },
      });
      if (!result.ok || !result.solicitation) return onNotice(result.message || "Não foi possível atualizar a solicitação.");
      setSelected(result.solicitation);
      setEditing(false);
      onNotice("Solicitação atualizada.");
      await reload();
    } catch (error) { onNotice(error instanceof Error ? error.message : "Não foi possível atualizar a solicitação."); }
    finally { setBusy(false); }
  };

  const transition = async (action: "start" | "complete" | "cancel" | "reopen") => {
    if (!selected) return;
    const messages = { start: "Solicitação iniciada.", complete: "Solicitação concluída.", cancel: "Solicitação cancelada.", reopen: "Solicitação reaberta." };
    setBusy(true);
    try {
      const result = await dataService.transitionSolicitation({ id: selected.id, revision: selected.revision, action });
      if (!result.ok || !result.solicitation) return onNotice(result.message || "Não foi possível atualizar o status.");
      setSelected(result.solicitation);
      onNotice(messages[action]);
      await reload();
    } catch (error) { onNotice(error instanceof Error ? error.message : "Não foi possível atualizar o status."); }
    finally { setBusy(false); }
  };

  const deadlineTone = (item: Solicitation) => item.status === "completed" || item.status === "cancelled" ? "closed" : item.atrasada ? "overdue" : !item.prazo_em ? "none" : isSolicitationDueToday(item.prazo_em) ? "today" : "normal";
  const itemCanStart = selected?.status === "pending";
  const itemCanComplete = selected && ["pending", "in_progress"].includes(selected.status);
  const itemCanCancel = isCoordinator && selected && ["pending", "in_progress"].includes(selected.status);
  const itemCanReopen = isCoordinator && selected && ["completed", "cancelled"].includes(selected.status);

  return <section className="solicitations-page">
    <header className="solicitations-heading">
      <div className="solicitations-heading-copy">
        <button className="solicitations-back" onClick={onBack}><ArrowLeft size={15} /> Pedidos</button>
        <span className="section-kicker">EQUIPE</span>
        <h2>Solicitações</h2>
        <p>Acompanhe tarefas e pendências direcionadas à equipe.</p>
      </div>
      {isCoordinator && <button className="primary solicitations-new" onClick={() => { setForm(emptyForm); setSessionQuery(""); setCreateOpen(true); }}><Plus size={16} /> Nova solicitação</button>}
    </header>

    <div className="solicitation-summary" aria-label="Resumo das solicitações">
      <span><strong>{counts.pending}</strong> Pendentes</span>
      <span><strong>{counts.in_progress}</strong> Em andamento</span>
      <span className={counts.overdue ? "has-overdue" : ""}><strong>{counts.overdue}</strong> Atrasadas</span>
    </div>

    <div className="solicitations-toolbar">
      <div className="solicitation-filters" role="group" aria-label="Filtrar solicitações">
        {statusFilters.map(([key, label]) => <button key={key} type="button" aria-pressed={filter === key} className={filter === key ? "active" : ""} onClick={() => setFilter(key)}>{label}<span className="solicitation-filter-count">{counts[key]}</span></button>)}
      </div>
      <label className="solicitation-search"><Search size={15} /><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar solicitação, sessão ou responsável" /></label>
    </div>

    <div className="solicitation-list" aria-busy={busy}>
      {visibleItems.map((item) => <article className="solicitation-card" key={item.id}>
        <button className="solicitation-card-main" onClick={() => void openDetail(item)}>
          <span className={`solicitation-status ${item.status}`}>{statusLabels[item.status]}</span>
          <strong className="solicitation-card-title">{item.descricao}</strong>
          <span className="solicitation-card-meta">
            <span className="solicitation-assignee"><span className="solicitation-avatar" aria-hidden="true">{item.responsavel_nome.trim().charAt(0).toLocaleUpperCase("pt-BR") || "?"}</span><span>{item.responsavel_nome}</span></span>
            {item.sessao_codigo && <span className="solicitation-session-chip">{item.sessao_codigo}</span>}
            <span className="solicitation-requested-date">Solicitada em {formatSolicitationDate(item.solicitada_em)}</span>
          </span>
          <span className={`solicitation-deadline ${deadlineTone(item)}`}><Clock3 size={13} /><span className="solicitation-deadline-label">Prazo</span><strong>{formatSolicitationDeadline(item.prazo_em, item.atrasada)}</strong></span>
        </button>
        <button className="solicitation-open" aria-label={`Ver detalhes: ${item.descricao}`} onClick={() => void openDetail(item)}>Ver detalhes <ArrowLeft size={14} /></button>
      </article>)}
      {!visibleItems.length && <div className="solicitation-empty"><ClipboardList size={25} />
        <strong>{search ? "Nenhuma solicitação encontrada" : items.length === 0 && isCoordinator ? "Nenhuma solicitação criada" : `Nenhuma solicitação ${emptyFilterLabel}`}</strong>
        <span>{search ? "Tente outro termo ou limpe a busca." : items.length === 0 && isCoordinator ? "Crie uma solicitação para organizar uma tarefa da equipe." : "Você está em dia com as tarefas desta lista."}</span>
        {search && <button className="secondary" onClick={() => setSearch("")}>Limpar busca</button>}
        {!search && items.length === 0 && isCoordinator && <button className="primary" onClick={() => { setForm(emptyForm); setCreateOpen(true); }}><Plus size={15} /> Nova solicitação</button>}
      </div>}
    </div>

    {createOpen && <div className="modal-backdrop solicitation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) setCreateOpen(false); }}>
      <form className="modal solicitation-modal" role="dialog" aria-modal="true" aria-labelledby="solicitation-create-title" onSubmit={(event) => void saveCreate(event)}>
        <header className="solicitation-modal-heading"><div><span className="section-kicker">NOVA TAREFA</span><h2 id="solicitation-create-title">Nova solicitação</h2></div><button type="button" className="icon-button" onClick={() => setCreateOpen(false)} aria-label="Fechar"><X size={18} /></button></header>
        <SolicitationFields form={form} assignees={assignees} sessionOptions={sessionOptions} onChange={setForm} onSessionQuery={setSessionQuery} />
        <footer><button type="button" className="secondary" onClick={() => setCreateOpen(false)} disabled={busy}>Cancelar</button><button className="primary" type="submit" disabled={busy || !assignees.length}><Plus size={16} /> Criar solicitação</button></footer>
      </form>
    </div>}

    {selected && <div className="modal-backdrop solicitation-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) { setSelected(null); setEditing(false); } }}>
      <section className="modal solicitation-modal" role="dialog" aria-modal="true" aria-labelledby="solicitation-detail-title">
        <header className="solicitation-modal-heading"><div><span className={`solicitation-status ${selected.status}`}>{statusLabels[selected.status]}</span><h2 id="solicitation-detail-title">{editing ? "Editar solicitação" : "Detalhes da solicitação"}</h2></div><button type="button" className="icon-button" onClick={() => { setSelected(null); setEditing(false); }} aria-label="Fechar"><X size={18} /></button></header>
        {editing ? <form onSubmit={(event) => void saveEdit(event)}>
          <SolicitationFields form={form} assignees={assignees} sessionOptions={sessionOptions} onChange={setForm} onSessionQuery={setSessionQuery} />
          <footer><button type="button" className="secondary" onClick={() => setEditing(false)} disabled={busy}>Cancelar</button><button className="primary" type="submit" disabled={busy}><Check size={16} /> Salvar alterações</button></footer>
        </form> : <>
          <div className="solicitation-detail-description"><h3>{selected.descricao}</h3>{selected.observacao && <p><strong>Observação</strong>{selected.observacao}</p>}</div>
          <dl className="solicitation-detail-grid">
            <div><dt>Responsável</dt><dd>{selected.responsavel_nome} · {selected.responsavel_usuario}</dd></div>
            <div><dt>Criado por</dt><dd>{selected.criado_por_nome}</dd></div>
            <div><dt>Solicitada em</dt><dd>{formatSolicitationDate(selected.solicitada_em)}</dd></div>
            <div><dt>Prazo</dt><dd className={selected.atrasada ? "solicitation-overdue-text" : ""}>{formatSolicitationDeadline(selected.prazo_em, selected.atrasada)}</dd></div>
            <div><dt>Sessão</dt><dd>{selected.sessao_codigo ? <button className="solicitation-session-link" onClick={() => { setSelected(null); onOpenOrder(selected.sessao_codigo!); }}>{selected.sessao_codigo}</button> : "—"}</dd></div>
            {selected.iniciado_em && <div><dt>Iniciada em</dt><dd>{formatSolicitationDate(selected.iniciado_em)}</dd></div>}
            {selected.concluido_em && <div><dt>Concluída em</dt><dd>{formatSolicitationDate(selected.concluido_em)}</dd></div>}
            {selected.cancelado_em && <div><dt>Cancelada em</dt><dd>{formatSolicitationDate(selected.cancelado_em)}</dd></div>}
          </dl>
          <div className="solicitation-detail-actions">
            {isCoordinator && <button className="secondary" onClick={beginEdit} disabled={busy}><Pencil size={15} /> Editar</button>}
            {itemCanStart && <button className="secondary" onClick={() => void transition("start")} disabled={busy}><Clock3 size={15} /> Iniciar</button>}
            {itemCanComplete && <button className="primary" onClick={() => void transition("complete")} disabled={busy}><CircleCheck size={15} /> Concluir</button>}
            {itemCanCancel && <button className="solicitation-cancel" onClick={() => void transition("cancel")} disabled={busy}>Cancelar solicitação</button>}
            {itemCanReopen && <button className="secondary" onClick={() => void transition("reopen")} disabled={busy}><RotateCcw size={15} /> Reabrir</button>}
          </div>
        </>}
      </section>
    </div>}
  </section>;
}
