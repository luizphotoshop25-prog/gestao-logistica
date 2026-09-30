const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain, session } = require("electron");

const projectRoot = path.join(__dirname, "..");
const realProfilePath = path.resolve(app.getPath("userData"));
const profilePath = process.env.GESTAO_CAPTURE_PROFILE;
if (!profilePath) throw new Error("Execute npm run capture:ui para preparar o perfil isolado.");
const resolvedProfilePath = path.resolve(profilePath);
const devServerUrl = process.env.GESTAO_DEV_SERVER_URL;
if (!devServerUrl || !/^http:\/\/127\.0\.0\.1:\d+$/.test(devServerUrl)) throw new Error("Origem local dinâmica ausente ou inválida.");
const devServerHost = new URL(devServerUrl).host;
const httpTransport = process.env.GESTAO_DATA_TRANSPORT === "http";
const apiUrl = process.env.GESTAO_API_URL || "";
if (httpTransport && !/^http:\/\/127\.0\.0\.1:\d+$/.test(apiUrl)) throw new Error("API loopback HTTP ausente ou inválida.");
const apiHost = httpTransport ? new URL(apiUrl).host : "";
const expectedSession = process.env.GESTAO_CAPTURE_SESSION || "M99999";
const expectedClientName = process.env.GESTAO_CAPTURE_CLIENT_NAME || "Cliente Teste Visual";
const captureUser = process.env.GESTAO_CAPTURE_USER || "";
const capturePassword = process.env.GESTAO_CAPTURE_PASSWORD || "";
const outputPath = process.env.GESTAO_CAPTURE_PATH || path.join(projectRoot, "work", "gestao-logistica-ui.png");
const menuOutputPath = outputPath.replace(/\.png$/i, "-menu.png");
const detailOutputPath = outputPath.replace(/\.png$/i, "-pedido.png");
const detailTabs = ["operation", "history"];
const nativeSetTimeout = global.setTimeout;
const nativeSetInterval = global.setInterval;
const database = require("../electron/database.cjs");
const initializeDatabase = database.initialize;

if (resolvedProfilePath === realProfilePath || !resolvedProfilePath.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
  throw new Error(`Captura visual recusada: userData temporário inválido (${resolvedProfilePath}).`);
}

