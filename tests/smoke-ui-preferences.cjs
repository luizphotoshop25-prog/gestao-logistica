const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { PREFERENCE_FILE, SUPPORTED_FONT_SCALES, readUiPreferences, writeUiPreferences } = require("../electron/ui-preferences.cjs");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-ui-preferences-"));
const profileA = path.join(root, "profile-a");
const profileB = path.join(root, "profile-b");
try {
  assert.deepEqual(SUPPORTED_FONT_SCALES, [0.9, 1, 1.1, 1.2, 1.3]);
  assert.deepEqual(readUiPreferences(profileA), { fontScale: 1, startWithWindows: false });
  assert.deepEqual(readUiPreferences(profileB, { defaultStartWithWindows: true }), { fontScale: 1, startWithWindows: true });
  assert.deepEqual(writeUiPreferences(profileA, { fontScale: 1.2 }), { ok: true, fontScale: 1.2, startWithWindows: false });
  assert.equal(JSON.parse(fs.readFileSync(path.join(profileA, PREFERENCE_FILE), "utf8")).fontScale, 1.2);
  assert.deepEqual(readUiPreferences(profileA), { fontScale: 1.2, startWithWindows: false });
  assert.deepEqual(readUiPreferences(profileB), { fontScale: 1, startWithWindows: false });
  assert.deepEqual(writeUiPreferences(profileB, { startWithWindows: true }), { ok: true, fontScale: 1, startWithWindows: true });
  assert.deepEqual(writeUiPreferences(profileB, { fontScale: 1.3 }), { ok: true, fontScale: 1.3, startWithWindows: true });
  assert.equal(writeUiPreferences(profileB, { fontScale: 1.3 }).ok, true);
  assert.deepEqual(readUiPreferences(profileA), { fontScale: 1.2, startWithWindows: false });
  assert.deepEqual(readUiPreferences(profileB), { fontScale: 1.3, startWithWindows: true });
  assert.equal(writeUiPreferences(profileA, { fontScale: 1.25 }).ok, false);
  const child = require("node:child_process").spawnSync(process.execPath, ["-e", `const prefs=require(${JSON.stringify(path.resolve(__dirname, "../electron/ui-preferences.cjs"))});process.stdout.write(String(prefs.readUiPreferences(process.argv[1]).fontScale))`, profileA], { encoding: "utf8" });
  assert.equal(child.status, 0);
  assert.equal(child.stdout, "1.2", "A preferência deve sobreviver a uma nova execução do processo.");
  fs.writeFileSync(path.join(profileA, PREFERENCE_FILE), "{invalid json", "utf8");
  assert.deepEqual(readUiPreferences(profileA), { fontScale: 1, startWithWindows: false });
  fs.writeFileSync(path.join(profileA, PREFERENCE_FILE), JSON.stringify({ fontScale: -50 }), "utf8");
  assert.deepEqual(readUiPreferences(profileA), { fontScale: 1, startWithWindows: false });
  fs.writeFileSync(path.join(profileA, PREFERENCE_FILE), JSON.stringify({ fontScale: "banana" }), "utf8");
  assert.deepEqual(readUiPreferences(profileA), { fontScale: 1, startWithWindows: false });
  for (const stylesheet of ["styles.css", "foundation.css"]) {
    const css = fs.readFileSync(path.join(__dirname, "../src", stylesheet), "utf8");
    if (stylesheet === "styles.css") assert.match(css, /--font-scale:\s*1/);
    else assert.match(css, /var\(--type-[^)]+\)/);
    assert.doesNotMatch(css, /font-size:\s*[0-9.]+px/i, `${stylesheet} deve usar tokens tipográficos escaláveis.`);
  }
  console.log("Preferências locais, fallback, validação e isolamento entre perfis: OK");
} finally {
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(path.resolve(os.tmpdir()), resolvedRoot);
  assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative));
  fs.rmSync(resolvedRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
