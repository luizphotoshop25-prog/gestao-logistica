const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createRemoteTray } = require("../electron/remote-tray.cjs");

class FakeTray extends EventEmitter {
  constructor(icon) { super(); this.icon = icon; this.destroyed = false; }
  setToolTip(value) { this.tooltip = value; }
  setContextMenu(menu) { this.menu = menu; }
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; }
}
const menuItems = [];
const Menu = { buildFromTemplate(items) { menuItems.push(...items); return items; } };
let quitCalls = 0;
let popupClosed = 0;
let beforeExit = 0;
const app = { quit() { quitCalls++; } };
const window = {
  minimized: true, hidden: false, focused: false,
  isDestroyed: () => false,
  isMinimized() { return this.minimized; },
  restore() { this.minimized = false; this.restored = true; },
  show() { this.hidden = false; this.shown = true; },
  hide() { this.hidden = true; },
  focus() { this.focused = true; },
  on(name, callback) { this[name] = callback; },
};
const popup = { close() { popupClosed++; } };
const controller = createRemoteTray({
  app, Tray: FakeTray, Menu, getMainWindow: () => window, getPopup: () => popup,
  beforeExit: () => { beforeExit++; }, enabled: true,
});
(async () => {
  try {
    assert.deepEqual(await controller.initialize({ id: "application-icon" }), { ok: true });
    const tray = controller.getTray();
    assert.ok(tray);
    assert.equal(tray.tooltip, "Gestão Logística · Aguardando conexão");
    controller.setConnectionStatus("connected");
    assert.equal(tray.tooltip, "Gestão Logística · Conectado");
    controller.setConnectionStatus("waiting");
    assert.equal(tray.tooltip, "Gestão Logística · Aguardando conexão");
    assert.deepEqual(menuItems.filter((item) => item.label).map((item) => item.label), ["Abrir Gestão Logística", "Sair do Gestão Logística"]);
    controller.attachWindow(window);
    let prevented = false;
    window.close({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.equal(window.hidden, true, "X esconde a janela principal e conserva o processo.");
    assert.equal(quitCalls, 0);
    tray.emit("double-click");
    assert.equal(window.restored, true);
    assert.equal(window.shown, true);
    assert.equal(window.focused, true);
    menuItems.find((item) => item.label === "Sair do Gestão Logística").click();
    assert.equal(popupClosed, 1);
    assert.equal(beforeExit, 1);
    assert.equal(quitCalls, 1);
    assert.equal(tray.destroyed, true);
    assert.equal(controller.isQuitting(), true);
    prevented = false;
    window.close({ preventDefault() { prevented = true; } });
    assert.equal(prevented, false, "Quit explícito e updater não são interceptados pelo close handler.");
    console.log("Tray: X para esconder, abrir/restaurar, status, sair explícito e fechamento de atualização aprovados.");
  } finally { controller.quit(); }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
