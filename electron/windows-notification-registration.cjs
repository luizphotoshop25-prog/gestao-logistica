const path = require("node:path");

const APP_USER_MODEL_ID = "br.com.manoelguimaraes.gestaologistica";
const TOAST_ACTIVATOR_CLSID = "{9C070A34-2C33-41B1-83F3-41262D1E71B2}";
const START_MENU_SHORTCUT = path.join("Microsoft", "Windows", "Start Menu", "Programs", "Gestão Logística.lnk");

function sameWindowsPath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}

function ensureWindowsNotificationRegistration({ platform, appDataPath, executablePath, shell }) {
  if (platform !== "win32") return { ok: true, status: "not-windows" };
  if (!appDataPath || !executablePath || !shell?.readShortcutLink || !shell?.writeShortcutLink) {
    return { ok: false, status: "unavailable" };
  }

  const shortcutPath = path.join(appDataPath, START_MENU_SHORTCUT);
  try {
    const before = shell.readShortcutLink(shortcutPath);
    if (!before?.target || !sameWindowsPath(before.target, executablePath)) {
      return {
        ok: false,
        status: "target-mismatch",
        shortcutPath,
        target: before?.target || "",
      };
    }

    const needsUpdate = before.appUserModelId !== APP_USER_MODEL_ID
      || before.toastActivatorClsid !== TOAST_ACTIVATOR_CLSID;
    if (needsUpdate) {
      const updated = shell.writeShortcutLink(shortcutPath, "update", {
        ...before,
        appUserModelId: APP_USER_MODEL_ID,
        toastActivatorClsid: TOAST_ACTIVATOR_CLSID,
      });
      if (!updated) return { ok: false, status: "write-failed", shortcutPath, target: before.target };
    }

    const after = shell.readShortcutLink(shortcutPath);
    const verified = after.appUserModelId === APP_USER_MODEL_ID
      && after.toastActivatorClsid === TOAST_ACTIVATOR_CLSID
      && sameWindowsPath(after.target, executablePath);
    return {
      ok: verified,
      status: !verified ? "verification-failed" : needsUpdate ? "updated" : "already-correct",
      changed: needsUpdate && verified,
      shortcutPath,
      target: after.target || "",
      before: {
        appUserModelId: before.appUserModelId || "",
        toastActivatorClsid: before.toastActivatorClsid || "",
      },
      after: {
        appUserModelId: after.appUserModelId || "",
        toastActivatorClsid: after.toastActivatorClsid || "",
      },
    };
  } catch (error) {
    const status = error?.code === "ENOENT" ? "shortcut-missing" : "read-or-write-failed";
    return { ok: false, status, shortcutPath };
  }
}

module.exports = {
  APP_USER_MODEL_ID,
  TOAST_ACTIVATOR_CLSID,
  ensureWindowsNotificationRegistration,
};
