import { useEffect, useRef, useState } from "react";
import { Activity, AlertTriangle, ArrowRight, Clock3, CornerDownLeft, Search, Users, X } from "lucide-react";

type Props = {
  open: boolean;
  query: string;
  results: Order[];
  onQueryChange(value: string): void;
  onClose(): void;
  onOpenOrder(order: Order): void;
  onFilter(filter: string): void;
  onClients(): void;
};

const shortcuts = [
  { label: "Abrir pedidos que precisam de mim", hint: "Fila operacional", icon: Activity, action: "needs_me" },
  { label: "Abrir alertas operacionais", hint: "Erros e atrasos", icon: AlertTriangle, action: "alerts" },
  { label: "Abrir pedidos aguardando terceiros", hint: "Cliente, tratamento ou fornecedor", icon: Clock3, action: "waiting" },
];

export function CommandPalette({ open, query, results, onQueryChange, onClose, onOpenOrder, onFilter, onClients }: Props) {
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setActiveIndex(0);
    window.setTimeout(() => inputRef.current?.focus(), 0);
  }, [open, query]);
  if (!open) return null;

  const itemCount = query.trim() ? results.length : shortcuts.length + 1;
  const chooseActive = () => {
    if (query.trim()) {
      const order = results[activeIndex];
      if (order) onOpenOrder(order);
      return;
    }
    if (activeIndex < shortcuts.length) onFilter(shortcuts[activeIndex].action);
    else onClients();
  };

  return <div className="command-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
    <section className="command-palette" role="dialog" aria-modal="true" aria-label="Busca rápida e comandos">
      <header><Search size={19} /><input ref={inputRef} value={query} onChange={(event) => onQueryChange(event.target.value)} onKeyDown={(event) => {
        if (event.key === "ArrowDown") { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, Math.max(0, itemCount - 1))); }
        if (event.key === "ArrowUp") { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
        if (event.key === "Enter") { event.preventDefault(); chooseActive(); }
        if (event.key === "Escape") onClose();
      }} placeholder="Busque por sessão, cliente, telefone, CAD ou rastreio..." /><kbd>Esc</kbd><button onClick={onClose} aria-label="Fechar busca"><X size={16} /></button></header>
      <div className="command-content">
        {query.trim() ? <>
          <span className="command-section-label">PEDIDOS ENCONTRADOS</span>
          {results.map((order, index) => <button key={order.id} className={`command-result ${index === activeIndex ? "active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => onOpenOrder(order)}>
            <span className="command-session">{order.sessao}</span><span className="command-main"><strong>{order.cliente_nome || "Cliente não identificado"}</strong><small>{order.acao_recomendada || "Abrir ficha do pedido"}</small></span><ArrowRight size={16} />
          </button>)}
          {!results.length && <div className="command-empty"><Search size={20} /><strong>Nenhum pedido localizado</strong><span>Tente pesquisar por outro identificador.</span></div>}
        </> : <>
          <span className="command-section-label">NAVEGAÇÃO RÁPIDA</span>
          {shortcuts.map((item, index) => { const Icon = item.icon; return <button key={item.action} className={`command-result ${index === activeIndex ? "active" : ""}`} onMouseEnter={() => setActiveIndex(index)} onClick={() => onFilter(item.action)}><span className="command-icon"><Icon size={16} /></span><span className="command-main"><strong>{item.label}</strong><small>{item.hint}</small></span><ArrowRight size={16} /></button>; })}
          <button className={`command-result ${activeIndex === shortcuts.length ? "active" : ""}`} onMouseEnter={() => setActiveIndex(shortcuts.length)} onClick={onClients}><span className="command-icon"><Users size={16} /></span><span className="command-main"><strong>Consultar cadastro de clientes</strong><small>Nome, telefone, e-mail ou CAD</small></span><ArrowRight size={16} /></button>
        </>}
      </div>
      <footer><span><kbd>↑</kbd><kbd>↓</kbd> navegar</span><span><CornerDownLeft size={13} /> abrir</span><span><kbd>Ctrl K</kbd> de qualquer tela</span></footer>
    </section>
  </div>;
}