database.initialize = (electronApp) => {
  if (httpTransport) throw new Error("O cliente HTTP não deve abrir SQLite local.");
  const activeProfilePath = path.resolve(electronApp.getPath("userData"));
  if (activeProfilePath !== resolvedProfilePath) throw new Error(`Captura visual recusada: userData inesperado (${activeProfilePath}).`);
  initializeDatabase(electronApp);
  const digitalSessions = ["M60001", "M60002", "M60003", "M60004"];
  const fixtureRows = [{ eligible: true, linha: 1, sessao: "M99999", clienteNome: "Cliente Teste Visual", clienteEmail: "teste-visual@example.invalid", clienteTelefone: "00000000000", clienteCidade: "Curitiba - TESTE", fotosQuantidade: 25, observacoes: "Fixture sintético da captura visual.", editor: "Editor Teste", selecaoFinalizadaEm: null, tratamentoConcluido: false }, ...digitalSessions.map((sessao, index) => ({ eligible: true, linha: index + 2, sessao, clienteNome: `Cliente Exemplo ${String.fromCharCode(65 + index)}`, clienteEmail: `digital-${index}@example.invalid`, clienteTelefone: `0000000000${index + 1}`, clienteCidade: "Curitiba - TESTE", fotosQuantidade: 8 + index * 2, observacoes: "Fixture sintético de Enviados Digital.", editor: "Editor Teste", selecaoFinalizadaEm: null, tratamentoConcluido: false }))];
  const fixture = database.importSafeRows({ rows: fixtureRows });
  if (!fixture.ok || fixture.imported !== fixtureRows.length) throw new Error(`Não foi possível preparar o fixture visual: ${fixture.message || "resultado inesperado"}.`);
  const coordinator = database.createUser({ nome: "Coordenação Teste", usuario: "coordenacao-visual", role: "coordinator", senhaHash: "fixture-sintetico" });
  const employee = database.createUser({ nome: "Carlos Teste", usuario: "carlos-visual", role: "employee", senhaHash: "fixture-sintetico" });
  if (!coordinator.ok || !employee.ok) throw new Error("Não foi possível preparar usuários sintéticos para a captura de Solicitações.");
  const digitalOrders = digitalSessions.map((sessao) => database.listOrders({ search: sessao })[0]);
  const includedDigitalOrders = digitalOrders.filter((_order, index) => index !== 2);
  const digital = database.createDigitalShipment({ numeroPedidoDigital: "900001", dataEnvio: "2026-09-29", pedidoIds: includedDigitalOrders.map((order) => order.id), itensDigital: 32, quantidadesEnviadas: { [includedDigitalOrders[0].id]: 20, [includedDigitalOrders[1].id]: 8, [includedDigitalOrders[2].id]: 4 }, actorUserId: coordinator.user.id, actorRole: "coordinator" });
  if (!digital.ok) throw new Error(`Não foi possível preparar o fixture de Enviados Digital: ${digital.message || "resultado inesperado"}.`);
  const now = Date.now();
  const createRequest = (descricao, prazo, sessao = "M99999") => database.createSolicitation({ descricao, observacao: "Fixture visual sintética para validar a hierarquia dos detalhes.", sessao_codigo: sessao, responsavel_usuario_id: employee.user.id, criado_por_usuario_id: coordinator.user.id, criado_por_nome: coordinator.user.nome, prazo_em: prazo });
  for (const [descricao, prazo] of [
    ["Revisar seleção e separar as imagens prioritárias", new Date(now - 2 * 86400000).toISOString()],
    ["Confirmar arquivos recebidos do laboratório", new Date(now + 3 * 3600000).toISOString()],
    ["Preparar conferência da próxima remessa", new Date(now + 30 * 3600000).toISOString()],
  ]) {
    const result = createRequest(descricao, prazo);
    if (!result.ok) throw new Error(`Não foi possível preparar solicitação visual: ${result.message || "resultado inesperado"}.`);
  }
  const noDeadline = createRequest("Organizar pendências sem prazo definido", null, "");
  if (!noDeadline.ok) throw new Error(`Não foi possível preparar solicitação sem prazo: ${noDeadline.message || "resultado inesperado"}.`);
};



const delay = (milliseconds) => new Promise((resolve) => nativeSetTimeout(resolve, milliseconds));

async function waitForSelector(window, selector, timeout = 5000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const found = await window.webContents.executeJavaScript(`Boolean(document.querySelector(${JSON.stringify(selector)}))`);
    if (found) return;
    await delay(80);
  }
  const detail = selector.includes("digital-table") ? await window.webContents.executeJavaScript("document.querySelector('.digital-screen')?.innerText.slice(0,900)") : "";
  throw new Error(`A captura visual não encontrou ${selector} em ${timeout} ms. ${detail}`);
}

