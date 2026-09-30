const http = require("node:http");
const path = require("node:path");
const { randomBytes, timingSafeEqual } = require("node:crypto");
const { saveCredential } = require("../server/integrations/digital/credential-store.cjs");

const dataDir = process.env.GESTAO_SERVER_DATA;
const username = process.env.DIGITAL_PROVISION_LOGIN;
if (process.argv.length !== 2 || !dataDir || !path.isAbsolute(dataDir)
  || !username || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username)) {
  process.stderr.write("DIGITAL_CONFIG_ERROR\n");
  process.exit(1);
}

const csrf = randomBytes(32).toString("hex");
let used = false;
let origin;
const headers = {
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY"
};
const escapeHtml = (value) => value.replace(/[&<>"']/g, (character) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
const sameToken = (value) => typeof value === "string" && value.length === csrf.length
  && timingSafeEqual(Buffer.from(value), Buffer.from(csrf));

function reply(response, status, body, extra = {}) {
  response.writeHead(status, { ...headers, "Content-Type": "text/html; charset=utf-8", ...extra });
  response.end(body);
}

const server = http.createServer(async (request, response) => {
  if (used || request.headers.host !== new URL(origin).host) {
    reply(response, 403, "Indisponível"); return;
  }
  if (request.method === "GET" && request.url === "/") {
    reply(response, 200, `<!doctype html><html lang="pt-BR"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Credencial Digital Fotos</title>
<style>body{font:16px system-ui;background:#f2f5fa;color:#15233b;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:white;border:1px solid #d8e0eb;border-radius:12px;padding:30px;width:min(380px,calc(100vw - 60px))}
label{display:block;margin:18px 0 7px}input{box-sizing:border-box;width:100%;padding:12px;border:1px solid #aebfd1;border-radius:7px;font:inherit}
button{margin-top:22px;width:100%;padding:12px;background:#176fca;color:white;border:0;border-radius:7px;font:inherit;cursor:pointer}
small{color:#54657a}</style><main><h1>Digital Fotos</h1><p>Provisionamento local no PC servidor.</p>
<p>Conta: <strong>${escapeHtml(username)}</strong></p><form method="post" action="/provision" autocomplete="off">
<input type="hidden" name="csrf" value="${csrf}"><label for="password">Senha Digital Fotos</label>
<input id="password" name="password" type="password" required autofocus autocomplete="new-password">
<button type="submit">Salvar com proteção Windows</button></form>
<p><small>Esta página usa somente 127.0.0.1 e fecha após salvar.</small></p></main></html>`,
    { "Set-Cookie": `digital_provision=${csrf}; HttpOnly; SameSite=Strict; Path=/` });
    return;
  }
  if (request.method !== "POST" || request.url !== "/provision") {
    reply(response, 404, "Não encontrado"); return;
  }
  const trustedOrigin = request.headers.origin === origin
    || (request.headers.origin === "null" && request.headers["sec-fetch-site"] === "same-origin");
  if (!trustedOrigin
    || request.headers["content-type"] !== "application/x-www-form-urlencoded"
    || !sameToken(request.headers.cookie?.match(/(?:^|;\s*)digital_provision=([^;]+)/)?.[1])) {
    reply(response, 403, "Requisição rejeitada"); return;
  }
  let body = "";
  try {
    const chunks = [];
    let bytes = 0;
    for await (const chunk of request) {
      bytes += chunk.length;
      if (bytes > 4096) throw new Error("LIMIT");
      chunks.push(chunk);
    }
    body = Buffer.concat(chunks).toString("utf8");
    const form = new URLSearchParams(body);
    const password = form.get("password");
    if (!sameToken(form.get("csrf")) || form.getAll("password").length !== 1
      || typeof password !== "string" || password.length < 1 || password.length > 1024) {
      reply(response, 400, "Formulário inválido"); return;
    }
    used = true;
    await saveCredential(dataDir, { username, password });
    reply(response, 200, "<!doctype html><html lang=pt-BR><meta charset=utf-8><title>Concluído</title><p>Credencial protegida. Esta janela pode ser fechada.</p></html>");
    process.stdout.write("DIGITAL_CREDENTIAL_PROVISIONED\n");
    server.close();
  } catch {
    used = true;
    reply(response, 500, "Falha ao proteger a credencial. Nenhuma senha foi exibida.");
    process.stdout.write("DIGITAL_CREDENTIAL_STORE_ERROR\n");
    server.close();
    process.exitCode = 1;
  } finally { body = ""; }
});

server.listen(0, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(`DIGITAL_PROVISION_URL=${origin}/\n`);
});
setTimeout(() => { if (!used) { server.close(); process.exitCode = 1; } }, 30 * 60 * 1000).unref();
