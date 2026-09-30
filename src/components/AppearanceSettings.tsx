import { useEffect, useRef, useState } from "react";
import { RotateCcw, Settings2, X } from "lucide-react";

const scales = [0.9, 1, 1.1, 1.2, 1.3] as const;

export function AppearanceSettings({
  fontScale,
  onPreview,
  onApply,
}: {
  fontScale: number;
  onPreview: (scale: number) => void;
  onApply: (scale: number) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(fontScale);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionsRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (open) {
      setDraft(fontScale);
      setError("");
      window.requestAnimationFrame(() => optionsRef.current?.querySelector<HTMLButtonElement>("[aria-pressed='true']")?.focus());
    }
  }, [open, fontScale]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) cancel();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open, saving, fontScale]);

  const close = () => {
    setOpen(false);
    window.requestAnimationFrame(() => triggerRef.current?.focus());
  };
  const cancel = () => {
    onPreview(fontScale);
    close();
  };
  const choose = (scale: number) => {
    setDraft(scale);
    setError("");
    onPreview(scale);
  };
  const apply = async () => {
    setSaving(true);
    setError("");
    try {
      if (await onApply(draft)) close();
      else setError("Não foi possível salvar a preferência neste computador.");
    } catch {
      setError("Não foi possível salvar a preferência neste computador.");
    } finally {
      setSaving(false);
    }
  };

  return <>
    <button ref={triggerRef} className="appearance-trigger" type="button" onClick={() => setOpen(true)}>
      <Settings2 size={18} aria-hidden="true" /><span>Aparência</span>
    </button>
    {open && <div className="appearance-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !saving) cancel(); }}>
      <section className="appearance-dialog" role="dialog" aria-modal="true" aria-labelledby="appearance-title" aria-describedby="appearance-help">
        <header className="appearance-dialog-header">
          <div><span className="section-kicker">CONFIGURAÇÕES</span><h2 id="appearance-title">Aparência</h2></div>
          <button className="appearance-close" type="button" aria-label="Fechar configurações" onClick={cancel} disabled={saving}><X size={19} /></button>
        </header>
        <div className="appearance-setting">
          <div className="appearance-setting-heading"><div><h3>Tamanho do texto</h3><p id="appearance-help">A interface acompanha o ajuste enquanto você escolhe.</p></div><strong aria-live="polite">{Math.round(draft * 100)}%</strong></div>
          <div className="appearance-options" role="group" aria-label="Tamanho do texto" ref={optionsRef}>
            {scales.map((scale) => <button key={scale} type="button" aria-pressed={draft === scale} onClick={() => choose(scale)}>{Math.round(scale * 100)}%</button>)}
          </div>
          <div className="appearance-sample" aria-label="Prévia de texto">
            <strong>Prévia</strong>
            <span>Texto mais confortável para acompanhar sua operação.</span>
            <small>Os dados e filtros da tela permanecem como estão.</small>
          </div>
          <p className="appearance-local-note">Esta configuração afeta somente este computador.</p>
          {error && <p className="appearance-error" role="alert">{error}</p>}
        </div>
        <footer className="appearance-actions">
          <button type="button" className="appearance-reset" onClick={() => choose(1)} disabled={saving}><RotateCcw size={16} />Restaurar padrão</button>
          <div><button type="button" className="ui-button" onClick={cancel} disabled={saving}>Cancelar</button><button type="button" className="appearance-apply" onClick={() => void apply()} disabled={saving}>{saving ? "Aplicando…" : "Aplicar"}</button></div>
        </footer>
      </section>
    </div>}
  </>;
}
