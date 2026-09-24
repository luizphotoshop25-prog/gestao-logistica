const path = require("node:path");
const { startApiServer } = require("./api-server.cjs");

async function main() {
  const dataDirectory = process.env.GESTAO_SERVER_DATA;
  const host = process.env.GESTAO_API_HOST || "127.0.0.1";
  const port = Number(process.env.GESTAO_API_PORT);
  if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error("GESTAO_SERVER_DATA absoluto é obrigatório.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("GESTAO_API_PORT deve ser uma porta válida e estável.");
  const api = await startApiServer({ dataDirectory, host, port, allowedOrigin: ["null", "file://"], lanPilot: true });
  console.log(`Gestão Logística LAN ativa em http://${host}:${api.port}`);
  console.log(`Dados do piloto: ${path.resolve(dataDirectory)}`);
  const stop = async () => { await api.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
