const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const net = require("node:net");
const database = require("../electron/database.cjs");
let active = false;
const SESSION_HOURS = 12;
const LOGIN_FAILURE_LIMIT = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const loginFailures = new Map();

function hashToken(token) { return crypto.createHash("sha256").update(token).digest("hex"); }
function createPasswordHash(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return `scrypt:v1:${salt}:${derived}`;
}
function verifyPassword(password, stored) {
  const parts = cleanHash(stored).split(":");
  if (parts.length !== 4 || parts[0] !== "scrypt" || parts[1] !== "v1") return false;
  const expected = Buffer.from(parts[3], "hex");
  const actual = crypto.scryptSync(String(password), parts[2], expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}
function cleanHash(value) { return String(value || ""); }
function publicUser(user) { return user ? { id: user.id, nome: user.nome, usuario: user.usuario, role: user.role || "employee" } : null; }
function readBearer(request) {
  const header = String(request.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
}

function loginRateKey(request) {
  const cloudflareIp = String(request.headers["cf-connecting-ip"] || "").trim();
  return net.isIP(cloudflareIp) ? cloudflareIp : request.socket.remoteAddress || "unknown";
}

function loginRateStatus(key, time = Date.now()) {
  const entry = loginFailures.get(key);
  if (!entry) return { allowed: true };
  if (entry.blockedUntil > time) return { allowed: false, retryAfter: Math.ceil((entry.blockedUntil - time) / 1000) };
  if (entry.windowStarted + LOGIN_WINDOW_MS <= time) loginFailures.delete(key);
  return { allowed: true };
}

function recordLoginFailure(key, time = Date.now()) {
  if (loginFailures.size > 5000) {
    for (const [candidate, entry] of loginFailures) {
      if (entry.blockedUntil <= time && entry.windowStarted + LOGIN_WINDOW_MS <= time) loginFailures.delete(candidate);
    }
  }
  const previous = loginFailures.get(key);
  const entry = !previous || previous.windowStarted + LOGIN_WINDOW_MS <= time
    ? { windowStarted: time, failures: 0, blockedUntil: 0 }
    : previous;
  entry.failures += 1;
  if (entry.failures >= LOGIN_FAILURE_LIMIT) entry.blockedUntil = time + LOGIN_WINDOW_MS;
  loginFailures.set(key, entry);
  return entry.blockedUntil > time ? Math.ceil((entry.blockedUntil - time) / 1000) : 0;
}

function sendJson(response, statusCode, body, allowedOrigin = "") {
  response.statusCode = statusCode;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  if (allowedOrigin) response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 1024 * 1024) throw Object.assign(new Error("Corpo excede 1 MB."), { code: "PAYLOAD_TOO_LARGE" });
  }
  try { return body ? JSON.parse(body) : {}; }
  catch { throw Object.assign(new Error("JSON inválido."), { code: "INVALID_JSON" }); }
}

async function requireSession(request) {
  const token = readBearer(request);
  if (!token) return null;
  const user = database.getSessionUser(hashToken(token));
  return user && user.ativo ? user : null;
}

