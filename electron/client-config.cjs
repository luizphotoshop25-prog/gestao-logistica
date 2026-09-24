const fs = require("node:fs");
const path = require("node:path");

function isPrivateApiHost(hostname) {
  if (hostname === "127.0.0.1" || hostname === "localhost") return true;
  const parts = hostname.split(".").map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && (parts[0] === 10 || (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31)
      || (parts[0] === 192 && parts[1] === 168));
}

function validateApiUrl(apiUrl, mode) {
  let target;
  try { target = new URL(apiUrl); } catch { throw new Error("URL da API do Gestão Logística inválida."); }
  if (target.origin !== apiUrl || target.username || target.password || target.search || target.hash || target.pathname !== "/") {
    throw new Error("A API deve ser configurada com uma origem, sem caminho ou credenciais.");
  }
  if (target.protocol === "https:" && !isPrivateApiHost(target.hostname) && mode === "https-remote") return "https-remote";
  if (target.protocol === "http:" && target.port && isPrivateApiHost(target.hostname) && mode === "lan-pilot") return "lan-pilot";
  throw new Error("API remota exige HTTPS público com mode=https-remote; LAN exige HTTP privado com mode=lan-pilot.");
}

function loadClientConfig({ configPath, environment = process.env }) {
  let fileConfig = {};
  const explicit = Boolean(environment.GESTAO_CLIENT_CONFIG);
  if (explicit && !path.isAbsolute(configPath)) throw new Error("GESTAO_CLIENT_CONFIG deve ser absoluto.");
  if (fs.existsSync(configPath)) fileConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
  else if (explicit) throw new Error("GESTAO_CLIENT_CONFIG não encontrado.");
  const transport = environment.GESTAO_DATA_TRANSPORT || fileConfig.transport || "ipc";
  if (transport !== "ipc" && transport !== "http") throw new Error("Transporte de dados inválido.");
  const apiUrl = environment.GESTAO_API_URL || fileConfig.apiUrl || "";
  const mode = environment.GESTAO_CLIENT_MODE || fileConfig.mode || (environment.GESTAO_LAN_PILOT === "1" ? "lan-pilot" : "");
  if (transport === "ipc") {
    if (explicit || apiUrl || mode) throw new Error("Configuração remota incompleta: transporte HTTP obrigatório.");
    return { transport, apiUrl: "", mode: "ipc" };
  }
  return { transport, apiUrl, mode: validateApiUrl(apiUrl, mode) };
}

module.exports = { loadClientConfig, validateApiUrl };
