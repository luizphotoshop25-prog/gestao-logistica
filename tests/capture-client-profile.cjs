const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const output = path.resolve("work/client-profile-review");

if (!process.versions.electron) {
  (async () => {
    const server = await (await import("vite")).createServer({ server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    const env = { ...process.env, PROFILE_CAPTURE_ORIGIN: `http://127.0.0.1:${server.httpServer.address().port}` };
    delete env.ELECTRON_RUN_AS_NODE;
    try { await new Promise((resolve, reject) => { const child = spawn(require("electron"), [__filename], { env, stdio: "inherit", windowsHide: true }); child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(Error(`Capture exit ${code}`))); }); }
    finally { await server.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require("electron");
  fs.mkdirSync(output, { recursive: true });
  app.setPath("userData", path.join(output, "profile"));
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1366, height: 768, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on("console-message", details => { if (details.level === 3) errors.push(details.message); });
    const evaluate = code => win.webContents.executeJavaScript(code);
    const pause = (ms = 250) => new Promise(resolve => setTimeout(resolve, ms));
    async function wait(selector) { for (let i = 0; i < 100; i++) { if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return; await pause(); } throw Error(`Missing ${selector}`); }
    async function capture(name) { await evaluate("document.fonts.ready"); await evaluate("new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))"); await pause(500); fs.writeFileSync(path.join(output, name + ".png"), (await win.webContents.capturePage()).toPNG()); }
    async function enterOrders(query = "") {
      await evaluate('document.querySelectorAll(".app-navigation>button")[1].click()');
      await wait(".orders-table .session-link");
      if (query) { await evaluate(`(()=>{const input=document.querySelector('.orders-search input');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(query)});input.dispatchEvent(new Event('input',{bubbles:true}))})()`); await pause(300); }
    }
    try {
      await win.loadURL(`${process.env.PROFILE_CAPTURE_ORIGIN}/tests/central-fixture.html?count=55`);
      await wait(".app-navigation");
      await evaluate("window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copied.push(text)}})");
      await enterOrders();
      assert.equal(await evaluate('window.profileCalls.length'), 0, "profile data should load on demand");
      assert.equal(await evaluate('document.querySelectorAll(".client-profile-trigger:not(:disabled)").length>0'), true);
      assert.equal(await evaluate('document.querySelector(".orders-table tbody tr:nth-child(4) .client-profile-trigger").disabled'), true, "unlinked-client trigger must be disabled");

      const first = '.orders-table tbody tr:nth-child(1) .client-profile-trigger';
      await evaluate(`document.querySelector(${JSON.stringify(first)}).focus();document.querySelector(${JSON.stringify(first)}).click()`);
      await wait(".client-profile-loading");
      await wait(".client-profile-fields");
      assert.equal(await evaluate('document.querySelector(".client-profile-popover").innerText.includes("Ana Cliente Sintética")'), true);
      assert.equal(await evaluate('window.profileCalls.length'), 1);
      await capture("client-profile-complete-1366x768");

      const copyButton = label => evaluate(`[...document.querySelectorAll('.client-profile-field button')].find(button=>button.getAttribute('aria-label')===${JSON.stringify('Copiar ' + label)}).click()`);
      await copyButton("CPF/CNPJ"); await pause(50); assert.equal(await evaluate('window.copied.at(-1)'), "123.456.789-01");
      await copyButton("E-mail"); await pause(50); assert.equal(await evaluate('window.copied.at(-1)'), "ana@example.invalid");
      await copyButton("Telefone"); await pause(50); assert.equal(await evaluate('window.copied.at(-1)'), "(41) 3333-4444");
      await copyButton("Endereço"); await pause(50); assert.equal(await evaluate('window.copied.at(-1)'), "Rua de Teste, 123 · Sala 2 · Centro");
      await evaluate('document.querySelector(".client-profile-footer .ui-button").click()'); await pause(50);
      const copiedAll = await evaluate('window.copied.at(-1)');
      assert.match(copiedAll, /Nome: Ana Cliente Sintética/);
      assert.match(copiedAll, /CPF\/CNPJ: 123\.456\.789-01/);
      assert.match(copiedAll, /Cidade\/UF: Curitiba\/PR/);
      assert.equal(copiedAll.includes("\n\n"), false, "copy-all must not include blank lines");

      await evaluate('window.profileFailures=1;document.querySelectorAll(".client-profile-trigger:not(:disabled)")[1].click()');
      await wait(".client-profile-error");
      assert.equal(await evaluate('document.querySelector(".client-profile-error").innerText.includes("Tentar novamente")'), true);
      await capture("client-profile-error-1366x768");
      await evaluate('document.querySelector(".client-profile-error button").click()'); await wait(".client-profile-fields");
      assert.equal(await evaluate('document.querySelector(".client-profile-popover").innerText.includes("Não informado")'), true, "partial profile must explicitly show missing values");
      assert.equal(await evaluate('document.querySelector(".client-profile-popover").innerText.includes("12.345.678/0001-90")'), true, "CNPJ must be formatted for display");
      await capture("client-profile-partial-1366x768");

      const beforeSwitchCalls = await evaluate("window.profileCalls.length");
      await evaluate('document.querySelectorAll(".client-profile-trigger:not(:disabled)")[2].click()'); await wait(".client-profile-fields");
      assert.equal(await evaluate("window.profileCalls.length"), beforeSwitchCalls + 1, "second trigger should switch directly to another profile");
      assert.equal(await evaluate('document.querySelector(".client-profile-popover").innerText.includes("Camila Cliente Sintética")'), true);

      const table = '.orders-table-wrap';
      await evaluate(`document.querySelector(${JSON.stringify(table)}).scrollTop=180`); await pause(50);
      await evaluate('(()=>{const select=document.querySelectorAll(".orders-control select")[1];Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,"value").set.call(select,"session-desc");select.dispatchEvent(new Event("change",{bubbles:true}))})()'); await pause(180);
      await evaluate('document.querySelector(".client-profile-trigger:not(:disabled)").focus();document.querySelector(".client-profile-trigger:not(:disabled)").click()'); await wait(".client-profile-fields");
      const baseline = await evaluate('JSON.stringify({options:window.lastOrderOptions,filter:document.querySelectorAll(".orders-control select")[0].value,sort:document.querySelectorAll(".orders-control select")[1].value,scroll:document.querySelector(".orders-table-wrap").scrollTop,page:document.querySelector(".pagination").innerText})');
      await evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
      await pause(100);
      assert.equal(await evaluate('!!document.querySelector(".client-profile-popover")'), false);
      assert.equal(await evaluate('document.activeElement.classList.contains("client-profile-trigger")'), true, "Escape should restore focus");
      assert.deepEqual(JSON.parse(await evaluate('JSON.stringify({options:window.lastOrderOptions,filter:document.querySelectorAll(".orders-control select")[0].value,sort:document.querySelectorAll(".orders-control select")[1].value,scroll:document.querySelector(".orders-table-wrap").scrollTop,page:document.querySelector(".pagination").innerText})')), JSON.parse(baseline), "close must preserve list state and scroll");

      await evaluate('document.querySelectorAll(".client-profile-trigger:not(:disabled)")[0].click()'); await wait(".client-profile-fields");
      await evaluate('(()=>{const input=document.querySelector(".orders-search input");input.dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}));input.focus()})()'); await wait(".orders-search input"); await pause(100);
      assert.equal(await evaluate('!!document.querySelector(".client-profile-popover")'), false, "outside click should close profile");
      assert.equal(await evaluate('window.lastOrderOptions.filter'), "needs_me");

      await win.setContentSize(1366, 768); await pause(150);
      const lastVisible = '.orders-table tbody tr:last-child .client-profile-trigger:not(:disabled)';
      await evaluate('document.querySelector(".orders-table-wrap").scrollTop=document.querySelector(".orders-table-wrap").scrollHeight'); await pause(150);
      await evaluate(`document.querySelector(${JSON.stringify(lastVisible)}).focus();document.querySelector(${JSON.stringify(lastVisible)}).click()`); await wait(".client-profile-fields"); await pause(300);
      const bounds = await evaluate('(()=>{const r=document.querySelector(".client-profile-popover").getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()');
      assert(bounds.left >= 0 && bounds.top >= 0 && bounds.right <= bounds.width && bounds.bottom <= bounds.height, `popover out of viewport: ${JSON.stringify(bounds)}, expanded=${await evaluate(`document.querySelector(${JSON.stringify(lastVisible)})?.getAttribute('aria-expanded')`)}, calls=${await evaluate("JSON.stringify(window.profileCalls)")}`);
      await evaluate('document.querySelectorAll(".client-profile-trigger:not(:disabled)")[1].click()'); await wait(".client-profile-fields"); await pause(180);
      await win.setContentSize(1920, 1080); await pause(250);
      const wideBounds = await evaluate('(()=>{const r=document.querySelector(".client-profile-popover").getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:innerWidth,height:innerHeight}})()');
      assert(wideBounds.left >= 0 && wideBounds.top >= 0 && wideBounds.right <= wideBounds.width && wideBounds.bottom <= wideBounds.height, `wide popover out of viewport: ${JSON.stringify(wideBounds)}`);
      assert.equal(await evaluate('document.querySelector(".client-profile-popover").innerText.includes("Não informado")'), true);
      await capture("client-profile-edge-partial-1920x1080");

      await win.loadURL(`${process.env.PROFILE_CAPTURE_ORIGIN}/tests/central-fixture.html?transport=http`); await wait(".app-navigation");
      await evaluate("window.copied=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copied.push(text)}})");
      await enterOrders(); await evaluate('document.querySelector(".client-profile-trigger:not(:disabled)").click()'); await wait(".client-profile-fields");
      assert.equal(await evaluate('document.querySelector(".client-profile-popover").innerText.includes("Cliente Sintética")'), true, "remote HTTP profile should load");

      assert.deepEqual(errors, []);
      console.log(`Ficha rápida do cliente: captura concluída; sob demanda, IPC e HTTP, cópia, erros, estados parciais, foco, scroll e borda aprovados. ${output}`);
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
}
