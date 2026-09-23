const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const crypto = require("node:crypto");
const database = require("../electron/database.cjs");
let active = false;
const SESSION_HOURS = 12;

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
function publicUser(user) { return user ? { id: user.id, nome: user.nome, usuario: user.usuario } : null; }
function readBearer(request) {
  const header = String(request.headers.authorization || "");
  return header.startsWith("Bearer ") ? header.slice(7).trim() : "";
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

function startApiServer({ userDataPath, host = "127.0.0.1", port = 0, allowedOrigin = "" } = {}) {
  if (!userDataPath || !path.isAbsolute(userDataPath)) throw new Error("userDataPath absoluto é obrigatório.");
  if (host !== "127.0.0.1") throw new Error("A API protótipo aceita somente loopback.");
  if (active) throw new Error("Somente uma API pode operar por processo.");
  const resolvedPath = path.resolve(userDataPath);
  const relativePath = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(path.dirname(resolvedPath)));
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) throw new Error("userDataPath deve ficar no diretório temporário.");
  if (fs.existsSync(resolvedPath) && fs.lstatSync(resolvedPath).isSymbolicLink()) throw new Error("userDataPath não pode ser link simbólico.");
  active = true;
  try { database.initialize({ getPath: () => resolvedPath }); } catch (error) { active = false; database.close(); throw error; }

  const server = http.createServer(async (request, response) => {
    const requestOrigin = request.headers.origin || "";
    const errorBody = (error, message) => ({ error, message });
    if (requestOrigin && requestOrigin !== allowedOrigin) return sendJson(response, 403, errorBody("ORIGIN_NOT_ALLOWED", "Origem não permitida."));
    if (request.method === "OPTIONS") {
      response.statusCode = 204;
      if (allowedOrigin) response.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      response.setHeader("Access-Control-Allow-Methods", "GET, PATCH, OPTIONS");
      response.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
      response.setHeader("Access-Control-Allow-Private-Network", "true");
      return response.end();
    }
    const url = new URL(request.url, "http://127.0.0.1");
    try {
      if (request.method === "GET" && url.pathname === "/health") return sendJson(response, 200, { ok: true }, allowedOrigin);
      if (request.method === "POST" && url.pathname === "/api/auth/login") {
        const body = await readJson(request);
        const user = database.getUserForLogin(body.usuario);
        if (!user || !user.ativo || !verifyPassword(body.senha || "", user.senha_hash)) return sendJson(response, 401, { ok: false, message: "Usuário ou senha inválidos." }, allowedOrigin);
        const token = crypto.randomBytes(32).toString("base64url");
        const expiraEm = new Date(Date.now() + SESSION_HOURS * 60 * 60 * 1000).toISOString();
        database.createSession({ usuarioId: user.id, tokenHash: hashToken(token), expiraEm });
        return sendJson(response, 200, { ok: true, user: publicUser(user), session: token, expiraEm }, allowedOrigin);
      }
      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
        const token = readBearer(request);
        if (token) database.revokeSession(hashToken(token));
        return sendJson(response, 200, { ok: true }, allowedOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/auth/current") {
        const user = await requireSession(request);
        return user ? sendJson(response, 200, { ok: true, user: publicUser(user) }, allowedOrigin) : sendJson(response, 401, { ok: false, message: "Sessão inválida ou expirada." }, allowedOrigin);
      }
      const currentUser = await requireSession(request);
      if (!currentUser) return sendJson(response, 401, { ok: false, message: "Sessão inválida ou expirada." }, allowedOrigin);
      if (request.method === "GET" && url.pathname === "/api/orders") {
        const rows = database.listOrders({ search: url.searchParams.get("search") || "", filter: url.searchParams.get("filter") || "all" });
        return sendJson(response, 200, { ok: true, rows }, allowedOrigin);
      }
      if (request.method === "GET" && url.pathname === "/api/dashboard") return sendJson(response, 200, { ok: true, dashboard: database.getDashboard() }, allowedOrigin);
      const match = url.pathname.match(/^\/api\/orders\/([^/]+)$/);
      if (match && request.method === "GET") {
        const result = database.getOrder(decodeURIComponent(match[1]));
        return sendJson(response, result.ok ? 200 : 404, result, allowedOrigin);
      }
      if (match && request.method === "PATCH") {
        const body = await readJson(request);
        if (!body.values || typeof body.values !== "object" || Array.isArray(body.values)) return sendJson(response, 400, errorBody("INVALID_INPUT", "values é obrigatório."), allowedOrigin);
        const result = database.updateOrder({ id: decodeURIComponent(match[1]), revisao: body.revisao, values: body.values, usuarioId: currentUser.id });
        return sendJson(response, result.ok ? 200 : result.error === "REVISION_CONFLICT" ? 409 : 400, result, allowedOrigin);
      }
      return sendJson(response, 404, errorBody("NOT_FOUND", "Rota não encontrada."), allowedOrigin);
    } catch (error) {
      const statusCode = error.code === "INVALID_JSON" ? 400 : error.code === "PAYLOAD_TOO_LARGE" ? 413 : 500;
      return sendJson(response, statusCode, errorBody(error.code || "INTERNAL_ERROR", error.message || "Erro interno."), allowedOrigin);
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
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
