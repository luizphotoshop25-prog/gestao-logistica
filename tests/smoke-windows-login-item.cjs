const assert = require("node:assert/strict");
const { BACKGROUND_ARGUMENT, isBackgroundStartup, configureWindowsLoginItem } = require("../electron/windows-login-item.cjs");

const calls = [];
let actual = false;
const app = {
  setLoginItemSettings(value) { calls.push(value); actual = value.openAtLogin; },
  getLoginItemSettings() { return { openAtLogin: actual }; },
};

assert.equal(isBackgroundStartup(["app.exe", BACKGROUND_ARGUMENT]), true);
assert.equal(isBackgroundStartup(["app.exe"]), false);
assert.deepEqual(configureWindowsLoginItem({ app, enabled: true, platform: "win32", executablePath: "C:\\Installed\\Gestão Logística.exe" }),
  { ok: true, supported: true, openAtLogin: true, args: [BACKGROUND_ARGUMENT] });
assert.equal(calls[0].path, "C:\\Installed\\Gestão Logística.exe");
assert.deepEqual(calls[0].args, [BACKGROUND_ARGUMENT]);
assert.equal(configureWindowsLoginItem({ app, enabled: false, platform: "win32" }).openAtLogin, false);
actual = false;
const unconfirmedApp = { setLoginItemSettings() {}, getLoginItemSettings: () => ({ openAtLogin: false }) };
assert.equal(configureWindowsLoginItem({ app: unconfirmedApp, enabled: true, platform: "win32" }).ok, false, "A preferência só confirma se o Windows a devolveu.");
assert.deepEqual(configureWindowsLoginItem({ app, enabled: true, platform: "linux" }),
  { ok: true, supported: false, openAtLogin: false, args: [BACKGROUND_ARGUMENT] });
console.log("Auto-start: argumento background, executável instalado, confirmação do Windows e plataforma não suportada aprovados.");
