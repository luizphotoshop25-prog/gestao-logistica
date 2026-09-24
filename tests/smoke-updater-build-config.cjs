const assert = require("node:assert/strict");
const fs = require("node:fs");
const { spawnSync } = require("node:child_process");
const path = require("node:path");

const project = path.join(__dirname, "..");
function loadConfig(overrides = {}) {
  const env = { ...process.env, GESTAO_UPDATE_GITHUB_OWNER: "", GESTAO_UPDATE_GITHUB_REPO: "", ...overrides };
  return spawnSync(process.execPath, ["-e", "const c=require('./electron-builder.config.cjs'); const p=require('./package.json'); console.log(JSON.stringify({publish:c.publish, appId:c.appId, productName:c.productName, target:c.win.target, nsis:c.nsis, version:p.version}));"], {
    cwd: project, env, encoding: "utf8",
  });
}

const unconfigured = loadConfig();
assert.equal(unconfigured.status, 0, unconfigured.stderr);
const defaults = JSON.parse(unconfigured.stdout.trim());
assert.deepEqual(defaults.publish, [{ provider: "github", owner: "luizphotoshop25-prog", repo: "gestao-logistica", releaseType: "release" }]);
assert.equal(defaults.target, "nsis");
assert.equal(defaults.nsis.artifactName, "gestao-logistica-setup-${version}.${ext}");
assert.deepEqual({
  include: defaults.nsis.include,
  oneClick: defaults.nsis.oneClick,
  perMachine: defaults.nsis.perMachine,
  runAfterFinish: defaults.nsis.runAfterFinish,
  packElevateHelper: defaults.nsis.packElevateHelper,
  deleteAppDataOnUninstall: defaults.nsis.deleteAppDataOnUninstall,
}, { include: "build/installer.nsh", oneClick: true, perMachine: false, runAfterFinish: true, packElevateHelper: true, deleteAppDataOnUninstall: false }, "installer must remain per-user, one-click, and preserve app data");
assert.equal(defaults.version, "0.1.2");
const installerInit = fs.readFileSync(path.join(project, "build/installer.nsh"), "utf8");
assert.match(installerInit, /\$\{if\}\s+\$\{isUpdated\}[\s\S]*SetSilent silent/, "legacy auto-update launches must become silent before NSIS pages");
const overridden = loadConfig({ GESTAO_UPDATE_GITHUB_OWNER: "example-owner", GESTAO_UPDATE_GITHUB_REPO: "another-repo" });
assert.equal(overridden.status, 0, overridden.stderr);
assert.deepEqual(JSON.parse(overridden.stdout.trim()).publish, defaults.publish, "the installed app feed cannot be redirected by build environment variables");
const missingToken = spawnSync(process.execPath, [path.join(project, "scripts/check-release-config.cjs")], {
  cwd: project,
  env: { ...process.env, GESTAO_UPDATE_GITHUB_OWNER: "", GESTAO_UPDATE_GITHUB_REPO: "", GH_TOKEN: "", GITHUB_TOKEN: "", GITHUB_REPOSITORY: "" },
  encoding: "utf8",
});
assert.notEqual(missingToken.status, 0, "manual publication must require a write token");
const wrongWorkflowRepo = spawnSync(process.execPath, [path.join(project, "scripts/check-release-config.cjs")], {
  cwd: project,
  env: { ...process.env, GH_TOKEN: "test-token-not-used", GITHUB_TOKEN: "", GITHUB_REPOSITORY: "example-owner/example-repo" },
  encoding: "utf8",
});
assert.notEqual(wrongWorkflowRepo.status, 0, "publishing from a different GitHub repository must fail closed");
console.log("Auto-update build config: feed GitHub fixo, bloqueio sem token e validação do repositório de publicação aprovados.");
