const fs = require("node:fs");
const path = require("node:path");

const SUPPORTED_FONT_SCALES = Object.freeze([0.9, 1, 1.1, 1.2, 1.3]);
const PREFERENCE_FILE = "ui-preferences.json";

function normalizeFontScale(value) {
  return typeof value === "number" && SUPPORTED_FONT_SCALES.includes(value) ? value : 1;
}

function preferencePath(userDataPath) {
  if (typeof userDataPath !== "string" || !path.isAbsolute(userDataPath)) {
    throw new TypeError("O diretório local de preferências precisa ser absoluto.");
  }
  return path.join(userDataPath, PREFERENCE_FILE);
}

function readUiPreferences(userDataPath, { defaultStartWithWindows = false } = {}) {
  try {
    const parsed = JSON.parse(fs.readFileSync(preferencePath(userDataPath), "utf8"));
    return { fontScale: normalizeFontScale(parsed?.fontScale), startWithWindows: typeof parsed?.startWithWindows === "boolean" ? parsed.startWithWindows : defaultStartWithWindows };
  } catch {
    return { fontScale: 1, startWithWindows: defaultStartWithWindows };
  }
}

function writeUiPreferences(userDataPath, input, { defaultStartWithWindows = false } = {}) {
  const current = readUiPreferences(userDataPath, { defaultStartWithWindows });
  const fontScale = input && Object.hasOwn(input, "fontScale") ? normalizeFontScale(input.fontScale) : current.fontScale;
  const startWithWindows = input && Object.hasOwn(input, "startWithWindows") ? input.startWithWindows : current.startWithWindows;
  if (fontScale !== (input && Object.hasOwn(input, "fontScale") ? input.fontScale : fontScale)
    || typeof startWithWindows !== "boolean") return { ok: false, ...current };

  const target = preferencePath(userDataPath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ fontScale, startWithWindows }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
    fs.renameSync(temporary, target);
    return { ok: true, fontScale, startWithWindows };
  } finally {
    try { fs.rmSync(temporary, { force: true }); } catch { /* Best effort cleanup. */ }
  }
}

module.exports = { PREFERENCE_FILE, SUPPORTED_FONT_SCALES, normalizeFontScale, readUiPreferences, writeUiPreferences };
