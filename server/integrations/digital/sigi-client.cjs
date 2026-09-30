const { randomUUID } = require("node:crypto");
const history = require("../../../tools/digital-history/core.cjs");
const { discoverSigiConfiguration } = require("./sigi-config.cjs");

const FIELDS = ["Zid", "Chave", "DadosRepositorioSerializado"];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const coded = (code) => Object.assign(new Error(code), { code });

function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /senha|password|username|email|cookie|authorization|zid|chave|dadosrepositorioserializado|token/i.test(key)
      ? "<REDACTED>" : redact(item)]));
}

function decode(raw) {
  let result = raw;
  for (let i = 0; i < 3 && typeof result === "string"; i++) {
    try { result = JSON.parse(result); } catch { throw coded("DIGITAL_UNEXPECTED_RESPONSE"); }
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) throw coded("DIGITAL_UNEXPECTED_RESPONSE");
  return result;
}

class SigiClient {
  constructor({ fetchImpl = fetch, credentialProvider, timeoutMs = 15000, delayMs = 500,
    pause = sleep, deviceId = randomUUID(), discover = discoverSigiConfiguration } = {}) {
    this.fetchImpl = fetchImpl;
    this.credentialProvider = credentialProvider;
    this.timeoutMs = timeoutMs;
    this.delayMs = delayMs;
    this.pause = pause;
    this.deviceId = deviceId;
    this.discover = discover;
    this.state = null;
    this.baseUrl = null;
    this.version = null;
    this.authenticated = false;
    this.lastRequestAt = 0;
    this.credentials = null;
  }

  close() {
    if (this.credentials) { this.credentials.username = undefined; this.credentials.password = undefined; }
    this.credentials = null;
    this.state = null;
    this.authenticated = false;
    this.baseUrl = null;
  }

  updateSessionState(payload) {
    if (!this.state) return;
    let nested;
    try { nested = typeof payload.ObjetoRetorno === "string" ? JSON.parse(payload.ObjetoRetorno) : payload.ObjetoRetorno; }
    catch { nested = null; }
    for (const source of [payload, nested]) {
      if (!source || typeof source !== "object") continue;
      for (const field of FIELDS) if (typeof source[field] === "string" && source[field]) this.state[field] = source[field];
    }
  }

  async post(route, fields = {}) {
    if (!this.baseUrl || !this.state) throw coded("DIGITAL_SESSION_ERROR");
    const url = new URL(route, this.baseUrl);
    if (url.protocol !== "https:" || url.hostname !== "online-ws.sigi.com.br"
      || !url.pathname.startsWith(this.baseUrl.pathname)) throw coded("DIGITAL_CONFIG_ERROR");
    const elapsed = Date.now() - this.lastRequestAt;
    if (this.lastRequestAt && elapsed < this.delayMs) await this.pause(this.delayMs - elapsed);
    const form = new FormData();
    for (const [key, value] of Object.entries({ ...this.state, ...fields })) form.set(key, String(value ?? ""));
    for (let attempt = 0; attempt < 2; attempt++) {
      let response;
      try {
        this.lastRequestAt = Date.now();
        response = await this.fetchImpl(url, { method: "POST", body: form, redirect: "error",
          signal: AbortSignal.timeout(this.timeoutMs) });
      } catch {
        if (attempt === 0) { await this.pause(1000); continue; }
        throw coded("DIGITAL_API_UNAVAILABLE");
      }
      if (response.status === 429) throw coded("DIGITAL_RATE_LIMIT");
      if (response.status === 401 || response.status === 403) throw coded("DIGITAL_SESSION_ERROR");
      if (response.status >= 500 && attempt === 0) { await this.pause(1000); continue; }
      if (!response.ok) throw coded("DIGITAL_API_UNAVAILABLE");
      let payload;
      try { payload = decode(await response.text()); }
      catch { throw coded("DIGITAL_UNEXPECTED_RESPONSE"); }
      this.updateSessionState(payload);
      if ([5, 6, 9].includes(payload.Status)) throw coded("DIGITAL_SESSION_ERROR");
      if (payload.Status !== 0) throw coded("DIGITAL_UNEXPECTED_RESPONSE");
      const result = payload.ObjetoRetorno;
      if (typeof result !== "string") return result;
      try { return JSON.parse(result); } catch { return result; }
    }
    throw coded("DIGITAL_API_UNAVAILABLE");
  }

