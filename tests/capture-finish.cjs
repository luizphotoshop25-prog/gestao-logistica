const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const output = path.resolve('work/final-review');

if (!process.versions.electron) {
  (async () => {
    const server = await (await import('vite')).createServer({ server: { host: '127.0.0.1', port: 0 } });
    await server.listen();
    const env = { ...process.env, REVIEW_ORIGIN: `http://127.0.0.1:${server.httpServer.address().port}` };
    delete env.ELECTRON_RUN_AS_NODE;
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(require('electron'), [__filename], { env, stdio: 'inherit', windowsHide: true });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Captura final falhou: ${code}`)));
      });
    } finally { await server.close(); }
  })().catch(error => { console.error(error); process.exitCode = 1; });
} else {
  const { app, BrowserWindow } = require('electron');
  fs.mkdirSync(output, { recursive: true });
  const profile = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'gestao-final-review-'));
  app.setPath('userData', profile);
  app.whenReady().then(async () => {
    const win = new BrowserWindow({ show: false, width: 1366, height: 768, useContentSize: true, webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
    const errors = [];
    win.webContents.on('console-message', details => { if (details.level === 3) errors.push(details.message); });
    const evaluate = code => win.webContents.executeJavaScript(code);
    const wait = async selector => {
      for (let i = 0; i < 80; i++) {
        if (await evaluate(`!!document.querySelector(${JSON.stringify(selector)})`)) return;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`Elemento ausente: ${selector}`);
    };
    const capture = async name => {
      await evaluate('document.fonts.ready');
      await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
      win.webContents.invalidate();
      await new Promise(resolve => setTimeout(resolve, 350));
      fs.writeFileSync(path.join(output, `${name}.png`), (await win.webContents.capturePage()).toPNG());
    };
    try {
      for (const [width, height] of [[1366, 768], [1920, 1080]]) {
        win.setContentSize(width, height);
        for (const role of ['coordinator', 'employee']) {
          await win.loadURL(`${process.env.REVIEW_ORIGIN}/tests/central-fixture.html?role=${role}`);
          await wait('.central-order');
          await evaluate("document.querySelectorAll('.app-navigation>button')[2].click()");
          await wait('.solicitation-card');
          assert.equal(await evaluate('document.querySelector(".app-navigation button[aria-current=page]")?.textContent'), 'Solicitações');
          assert.equal(await evaluate('document.querySelectorAll(".app-navigation").length'), 1);
          for (let attempt = 0; attempt < 40 && await evaluate('getComputedStyle(document.querySelector(".app-navigation button[aria-current=page]")).backgroundColor !== "rgb(234, 240, 255)"'); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
          assert.equal(await evaluate('getComputedStyle(document.querySelector(".app-navigation button[aria-current=page]")).backgroundColor'), 'rgb(234, 240, 255)', 'Estilo da navegação não carregou');
          assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Rolagem horizontal em Solicitações');
          await capture(`solicitacoes-${role}-${width}x${height}`);
          await evaluate("document.querySelector('.solicitation-card-main').click()");
          await wait('.solicitation-detail-pane');
          await capture(`solicitacao-detalhe-${role}-${width}x${height}`);
          if (role === 'coordinator') {
            await evaluate("document.querySelector('.shell-secondary button').click()");
            await wait('.clients-table tbody tr');
            for (let attempt = 0; attempt < 30 && await evaluate('!!document.querySelector(".clients-state")'); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
            assert.equal(await evaluate('document.querySelector(".app-navigation button[aria-current=page]")?.textContent'), 'Clientes');
            assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Rolagem horizontal em Clientes');
            await capture(`clientes-${width}x${height}`);
          }
        }
      }
      assert.deepEqual(errors, []);
      console.log(`Revisão final: Solicitações nos dois perfis, detalhe e Clientes em 1366x768 e 1920x1080. ${output}`);
      app.exit(0);
    } catch (error) { console.error(error); app.exit(1); }
  });
  app.on('will-quit', () => { try { fs.rmSync(profile, { recursive: true, force: true }); } catch {} });
}
