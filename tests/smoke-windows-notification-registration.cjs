const assert = require("node:assert/strict");
const path = require("node:path");
const {
  APP_USER_MODEL_ID,
  TOAST_ACTIVATOR_CLSID,
  ensureWindowsNotificationRegistration,
} = require("../electron/windows-notification-registration.cjs");

const executablePath = "C:\\Users\\Test\\Programs\\Gestão Logística\\Gestão Logística.exe";
const appDataPath = "C:\\Users\\Test\\AppData\\Roaming";
const shortcutPath = path.join(appDataPath, "Microsoft", "Windows", "Start Menu", "Programs", "Gestão Logística.lnk");

function createHarness(initial, { failWrite = false } = {}) {
  let details = { ...initial };
  const writes = [];
  return {
    writes,
    shell: {
      readShortcutLink(file) {
        assert.equal(file, shortcutPath);
        return { ...details };
      },
      writeShortcutLink(file, operation, next) {
        assert.equal(file, shortcutPath);
        assert.equal(operation, "update");
        writes.push({ ...next });
        if (failWrite) return false;
        details = { ...next };
        return true;
      },
    },
  };
}

const baseline = {
  target: executablePath,
  args: "--example",
  cwd: "C:\\Users\\Test\\Programs\\Gestão Logística",
  icon: "C:\\icons\\custom.ico",
  iconIndex: 3,
  description: "Gestão Logística installed app",
};

{
  const harness = createHarness({ ...baseline, appUserModelId: APP_USER_MODEL_ID, toastActivatorClsid: TOAST_ACTIVATOR_CLSID });
  const result = ensureWindowsNotificationRegistration({ platform: "win32", appDataPath, executablePath, shell: harness.shell });
  assert.equal(result.status, "already-correct");
  assert.equal(harness.writes.length, 0);
}

for (const field of ["appUserModelId", "toastActivatorClsid"]) {
  const details = { ...baseline, appUserModelId: APP_USER_MODEL_ID, toastActivatorClsid: TOAST_ACTIVATOR_CLSID };
  delete details[field];
  const harness = createHarness(details);
  const result = ensureWindowsNotificationRegistration({ platform: "win32", appDataPath, executablePath, shell: harness.shell });
  assert.equal(result.ok, true, `${field} ausente deve ser registrado`);
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.writes[0][field], field === "appUserModelId" ? APP_USER_MODEL_ID : TOAST_ACTIVATOR_CLSID);
}

{
  const harness = createHarness({ ...baseline, appUserModelId: "incorrect", toastActivatorClsid: "{incorrect}" });
  const result = ensureWindowsNotificationRegistration({ platform: "win32", appDataPath, executablePath, shell: harness.shell });
  assert.equal(result.ok, true);
  assert.equal(harness.writes.length, 1);
  for (const field of ["target", "args", "cwd", "icon", "iconIndex", "description"]) {
    assert.equal(harness.writes[0][field], baseline[field], `${field} deve ser preservado`);
  }
}

{
  const result = ensureWindowsNotificationRegistration({ platform: "win32", appDataPath, executablePath, shell: {
    readShortcutLink() { const error = new Error("missing"); error.code = "ENOENT"; throw error; },
    writeShortcutLink() { assert.fail("Não deveria gravar sem leitura válida"); },
  } });
  assert.deepEqual({ ok: result.ok, status: result.status }, { ok: false, status: "shortcut-missing" });
}

{
  const harness = createHarness({ ...baseline, appUserModelId: "wrong", toastActivatorClsid: "wrong" }, { failWrite: true });
  const result = ensureWindowsNotificationRegistration({ platform: "win32", appDataPath, executablePath, shell: harness.shell });
  assert.deepEqual({ ok: result.ok, status: result.status }, { ok: false, status: "write-failed" });
}

{
  const harness = createHarness({ ...baseline, target: "C:\\Other\\App.exe" });
  const result = ensureWindowsNotificationRegistration({ platform: "win32", appDataPath, executablePath, shell: harness.shell });
  assert.deepEqual({ ok: result.ok, status: result.status }, { ok: false, status: "target-mismatch" });
  assert.equal(harness.writes.length, 0);
}

assert.deepEqual(ensureWindowsNotificationRegistration({ platform: "linux" }), { ok: true, status: "not-windows" });
console.log("Windows notification registration: metadata audit, safe repair, failure paths, and shortcut property preservation passed.");