function startApiServer({ userDataPath, dataDirectory, host = "127.0.0.1", port = 0, allowedOrigin = "", lanPilot = false } = {}) {
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("Porta da API inválida.");
  if (lanPilot) {
    if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error("dataDirectory absoluto é obrigatório no modo LAN.");
    if (!host || port === 0) throw new Error("Modo servidor exige host explícito e porta estável.");
  } else {
    if (!userDataPath || !path.isAbsolute(userDataPath)) throw new Error("userDataPath absoluto é obrigatório.");
    if (host !== "127.0.0.1") throw new Error("Host de rede exige modo LAN explícito.");
  }
  if (active) throw new Error("Somente uma API pode operar por processo.");
  const resolvedPath = path.resolve(lanPilot ? dataDirectory : userDataPath);
  if (!lanPilot) {
    const relativePath = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(path.dirname(resolvedPath)));
    if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error("userDataPath deve ficar no diretório temporário.");
  }
  if (fs.existsSync(resolvedPath) && fs.lstatSync(resolvedPath).isSymbolicLink()) throw new Error("Diretório de dados não pode ser link simbólico.");
  active = true;
  try {
    if (lanPilot) database.initializeDataDirectory(resolvedPath);
    else database.initialize({ getPath: () => resolvedPath });
  } catch (error) { active = false; database.close(); throw error; }

  const server = http.createServer(async (request, response) => {
    const requestOrigin = request.headers.origin || "";
    const allowedOrigins = Array.isArray(allowedOrigin) ? allowedOrigin : allowedOrigin ? [allowedOrigin] : [];
    const responseOrigin = requestOrigin && allowedOrigins.includes(requestOrigin) ? requestOrigin : "";
    const errorBody = (error, message) => ({ error, message });
    if (requestOrigin && !responseOrigin) return sendJson(response, 403, errorBody("ORIGIN_NOT_ALLOWED", "Origem não permitida."));
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      if (responseOrigin) response.setHeader("Access-Control-Allow-Origin", responseOrigin);
      response.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      return response.end();
    }
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true, database: "available" }, responseOrigin);
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const rateKey = loginRateKey(request);
        const rate = loginRateStatus(rateKey);
        if (!rate.allowed) {
          response.setHeader("Retry-After", String(rate.retryAfter));
          return sendJson(response, 429, errorBody("LOGIN_RATE_LIMITED", "Muitas tentativas de login. Aguarde antes de tentar novamente."), responseOrigin);
        }
        const body = await readJson(request);
        const user = database.getUserForLogin(body.usuario);
        if (!user || !user.ativo || !verifyPassword(body.senha || "", user.senha_hash)) {
          const retryAfter = recordLoginFailure(rateKey);
          if (retryAfter) response.setHeader("Retry-After", String(retryAfter));
          return sendJson(response, retryAfter ? 429 : 401, { ...errorBody(retryAfter ? "LOGIN_RATE_LIMITED" : "INVALID_CREDENTIALS", retryAfter ? "Muitas tentativas de login. Aguarde antes de tentar novamente." : "Usuário ou senha inválidos.") }, responseOrigin);
        }
        loginFailures.delete(rateKey);
        const token = crypto.randomBytes(32).toString("base64url");
        const expiraEm = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
        database.createSession({ usuarioId: user.id, tokenHash: hashToken(token), expiraEm });
        return sendJson(response, 200, { ok: true, user: publicUser(user), session: token, expiraEm }, responseOrigin);
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const token = readBearer(request);
        if (token) database.revokeSession(hashToken(token));
        return sendJson(response, 200, { ok: true }, responseOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/auth/current") {
        const user = await requireSession(request);
        return user ? sendJson(response, 200, { ok: true, user: publicUser(user) }, responseOrigin) : sendJson(response, 401, { ok: false, message: "Sessão inválida ou expirada." }, responseOrigin);
      }
      const currentUser = await requireSession(request);
      if (!currentUser) return sendJson(response, 401, { ok: false, message: "Sessão inválida ou expirada." }, responseOrigin);
      if (request.method === "GET" && url.pathname === "/api/solicitations/assignees") {
        if (currentUser.role !== "coordinator") return sendJson(response, 403, errorBody("FORBIDDEN", "Somente a coordenação pode consultar responsáveis."), responseOrigin);
        return sendJson(response, 200, { ok: true, rows: database.listActiveUsers() }, responseOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/solicitations") {
        return sendJson(response, 200, { ok: true, rows: database.listSolicitations({ userId: currentUser.id, role: currentUser.role }) }, responseOrigin);
      }
      if (request.method === "POST" && url.pathname === "/api/solicitations") {
        if (currentUser.role !== "coordinator") return sendJson(response, 403, errorBody("FORBIDDEN", "Somente a coordenação pode criar solicitações."), responseOrigin);
        const body = await readJson(request);
        const result = database.createSolicitation({
          descricao: body.descricao,
          observacao: body.observacao,
          sessao_codigo: body.sessao_codigo,
          responsavel_usuario_id: body.responsavel_usuario_id,
          prazo_em: body.prazo_em,
          criado_por_usuario_id: currentUser.id,
          criado_por_nome: currentUser.nome,
        });
        return sendJson(response, result.ok ? 201 : 400, result, responseOrigin);
      }
      const solicitationAction = url.pathname.match(/^\/api\/solicitations\/([^/]+)\/(start|complete|cancel|reopen)$/);
      if (solicitationAction && request.method === "POST") {
        const [, solicitationId, action] = solicitationAction;
        if (["cancel", "reopen"].includes(action) && currentUser.role !== "coordinator")
          return sendJson(response, 403, errorBody("FORBIDDEN", "Somente a coordenação pode cancelar ou reabrir solicitações."), responseOrigin);
        const body = await readJson(request);
        const result = database.transitionSolicitation({ id: decodeURIComponent(solicitationId), revision: body.revision, action, actorUserId: currentUser.id, actorRole: currentUser.role });
        const status = result.ok ? 200 : result.error === "NOT_FOUND" ? 404 : result.error === "REVISION_CONFLICT" ? 409 : 400;
        return sendJson(response, status, result, responseOrigin);
      }
      const solicitation = url.pathname.match(/^\/api\/solicitations\/([^/]+)$/);
      if (solicitation && request.method === "GET") {
        const item = database.getSolicitation(decodeURIComponent(solicitation[1]), { userId: currentUser.id, role: currentUser.role });
        return item ? sendJson(response, 200, { ok: true, solicitation: item }, responseOrigin)
          : sendJson(response, 404, errorBody("NOT_FOUND", "Solicitação não encontrada."), responseOrigin);
      }
      if (solicitation && request.method === "PATCH") {
        if (currentUser.role !== "coordinator") return sendJson(response, 403, errorBody("FORBIDDEN", "Somente a coordenação pode editar solicitações."), responseOrigin);
        const body = await readJson(request);
        const result = database.updateSolicitation({ id: decodeURIComponent(solicitation[1]), revision: body.revision, values: body.values });
        const status = result.ok ? 200 : result.error === "NOT_FOUND" ? 404 : result.error === "REVISION_CONFLICT" ? 409 : 400;
        return sendJson(response, status, result, responseOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/orders") {
        const rows = database.listOrders({ search: url.searchParams.get("search") || "", filter: url.searchParams.get("filter") || "all" });
        return sendJson(response, 200, { ok: true, rows }, responseOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") return sendJson(response, 200, { ok: true, dashboard: database.getDashboard() }, responseOrigin);
      const match = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (match && request.method === "GET") {
        const result = database.getOrder(decodeURIComponent(match[1]));
        return sendJson(response, result.ok ? 200 : 404, result, responseOrigin);
      }
      if (match && request.method === "PATCH") {
        const body = await readJson(request);
        if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) return sendJson(response, 400, errorBody("INVALID_INPUT", "values é obrigatório."), responseOrigin);
        const result = database.updateOrder({ id: decodeURIComponent(match[1]), revisao: body.revisao, values: body.values, usuarioId: currentUser.id });
        return sendJson(response, result.ok ? 200 : result.error === "REVISION_CONFLICT" ? 409 : 400, result, responseOrigin);
      }
      return sendJson(response, 404, errorBody("NOT_FOUND", "Rota não encontrada."), responseOrigin);
    } catch (error) {
      const statusCode = error.code === "INVALID_JSON" ? 400 : error.code === "PAYLOAD_TOO_LARGE" ? 413 : 500;
      return sendJson(response, statusCode, errorBody(error.code || "INTERNAL_ERROR", statusCode === 500 ? "Erro interno." : error.message), responseOrigin);
    }
  });

  return new Promise((resolve, reject) => {
    const fail = (error) => { database.close(); active = false; reject(error); };
    server.once("error", fail);
    server.listen(port, host, () => {
      server.removeListener("error", fail);
      const address = server.address();
      resolve({ host, port: address.port, origin: `http://${host}:${address.port}`, close: async () => { await new Promise((done) => server.close(done)); database.close(); active = false; } });
    });
  });
}

if (require.main === module) {
  const userDataPath = process.env.GESTAO_API_TEST_USER_DATA;
  if (!userDataPath) throw new Error("GESTAO_API_TEST_USER_DATA é obrigatório no modo CLI.");
  startApiServer({ userDataPath, port: Number(process.env.GESTAO_API_PORT || 0) }).then(({ origin }) => console.log(origin));
}

module.exports = { startApiServer };
module.exports.createPasswordHash = createPasswordHash;
