const fs = require("node:fs");
const path = require("node:path");

const OFFICIAL_REMOTE_CONFIG_URL = "https://raw.githubusercontent.com/luizphotoshop25-prog/gestao-logistica/master/remote-config.json";
const MAX_CONFIG_BYTES = 4096;
const CONFIG_TIMEOUT_MS = 6000;
const API_HEALTH_TIMEOUT_MS = 5000;

function validateRemoteConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.environment !== "pilot" || typeof value.enabled !== "boolean") {
    throw new Error("A configuração remota tem formato inválido.");
  }
  if (!value.enabled) {
    const disabled = new Error("O servidor remoto está temporariamente desativado.");
    disabled.code = "REMOTE_CONFIG_DISABLED";
    throw disabled;
  }
  if (typeof value.apiBaseUrl !== "string" || value.apiBaseUrl.length > 256) throw new Error("A URL da API na configuração remota é inválida.");
  let target;
  try { target = new URL(value.apiBaseUrl); } catch { throw new Error("A URL da API na configuração remota é inválida."); }
  const hostname = target.hostname.toLowerCase();
  const approvedCloudOrigin = hostname.endsWith(".trycloudflare.com") || hostname.endsWith(".workers.dev");
  if (target.protocol !== "https:" || target.origin !== value.apiBaseUrl || target.username || target.password
    || target.pathname !== "/" || target.search || target.hash || !approvedCloudOrigin) {
    throw new Error("A API remota deve usar uma origem HTTPS aprovada do Quick Tunnel ou Cloudflare Workers.");
  }
  return { apiBaseUrl: target.origin, environment: "pilot", enabled: true };
}

async function readResponseText(response, maxBytes) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) throw new Error("A configuração remota excede o tamanho permitido.");
  if (!response.body?.getReader) {
    const content = await response.text();
    if (Buffer.byteLength(content, "utf8") > maxBytes) throw new Error("A configuração remota excede o tamanho permitido.");
    return content;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maxBytes) {
      await reader.cancel();
      throw new Error("A configuração remota excede o tamanho permitido.");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function fetchRemoteConfig({ fetchImpl = globalThis.fetch, configUrl = OFFICIAL_REMOTE_CONFIG_URL, timeoutMs = CONFIG_TIMEOUT_MS, maxBytes = MAX_CONFIG_BYTES } = {}) {
  if (typeof fetchImpl !== "function") throw new Error("A consulta à configuração remota não está disponível.");
  if (configUrl !== OFFICIAL_REMOTE_CONFIG_URL) throw new Error("Origem de configuração remota não aprovada.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(OFFICIAL_REMOTE_CONFIG_URL, {
      method: "GET",
      headers: { accept: "application/json" },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`GitHub respondeu HTTP ${response.status} ao consultar a configuração remota.`);
    if (response.url && response.url !== OFFICIAL_REMOTE_CONFIG_URL) throw new Error("GitHub redirecionou a configuração para uma origem inesperada.");
    const content = await readResponseText(response, maxBytes);
    let parsed;
    try { parsed = JSON.parse(content); } catch { throw new Error("A configuração remota não contém JSON válido."); }
    return validateRemoteConfig(parsed);
  } catch (error) {
    if (error?.name === "AbortError") throw new Error("A consulta à configuração remota excedeu o tempo limite.");
    throw error;
  } finally { clearTimeout(timer); }
}

function readCachedConfig(cachePath) {
  try {
    if (!path.isAbsolute(cachePath)) return null;
    return validateRemoteConfig(JSON.parse(fs.readFileSync(cachePath, "utf8")));
  } catch { return null; }
}

function writeCachedConfig(cachePath, config) {
  if (!path.isAbsolute(cachePath)) throw new Error("O caminho do cache remoto deve ser absoluto.");
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  const temporaryPath = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporaryPath, cachePath);
  } finally { try { fs.rmSync(temporaryPath, { force: true }); } catch {} }
}

async function resolveRemoteConfig({ cachePath, fetchImpl = globalThis.fetch, configUrl = OFFICIAL_REMOTE_CONFIG_URL } = {}) {
  const cached = readCachedConfig(cachePath);
  try {
    const config = await fetchRemoteConfig({ fetchImpl, configUrl });
    try { writeCachedConfig(cachePath, config); } catch {}
    return { ok: true, config, source: "github" };
  } catch (error) {
    if (error?.code === "REMOTE_CONFIG_DISABLED") return { ok: false, error: error.code, message: error.message };
    if (cached) return { ok: true, config: cached, source: "cache" };
    return { ok: false, error: "REMOTE_CONFIG_UNAVAILABLE", message: error?.message || "Configuração remota indisponível." };
  }
}

async function checkRemoteApiHealth(apiBaseUrl, { fetchImpl = globalThis.fetch, timeoutMs = API_HEALTH_TIMEOUT_MS } = {}) {
  let config;
  try { config = validateRemoteConfig({ apiBaseUrl, environment: "pilot", enabled: true }); }
  catch (error) { return { ok: false, message: error?.message || "A URL da API remota é inválida." }; }
  if (typeof fetchImpl !== "function") return { ok: false, message: "A verificação da API remota não está disponível." };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${config.apiBaseUrl}/health`, { method: "GET", headers: { accept: "application/json" }, redirect: "error", signal: controller.signal });
    if (!response.ok) return { ok: false, message: `O servidor da empresa respondeu HTTP ${response.status}.` };
    const health = await response.json();
    if (health?.ok !== true || health?.database !== "available") return { ok: false, message: "O servidor da empresa ainda não está pronto." };
    return { ok: true };
  } catch (error) {
    if (error?.name === "AbortError") return { ok: false, message: "O servidor da empresa demorou para responder." };
    return { ok: false, message: "Não foi possível conectar ao servidor da empresa." };
  } finally { clearTimeout(timer); }
}

module.exports = {
  OFFICIAL_REMOTE_CONFIG_URL,
  MAX_CONFIG_BYTES,
  CONFIG_TIMEOUT_MS,
  validateRemoteConfig,
  fetchRemoteConfig,
  resolveRemoteConfig,
  checkRemoteApiHealth,
};
