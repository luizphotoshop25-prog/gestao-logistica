const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");
const { createTestUser } = require("./http-test-auth.cjs");
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

  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-treatment-ipc-"));
  try {
    database.initializeDataDirectory(root);
    const henrique = createTestUser(database, "henrique", "Henrique");
    const carlos = createTestUser(database, "carlos", "Carlos");
    database.setUserRole("henrique", "coordinator");
    database.close();
    database.initializeDataDirectory(root);
    const fixture = (sessao, fotos) => ({ eligible: true, linha: Number(sessao.slice(1)), sessao,
      clienteNome: "Cliente Sintético", clienteEmail: `${sessao}@example.invalid`, clienteTelefone: "0000000000",
      clienteCidade: "Teste", fotosQuantidade: fotos, observacoes: "", selecaoFinalizadaEm: null,
      tratamentoConcluido: false, postadoEm: null, codigoRastreio: "", entregue: false, editor: "", warnings: [] });
    database.importSafeRows({ rows: [fixture("M97001", 8), fixture("M97002", 20)] });
    const preselection = database.listOrders({ search: "M97001" })[0];
    const selectedSmall = database.updateOrder({ id: database.listOrders({ search: "M97002" })[0].id,
      revisao: database.listOrders({ search: "M97002" })[0].revisao, values: { selecao_finalizada_em: "2026-09-20" } }).order;
    const corrupt = new DatabaseSync(database.getStatus().databasePath);
    corrupt.prepare("UPDATE pedidos SET tratamento_responsavel_usuario_id=? WHERE id=?").run(carlos.id, preselection.id);
    corrupt.close();

    const mainSource = fs.readFileSync(path.join(__dirname, "../electron/main.cjs"), "utf8");
    const match = mainSource.match(/function registerIpc\(\) \{([\s\S]*?)\n\}\n\nasync function runSiwinSync/);
    assert.ok(match, "capture actual main-process IPC registration");
    const handlers = new Map();
    const registerIpc = vm.runInNewContext(`(function(handle,database){ return function(){ ${match[1]}\n}; })`)(
      (channel, callback) => handlers.set(channel, callback), database);
    registerIpc();
    const response = handlers.get("orders:list")({ scope: "mine", userId: carlos.id });
    assert.equal(response.ok, true);
    assert.equal(response.rows.some(order => order.id === preselection.id), false, "IPC rejects a legacy preselection assignee");
    assert.equal(response.rows.some(order => order.id === selectedSmall.id), true, "IPC uses the local coordinator even when caller supplies another userId");
    assert.equal(response.rows.every(order => order.tratamento_responsavel_usuario_id === henrique.id
      && order.selecao_finalizada_em && !order.tratamento_concluido_em && order.acompanhamento_status === "ativo"), true);
    assert.equal(handlers.get("orders:list")({ scope: "mine" }).rows.some(order => order.id === selectedSmall.id), true,
      "IPC exposes finalized active orders assigned to the local coordinator");
    console.log("Atribuição de tratamento IPC: preload encaminha o contrato tipado e o handler real filtra pela mesma elegibilidade do domínio e pelo operador local.");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
