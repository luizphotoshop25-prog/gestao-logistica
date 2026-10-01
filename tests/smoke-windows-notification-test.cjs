const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { showWindowsNotificationTest } = require("../electron/windows-notification-test.cjs");

const events = [];
let currentNotification;
class FakeNotification extends EventEmitter {
  static isSupported() { return true; }
  constructor(options) { super(); this.options = options; currentNotification = this; }
  show() { events.push("show"); }
}
let minimized = false;
let visible = true;
let focused = false;
let focusListener;
const window = {
  once: (event, listener) => { if (event === "focus") focusListener = listener; },
  isDestroyed: () => false,
  isMinimized: () => minimized,
  minimize: () => { minimized = true; events.push("minimize"); },
  restore: () => { minimized = false; events.push("restore"); },
  show: () => { visible = true; events.push("window-show"); },
  focus: () => { focused = true; events.push("focus"); focusListener?.(); },
  webContents: { send: (...args) => events.push(args) },
};

assert.deepEqual(showWindowsNotificationTest({ Notification: FakeNotification, mainWindow: window, log: (event) => events.push(event) }), { ok: true, status: "shown" });
assert.deepEqual(currentNotification.options, {
  title: "Gestão Logística",
  body: "Notificação de teste. Clique para abrir o Gestão Logística.",
  silent: true,
});
assert.deepEqual(events, ["minimize", "show", "shown; window-minimized"]);
assert.equal(minimized, true);
currentNotification.emit("click");
assert.deepEqual(events.slice(3), ["restore", "window-show", "focus", "window-focused", ["notifications:open", "__native_notification_test__"], "click-received; window-restored; notifications:open-sent"]);
assert.equal(minimized, false);
assert.equal(visible, true);
assert.equal(focused, true);

class UnsupportedNotification extends FakeNotification {
  static isSupported() { return false; }
}
assert.deepEqual(showWindowsNotificationTest({ Notification: UnsupportedNotification, mainWindow: window }), { ok: false, status: "unsupported" });
console.log("Windows notification test: exact safe copy, minimized display, click restoration, and navigation event passed.");
