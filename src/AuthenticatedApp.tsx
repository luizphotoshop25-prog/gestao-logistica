import { FormEvent, useEffect, useState } from "react";
import { App } from "./App";
import { dataService } from "./services/dataService";

export function AuthenticatedApp() {
  const httpMode = window.gestaoConfig.dataTransport === "http";
  const [user, setUser] = useState<AuthUser | null>(httpMode ? null : { id: "ipc-local", nome: "Usuário local", usuario: "local", role: "coordinator" });
  const [loading, setLoading] = useState(httpMode);
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [message, setMessage] = useState("");
  const restore = async () => { setLoading(true); setMessage(""); try { const token = await window.gestaoSession.read(); if (token) { dataService.restoreSession(token); const result = await dataService.currentUser(); if (result.ok && result.user) setUser(result.user); else await window.gestaoSession.clear(); } } catch (error) { setMessage(error instanceof Error ? error.message : "Não foi possível conectar ao servidor do Gestão Logística."); } finally { setLoading(false); } };
  useEffect(() => { if (httpMode) void restore(); }, [httpMode]);
  useEffect(() => {
    if (!httpMode) return;
    const expired = () => { setUser(null); setMessage("Sessão expirada. Entre novamente."); void window.gestaoSession.clear(); };
    window.addEventListener("gestao:session-expired", expired);
    return () => window.removeEventListener("gestao:session-expired", expired);
  }, [httpMode]);
  const login = async (event: FormEvent) => { event.preventDefault(); setMessage(""); try { const result = await dataService.login({ usuario, senha }); if (!result.ok || !result.user || !result.session) return setMessage(result.message || "Não foi possível entrar."); await window.gestaoSession.write(result.session); setSenha(""); setUser(result.user); } catch (error) { setMessage(error instanceof Error ? error.message : "Não foi possível conectar ao servidor do Gestão Logística."); } };
  const logout = async () => { try { await dataService.logout(); } catch { /* Sessão local deve ser limpa mesmo sem rede. */ } finally { await window.gestaoSession.clear(); setUser(null); } };
  if (loading) return <div className="auth-screen"><p>Validando sessão…</p></div>;
  if (!user) return <div className="auth-screen"><form className="auth-card" onSubmit={login}><span>GESTÃO LOGÍSTICA</span><h1>Entrar</h1><label>Usuário<input autoFocus value={usuario} onChange={(event) => setUsuario(event.target.value)} /></label><label>Senha<input type="password" value={senha} onChange={(event) => setSenha(event.target.value)} /></label>{message && <p className="auth-error">{message}</p>}<button className="primary" type="submit">Entrar</button>{message.includes("conectar") && <button type="button" onClick={() => void restore()}>Tentar novamente</button>}</form></div>;
  return <><App currentUser={user} />{httpMode && <div className="current-user"><span>{user.nome}</span><button onClick={() => void logout()}>Sair</button></div>}</>;
}
