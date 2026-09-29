const path = require("node:path");
const database = require("../electron/database.cjs");
const { syncClientDocuments } = require("../electron/siwin.cjs");

async function main() {
  const dataDirectory = process.env.GESTAO_SERVER_DATA;
  if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error("Defina GESTAO_SERVER_DATA com o diretório absoluto do banco piloto.");
  database.initializeDataDirectory(dataDirectory);
  try {
    const result = await syncClientDocuments(database);
    process.stdout.write(`Backfill documental concluído: ${result.updated} clientes atualizados de ${result.scanned} CADs locais.\n`);
  } finally {
    database.close();
  }
}

main().catch((error) => {
  database.close();
  console.error(`Backfill documental falhou: ${error.message}`);
  process.exitCode = 1;
});
