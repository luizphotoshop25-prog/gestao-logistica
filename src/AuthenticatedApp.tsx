import { FormEvent, useEffect, useState } from "react";
import { App } from "./App";
import { dataService } from "./services/dataService";
import { UpdateNotice } from "./components/UpdateNotice";

export function AuthenticatedApp() {
  const httpMode = window.gestaoConfig.dataTransport === "http";
  const [user, setUser] = useState<AuthUser | null>(httpMode ? null : { id: "ipc-local", nome: "Usuário local", usuario: "local", role: "coordinator" });
  const [loading, setLoading] = useState(httpMode);
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [message, setMessage] = useState("");
  const [retrying, setRetrying] = useState(false);
  const [savedFontScale, setSavedFontScale] = useState(1);
  const [previewFontScale, setPreviewFontScale] = useState(1);
  const [startWithWindows, setStartWithWindows] = useState(false);
  const [backgroundOffline, setBackgroundOffline] = useState(false);
  useEffect(() => {
    let active = true;
    void window.gestaoUiPreferences.get().then((result) => {
      if (!active || !result.ok) return;
      setSavedFontScale(result.fontScale);
      setPreviewFontScale(result.fontScale);
      setStartWithWindows(result.startWithWindows);
    }).catch(() => {});
    return () => { active = false; };
  }, []);
  useEffect(() => {
    document.documentElement.style.setProperty("--font-scale", String(previewFontScale));
  }, [previewFontScale]);
  const applyFontScale = async (fontScale: number) => {
    const result = await window.gestaoUiPreferences.set({ fontScale });
    if (!result.ok) return false;
    setSavedFontScale(result.fontScale);
    setPreviewFontScale(result.fontScale);
    return true;
  };
  const applyStartWithWindows = async (startWithWindows: boolean) => {
    const result = await window.gestaoUiPreferences.set({ startWithWindows });
    if (!result.ok) { setMessage(result.message || "Não foi possível salvar a inicialização automática neste computador."); return false; }
    setStartWithWindows(result.startWithWindows);
    setMessage("");
    return true;
  };
  const restore = async () => {
    setLoading(true);
    setMessage("");
    try {
      const token = await window.gestaoSession.read();
      if (!token) {
        if (window.gestaoConfig.backgroundStart) {
          window.gestaoApp.setConnectionStatus("login");
          window.gestaoApp.showAuthenticationWindow();
        }
        return;
      }
      dataService.restoreSession(token);
      const result = await dataService.currentUser();
      if (result.ok && result.user) {
        setUser(result.user);
        setBackgroundOffline(false);
        window.gestaoApp.setConnectionStatus("connected");
      } else {
        await window.gestaoSession.clear();
        setUser(null);
        if (window.gestaoConfig.backgroundStart) {
          window.gestaoApp.setConnectionStatus("login");
          window.gestaoApp.showAuthenticationWindow();
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.toLocaleLowerCase("pt-BR").includes("sessão expirada")) {
        setBackgroundOffline(false);
        setUser(null);
        window.gestaoApp.setConnectionStatus("login");
        if (window.gestaoConfig.backgroundStart) window.gestaoApp.showAuthenticationWindow();
        return;
      }
      if (window.gestaoConfig.backgroundStart) {
        setBackgroundOffline(true);
        window.gestaoApp.setConnectionStatus("waiting");
      } else {
        setMessage(error instanceof Error ? error.message : "Não foi possível conectar ao servidor do Gestão Logística.");
      }
    } finally { setLoading(false); }
  };
  useEffect(() => {
    if (httpMode) void restore();
    else void dataService.currentUser().then(result => { if (result.ok && result.user) setUser(result.user); }).catch(() => {});
  }, [httpMode]);
  useEffect(() => {
    if (!httpMode) return;
    const expired = () => {
      setUser(null);
      setMessage("Sessão expirada. Entre novamente.");
      void window.gestaoSession.clear();
      window.gestaoApp.setConnectionStatus("login");
      if (window.gestaoConfig.backgroundStart) window.gestaoApp.showAuthenticationWindow();
    };
    window.addEventListener("gestao:session-expired", expired);
    return () => window.removeEventListener("gestao:session-expired", expired);
  }, [httpMode]);
  const login = async (event: FormEvent) => { event.preventDefault(); setMessage(""); try { const result = await dataService.login({ usuario, senha }); if (!result.ok || !result.user || !result.session) return setMessage(result.message || "Não foi possível entrar."); await window.gestaoSession.write(result.session); setSenha(""); setBackgroundOffline(false); setUser(result.user); window.gestaoApp.setConnectionStatus("connected"); } catch (error) { setMessage(error instanceof Error ? error.message : "Não foi possível conectar ao servidor do Gestão Logística."); } };
  const retryRemote = async () => {
    setRetrying(true);
    try {
      const result = await window.gestaoSession.retryRemoteConfig();
      if (!result.ok) setMessage(result.message || "Não foi possível conectar ao servidor do Gestão Logística.");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Não foi possível conectar ao servidor do Gestão Logística."); }
    finally { setRetrying(false); }
  };
  const logout = async () => { try { await dataService.logout(); } catch { /* Sessão local deve ser limpa mesmo sem rede. */ } finally { await window.gestaoSession.clear(); setUser(null); window.gestaoApp.setConnectionStatus("login"); } };
  if (loading) return <><div className="auth-screen"><p>Validando sessão…</p></div><UpdateNotice /></>;
  if (backgroundOffline && window.gestaoConfig.backgroundStart) return <><div className="auth-screen"><section className="auth-card"><span>GESTÃO LOGÍSTICA · EM SEGUNDO PLANO</span><div><h1>Aguardando conexão</h1><p className="auth-intro">O Gestão continuará tentando conectar em segundo plano. Abra novamente quando a rede estiver disponível.</p></div><button className="ui-button" type="button" onClick={() => void retryRemote()} disabled={retrying}>{retrying ? "Verificando servidor…" : "Tentar novamente"}</button>{message && <p className="auth-error" role="alert">{message}</p>}</section></div><UpdateNotice /></>;
  if (!user) return <><div className="auth-screen"><form className="auth-card" onSubmit={login}><span>GESTÃO LOGÍSTICA · ESTÚDIO MANOEL GUIMARÃES</span><div><h1>Entrar</h1><p className="auth-intro">Acesse sua central de pedidos e solicitações.</p></div><label>Usuário<input autoFocus autoComplete="username" value={usuario} onChange={(event) => setUsuario(event.target.value)} /></label><label>Senha<input type="password" autoComplete="current-password" value={senha} onChange={(event) => setSenha(event.target.value)} /></label>{message && <p className="auth-error" role="alert">{message}</p>}<button className="primary" type="submit">Entrar</button>{httpMode && message.toLocaleLowerCase("pt-BR").includes("conectar") && <button className="ui-button" type="button" onClick={() => void retryRemote()} disabled={retrying}>{retrying ? "Verificando servidor…" : "Tentar novamente"}</button>}</form></div><UpdateNotice /></>;
  return <><App currentUser={user} onLogout={httpMode ? () => void logout() : undefined} fontScale={savedFontScale} startWithWindows={startWithWindows} onFontScalePreview={setPreviewFontScale} onFontScaleApply={applyFontScale} onStartWithWindowsApply={applyStartWithWindows} /><UpdateNotice /></>;
}
