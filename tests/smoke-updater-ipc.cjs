const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const exposed = {};
const calls = [];
const listeners = new Map();
const ipcRenderer = {
  invoke: (channel, ...args) => { calls.push([channel, ...args]); return Promise.resolve({ ok: true, enabled: true, state: { status: "idle" } }); },
  on: (channel, listener) => listeners.set(channel, listener),
  removeListener: (channel, listener) => { if (listeners.get(channel) === listener) listeners.delete(channel); },
};
const source = fs.readFileSync(path.join(__dirname, "../electron/preload.cjs"), "utf8");
const install = vm.runInNewContext(`(function(require){${source}\n})`, { process: { env: {} } });
install((name) => {
  if (name !== "electron") throw new Error(`Unexpected module: ${name}`);
  return { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer };
});

async function main() {
  const api = exposed.gestaoAPI;
  assert.equal((await api.getUpdaterState()).enabled, true);
  await api.downloadAppUpdate();
  await api.installAppUpdate();
  let received;
  const unsubscribe = api.onUpdaterState((state) => { received = state; });
  listeners.get("updater:state")({}, { status: "available", version: "0.1.1" });
  assert.deepEqual(received, { status: "available", version: "0.1.1" });
  unsubscribe();
  assert.equal(listeners.has("updater:state"), false);
  assert.deepEqual(calls.map(([channel]) => channel), ["updater:get-state", "updater:download", "updater:install"]);
  console.log("Auto-update IPC: preload expõe apenas estado, download, instalação e evento tipado com unsubscribe.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
