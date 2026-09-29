const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const exposed = {};
const calls = [];
const ipcRenderer = { invoke: (channel, ...args) => { calls.push([channel, ...args]); return Promise.resolve({ ok: true }); } };
const source = fs.readFileSync(path.join(__dirname, "../electron/preload.cjs"), "utf8");
const installPreload = vm.runInNewContext(`(function(require){${source}\n})`, { process: { env: {} } });
installPreload(name => {
  assert.equal(name, "electron");
  return { contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } }, ipcRenderer };
});

async function main() {
  const api = exposed.gestaoAPI;
  await api.localCurrentUser();
  const options = { search: "M12345", scope: "mine" };
  const assignment = { id: "order-id", revisao: 4, responsavelUsuarioId: "carlos-id" };
  const restore = { id: "order-id", revisao: 5 };
  await api.listOrders(options);
  await api.listTreatmentAssignees();
  await api.updateTreatmentAssignee(assignment);
  await api.restoreAutomaticTreatmentAssignee(restore);
  assert.deepEqual(calls, [
    ["auth:local-current"],
    ["orders:list", options],
    ["orders:treatment-assignees"],
    ["orders:treatment-assignee", assignment],
    ["orders:treatment-assignee-automatic", restore],
  ]);
  console.log("Atribuição de tratamento IPC: listagem, visão mine e métodos de override/restauração invocam os canais esperados.");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
