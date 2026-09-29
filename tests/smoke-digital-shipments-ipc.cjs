const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

async function main() {
  const exposed = {};
  const calls = [];
  const ipcRenderer = { invoke: (channel, ...args) => { calls.push([channel, ...args]); return Promise.resolve({ ok: true }); } };
  const preloadPath = path.join(__dirname, "../electron/preload.cjs");
  const preload = fs.readFileSync(preloadPath, "utf8");
  const installPreload = vm.runInNewContext(`(function(require){${preload}\n})`, { process: { env: {} } });
  installPreload((name) => {
    assert.equal(name, "electron");
    return { contextBridge: { exposeInMainWorld: (key, api) => { exposed[key] = api; } }, ipcRenderer };
  });

  const mainSource = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
  for (const channel of ["list", "get", "for-order", "resolve-sessions", "create", "update"]) {
    assert.match(mainSource, new RegExp(`handle\\(\\"digital-shipments:${channel}\\"`), `main registers ${channel} handler`);
  }

  const dataServiceSource = fs.readFileSync(path.join(__dirname, "../src/services/dataService.ts"), "utf8");
  const compiled = ts.transpileModule(dataServiceSource, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
  const context = { exports: {}, URL, URLSearchParams, AbortSignal, window: { gestaoAPI: exposed.gestaoAPI, gestaoConfig: { dataTransport: "ipc", apiUrl: "" } } };
  vm.runInNewContext(compiled, context);
  const service = context.exports.dataService;
  const options = { search: "M60001", page: 2, pageSize: 20 };
  const input = { sessions: ["M60001", "M60002"] };
  const create = { numeroPedidoDigital: "900001", dataEnvio: "2026-09-29", pedidoIds: ["order-a"] };
  const update = { id: "digital-a", revision: 2, numeroPedidoDigital: "900002", dataEnvio: "2026-09-30", pedidoIds: ["order-a"] };
  await service.listDigitalShipments(options);
  await service.getDigitalShipment("digital-a");
  await service.getDigitalShipmentsForOrder("order-a");
  await service.resolveDigitalShipmentSessions(input);
  await service.createDigitalShipment(create);
  await service.updateDigitalShipment(update);
  assert.deepEqual(calls, [
    ["digital-shipments:list", options],
    ["digital-shipments:get", "digital-a"],
    ["digital-shipments:for-order", "order-a"],
    ["digital-shipments:resolve-sessions", input],
    ["digital-shipments:create", create],
    ["digital-shipments:update", update],
  ]);
  console.log("Enviados Digital IPC: main registra os handlers e DataService/preload encaminham seis operações tipadas.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