  async login() {
    if (typeof this.credentialProvider !== "function") throw coded("DIGITAL_CREDENTIAL_MISSING");
    const supplied = await this.credentialProvider();
    if (!supplied || typeof supplied.username !== "string" || !supplied.username
      || typeof supplied.password !== "string" || !supplied.password) throw coded("DIGITAL_CREDENTIAL_MISSING");
    this.credentials = { username: supplied.username, password: supplied.password };
    try {
      const config = await this.discover(this.fetchImpl, this.timeoutMs);
      this.baseUrl = config.baseUrl;
      this.version = config.version || null;
      this.state = { Zid: config.zid, Chave: "", DadosRepositorioSerializado: "" };
      await this.post("App/ObterViewModel");
      if (!this.state.Chave || !this.state.DadosRepositorioSerializado) throw coded("DIGITAL_BOOTSTRAP_ERROR");
      if (await this.post("Login/ValidarEmail", { email: this.credentials.username }) !== true)
        throw coded("DIGITAL_LOGIN_INVALID");
      if (await this.post("Login/ValidarSenha", { email: this.credentials.username,
        senha: this.credentials.password }) !== true) throw coded("DIGITAL_LOGIN_INVALID");
      const login = await this.post("Login/VerificarLogin", {
        "vmLogin[Username]": this.credentials.username,
        "vmLogin[Senha]": this.credentials.password,
        "vmLogin[IsLembrarCredenciais]": "false",
        "vmLogin[CredenciaisSerializada]": "",
        "vmLogin[AcaoAposLogin]": "0",
        "vmDispositivo[Navegador]": "GestaoLogistica-DigitalSync 0.1",
        "vmDispositivo[SistemaOperacional]": "Windows",
        "vmDispositivo[Dispositivo]": "Windows",
        "vmDispositivo[OrigemPedido]": "1",
        "vmDispositivo[IdentificadorComputador]": this.deviceId,
        "vmDispositivo[IsNaoCorrigirCorDensidade]": "false"
      });
      if (!login || login.Status !== 1 || !login.Cliente) throw coded("DIGITAL_LOGIN_INVALID");
      this.authenticated = true;
    } catch (error) {
      this.authenticated = false;
      this.state = null;
      const known = new Set(["DIGITAL_CREDENTIAL_MISSING", "DIGITAL_CREDENTIAL_STORE_ERROR",
        "DIGITAL_CREDENTIAL_PLATFORM_UNSUPPORTED", "DIGITAL_CONFIG_ERROR", "DIGITAL_BOOTSTRAP_ERROR",
        "DIGITAL_LOGIN_INVALID", "DIGITAL_SESSION_ERROR", "DIGITAL_API_UNAVAILABLE",
        "DIGITAL_RATE_LIMIT", "DIGITAL_UNEXPECTED_RESPONSE"]);
      const reason = error?.code || error?.message;
      throw coded(known.has(reason) ? reason : "DIGITAL_LOGIN_PROTOCOL_ERROR");
    } finally {
      // The provider remains callable for a single controlled renewal; plaintext stays process-local.
      if (this.credentials) { this.credentials.username = undefined; this.credentials.password = undefined; }
      this.credentials = null;
    }
  }

  async read(route, fields) {
    if (!this.authenticated) await this.login();
    try { return await this.post(route, fields); }
    catch (error) {
      if (error.code !== "DIGITAL_SESSION_ERROR") throw error;
      this.authenticated = false;
      await this.login();
      return this.post(route, fields); // Read-only endpoints only; exactly one renewal/replay.
    }
  }

  async listOrders(page, pageSize = 25, count = false) {
    const payload = await this.read("Pedido/Pedidos", { pagina: String(page),
      registrosPorPagina: String(pageSize), isContarRegistros: String(count) });
    return history.parseOrderList({ ObjetoRetorno: payload });
  }

  async getOrderDetail(meta) {
    const payload = await this.read("Pedido/DadosPedido", { idFotoPedido: String(meta.idFotoPedido), isResumo: "false" });
    return history.extractDetail({ ObjetoRetorno: payload }, meta);
  }
}

module.exports = { SigiClient, redact, decode };
