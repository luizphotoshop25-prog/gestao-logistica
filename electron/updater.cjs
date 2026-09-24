const fs = require("node:fs");
const path = require("node:path");

function readApprovedGitHubFeed(resourcesPath, fileSystem = fs) {
  try {
    const source = fileSystem.readFileSync(path.join(resourcesPath, "app-update.yml"), "utf8");
    const provider = source.match(/^provider:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
    const owner = source.match(/^owner:\s*["']?([A-Za-z0-9-]+)["']?\s*$/m)?.[1];
    const repo = source.match(/^repo:\s*["']?([A-Za-z0-9._-]+)["']?\s*$/m)?.[1];
    const host = source.match(/^host:\s*["']?([^\s"']+)["']?\s*$/m)?.[1];
    const privateFeed = /^private:\s*true\s*$/m.test(source);
    const customUrl = /^url:\s*\S+/m.test(source);
    return provider === "github" && Boolean(owner) && Boolean(repo)
      && (!host || host === "github.com") && !privateFeed && !customUrl;
  } catch { return false; }
}

function createUpdaterController({ app, autoUpdater, resourcesPath, send = () => {}, logError = () => {}, fileSystem = fs, platform = process.platform }) {
  const enabled = Boolean(app?.isPackaged && platform === "win32"
    && readApprovedGitHubFeed(resourcesPath, fileSystem));
  let state = { status: "idle" };
  let operation = null;
  let downloadInFlight = false;
  let updateDownloaded = false;

  const setState = (next) => {
    state = next;
    try { send({ ...state }); } catch { /* A renderer can close while an update event arrives. */ }
  };
  const onError = (error) => {
    const message = String(error?.message || "Falha no serviço de atualização.").slice(0, 300);
    try { logError(message); } catch { /* Update logging must never affect app startup or use. */ }
    if (operation === "download") setState({ status: "error", message: "Não foi possível baixar a atualização. O sistema continua disponível." });
    operation = null;
    downloadInFlight = false;
  };

  if (enabled) {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = false;
    autoUpdater.on("checking-for-update", () => {});
    autoUpdater.on("update-available", (info) => {
      operation = null;
      setState({ status: "available", version: String(info?.version || "") });
    });
    autoUpdater.on("update-not-available", () => {
      operation = null;
      downloadInFlight = false;
      setState({ status: "idle" });
    });
    autoUpdater.on("download-progress", (progress) => {
      setState({ status: "downloading", percent: Math.max(0, Math.min(100, Number(progress?.percent) || 0)) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      operation = null;
      downloadInFlight = false;
      updateDownloaded = true;
      setState({ status: "downloaded", version: String(info?.version || state.version || "") });
    });
    autoUpdater.on("error", onError);
  }

  async function checkSilently() {
    if (!enabled || operation) return { ok: false, disabled: !enabled };
    operation = "check";
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (error) {
      onError(error);
      return { ok: false };
    }
  }

  async function download() {
    if (!enabled || state.status !== "available" || downloadInFlight) return { ok: false };
    operation = "download";
    downloadInFlight = true;
    setState({ status: "downloading", percent: 0 });
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (error) {
      onError(error);
      return { ok: false };
    }
  }

  function install() {
    if (!enabled || !updateDownloaded) return { ok: false };
    autoUpdater.quitAndInstall(true, true);
    return { ok: true };
  }

  return {
    enabled,
    getState: () => ({ ...state }),
    checkSilently,
    download,
    install,
  };
}

module.exports = { createUpdaterController, readApprovedGitHubFeed };
