const path = require("node:path");
const { DigitalSyncState } = require("../server/integrations/digital/digital-sync-state.cjs");
const { readDatabaseState } = require("../server/integrations/digital/digital-sync-planner.cjs");

async function main() {
  const dataDir = process.env.GESTAO_SERVER_DATA;
  if (process.argv.length !== 2 || !dataDir || !path.isAbsolute(dataDir))
    throw new Error("DIGITAL_CONFIG_ERROR");
  const mainPath = path.join(dataDir, "gestao-logistica.sqlite3");
  const before = readDatabaseState(mainPath).counts;
  const state = new DigitalSyncState(dataDir);
  const observationsBefore = state.inspect().observations;
  const result = await state.classifyBaselineUnimported();
  const after = readDatabaseState(mainPath).counts;
  const inspect = state.inspect();
  if (before.envios !== after.envios || before.relacoes !== after.relacoes
    || inspect.observations !== observationsBefore || state.loadSnapshot().baselineIds.length !== 50
    || inspect.integrity !== "ok" || inspect.foreignKeyViolations)
    throw new Error("DIGITAL_STATE_VERIFY_FAILED");
  process.stdout.write(JSON.stringify({ ...result, observations: inspect.observations,
    integrity: inspect.integrity, foreignKeyViolations: inspect.foreignKeyViolations,
    operationalWrites: 0 }) + "\n");
}

main().catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
