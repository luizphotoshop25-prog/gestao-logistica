const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createUpdaterController, readApprovedGitHubFeed } = require("../electron/updater.cjs");
const { AppUpdater } = require("electron-updater/out/AppUpdater");

class FakeUpdater extends EventEmitter {
  checks = 0;
  downloads = 0;
  installs = [];
  checkError = null;
  downloadError = null;
  async checkForUpdates() { this.checks += 1; if (this.checkError) throw this.checkError; }
  async downloadUpdate() { this.downloads += 1; if (this.downloadError) throw this.downloadError; }
  quitAndInstall(...args) { this.installs.push(args); }
}

async function main() {
  const semverUpdater = new AppUpdater(null, { version: "0.1.5" });
  assert.equal(await semverUpdater.isUpdateAvailable({ version: "0.1.6" }), true, "installed v0.1.5 must detect v0.1.6");
  assert.equal(await semverUpdater.isUpdateAvailable({ version: "0.1.5" }), false, "an identical build version must not be offered as an update");
  const patchReleaseUpdater = new AppUpdater(null, { version: "0.1.6" });
  assert.equal(await patchReleaseUpdater.isUpdateAvailable({ version: "0.1.7" }), true, "installed v0.1.6 must detect the client-profile release v0.1.7");
  assert.equal(await patchReleaseUpdater.isUpdateAvailable({ version: "0.1.6" }), false, "identical versions must never be offered as an update");

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-updater-"));
  const profileFixUpdater = new AppUpdater(null, { version: "0.1.7" });
  assert.equal(await profileFixUpdater.isUpdateAvailable({ version: "0.1.8" }), true, "installed v0.1.7 must detect the HTTP profile fix v0.1.8");
  try {
    const resources = path.join(root, "resources");
    fs.mkdirSync(resources);
    const feed = path.join(resources, "app-update.yml");
    fs.writeFileSync(feed, "provider: github\nowner: equipe\nrepo: gestao-logistica\nreleaseType: release\n");
    assert.equal(readApprovedGitHubFeed(resources), true);
    fs.writeFileSync(feed, "provider: generic\nurl: http://example.invalid\n");
    assert.equal(readApprovedGitHubFeed(resources), false, "non-GitHub and insecure feeds are rejected");
    fs.writeFileSync(feed, "provider: github\nowner: equipe\nrepo: gestao-logistica\nurl: http://example.invalid\n");
    assert.equal(readApprovedGitHubFeed(resources), false, "arbitrary HTTP feed URLs are rejected");
    fs.writeFileSync(feed, "provider: github\nowner: equipe\nrepo: gestao-logistica\n");

    const devUpdater = new FakeUpdater();
    const dev = createUpdaterController({ app: { isPackaged: false }, autoUpdater: devUpdater, resourcesPath: resources, platform: "win32" });
    assert.equal(dev.enabled, false);
    assert.equal((await dev.checkSilently()).disabled, true);
    assert.equal(devUpdater.checks, 0, "npm run dev must never check for production updates");

    const states = [];
    const errors = [];
    const updater = new FakeUpdater();
    const controller = createUpdaterController({
      app: { isPackaged: true }, autoUpdater: updater, resourcesPath: resources, platform: "win32",
      send: (state) => states.push(state), logError: (message) => errors.push(message),
    });
    assert.equal(controller.enabled, true);
    assert.equal(updater.autoDownload, false);
    assert.equal(updater.autoInstallOnAppQuit, false, "quit must not install without the explicit restart action");

    await controller.checkSilently();
    assert.equal(updater.checks, 1);
    updater.emit("update-not-available", { version: "0.1.0" });
    assert.equal(controller.getState().status, "idle");

    updater.checkError = new Error("private network endpoint detail");
    await controller.checkSilently();
    assert.equal(controller.getState().status, "idle", "automatic check failures stay silent");
    assert.equal(errors.length, 1, "technical failure is logged");
    updater.checkError = null;

    await controller.checkSilently();
    updater.emit("update-available", { version: "0.1.1" });
    assert.deepEqual(controller.getState(), { status: "available", version: "0.1.1" });
    assert.equal(controller.install().ok, false, "must not restart before the user downloads and approves install");
    assert.equal((await controller.download()).ok, true);
    assert.equal(updater.downloads, 1);
    updater.emit("download-progress", { percent: 43.6 });
    assert.deepEqual(controller.getState(), { status: "downloading", percent: 43.6 });
    updater.emit("update-downloaded", { version: "0.1.1" });
    assert.deepEqual(controller.getState(), { status: "downloaded", version: "0.1.1" });
    assert.deepEqual(updater.installs, []);
    assert.deepEqual(controller.install(), { ok: true });
    assert.deepEqual(updater.installs, [[true, true]], "NSIS updates must run silently and relaunch the app");
    assert.ok(states.some((state) => state.status === "available"));
    assert.ok(states.some((state) => state.status === "downloading" && state.percent === 43.6));
    assert.ok(states.some((state) => state.status === "downloaded"));

    const failedUpdater = new FakeUpdater();
    failedUpdater.downloadError = new Error("network unreachable");
    const failed = createUpdaterController({ app: { isPackaged: true }, autoUpdater: failedUpdater, resourcesPath: resources, platform: "win32" });
    await failed.checkSilently();
    failedUpdater.emit("update-available", { version: "0.1.2" });
    assert.equal((await failed.download()).ok, false);
    assert.deepEqual(failed.getState(), { status: "error", message: "Não foi possível baixar a atualização. O sistema continua disponível." });
    assert.equal(failed.install().ok, false);
    console.log("Auto-update: SemVer 0.1.5→0.1.6 e 0.1.6→0.1.7, modo dev, check silencioso, disponibilidade, erro, progresso, download e reinício explícito aprovados.");
  } finally { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
