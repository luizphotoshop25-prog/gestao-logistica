const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync, backup } = require("node:sqlite");

function inspect(file, kind) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON");
    const result = { integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
      foreignKeys: db.prepare("PRAGMA foreign_key_check").all().length,
      schemaVersion: db.prepare("PRAGMA schema_version").get().schema_version,
      userVersion: db.prepare("PRAGMA user_version").get().user_version };
    if (kind === "operational") {
      result.shipments = db.prepare("SELECT COUNT(*) n FROM digital_envios").get().n;
      result.relations = db.prepare("SELECT COUNT(*) n FROM digital_envio_itens").get().n;
    } else {
      result.observations = db.prepare("SELECT COUNT(*) n FROM observations").get().n;
      result.baselineObservedAt = db.prepare("SELECT value FROM meta WHERE key='baseline_observed_at'").get().value;
      result.window = db.prepare("SELECT COUNT(*) n FROM scan_window").get().n;
    }
    if (result.integrity !== "ok" || result.foreignKeys !== 0) throw Error("DIGITAL_BACKUP_INVALID");
    return result;
  } finally { db.close(); }
}

async function rehearse(dataDir) {
  if (!path.isAbsolute(dataDir || "")) throw Error("DIGITAL_CONFIG_ERROR");
  const files = {
    operational: path.join(dataDir, "gestao-logistica.sqlite3"),
    auxiliary: path.join(dataDir, "digital-sync", "digital-sync-state.sqlite3")
  };
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "digital-sync-recovery-"));
  try {
    const results = {};
    for (const [kind, original] of Object.entries(files)) {
      const before = inspect(original, kind);
      const snapshot = path.join(temp, `${kind}-backup.sqlite3`);
      const source = new DatabaseSync(original, { readOnly: true });
      try { await backup(source, snapshot); }
      finally { source.close(); }
      const backedUp = inspect(snapshot, kind);
      const restored = path.join(temp, `${kind}-restored.sqlite3`);
      fs.copyFileSync(snapshot, restored);
      const afterRestore = inspect(restored, kind);
      if (JSON.stringify(backedUp) !== JSON.stringify(afterRestore))
        throw Error("DIGITAL_BACKUP_MISMATCH");
      results[kind] = { before, snapshot: backedUp, backupVerified: true, restoreVerified: true };
    }
    return { ok: true, temporaryRestore: true, operationalWrites: 0, databases: results };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (require.main === module) {
  rehearse(process.env.GESTAO_SERVER_DATA).then((result) => process.stdout.write(JSON.stringify(result) + "\n"))
    .catch((error) => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}

module.exports = { rehearse };
