import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Clipboard, Copy, X } from "lucide-react";

export type ClientProfileTarget = { orderId: string; clientName: string; anchor: HTMLElement };

type Props = {
  target: ClientProfileTarget | null;
  cacheVersion: number;
  onClose: (restoreFocus?: boolean) => void;
};

type Position = { top: number; left: number; width: number };

function clean(value: string | null | undefined): string {
  return String(value || "").trim();
}

function formatCpf(value: string | null): string {
  const original = clean(value);
  const digits = original.replace(/\D/g, "");
  return digits.length === 11 ? digits.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, "$1.$2.$3-$4") : original;
}

function formatCep(value: string | null): string {
  const original = clean(value);
  const digits = original.replace(/\D/g, "");
  return digits.length === 8 ? digits.replace(/(\d{5})(\d{3})/, "$1-$2") : original;
}

function formatPhone(value: string | null): string {
  const original = clean(value);
  const digits = original.replace(/\D/g, "");
  if (digits.length === 11) return digits.replace(/(\d{2})(\d{5})(\d{4})/, "($1) $2-$3");
  if (digits.length === 10) return digits.replace(/(\d{2})(\d{4})(\d{4})/, "($1) $2-$3");
  return original;
}

export function OrderClientProfilePopover({ target, cacheVersion, onClose }: Props) {
  const [result, setResult] = useState<OrderClientProfileResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [position, setPosition] = useState<Position | null>(null);
  const [copyFeedback, setCopyFeedback] = useState("");
  const cache = useRef(new Map<string, OrderClientProfileResult>());
  const panelRef = useRef<HTMLElement>(null);
  const feedbackTimer = useRef<number | null>(null);
  const panelId = target ? `client-profile-${target.orderId.replace(/[^a-zA-Z0-9_-]/g, "")}` : "client-profile-panel";

  useEffect(() => { cache.current.clear(); }, [cacheVersion]);

  useEffect(() => {
    if (!target) {
      setResult(null);
      setFailed(false);
      setLoading(false);
      return;
    }
    let active = true;
    const cached = cache.current.get(target.orderId);
    setFailed(false);
    if (cached) {
      setResult(cached);
      setLoading(false);
      return () => { active = false; };
    }
    setResult(null);
    setLoading(true);
    void window.gestaoAPI.getOrderClientProfile(target.orderId)
      .then((response) => {
        if (!active) return;
        if (!response.ok) {
          setFailed(true);
          return;
        }
        if (response.ok) cache.current.set(target.orderId, response);
        setResult(response);
      })
      .catch(() => {
        if (active) setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [target?.orderId, retry, cacheVersion]);

  useLayoutEffect(() => {
    if (!target) return;
    const updatePosition = () => {
      const currentAnchor = target.anchor.isConnected ? target.anchor : [...document.querySelectorAll<HTMLElement>("[data-order-profile-trigger]")].find((button) => button.dataset.orderProfileTrigger === target.orderId);
      if (!currentAnchor) return onClose(false);
      const anchor = currentAnchor.getBoundingClientRect();
      const width = Math.min(390, Math.max(280, window.innerWidth - 24));
      const height = panelRef.current?.getBoundingClientRect().height || 420;
      let left = anchor.left;
      if (left + width > window.innerWidth - 12) left = anchor.right - width;
      left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
      let top = anchor.bottom + 8;
      if (top + height > window.innerHeight - 12) top = anchor.top - height - 8;
      top = Math.max(12, Math.min(top, window.innerHeight - height - 12));
      const nextPosition = { top, left, width };
      if (panelRef.current) {
        panelRef.current.style.top = `${top}px`;
        panelRef.current.style.left = `${left}px`;
        panelRef.current.style.width = `${width}px`;
      }
      setPosition(nextPosition);
    };
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [target?.orderId, loading, failed, result, onClose]);

  useEffect(() => {
    if (!target) return;
    const onPointerDown = (event: PointerEvent) => {
      const element = event.target as Element | null;
      if (element?.closest(".client-profile-trigger") || panelRef.current?.contains(element)) return;
      onClose(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      onClose(true);
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [target?.orderId, onClose]);

  useEffect(() => () => {
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
  }, []);

  const profile = result?.ok && result.linked ? result.profile : null;
  const address = profile ? [
    [clean(profile.logradouro), clean(profile.numero)].filter(Boolean).join(", "),
    clean(profile.complemento),
    clean(profile.bairro),
  ].filter(Boolean).join(" · ") : "";
  const cityState = profile ? [clean(profile.cidade), clean(profile.uf)].filter(Boolean).join("/") : "";
  const fields: Array<[string, string]> = profile ? ([
    ["Nome", clean(profile.nomeCompleto)],
    ["CPF", formatCpf(profile.cpf)],
    ["E-mail", clean(profile.email)],
    ["Telefone", formatPhone(profile.telefone)],
    ["Celular", formatPhone(profile.celular)],
    ["Endereço", address],
    ["Cidade/UF", cityState],
    ["CEP", formatCep(profile.cep)],
  ] as Array<[string, string]>).filter(([, value]) => value) : [];

  const copy = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopyFeedback(`${label} copiado`);
    } catch {
      setCopyFeedback("Não foi possível copiar");
    }
    if (feedbackTimer.current !== null) window.clearTimeout(feedbackTimer.current);
    feedbackTimer.current = window.setTimeout(() => setCopyFeedback(""), 1800);
  };

  if (!target) return null;
  const copyAll = () => copy(fields.map(([label, value]) => `${label}: ${value}`).join("\n"), "Dados do cliente");
  const noClient = result?.ok && !result.linked;

  return createPortal(
    <section
      ref={panelRef}
      id={panelId}
      className="client-profile-popover"
      role="dialog"
      aria-labelledby={`${panelId}-title`}
      style={{ top: position?.top ?? -10000, left: position?.left ?? 12, width: position?.width ?? 390 }}
    >
      <header className="client-profile-header">
        <div><span className="section-kicker">DADOS DO CLIENTE</span><h2 id={`${panelId}-title`}>{profile?.nomeCompleto || target.clientName}</h2></div>
        <button type="button" className="client-profile-close" aria-label="Fechar dados do cliente" onClick={() => onClose(true)}><X size={17} /></button>
      </header>
      {loading && <div className="client-profile-loading" role="status"><span className="ui-spinner" /><span>Carregando dados cadastrais…</span></div>}
      {failed && <div className="client-profile-error" role="alert"><strong>Não foi possível carregar os dados do cliente.</strong><button type="button" onClick={() => setRetry(value => value + 1)}>Tentar novamente</button></div>}
      {noClient && <div className="client-profile-error" role="status"><strong>Cliente não vinculado</strong></div>}
      {result?.ok && result.linked && profile && <>
        <div className="client-profile-fields">
          {([
            ["CPF", formatCpf(profile.cpf), formatCpf(profile.cpf)],
            ["E-mail", clean(profile.email), clean(profile.email)],
            ["Telefone", formatPhone(profile.telefone), formatPhone(profile.telefone)],
            ["Celular", formatPhone(profile.celular), formatPhone(profile.celular)],
            ["Endereço", address, address],
            ["Cidade / UF", cityState, cityState],
            ["CEP", formatCep(profile.cep), formatCep(profile.cep)],
          ] as Array<[string, string, string | null]>).map(([label, value, copyValue]) => (
            <div className="client-profile-field" key={label}>
              <span>{label}</span><strong>{value || "Não informado"}</strong>
              {copyValue && <button type="button" aria-label={`Copiar ${label}`} onClick={() => void copy(copyValue, label)}><Copy size={14} /></button>}
            </div>
          ))}
        </div>
        <footer className="client-profile-footer">
          <span role="status" aria-live="polite">{copyFeedback}</span>
          <button type="button" className="ui-button" onClick={() => void copyAll()} disabled={!fields.length}><Clipboard size={14} />Copiar dados</button>
        </footer>
      </>}
      {copyFeedback && !profile && <span className="sr-only" role="status">{copyFeedback}</span>}
    </section>,
    document.body,
  );
}
