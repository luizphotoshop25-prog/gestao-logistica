import { useEffect, useState } from "react";
import { Download, RotateCw, X } from "lucide-react";

export function UpdateNotice() {
  const [state, setState] = useState<AppUpdateState>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let active = true;
    const unsubscribe = window.gestaoAPI.onUpdaterState((next) => {
      if (!active) return;
      setState(next);
      if (next.status === "available" || next.status === "downloaded" || next.status === "error") setDismissed(false);
    });
    void window.gestaoAPI.getUpdaterState().then((result) => {
      if (active && result.ok) setState(result.state);
    }).catch(() => {});
    return () => { active = false; unsubscribe(); };
  }, []);

  if (dismissed || state.status === "idle" || state.status === "checking") return null;
  const close = () => setDismissed(true);

  return <aside className="update-notice" role="status" aria-live="polite">
    <div className="update-notice-copy">
      <strong>{state.status === "available" ? "Nova atualização disponível"
        : state.status === "downloading" ? "Baixando atualização"
          : state.status === "downloaded" ? "Atualização pronta"
            : "Atualização indisponível"}</strong>
      <span>{state.status === "available" ? `Versão ${state.version} pronta para baixar.`
        : state.status === "downloading" ? `${Math.round(state.percent)}% concluído`
          : state.status === "downloaded" ? `Versão ${state.version} pronta para instalar.`
            : ("message" in state ? state.message : "")}</span>
      {state.status === "downloading" && <progress max={100} value={state.percent} />}
    </div>
    <div className="update-notice-actions">
      {state.status === "available" && <button type="button" className="primary" onClick={() => void window.gestaoAPI.downloadAppUpdate()}><Download size={15} /> Atualizar agora</button>}
      {state.status === "downloaded" && <button type="button" className="primary" onClick={() => void window.gestaoAPI.installAppUpdate()}><RotateCw size={15} /> Reiniciar e atualizar</button>}
      {state.status !== "downloading" && <button type="button" className="update-notice-dismiss" onClick={close} aria-label="Depois" title="Depois"><X size={14} /> Depois</button>}
    </div>
  </aside>;
}
