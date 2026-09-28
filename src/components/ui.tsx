import { useEffect, useRef, type ReactNode } from "react";

export function ViewState({ kind, title, description, onRetry }: { kind: 'loading' | 'error' | 'empty'; title: string; description?: string; onRetry?: () => void }) {
  return <div className={'ui-state ui-state-' + kind} role={kind === 'error' ? 'alert' : 'status'} aria-busy={kind === 'loading'}>{kind === 'loading' && <span className="ui-spinner" />}<strong>{title}</strong>{description && <p>{description}</p>}{onRetry && <button className="ui-button" onClick={onRetry}>Tentar novamente</button>}</div>;
}

// Base para os próximos formulários e previews; a ficha atual permanece intacta.
export function Overlay({ title, children, onClose, variant = 'modal' }: { title: string; children: ReactNode; onClose: () => void; variant?: 'modal' | 'drawer' }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const dialog = ref.current;
    dialog?.showModal();
    return () => { dialog?.close(); previous?.focus(); };
  }, []);
  return <dialog ref={ref} className={'ui-overlay ui-' + variant} aria-label={title} onCancel={event => { event.preventDefault(); onClose(); }}><header><h2>{title}</h2><button className="ui-button" aria-label="Fechar" onClick={onClose}>×</button></header>{children}</dialog>;
}
