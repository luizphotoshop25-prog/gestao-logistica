const fs = require("node:fs");
const path = require("node:path");
const { readDatabaseState } = require("../server/integrations/digital/digital-sync-planner.cjs");
const { reconcileBaseline } = require("../server/integrations/digital/digital-sync-reconcile.cjs");

const dataDir = process.env.GESTAO_SERVER_DATA;
if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("DIGITAL_CONFIG_ERROR");
const outDir = path.resolve("work/digital-sync");
const snapshot = JSON.parse(fs.readFileSync(path.join(outDir, "baseline-preview.json"), "utf8"));
const result = reconcileBaseline(snapshot, readDatabaseState(path.join(dataDir, "gestao-logistica.sqlite3")));
fs.writeFileSync(path.join(outDir, "reconciliation.json"), `${JSON.stringify(result, null, 2)}\n`);
process.stdout.write(JSON.stringify({ total: result.total, independent: result.independent,
  exclusive: result.exclusive }) + "\n");
