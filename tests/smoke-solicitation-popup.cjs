const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { createSolicitationPopupController, safeNotice, lifetimeFor, MAX_CARDS, MARGIN, WINDOW_WIDTH } = require("../electron/solicitation-popup-window.cjs");

let windows = [];
let nextId = 100;
class FakeWindow extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.destroyed = false;
    this.visible = false;
    this.bounds = null;
    this.webContents = {
      id: nextId++,
      isLoading: () => false,
      setWindowOpenHandler: () => {},
      on: () => {},
      send: (channel, state) => { this.lastMessage = { channel, state }; },
    };
    windows.push(this);
  }
  static getAllWindows() { return windows.filter((window) => !window.destroyed); }
  isDestroyed() { return this.destroyed; }
  setMenu() {}
  setAlwaysOnTop(value, level) { this.alwaysOnTop = { value, level }; }
  setBounds(value) { this.bounds = value; }
  showInactive() { this.visible = true; this.shownInactive = true; }
  loadFile(file) { this.file = file; return Promise.resolve(); }
  close() { this.destroyed = true; this.emit("closed"); }
}

const mainWindow = { title: "Gestão Logística", isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 900, height: 700 }) };
windows = [mainWindow];
const screen = {
  getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1366, height: 728 } }),
  getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1366, height: 728 } }),
};
const presented = [];
const actions = [];
const controller = createSolicitationPopupController({
  BrowserWindow: FakeWindow,
  screen,
  directory: "C:\\app\\electron",
  onPresented: (ids) => presented.push(ids),
  onAction: (action) => actions.push(action),
});
const id = (last) => "00000000-0000-4000-8000-0000000000" + String(last).padStart(2, "0");
const rows = [1, 2, 3, 4].map((index) => ({
  id: id(index), solicitacao_id: id(index), tipo: index === 1 ? "DUE_IN_15_MINUTES" : "ASSIGNED",
  sessao_codigo: "M50" + index, prazo_em: index === 1 ? "2026-10-02T21:00:00.000Z" : null,
  descricao: "DADO PESSOAL NÃO PODE SER EXIBIDO", observacao: "SEGREDO",
}));
try {
  const sanitized = safeNotice(rows[0], new Date("2026-10-02T20:55:00.000Z"));
  assert.deepEqual(Object.keys(sanitized).sort(), ["deadline", "detail", "id", "session", "snoozeMinutes", "solicitationId", "title", "type"].sort());
  assert.equal(sanitized.detail, "Faltam 5 minutos");
  assert.deepEqual(sanitized.snoozeMinutes, [5], "Opções de adiamento respeitam o tempo que resta até o prazo.");
  assert.doesNotMatch(JSON.stringify(sanitized), /DADO PESSOAL|SEGREDO|descricao|observacao/);
  assert.equal(lifetimeFor([{ type: "ASSIGNED" }]), 8000);
  assert.equal(lifetimeFor([{ type: "DUE_IN_15_MINUTES" }]), 15000);
  assert.equal(lifetimeFor([{ type: "DUE_NOW" }]), 30000);
  assert.equal(lifetimeFor([{ type: "OVERDUE" }]), 60000);
  const result = controller.present(rows, new Date("2026-10-02T20:55:00.000Z"));
  assert.deepEqual(result, { ok: true, count: 4, visible: 3, overflow: 1 });
  const popup = controller.getWindow();
  assert.equal(FakeWindow.getAllWindows().filter((window) => window !== mainWindow).length, 1, "Há uma única BrowserWindow hospedeira.");
  assert.equal(popup.options.frame, false);
  assert.equal(popup.options.skipTaskbar, true);
  assert.equal(popup.options.resizable, false);
  assert.equal(popup.options.webPreferences.contextIsolation, true);
  assert.equal(popup.options.webPreferences.nodeIntegration, false);
  assert.equal(popup.options.webPreferences.sandbox, true);
  assert.equal(popup.shownInactive, true, "A janela aparece sem ativar e sem roubar o foco.");
  assert.deepEqual(popup.alwaysOnTop, { value: true, level: "floating" });
  assert.equal(popup.bounds.x + popup.bounds.width, 1366 - MARGIN);
  assert.ok(popup.bounds.y + popup.bounds.height <= 728 - MARGIN);
  assert.equal(popup.bounds.width, WINDOW_WIDTH);
  assert.equal(popup.bounds.height <= 660, true);
  assert.equal(presented[0].length, 4, "Itens agregados também ficam marcados como apresentados.");
  assert.equal(MAX_CARDS, 3);
  assert.equal(controller.acceptAction({ sender: { id: popup.webContents.id } }, { action: "snooze", id: rows[0].id, minutes: 30 }), false);
  assert.equal(controller.acceptAction({ sender: { id: popup.webContents.id } }, { action: "snooze", id: rows[0].id, minutes: 10 }), false);
  assert.equal(controller.acceptAction({ sender: { id: popup.webContents.id } }, { action: "snooze", id: rows[0].id, minutes: 5 }), true);
  assert.deepEqual(actions.at(-1), { action: "snooze", id: rows[0].id, solicitationId: rows[0].solicitacao_id, minutes: 5 });
  assert.equal(popup.destroyed, true);
  controller.close();
  console.log("Popup: conteúdo sanitizado, prioridade visual, posição, foco não roubado, limite de cards e ações aprovados.");
} finally {
  controller.close();
}