async function capture(window, destination) {
  await window.webContents.executeJavaScript("window.scrollTo(0, 0); document.documentElement.scrollLeft = 0; document.body.scrollLeft = 0");
  await window.webContents.executeJavaScript("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await delay(220);
  const image = await window.webContents.capturePage();
  fs.writeFileSync(destination, image.toPNG());
}

// O teste valida somente a interface; sincronizações automáticas ficam desligadas.
global.setTimeout = (callback, delay, ...args) => delay === 1500 ? 0 : nativeSetTimeout(callback, delay, ...args);
global.setInterval = () => 0;

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
app.setPath("userData", profilePath);

// O teste visual deve permanecer invisível e nunca disputar o foco com o usuário.
BrowserWindow.prototype.show = function suppressVisualTestWindow() {};
const allowedChannels = new Set(["app:status", "updater:get-state", "auth:local-current", "orders:list", "orders:get", "orders:treatment-assignees", "clients:list", "dashboard:get", "siwin:status", "solicitations:list", "solicitations:get", "solicitations:assignees", "solicitations:create", "digital-shipments:list", "digital-shipments:get", "digital-shipments:for-order", "digital-shipments:resolve-sessions", "digital-shipments:create", "digital-shipments:update"]);
if (httpTransport) {
  allowedChannels.clear();
  allowedChannels.add("updater:get-state");
  allowedChannels.add("auth-session:read");
  allowedChannels.add("auth-session:write");
  allowedChannels.add("auth-session:clear");
}
const registerHandler = ipcMain.handle.bind(ipcMain);
let digitalListCalls = 0;
ipcMain.handle = (channel, handler) => registerHandler(channel, async (...args) => {
  if (channel === "digital-shipments:list") digitalListCalls++;
  if (allowedChannels.has(channel)) return handler(...args);
  fail(new Error(`IPC externo ou de escrita bloqueado: ${channel}`));
  return { ok: false, message: "Bloqueado pelo smoke visual." };
});
function fail(error) {
  console.error(error);
  database.close();
  app.exit(1);
}
process.on("unhandledRejection", fail);
process.on("uncaughtException", fail);
app.on("web-contents-created", (_event, contents) => {
  contents.on("preload-error", (_event, _file, error) => fail(error));
  contents.on("render-process-gone", (_event, details) => fail(new Error(JSON.stringify(details))));
  contents.on("did-fail-load", (_event, code, description) => fail(new Error(`Renderer: ${code} ${description}`)));
  contents.on("console-message", (details) => { if (details.level === 3) fail(new Error(details.message)); });
});
app.whenReady().then(() => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const url = new URL(details.url);
    const allowed = ["http:", "ws:"].includes(url.protocol) && [devServerHost, apiHost].includes(url.host);
    callback({ cancel: !allowed && !["data:", "devtools:"].includes(url.protocol) });
  });
});
require("../electron/main.cjs");

