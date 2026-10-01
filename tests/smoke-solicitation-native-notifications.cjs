const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { showNativeSolicitationNotification } = require("../electron/solicitation-native-notifications.cjs");

const id = "123e4567-e89b-42d3-a456-426614174000";
const events = [];
let notification;
class FakeNotification extends EventEmitter {
  static isSupported() { return true; }
  constructor(options) { super(); this.options = options; notification = this; }
  show() { events.push("show-notification"); }
}
const window = {
  isDestroyed: () => false,
  isVisible: () => true,
  isFocused: () => false,
  isMinimized: () => true,
  restore: () => events.push("restore"),
  show: () => events.push("show-window"),
  focus: () => events.push("focus"),
  webContents: { send: (...args) => events.push(args) },
};
assert.equal(showNativeSolicitationNotification(FakeNotification, window, { solicitationId: id, type: "OVERDUE" }).ok, true);
assert.deepEqual(notification.options, { title: "Solicitação atrasada", body: "Abra o Gestão Logística para visualizar.", silent: true });
notification.emit("click");
assert.deepEqual(events, ["show-notification", "restore", "show-window", "focus", ["notifications:open", id]]);
assert.deepEqual(showNativeSolicitationNotification(FakeNotification, { ...window, isFocused: () => true }, { solicitationId: id, type: "OVERDUE" }), { ok: false, reason: "foreground" });
assert.deepEqual(showNativeSolicitationNotification(FakeNotification, window, { solicitationId: "other", type: "OVERDUE" }), { ok: false, reason: "invalid-input" });
class UnsupportedNotification extends FakeNotification {
  static isSupported() { return false; }
}
const fallbackEvents = [];
assert.deepEqual(showNativeSolicitationNotification(UnsupportedNotification, window, { solicitationId: id, type: "OVERDUE" }, () => fallbackEvents.push("unsupported")), { ok: false, reason: "unsupported" });
assert.deepEqual(fallbackEvents, ["unsupported"]);
showNativeSolicitationNotification(FakeNotification, window, { solicitationId: id, type: "OVERDUE" }, () => fallbackEvents.push("failed"));
notification.emit("failed", {}, "toast failure");
assert.deepEqual(fallbackEvents, ["unsupported", "failed"]);
console.log("Windows: privacidade, supressão em foco e clique para restaurar/focar solicitação aprovados com evento simulado.");
