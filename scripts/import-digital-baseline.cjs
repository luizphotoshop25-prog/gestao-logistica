const fs = require("node:fs");
const path = require("node:path");
const { DigitalSyncState } = require("../server/integrations/digital/digital-sync-state.cjs");
const { readDatabaseState } = require("../server/integrations/digital/digital-sync-planner.cjs");
const { reconcileBaseline } = require("../server/integrations/digital/digital-sync-reconcile.cjs");

const dataDir = process.env.GESTAO_SERVER_DATA;
if (process.argv.length !== 2 || !dataDir || !path.isAbsolute(dataDir))
  throw new Error("DIGITAL_CONFIG_ERROR");
const baseline = JSON.parse(fs.readFileSync(path.resolve("work/digital-sync/baseline-preview.json"), "utf8"));
const mainState = readDatabaseState(path.join(dataDir, "gestao-logistica.sqlite3"));
const reconciliation = reconcileBaseline(baseline, mainState);
const store = new DigitalSyncState(dataDir);
const result = store.importBaseline(baseline, reconciliation);
const inspect = store.inspect();
const mainAfter = readDatabaseState(path.join(dataDir, "gestao-logistica.sqlite3"));
if (inspect.observations !== baseline.orders.length || inspect.integrity !== "ok"
  || inspect.foreignKeyViolations || mainState.counts.envios !== mainAfter.counts.envios
  || mainState.counts.relacoes !== mainAfter.counts.relacoes)
  throw new Error("DIGITAL_STATE_VERIFY_FAILED");
process.stdout.write(JSON.stringify({ imported: result.imported, count: result.count,
  firstObservedAt: result.firstObservedAt, stateIntegrity: inspect.integrity,
  foreignKeyViolations: inspect.foreignKeyViolations, mainDatabaseWrites: 0 }) + "\n");
