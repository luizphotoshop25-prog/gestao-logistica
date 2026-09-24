const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const project = path.join(__dirname, "..");
function loadConfig(overrides = {}) {
  const env = { ...process.env, GESTAO_UPDATE_GITHUB_OWNER: "", GESTAO_UPDATE_GITHUB_REPO: "", ...overrides };
  return spawnSync(process.execPath, ["-e", "const c=require('./electron-builder.config.cjs'); const p=require('./package.json'); console.log(JSON.stringify({publish:c.publish, appId:c.appId, productName:c.productName, target:c.win.target, version:p.version}));"], {
    cwd: project, env, encoding: "utf8",
  });
}

const unconfigured = loadConfig();
assert.equal(unconfigured.status, 0, unconfigured.stderr);
const defaults = JSON.parse(unconfigured.stdout.trim());
assert.deepEqual(defaults.publish, [], "no release destination may be inferred");
assert.equal(defaults.target, "nsis");
assert.match(defaults.version, /^\d+\.\d+\.\d+$/, "package version is the updater SemVer source");
const partial = loadConfig({ GESTAO_UPDATE_GITHUB_OWNER: "example-owner" });
assert.notEqual(partial.status, 0, "owner without repo must fail closed");
const configured = loadConfig({ GESTAO_UPDATE_GITHUB_OWNER: "example-owner", GESTAO_UPDATE_GITHUB_REPO: "gestao-logistica" });
assert.equal(configured.status, 0, configured.stderr);
const release = JSON.parse(configured.stdout.trim());
assert.deepEqual(release.publish, [{ provider: "github", owner: "example-owner", repo: "gestao-logistica", releaseType: "release" }]);
const missingToken = spawnSync(process.execPath, [path.join(project, "scripts/check-release-config.cjs")], {
  cwd: project,
  env: { ...process.env, GESTAO_UPDATE_GITHUB_OWNER: "example-owner", GESTAO_UPDATE_GITHUB_REPO: "gestao-logistica", GH_TOKEN: "", GITHUB_TOKEN: "" },
  encoding: "utf8",
});
assert.notEqual(missingToken.status, 0, "manual publication must require a write token");
console.log("Auto-update build config: provider ausente sem origem, validação de owner/repo e provider GitHub explícito aprovados.");
