import { FormEvent, useEffect, useState } from "react";
import { App } from "./App";
import { dataService } from "./services/dataService";

export function AuthenticatedApp() {
  const httpMode = window.gestaoConfig.dataTransport === "http";
  const [user, setUser] = useState<AuthUser | null>(httpMode ? null : { id: "ipc-local", nome: "Usuário local", usuario: "local" });
  const [loading, setLoading] = useState(httpMode);
  const [usuario, setUsuario] = useState("");
  const [senha, setSenha] = useState("");
  const [message, setMessage] = useState("");
  useEffect(() => { if (!httpMode) return; void (async () => { const token = await window.gestaoSession.read(); if (token) { dataService.restoreSession(token); const result = await dataService.currentUser(); if (result.ok && result.user) setUser(result.user); else await window.gestaoSession.clear(); } setLoading(false); })(); }, [httpMode]);
  const login = async (event: FormEvent) => { event.preventDefault(); setMessage(""); const result = await dataService.login({ usuario, senha }); if (!result.ok || !result.user || !result.session) return setMessage(result.message || "Não foi possível entrar."); await window.gestaoSession.write(result.session); setSenha(""); setUser(result.user); };
  const logout = async () => { await dataService.logout(); await window.gestaoSession.clear(); setUser(null); };
  if (loading) return <div className="auth-screen"><p>Validando sessão…</p></div>;
  if (!user) return <div className="auth-screen"><form className="auth-card" onSubmit={login}><span>GESTÃO LOGÍSTICA</span><h1>Entrar</h1><label>Usuário<input autoFocus value={usuario} onChange={(event) => setUsuario(event.target.value)} /></label><label>Senha<input type="password" value={senha} onChange={(event) => setSenha(event.target.value)} /></label>{message && <p className="auth-error">{message}</p>}<button className="primary" type="submit">Entrar</button></form></div>;
  return <><App />{httpMode && <div className="current-user"><span>{user.nome}</span><button onClick={() => void logout()}>Sair</button></div>}</>;
}
