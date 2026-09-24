const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const exposed = {};
const calls = [];
const ipcRenderer = { invoke: (channel, ...args) => { calls.push([channel, ...args]); return Promise.resolve({ ok: true }); } };
const source = fs.readFileSync(path.join(__dirname, "../electron/preload.cjs"), "utf8");
const wrapped = `(function(require){${source}\n})`;
const installPreload = vm.runInNewContext(wrapped, { process: { env: {} } });
installPreload((name) => {
  if (name !== "electron") throw new Error(`Unexpected module: ${name}`);
  return { contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } }, ipcRenderer };
});

async function main() {
  const api = exposed.gestaoAPI;
  const input = { descricao: "Fixture" };
  const update = { id: "id", revision: 1, values: { descricao: "Atualizada" } };
  const transition = { id: "id", revision: 2, action: "complete" };
  await api.listSolicitations();
  await api.getSolicitation("id");
  await api.listSolicitationAssignees();
  await api.createSolicitation(input);
  await api.updateSolicitation(update);
  await api.transitionSolicitation(transition);
  assert.deepEqual(calls, [
    ["solicitations:list"],
    ["solicitations:get", "id"],
    ["solicitations:assignees"],
    ["solicitations:create", input],
    ["solicitations:update", update],
    ["solicitations:transition", transition],
  ]);
  console.log("Solicitações IPC: os seis métodos do preload invocam os canais e payloads tipados esperados.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
