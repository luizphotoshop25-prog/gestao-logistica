const BACKGROUND_ARGUMENT = "--gestao-background-start";

function isBackgroundStartup(argv = process.argv) {
  return Array.isArray(argv) && argv.includes(BACKGROUND_ARGUMENT);
}

function configureWindowsLoginItem({ app, enabled, platform = process.platform, executablePath = process.execPath, disabled = false }) {
  if (platform !== "win32" || disabled) return { ok: true, supported: false, openAtLogin: false, args: [BACKGROUND_ARGUMENT] };
  if (!app || typeof app.setLoginItemSettings !== "function" || typeof app.getLoginItemSettings !== "function")
    return { ok: false, supported: true, openAtLogin: false, args: [BACKGROUND_ARGUMENT] };
  try {
    app.setLoginItemSettings({ openAtLogin: Boolean(enabled), path: executablePath, args: [BACKGROUND_ARGUMENT] });
    const actual = app.getLoginItemSettings();
    const openAtLogin = actual?.openAtLogin === true;
    return { ok: openAtLogin === Boolean(enabled), supported: true, openAtLogin, args: [BACKGROUND_ARGUMENT] };
  } catch { return { ok: false, supported: true, openAtLogin: false, args: [BACKGROUND_ARGUMENT] }; }
}

module.exports = { BACKGROUND_ARGUMENT, isBackgroundStartup, configureWindowsLoginItem };
