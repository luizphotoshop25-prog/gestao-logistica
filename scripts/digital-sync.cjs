const fs = require("node:fs");
const path = require("node:path");
const { DigitalSyncService } = require("../server/integrations/digital/digital-sync-service.cjs");

async function main() {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--once" || args[1] !== "--dry-run")
    throw new Error("USAGE: digital-sync --once --dry-run");
  const dataDir = process.env.GESTAO_SERVER_DATA;
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("DIGITAL_CONFIG_ERROR");
  const outputDir = path.resolve("work/digital-sync");
  const service = new DigitalSyncService({ dbPath: path.join(dataDir, "gestao-logistica.sqlite3"),
    dataDir, outputDir });
  try {
    const result = await service.runDryRun();
    process.stdout.write(JSON.stringify({ ok: true, mode: result.mode, scan: result.scan,
      planned: result.planned.length, databaseWrites: 0 }) + "\n");
  } catch (error) {
    const allowed = error.message.startsWith("DIGITAL_") ? error.message : "DIGITAL_SYNC_FAILED";
    fs.mkdirSync(outputDir, { recursive: true });
    fs.writeFileSync(path.join(outputDir, "sync-diagnostics.json"), JSON.stringify({ ok: false,
      reason: allowed, databaseWrites: 0 }, null, 2) + "\n");
    process.stdout.write(JSON.stringify({ ok: false, reason: allowed, databaseWrites: 0 }) + "\n");
    process.exitCode = 1;
  }
}
main().catch(() => { process.stderr.write("DIGITAL_SYNC_FAILED\n"); process.exitCode = 1; });
