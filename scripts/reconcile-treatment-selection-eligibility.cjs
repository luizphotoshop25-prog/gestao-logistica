const fs = require("node:fs");
const net = require("node:net");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");

const EXPECTED_PILOT_DATA = path.resolve("E:/GestaoLogistica_Server_Pilot/data");
const API_PORT = 8787;

function assertApiStopped() {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: "127.0.0.1", port: API_PORT });
    socket.setTimeout(1500);
    socket.once("connect", () => {
      socket.destroy();
      reject(new Error(`Reconciliação cancelada: a API ainda está escutando na porta ${API_PORT}.`));
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error(`Reconciliação cancelada: não foi possível confirmar que a API está parada na porta ${API_PORT}.`));
    });
    socket.once("error", (error) => {
      if (error.code === "ECONNREFUSED") resolve();
      else reject(new Error(`Reconciliação cancelada: não foi possível verificar a porta da API (${error.code || "erro"}).`));
    });
  });
}

function readOnlyIntegrity(databasePath) {
  const handle = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return {
      integrity: handle.prepare("PRAGMA integrity_check").get()?.integrity_check,
      foreignKeyViolations: handle.prepare("PRAGMA foreign_key_check").all().length,
    };
  } finally { handle.close(); }
}

async function main() {
  const configured = process.env.GESTAO_SERVER_DATA;
  if (!configured || !path.isAbsolute(configured)) throw new Error("GESTAO_SERVER_DATA deve apontar para a pasta absoluta do banco piloto.");
  const dataDirectory = path.resolve(configured);
  if (dataDirectory.toLowerCase() !== EXPECTED_PILOT_DATA.toLowerCase())
    throw new Error("Reconciliação cancelada: este procedimento aceita somente o banco piloto autorizado.");
  const databasePath = path.join(dataDirectory, "gestao-logistica.sqlite3");
  if (!fs.existsSync(databasePath)) throw new Error("Banco piloto não encontrado.");
  await assertApiStopped();
  const beforeIntegrity = readOnlyIntegrity(databasePath);
  if (beforeIntegrity.integrity !== "ok" || beforeIntegrity.foreignKeyViolations !== 0)
    throw new Error("Reconciliação cancelada: o banco precisa passar em integrity_check e foreign_key_check antes da escrita.");

  database.initializeDataDirectory(dataDirectory);
  let result;
  try {
    result = database.reconcileTreatmentAssignmentEligibility();
  } finally { database.close(); }
  const afterIntegrity = readOnlyIntegrity(databasePath);
  if (afterIntegrity.integrity !== "ok" || afterIntegrity.foreignKeyViolations !== 0)
    throw new Error("Reconciliação concluiu, mas a verificação final do banco falhou; mantenha a API parada e restaure o backup reportado.");
  if (!result.ok || result.audit.autoAssignedWithoutSelection !== 0
    || result.audit.eligibleAutomaticIncorrect !== 0 || result.audit.eligibleAutomaticUnassigned !== 0)
    throw new Error("Reconciliação concluiu, mas a auditoria pós-operação ainda encontrou atribuições operacionais inconsistentes.");
  console.log(JSON.stringify({
    ok: true,
    alreadyApplied: result.alreadyApplied,
    backup: result.backup,
    clearedPremature: result.clearedPremature,
    correctedEligible: result.correctedEligible,
    before: result.before || null,
    after: result.audit,
    integrityBefore: beforeIntegrity,
    integrityAfter: afterIntegrity,
  }, null, 2));
}

main().catch((error) => {
  database.close();
  console.error(error.message);
  process.exitCode = 1;
});
