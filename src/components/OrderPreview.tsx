import { useEffect, useState } from "react";
import { dataService } from "../services/dataService";
import { Overlay, ViewState } from "./ui";

const date = (value: string | null) => value ? value.slice(0, 10).split("-").reverse().join("/") : "Não registrado";

export function OrderPreview({ orderId, onClose, onOpenFull }: {
  orderId: string; onClose: () => void; onOpenFull: (id: string) => void;
}) {
  const [detail, setDetail] = useState<OrderDetailResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true); setError(""); setDetail(null);
    void dataService.getOrder(orderId).then(result => {
      if (!result.ok) throw new Error(result.message || "Não foi possível consultar o pedido.");
      if (active) setDetail(result);
    }).catch(() => { if (active) setError("Não foi possível consultar o pedido. Tente novamente."); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [orderId, attempt]);
  const order = detail?.order;
  return <Overlay title={order ? "Sessão " + order.sessao : "Consulta rápida"} variant="drawer" onClose={onClose}>
    <div className="order-preview">
      {loading ? <ViewState kind="loading" title="Carregando pedido…" /> : error ? <ViewState kind="error" title={error} onRetry={() => setAttempt(x => x + 1)} /> : order && <>
        <div className="preview-identity"><span className="section-kicker">CLIENTE</span><h3>{order.cliente_nome || "Cliente não identificado"}</h3><p>Consulta rápida · informações registradas no sistema</p></div>
        <section className="preview-action"><span className="section-kicker">PRÓXIMA AÇÃO</span><h3>{order.acao_recomendada || "Consultar ficha"}</h3><p>Depende de: {order.responsavel_atual === "Você" ? "Equipe" : order.responsavel_atual || "Não informado"}</p>{order.urgencia_texto && <p className="preview-warning">{order.urgencia_texto}</p>}</section>
        <dl className="preview-facts">
          <div><dt>Prazo de tratamento</dt><dd>{date(order.prazo_tratamento_em)}</dd></div>
          <div><dt>Prazo máximo</dt><dd>{date(order.prazo_maximo_em)}</dd></div>
          <div><dt>Seleção finalizada</dt><dd>{date(order.selecao_finalizada_em)}</dd></div>
          <div><dt>Fotos cobradas</dt><dd>{order.fotos_quantidade ?? "Não registrado"}</dd></div>
          <div><dt>Rastreio</dt><dd>{order.codigo_rastreio || "Não registrado"}</dd></div>
          <div><dt>Última movimentação</dt><dd>{date(order.ultima_movimentacao_em)}</dd></div>
        </dl>
        <section className="preview-notes"><h3>Observações</h3><p>{String(order.observacoes || "Nenhuma observação registrada.")}</p></section>
        <footer><button className="ui-button ui-button-primary" onClick={() => onOpenFull(order.id)}>Abrir ficha completa</button><button className="ui-button" onClick={onClose}>Voltar à lista</button></footer>
      </>}
    </div>
  </Overlay>;
}