app.whenReady().then(() => {
  const poll = nativeSetInterval(() => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window || window.webContents.isLoading()) return;
    clearInterval(poll);
    nativeSetTimeout(async () => {
      try {
        if (httpTransport) {
          await waitForSelector(window, ".auth-card");
          await capture(window, outputPath.replace(/\.png$/i, "-login.png"));
          await window.webContents.executeJavaScript(`(() => { const inputs=document.querySelectorAll('.auth-card input'); const set=(input,value)=>{ const setter=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set; setter.call(input,value); input.dispatchEvent(new Event('input',{bubbles:true})); }; set(inputs[0],${JSON.stringify(captureUser)}); set(inputs[1],${JSON.stringify(capturePassword)}); document.querySelector('.auth-card').requestSubmit(); })()`);
        }
        await waitForSelector(window, ".app-navigation");
        await window.webContents.executeJavaScript("document.querySelectorAll('.app-navigation>button')[1].click()");
        await waitForSelector(window, ".session-link");
        const visible = await window.webContents.executeJavaScript(`document.body.innerText.includes(${JSON.stringify(expectedSession)}) && document.body.innerText.includes(${JSON.stringify(expectedClientName)}) && typeof window.gestaoAPI.getOrder === "function" && (!${httpTransport} || window.gestaoConfig.dataTransport === "http")`);
        if (!visible) throw new Error("Fixture ou preload ausente.");
        await capture(window, outputPath);
        if (httpTransport) {
          await window.webContents.executeJavaScript("document.querySelector('.client-profile-trigger:not(:disabled)').click()");
          await waitForSelector(window, ".client-profile-fields");
          const profileLoaded = await window.webContents.executeJavaScript(`document.querySelector('.client-profile-popover').innerText.includes(${JSON.stringify(expectedClientName)})`);
          if (!profileLoaded) throw new Error("Ficha rápida HTTP não exibiu o cliente do banco sintético.");
          await capture(window, outputPath.replace(/\.png$/i, "-client-profile.png"));
          await window.webContents.executeJavaScript("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
          await window.webContents.executeJavaScript("document.querySelector('.session-link').click()");
          await waitForSelector(window, ".order-preview .ui-button-primary");
          const remotePreviewPath = outputPath.replace(/\.png$/i, "-preview.png");
          await capture(window, remotePreviewPath);
          await window.webContents.executeJavaScript("document.querySelector('.order-preview .ui-button-primary').click()");
          await waitForSelector(window, ".detail-modal");
          const remoteDetailPath = outputPath.replace(/\.png$/i, "-pedido.png");
          await capture(window, remoteDetailPath);
          process.stdout.write(`userData=${resolvedProfilePath}\n${outputPath}\n${remotePreviewPath}\n${remoteDetailPath}\n`);
          app.exit(0);
          return;
        }
        await window.webContents.executeJavaScript("document.querySelector('.integration-trigger')?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, pointerType: 'mouse' }))");
        await waitForSelector(window, ".app-menu-content");
        await capture(window, menuOutputPath);
        window.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        window.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await delay(180);
        await window.webContents.executeJavaScript("document.querySelector('.session-link').click()");
        await waitForSelector(window, ".order-preview");
        await waitForSelector(window, ".order-preview .ui-button-primary");
        await window.webContents.executeJavaScript("document.querySelector('.order-preview .ui-button-primary').click()");
        await waitForSelector(window, ".detail-modal");
        await capture(window, detailOutputPath);

        const generatedPaths = [outputPath, menuOutputPath, detailOutputPath];
        for (const tab of detailTabs) {
          const tabSelector = `.detail-nav button:nth-child(${detailTabs.indexOf(tab) + 2})`;
          await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(tabSelector)}).click()`);
          await waitForSelector(window, `.detail-modal[data-tab="${tab}"]`);
          const tabOutputPath = outputPath.replace(/\.png$/i, `-pedido-${tab}.png`);
          await capture(window, tabOutputPath);
          generatedPaths.push(tabOutputPath);
        }

        await window.webContents.executeJavaScript("document.querySelector('.detail-modal button[aria-label=\"Fechar ficha\"]')?.click()");
        await delay(220);
        await window.webContents.executeJavaScript("document.querySelectorAll('.app-navigation>button')[4].click()");
        await waitForSelector(window, ".solicitations-page");
        await waitForSelector(window, ".solicitation-card");
        const filterAndSearchPassed = await window.webContents.executeJavaScript(`(() => {
          const buttons = [...document.querySelectorAll('.solicitation-filters button')];
          const pending = buttons.find((button) => button.innerText.includes('Pendentes'));
          pending?.click();
          const pendingCount = document.querySelectorAll('.solicitation-card').length;
          const input = document.querySelector('.solicitation-search input');
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
          setter.call(input, 'próxima remessa'); input.dispatchEvent(new Event('input', { bubbles: true }));
          const searchMatches = [...document.querySelectorAll('.solicitation-card')].length === 1 && document.querySelector('.solicitation-card-title')?.innerText.includes('próxima remessa');
          setter.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true }));
          buttons.find((button) => button.innerText.includes('Abertas'))?.click();
          return pendingCount === 4 && searchMatches;
        })()`);
        if (!filterAndSearchPassed) throw new Error("Filtros ou busca de Solicitações não corresponderam aos fixtures visuais.");
        const solicitationListPath = outputPath.replace(/\.png$/i, "-solicitacoes.png");
        await capture(window, solicitationListPath);
        generatedPaths.push(solicitationListPath);
        await window.webContents.executeJavaScript("document.querySelector('.solicitation-card-main')?.click()");
        await waitForSelector(window, ".solicitation-detail-grid");
        const solicitationDetailPath = outputPath.replace(/\.png$/i, "-solicitacao-detalhe.png");
        await capture(window, solicitationDetailPath);
        generatedPaths.push(solicitationDetailPath);
        await window.webContents.executeJavaScript("document.querySelector('.solicitation-detail-pane .icon-button')?.click()");
        await delay(180);
        await window.webContents.executeJavaScript("document.querySelector('.solicitations-new')?.click()");
        await waitForSelector(window, "#solicitation-create-title");
        const solicitationCreatePath = outputPath.replace(/\.png$/i, "-solicitacao-nova.png");
        await capture(window, solicitationCreatePath);
        generatedPaths.push(solicitationCreatePath);
        await window.webContents.executeJavaScript(`(async () => {
          const form = document.querySelector('.solicitation-modal');
          const areas = form.querySelectorAll('textarea');
          const set = (element, value, prototype) => { Object.getOwnPropertyDescriptor(prototype, 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); element.dispatchEvent(new Event('change', { bubbles: true })); };
          set(areas[0], 'Validar criação pela interface de Solicitações', HTMLTextAreaElement.prototype);
          set(form.querySelector('select'), form.querySelector('select').options[1].value, HTMLSelectElement.prototype);
          await new Promise((resolve) => setTimeout(resolve, 80));
          form.requestSubmit();
          return { assignees: form.querySelector('select').options.length, selected: form.querySelector('select').value };
        })()`);
        const createdByUi = await (async () => {
          const deadline = Date.now() + 5000;
          while (Date.now() < deadline) {
            const found = database.listSolicitations({ role: "coordinator" }).find((item) => item.descricao === "Validar criação pela interface de Solicitações");
            if (found) return found.responsavel_usuario === "carlos-visual";
            await delay(80);
          }
          return false;
        })();
        if (!createdByUi) throw new Error(`A criação pela interface não persistiu a solicitação atribuída ao usuário sintético. Linhas atuais: ${JSON.stringify(database.listSolicitations({ role: "coordinator" }).map((item) => item.descricao))}`);

        await window.webContents.executeJavaScript("document.querySelector('.solicitation-modal .icon-button')?.click();document.querySelector('.shell-secondary button')?.click()");
        await waitForSelector(window, ".clients-table tbody tr");
        const clientsVisible = await window.webContents.executeJavaScript("document.querySelector('.clients-table')?.innerText.includes('Cliente Teste Visual') && document.querySelector('.shell-secondary [aria-current=page]')?.textContent.includes('Clientes')");
        if (!clientsVisible) throw new Error("A consulta de clientes não exibiu o cadastro sintético na nova página.");
        const clientsPath = outputPath.replace(/\.png$/i, "-clientes.png");
        await capture(window, clientsPath);
        generatedPaths.push(clientsPath);

        const setValue = async (selector, value, prototype = "HTMLInputElement") => window.webContents.executeJavaScript(`(() => { const element=document.querySelector(${JSON.stringify(selector)}); const setter=Object.getOwnPropertyDescriptor(${prototype}.prototype,'value').set; setter.call(element,${JSON.stringify(value)}); element.dispatchEvent(new Event('input',{bubbles:true})); element.dispatchEvent(new Event('change',{bubbles:true})); })()`);
        const waitText = async (selector, text) => {
          for (let attempt = 0; attempt < 60; attempt++) {
            if (await window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.innerText.includes(${JSON.stringify(text)})`)) return;
            await delay(100);
          }
          throw new Error(`Captura Digital sem o texto esperado: ${text}`);
        };
        await window.webContents.executeJavaScript("(() => { window.__nativeInterval = window.setInterval.bind(window); window.setInterval = (callback, milliseconds, ...args) => window.__nativeInterval(callback, milliseconds === 60000 ? 250 : milliseconds, ...args); })()");
        for (const [width, height] of [[1366, 768], [1920, 1080]]) {
          window.setContentSize(width, height);
          await window.webContents.executeJavaScript("document.querySelectorAll('.app-navigation>button')[3].click()");
          await waitForSelector(window, ".digital-panel");
          await window.webContents.executeJavaScript("document.querySelector('.notice button[aria-label=\\\"Fechar aviso\\\"]')?.click()");
          await setValue("#digital-search", ""); await delay(350);
          await waitForSelector(window, ".digital-table tbody tr");
          if (width === 1366) {
            const callsBeforePoll = digitalListCalls;
            await delay(1450);
            if (digitalListCalls <= callsBeforePoll) throw new Error("A listagem Enviados Digital não atualizou pelo polling visível.");
            await window.webContents.executeJavaScript("document.querySelector('.digital-heading .ui-button-primary').click()");
            await waitForSelector(window, ".digital-form-modal");
            await setValue(".digital-form-fields input", "RASCUNHO-SINTETICO");
            const callsWithFormOpen = digitalListCalls;
            await delay(650);
            const formPreserved = await window.webContents.executeJavaScript("document.querySelector('.digital-form-fields input')?.value === 'RASCUNHO-SINTETICO'");
            if (!formPreserved || digitalListCalls !== callsWithFormOpen) throw new Error("O polling alterou o formulário aberto ou continuou consultando durante a edição.");
            await window.webContents.executeJavaScript("document.querySelector('.digital-form-modal [aria-label=\\\"Fechar formulário\\\"]')?.click()");
            await delay(150);
            const callsBeforeReturn = digitalListCalls;
            await window.webContents.executeJavaScript("document.dispatchEvent(new Event('visibilitychange'))");
            const returnDeadline = Date.now() + 3000;
            while (digitalListCalls <= callsBeforeReturn && Date.now() < returnDeadline) await delay(50);
            if (digitalListCalls <= callsBeforeReturn) throw new Error("A listagem não atualizou ao retornar à aba visível.");
            await window.webContents.executeJavaScript("window.setInterval = window.__nativeInterval; document.querySelectorAll('.app-navigation>button')[0].click()");
            await delay(150);
            await window.webContents.executeJavaScript("document.querySelectorAll('.app-navigation>button')[3].click()");
            await waitForSelector(window, ".digital-table tbody tr");
          }
          const saveDigital = async (name) => {
            const destination = path.join(path.dirname(outputPath), `enviados-digital-${name}-${width}x${height}.png`);
            await capture(window, destination); generatedPaths.push(destination);
          };
          await setValue("#digital-search", ""); await delay(350);
          await saveDigital("principal");
          await setValue("#digital-search", "M60001"); await waitText(".digital-session-result", "ENVIO LOCALIZADO");
          await saveDigital("busca-M60001");
          await setValue("#digital-search", "M60003"); await waitText(".digital-no-history", "Nenhum envio");
          await saveDigital("sessao-sem-envio");
          await setValue("#digital-search", ""); await delay(250);
          await window.webContents.executeJavaScript("document.querySelector('.digital-heading .ui-button-primary').click()");
          await waitForSelector(window, ".digital-form-modal");
          await saveDigital("registrar-envio");
          await setValue(".digital-bulk-entry textarea", "M60002\nM60003\nM60004", "HTMLTextAreaElement");
          await window.webContents.executeJavaScript("document.querySelector('.digital-bulk-entry button').click()");
          await waitText(".digital-selection-summary", "3 sessões selecionadas");
          await saveDigital("multiplas-sessoes");
          await window.webContents.executeJavaScript("document.querySelector('.digital-form-modal [aria-label=\\\"Fechar formulário\\\"]').click(); document.querySelector('.digital-heading .ui-button-primary').click()");
          await waitForSelector(window, ".digital-form-modal");
          await setValue(".digital-add-one input", "M60001");
          await window.webContents.executeJavaScript("document.querySelector('.digital-add-one button').click()");
          await waitForSelector(window, ".digital-selected-list .previously-sent");
          await saveDigital("aviso-reenvio");
          await window.webContents.executeJavaScript("document.querySelector('.digital-form-modal [aria-label=\\\"Fechar formulário\\\"]').click()");
          await window.webContents.executeJavaScript("document.querySelector('.digital-number-link').click()");
          await waitForSelector(window, ".digital-detail-modal");
          await saveDigital("detalhe-pedido");
          await window.webContents.executeJavaScript("document.querySelector('.digital-detail-modal [aria-label=\\\"Fechar detalhe\\\"]').click()");
          await setValue("#digital-search", "M60999"); await waitText(".digital-session-result", "Sessão não encontrada");
          await waitForSelector(window, ".digital-screen .ui-state-empty");
          await saveDigital("estado-vazio");
        }

        process.stdout.write(`userData=${resolvedProfilePath}\n${generatedPaths.join("\n")}\n`);
        database.close();
        app.exit(0);
      } catch (error) {
        fail(error);
      }
    }, 2200);
  }, 25);
});
