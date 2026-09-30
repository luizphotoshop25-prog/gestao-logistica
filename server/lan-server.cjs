const path = require("node:path");
const fs = require("node:fs");
const { startApiServer } = require("./api-server.cjs");
const { digitalOptions } = require("./integrations/digital/sigi-config.cjs");

const DIGITAL_CONFIG_KEYS = ["DIGITAL_SYNC_ENABLED", "DIGITAL_SYNC_WRITE_ENABLED",
  "DIGITAL_SYNC_INTERVAL_MINUTES", "DIGITAL_SYNC_RECENT_ORDERS",
  "DIGITAL_SYNC_MAX_SCAN_PAGES", "DIGITAL_SYNC_REQUEST_DELAY_MS",
  "DIGITAL_SYNC_MAX_IMPORTS_PER_CYCLE"];
const LEGACY_DIGITAL_CONFIG_KEYS = DIGITAL_CONFIG_KEYS.slice(0, -1);

function loadDigitalSyncConfig(dataDirectory) {
  const file = path.join(dataDirectory, "digital-sync.config.json");
  if (!fs.existsSync(file)) return digitalOptions();
  let configured;
  try { configured = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch { throw new Error("DIGITAL_CONFIG_ERROR"); }
  if (!configured || typeof configured !== "object" || Array.isArray(configured)
    || ![LEGACY_DIGITAL_CONFIG_KEYS.length, DIGITAL_CONFIG_KEYS.length].includes(Object.keys(configured).length)
    || Object.keys(configured).some((key) => !DIGITAL_CONFIG_KEYS.includes(key))
    || LEGACY_DIGITAL_CONFIG_KEYS.some((key) => typeof configured[key] !== "string")
    || (configured.DIGITAL_SYNC_MAX_IMPORTS_PER_CYCLE !== undefined
      && typeof configured.DIGITAL_SYNC_MAX_IMPORTS_PER_CYCLE !== "string"))
    throw new Error("DIGITAL_CONFIG_ERROR");
  if (!["true", "false"].includes(configured.DIGITAL_SYNC_ENABLED)
    || !["true", "false"].includes(configured.DIGITAL_SYNC_WRITE_ENABLED))
    throw new Error("DIGITAL_CONFIG_ERROR");
  return digitalOptions({ ...process.env, ...configured });
}

async function main() {
  const dataDirectory = process.env.GESTAO_SERVER_DATA;
  const host = process.env.GESTAO_API_HOST || "127.0.0.1";
  const port = Number(process.env.GESTAO_API_PORT);
  if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error("GESTAO_SERVER_DATA absoluto é obrigatório.");
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("GESTAO_API_PORT deve ser uma porta válida e estável.");
  const api = await startApiServer({ dataDirectory, host, port, allowedOrigin: ["null", "file://"],
    lanPilot: true, digitalSyncConfig: loadDigitalSyncConfig(dataDirectory) });
  console.log(`Gestão Logística LAN ativa em http://${host}:${api.port}`);
  console.log(`Dados do piloto: ${path.resolve(dataDirectory)}`);
  const stop = async () => { await api.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });

module.exports = { loadDigitalSyncConfig };
