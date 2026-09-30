import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertTriangle, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, History, Images, Pencil, Plus, Search, Send, UserRound, X } from "lucide-react";
import { dataService } from "../services/dataService";
import { ViewState } from "./ui";

const formatDate = (value: string | null | undefined) => {
  if (!value) return "—";
  const [year, month, day] = value.slice(0, 10).split("-");
  return year && month && day ? `${day}/${month}/${year}` : value;
};
const localDate = () => {
  const value = new Date();
  return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, "0")}-${String(value.getDate()).padStart(2, "0")}`;
};
const digitalItemsLabel = (quantity: number | null | undefined) => quantity === null || quantity === undefined ? "—" : `${quantity} itens`;
const canonicalSession = (value: string) => {
  const compact = value.trim().replace(/\s+/g, "");
  if (!/^M?\d+$/i.test(compact)) return null;
  return `M${compact.replace(/^M/i, "")}`.toUpperCase();
};

type Candidate = Extract<DigitalShipmentSessionsResult["rows"][number], { id: string }>;
type ShipmentFormValues = { numeroPedidoDigital: string; dataEnvio: string; pedidoIds: string[]; confirmReenvio?: boolean };

export function DigitalShipmentsPage({ currentUser, onOpenOrder }: { currentUser: AuthUser; onOpenOrder: (id: string) => void }) {
  const [search, setSearch] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [sort, setSort] = useState<DigitalShipmentOptions["sort"]>("date-desc");
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<DigitalShipmentListResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [selectedShipment, setSelectedShipment] = useState<DigitalShipment | null>(null);
  const [formShipment, setFormShipment] = useState<DigitalShipment | null | undefined>(undefined);
  const [notice, setNotice] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef(0);
  const loadingRef = useRef(false);
  const pageRef = useRef(page);
  const lastRefreshAtRef = useRef(0);
  pageRef.current = page;

  const load = useCallback(async (nextPage = 1) => {
    const requestId = ++requestRef.current;
    loadingRef.current = true;
    lastRefreshAtRef.current = Date.now();
    setLoading(true);
    setError("");
    try {
      const response = await dataService.listDigitalShipments({ search, from, to, sort, page: nextPage, pageSize: 20 });
      if (requestId !== requestRef.current) return;
      if (!response.ok) throw new Error(response.message || "Não foi possível carregar os envios.");
      setResult(response);
      setPage(nextPage);
    } catch (cause) {
      if (requestId === requestRef.current) setError(cause instanceof Error ? cause.message : "Não foi possível carregar os envios.");
    } finally {
      if (requestId === requestRef.current) {
        loadingRef.current = false;
        setLoading(false);
      }
    }
  }, [search, from, to, sort]);

  useEffect(() => {
    const timer = window.setTimeout(() => void load(1), search ? 180 : 0);
    return () => window.clearTimeout(timer);
  }, [load, search, from, to, sort]);

  useEffect(() => {
    if (formShipment !== undefined) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState !== "visible" || loadingRef.current
        || Date.now() - lastRefreshAtRef.current < 1000) return;
      void load(pageRef.current);
    };
    const timer = window.setInterval(refreshWhenVisible, 60_000);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    window.addEventListener("focus", refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
      window.removeEventListener("focus", refreshWhenVisible);
    };
  }, [formShipment, load]);

  useEffect(() => { searchRef.current?.focus(); }, []);
  useEffect(() => () => {
    requestRef.current++;
    loadingRef.current = false;
  }, []);

  const openShipment = async (shipmentId: string) => {
    setError("");
    try {
      const response = await dataService.getDigitalShipment(shipmentId);
      if (!response.ok || !response.shipment) throw new Error(response.message || "Pedido Digital não encontrado.");
      setSelectedShipment(response.shipment);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível abrir o pedido Digital."); }
  };

  const handleSaved = (shipment: DigitalShipment, message: string) => {
    setFormShipment(undefined);
    setNotice(message);
    setSelectedShipment(shipment);
    void load(1);
  };

  const sessionResult = result?.session;
  const pageCount = Math.max(1, result?.totalPages || 1);
  const busyCount = result?.total || 0;

  return <section className="digital-screen">
    <div className="central-heading digital-heading">
      <div><span className="section-kicker">OPERAÇÃO</span><h1>Enviados Digital</h1><p>Consulte e registre pedidos enviados para a Digital Fotos.</p></div>
      <button type="button" className="ui-button ui-button-primary" onClick={() => setFormShipment(null)}><Plus size={17} /> Registrar envio</button>
    </div>

    {notice && <div className="digital-notice" role="status"><Check size={16} />{notice}<button aria-label="Fechar aviso" onClick={() => setNotice("")}><X size={15} /></button></div>}
    {error && <ViewState kind="error" title={error} onRetry={() => void load()} />}

    <section className="digital-panel" aria-label="Consulta de envios para Digital Fotos">
      <div className="digital-toolbar">
        <label className="digital-search"><Search size={19} /><input ref={searchRef} id="digital-search" value={search} onChange={(event) => { setSearch(event.target.value); setPage(1); }} placeholder="Buscar por sessão, pedido Digital ou cliente..." aria-label="Buscar sessão, pedido Digital ou cliente" /><kbd>/</kbd>{search && <button type="button" aria-label="Limpar busca" onClick={() => setSearch("")}><X size={16} /></button>}</label>
        <label className="digital-date-filter"><span>De</span><input type="date" value={from} onChange={(event) => { setFrom(event.target.value); setPage(1); }} aria-label="Data inicial" /></label>
        <label className="digital-date-filter"><span>Até</span><input type="date" value={to} onChange={(event) => { setTo(event.target.value); setPage(1); }} aria-label="Data final" /></label>
        <label className="orders-control">Ordenar por<select value={sort} onChange={(event) => { setSort(event.target.value as DigitalShipmentOptions["sort"]); setPage(1); }}><option value="date-desc">Data: mais recente</option><option value="date-asc">Data: mais antiga</option><option value="number-desc">Pedido Digital: maior</option><option value="number-asc">Pedido Digital: menor</option></select></label>
      </div>

      {sessionResult && <section className={`digital-session-result ${sessionResult.shipments.length ? "has-shipments" : "no-shipments"}`} aria-live="polite">
        {!sessionResult.found ? <div><span className="section-kicker">CONSULTA DE SESSÃO</span><strong>Sessão não encontrada no Gestão Logística.</strong><p>Confira o código e tente novamente.</p></div> : <>
          <div className="digital-session-identity"><span className="digital-session-icon"><Images size={18} /></span><div><span className="section-kicker">{sessionResult.shipments.length ? "ENVIO LOCALIZADO" : "PEDIDO LOCALIZADO"}</span><h2>{sessionResult.order?.sessao}</h2><p>{sessionResult.order?.cliente_nome || "Cliente não identificado"}</p></div></div>
          {sessionResult.shipments.length ? <div className="digital-session-history">
            <strong>Enviado para Digital</strong>
            {sessionResult.shipments.map((shipment) => <button type="button" key={shipment.id} onClick={() => void openShipment(shipment.id)}><span>Pedido Digital <b>{shipment.numero_pedido_digital}</b></span><span>{formatDate(shipment.data_envio)}</span><small>Registrado por {shipment.registrado_por}</small></button>)}
          </div> : <div className="digital-no-history"><strong>Nenhum envio para a Digital registrado.</strong><span>Esta sessão existe no Gestão Logística e ainda não possui registro de envio.</span></div>}
        </>}
      </section>}

      <div className="digital-list-heading"><div><h2>{search ? "Resultados" : "Envios recentes"}</h2><span>{loading ? "Consultando…" : `${busyCount} ${busyCount === 1 ? "envio" : "envios"}`}</span></div><button type="button" className="ui-button" onClick={() => void load()} disabled={loading}>Atualizar</button></div>
      {loading && !result ? <ViewState kind="loading" title="Carregando envios" /> : !loading && !busyCount ? <ViewState kind="empty" title={search ? "Nenhum envio encontrado" : "Nenhum envio registrado"} description={search ? "Revise a sessão, o número do pedido Digital ou o nome do cliente." : "Os registros feitos após o envio para a Digital Fotos aparecerão aqui."} /> : <>
        <div className="digital-table-wrap"><table className="digital-table"><caption className="sr-only">Envios registrados para a Digital Fotos</caption><thead><tr><th>Pedido Digital</th><th>Data</th><th>Sessões</th><th>Itens</th><th>Registrado por</th><th>Ações</th></tr></thead><tbody>
          {result?.rows.map((shipment) => <tr key={shipment.id}>
            <td><button type="button" className="digital-number-link" onClick={() => void openShipment(shipment.id)}>{shipment.numero_pedido_digital}</button></td>
            <td>{formatDate(shipment.data_envio)}</td><td>{shipment.sessoes_quantidade}</td>
            <td>{digitalItemsLabel(shipment.itens_digital)}</td>
            <td><span className="digital-registrar"><UserRound size={14} />{shipment.registrado_por}</span></td>
            <td><button type="button" className="ui-button digital-view-button" onClick={() => void openShipment(shipment.id)}>Consultar</button></td>
          </tr>)}
        </tbody></table></div>
        <div className="digital-pagination"><span>Exibindo {Math.min((page - 1) * 20 + 1, busyCount)}–{Math.min(page * 20, busyCount)} de {busyCount}</span><div><button type="button" className="ui-button" aria-label="Página anterior" disabled={page <= 1 || loading} onClick={() => void load(page - 1)}><ChevronLeft size={17} /></button><span>Página {page} de {pageCount}</span><button type="button" className="ui-button" aria-label="Próxima página" disabled={page >= pageCount || loading} onClick={() => void load(page + 1)}><ChevronRight size={17} /></button></div></div>
      </>}
    </section>

    {selectedShipment && <DigitalShipmentDetail shipment={selectedShipment} currentUser={currentUser} onClose={() => setSelectedShipment(null)} onEdit={() => { const value = selectedShipment; setSelectedShipment(null); setFormShipment(value); }} onOpenOrder={onOpenOrder} />}
    {formShipment !== undefined && <DigitalShipmentForm shipment={formShipment} onClose={() => setFormShipment(undefined)} onSaved={handleSaved} onDuplicate={(id) => { setFormShipment(undefined); void openShipment(id); }} />}
  </section>;
}

function DigitalShipmentDetail({ shipment, currentUser, onClose, onEdit, onOpenOrder }: {
  shipment: DigitalShipment; currentUser: AuthUser; onClose: () => void; onEdit: () => void; onOpenOrder: (id: string) => void;
}) {
  const mayEdit = currentUser.role === "coordinator" || shipment.criado_por_usuario_id === currentUser.id;
  return <div className="digital-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="digital-detail-modal" role="dialog" aria-modal="true" aria-labelledby="digital-detail-title">
      <header><div><span className="section-kicker">DIGITAL FOTOS</span><h2 id="digital-detail-title">Pedido Digital {shipment.numero_pedido_digital}</h2><p><CalendarDays size={15} />{formatDate(shipment.data_envio)}<span>·</span><UserRound size={15} />Registrado por {shipment.registrado_por}</p></div><button type="button" className="icon-button" aria-label="Fechar detalhe" onClick={onClose}><X size={20} /></button></header>
      <div className="digital-detail-summary"><span><Images size={16} />{shipment.sessoes_quantidade} sessões</span><span>{digitalItemsLabel(shipment.itens_digital)}</span><span>Revisão {shipment.revision}</span></div>
      <h3>Sessões incluídas</h3>
      {shipment.itens_digital !== null && shipment.items.every((item) => item.quantidade_enviada !== null) && shipment.itens_digital > shipment.items.reduce((sum, item) => sum + (item.quantidade_enviada ?? 0), 0) && <p className="digital-unassigned-items">{shipment.itens_digital - shipment.items.reduce((sum, item) => sum + (item.quantidade_enviada ?? 0), 0)} itens sem sessão identificada</p>}
      <div className="digital-items-table-wrap"><table className="digital-items-table"><thead><tr><th>Sessão</th><th>Cliente</th><th>Qtd. enviada</th><th>Ação</th></tr></thead><tbody>{shipment.items.map((item) => <tr key={item.pedido_id}><td><strong>{item.sessao}</strong></td><td>{item.cliente_nome || "Cliente não identificado"}</td><td>{item.quantidade_enviada === null ? "—" : item.quantidade_enviada}</td><td><button type="button" className="ui-button digital-view-button" onClick={() => { onClose(); onOpenOrder(item.pedido_id); }}>Consultar</button></td></tr>)}</tbody></table></div>
      <section className="digital-audit"><h3><History size={16} />Histórico de alterações</h3><div>{shipment.events.map((event) => <article key={event.id}><strong>{event.descricao}</strong><small>{new Date(event.criado_em).toLocaleString("pt-BR")} · {event.usuario_nome}</small></article>)}</div></section>
      <footer><button type="button" className="ui-button" onClick={onClose}>Fechar</button>{mayEdit && <button type="button" className="ui-button ui-button-primary" onClick={onEdit}><Pencil size={16} /> Editar registro</button>}</footer>
    </section>
  </div>;
}

function DigitalShipmentForm({ shipment, onClose, onSaved, onDuplicate }: {
  shipment: DigitalShipment | null; onClose: () => void; onSaved: (shipment: DigitalShipment, message: string) => void; onDuplicate: (id: string) => void;
}) {
  const [number, setNumber] = useState(shipment?.numero_pedido_digital || "");
  const [date, setDate] = useState(shipment?.data_envio || localDate());
  const [digitalTotal, setDigitalTotal] = useState(shipment?.itens_digital == null ? "" : String(shipment.itens_digital));
  const [sessionQuantities, setSessionQuantities] = useState<Record<string, string>>(() => Object.fromEntries(shipment?.items.map((item) => [item.pedido_id, item.quantidade_enviada == null ? "" : String(item.quantidade_enviada)]) || []));
  const [selected, setSelected] = useState<Candidate[]>(() => shipment?.items.map((item) => ({ ...item, id: item.pedido_id, priorShipments: [] })) || []);
  const [invalid, setInvalid] = useState<string[]>([]);
  const [singleSession, setSingleSession] = useState("");
  const [bulkSessions, setBulkSessions] = useState("");
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const singleRef = useRef<HTMLInputElement>(null);
  const selectedIds = useMemo(() => new Set(selected.map((item) => item.id)), [selected]);
  const parsedSessionQuantities = Object.fromEntries(selected.map((item) => [item.id, sessionQuantities[item.id] === "" || sessionQuantities[item.id] === undefined ? null : Number(sessionQuantities[item.id])]));
  const knownSessionSum = Object.values(parsedSessionQuantities).every((value) => value !== null) ? Object.values(parsedSessionQuantities).reduce<number>((sum, value) => sum + (value ?? 0), 0) : null;
  const exceedsTotal = digitalTotal !== "" && knownSessionSum !== null && knownSessionSum > Number(digitalTotal);

  const resolveAndAdd = async (tokens: string[]) => {
    const normalized = tokens.map(canonicalSession);
    const bad = tokens.filter((_value, index) => !normalized[index]);
    const valid = [...new Set(normalized.filter((value): value is string => Boolean(value)))];
    if (!valid.length) { setInvalid((old) => [...new Set([...old, ...bad])]); if (bad.length) setError("Use somente códigos de sessão, por exemplo M60001."); return; }
    setLoadingSessions(true); setError("");
    try {
      const response = await dataService.resolveDigitalShipmentSessions({ sessions: valid });
      if (!response.ok) throw new Error(response.message || "Não foi possível localizar as sessões.");
      const found = response.rows.filter((row): row is Candidate => "id" in row);
      const notFound = response.rows.filter((row) => "notFound" in row).map((row) => row.sessao);
      setSelected((old) => [...old, ...found.filter((candidate) => !old.some((item) => item.id === candidate.id))]);
      setInvalid((old) => [...new Set([...old.filter((item) => !valid.includes(item)), ...bad, ...notFound])]);
      if (bad.length || notFound.length) setError("Remova ou corrija as sessões destacadas antes de registrar.");
      setSingleSession(""); setBulkSessions("");
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível localizar as sessões."); }
    finally { setLoadingSessions(false); }
  };

  const submit = async (confirmReenvio = false) => {
    if (!number.trim() || !date || !selected.length || invalid.length) {
      setError(invalid.length ? "Remova ou corrija as sessões não encontradas." : "Informe o pedido Digital, a data e ao menos uma sessão existente.");
      return;
    }
    setSaving(true); setError("");
    try {
      if (digitalTotal !== "" && (!Number.isSafeInteger(Number(digitalTotal)) || Number(digitalTotal) < 0)) throw new Error("Informe um total inteiro igual ou maior que zero.");
      if (selected.some((item) => sessionQuantities[item.id] !== undefined && sessionQuantities[item.id] !== "" && (!Number.isSafeInteger(Number(sessionQuantities[item.id])) || Number(sessionQuantities[item.id]) < 0))) throw new Error("Informe quantidades inteiras iguais ou maiores que zero.");
      if (exceedsTotal) throw new Error("A soma das quantidades das sessões não pode ser maior que o total de itens do pedido Digital.");
      const values = { numeroPedidoDigital: number, dataEnvio: date, pedidoIds: selected.map((item) => item.id), itensDigital: digitalTotal === "" ? null : Number(digitalTotal), quantidadesEnviadas: parsedSessionQuantities, ...(confirmReenvio ? { confirmReenvio: true } : {}) };
      const response = shipment
        ? await dataService.updateDigitalShipment({ id: shipment.id, revision: shipment.revision, ...values })
        : await dataService.createDigitalShipment(values);
      if (!response.ok && response.error === "DUPLICATE_SESSIONS" && response.priorShipments?.length) {
        const unique = new Map(response.priorShipments.map((prior) => [`${prior.pedido_id}|${prior.envio_id}`, prior]));
        const lines = [...unique.values()].map((prior) => `${prior.sessao}: pedido Digital ${prior.numero_pedido_digital} de ${formatDate(prior.data_envio)}`);
        const yes = window.confirm(`${response.message}\n\n${lines.join("\n")}\n\nDeseja registrar o novo envio mesmo assim?`);
        if (yes) { setSaving(false); await submit(true); return; }
        setError("O registro foi cancelado. Nenhum envio foi alterado."); return;
      }
      if (!response.ok && response.error === "DUPLICATE_DIGITAL_ORDER" && response.existingId) {
        window.alert("Este pedido da Digital já foi registrado. Vou abrir o registro existente.");
        onDuplicate(response.existingId); return;
      }
      if (!response.ok || !response.shipment) throw new Error(response.message || (response.error === "REVISION_CONFLICT" ? "O registro mudou. Feche e abra novamente antes de editar." : "Não foi possível salvar o envio."));
      onSaved(response.shipment, shipment ? `Pedido Digital ${response.shipment.numero_pedido_digital} atualizado.` : `Pedido Digital ${response.shipment.numero_pedido_digital} registrado.`);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Não foi possível salvar o envio."); }
    finally { setSaving(false); }
  };

  return <div className="digital-modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) onClose(); }}>
    <section className="digital-form-modal" role="dialog" aria-modal="true" aria-labelledby="digital-form-title">
      <header><div><span className="section-kicker">REGISTRO OPERACIONAL</span><h2 id="digital-form-title">{shipment ? `Editar pedido Digital ${shipment.numero_pedido_digital}` : "Registrar envio"}</h2><p>Registre as sessões incluídas após o envio para a Digital Fotos.</p></div><button type="button" className="icon-button" aria-label="Fechar formulário" onClick={onClose} disabled={saving}><X size={20} /></button></header>
      <div className="digital-form-fields"><label>Número do pedido Digital<input autoFocus value={number} maxLength={80} onChange={(event) => setNumber(event.target.value)} placeholder="Ex.: 118596" /></label><label>Data do envio<input type="date" value={date} onChange={(event) => setDate(event.target.value)} /></label><label>Itens na Digital<input type="number" min="0" step="1" value={digitalTotal} onChange={(event) => setDigitalTotal(event.target.value)} placeholder="Opcional" /><small>Quantidade total de itens exibida no pedido da Digital Fotos.</small></label></div>
      <section className="digital-session-entry"><div><h3>Sessões</h3><p>Adicione uma por vez ou cole uma lista de códigos.</p></div>
        <form className="digital-add-one" onSubmit={(event) => { event.preventDefault(); void resolveAndAdd([singleSession]); }}><input ref={singleRef} value={singleSession} onChange={(event) => setSingleSession(event.target.value)} placeholder="Adicionar sessão..." aria-label="Adicionar sessão" /><button type="submit" className="ui-button" disabled={!singleSession.trim() || loadingSessions}><Plus size={15} /> Adicionar</button></form>
        <div className="digital-bulk-entry"><textarea value={bulkSessions} onChange={(event) => setBulkSessions(event.target.value)} rows={3} placeholder={"Cole sessões separadas por linha, vírgula ou ponto e vírgula\nM60001\nM60002"} aria-label="Colar várias sessões" /><button type="button" className="ui-button" disabled={!bulkSessions.trim() || loadingSessions} onClick={() => void resolveAndAdd(bulkSessions.split(/[\s,;]+/).filter(Boolean))}>{loadingSessions ? "Localizando…" : "Adicionar lista"}</button></div>
      </section>
      <div className="digital-selection-summary"><strong>{selected.length} {selected.length === 1 ? "sessão selecionada" : "sessões selecionadas"}</strong><span>{!selected.length ? "Quantidades da Digital são opcionais." : knownSessionSum === null ? "Informe as quantidades para conferir o total." : `${knownSessionSum} itens informados nas sessões`}</span></div>
      {invalid.length > 0 && <div className="digital-invalid-list" role="alert"><AlertTriangle size={16} /><div><strong>Corrija estas sessões para continuar</strong>{invalid.map((session) => <div key={session}><span>{session}</span><small>{canonicalSession(session) ? "Não encontrada no Gestão Logística" : "Formato inválido"}</small><button type="button" aria-label={`Remover ${session}`} onClick={() => setInvalid((old) => old.filter((value) => value !== session))}><X size={14} /></button></div>)}</div></div>}
      <div className="digital-selected-list">{selected.map((item) => { const prior = item.priorShipments.filter((entry) => entry.id !== shipment?.id); return <article key={item.id} className={prior.length ? "previously-sent" : ""}><div><strong>{item.sessao}</strong><span>{item.cliente_nome || "Cliente não identificado"}</span><label>Qtd. enviada<input aria-label={`Quantidade enviada da sessão ${item.sessao}`} type="number" min="0" step="1" value={sessionQuantities[item.id] || ""} onChange={(event) => setSessionQuantities((old) => ({ ...old, [item.id]: event.target.value }))} placeholder="Opcional" /></label>{prior.map((entry) => <em key={entry.id}>Já enviado em {formatDate(entry.data_envio)} · Pedido Digital {entry.numero_pedido_digital}</em>)}</div><button type="button" aria-label={`Remover ${item.sessao}`} onClick={() => setSelected((old) => old.filter((value) => value.id !== item.id))}><X size={16} /></button></article>; })}</div>
      {exceedsTotal && <p className="digital-form-error" role="alert">A soma das quantidades das sessões não pode ser maior que o total de itens do pedido Digital.</p>}
      {error && <p className="digital-form-error" role="alert">{error}</p>}
      <footer><span><Clock3 size={14} />A alteração ficará registrada no histórico.</span><button type="button" className="ui-button" onClick={onClose} disabled={saving}>Cancelar</button><button type="button" className="ui-button ui-button-primary" disabled={saving || loadingSessions || !number.trim() || !date || !selected.length || Boolean(invalid.length) || exceedsTotal} onClick={() => void submit()}>{saving ? "Salvando…" : shipment ? "Salvar alterações" : "Registrar envio"}</button></footer>
    </section>
  </div>;
}

export function DigitalOrderHistory({ orderId }: { orderId: string }) {
  const [rows, setRows] = useState<DigitalShipmentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(false);
    void dataService.getDigitalShipmentsForOrder(orderId).then((result) => {
      if (!active) return;
      if (result.ok) setRows(result.rows || []);
      else setError(true);
    }).catch(() => {
      if (active) setError(true);
    }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [orderId]);
  return <section className="digital-order-history detail-pane pane-summary"><div className="section-title"><div><h3>Digital Fotos</h3><p>Histórico de pedidos Digital associados a esta sessão.</p></div><Send size={17} /></div>
    {loading ? <p>Consultando histórico…</p> : error ? <p role="status">Não foi possível carregar o histórico. Tente novamente ao reabrir a ficha.</p> : rows.length ? <ul>{rows.map((row) => <li key={row.id}><strong>Pedido Digital {row.numero_pedido_digital}</strong><span>{formatDate(row.data_envio)}</span><small>Registrado por {row.registrado_por}</small></li>)}</ul> : <p>Nenhum envio registrado</p>}
  </section>;
}
