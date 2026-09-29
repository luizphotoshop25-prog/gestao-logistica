const VERSION = 1;

function applyDigitalQuantitiesMigration(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const alreadyRecorded = Boolean(db.prepare("SELECT 1 FROM schema_migrations WHERE version=?").get(VERSION));
  const shipmentColumnsBefore = new Set(db.prepare("PRAGMA table_info(digital_envios)").all().map((row) => row.name));
  const itemColumnsBefore = new Set(db.prepare("PRAGMA table_info(digital_envio_itens)").all().map((row) => row.name));
  if (alreadyRecorded && shipmentColumnsBefore.has("itens_digital") && itemColumnsBefore.has("quantidade_enviada")) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    const shipmentColumns = new Set(db.prepare("PRAGMA table_info(digital_envios)").all().map((row) => row.name));
    const itemColumns = new Set(db.prepare("PRAGMA table_info(digital_envio_itens)").all().map((row) => row.name));
    if (!shipmentColumns.has("itens_digital")) db.exec("ALTER TABLE digital_envios ADD COLUMN itens_digital INTEGER CHECK (itens_digital IS NULL OR (typeof(itens_digital)='integer' AND itens_digital>=0))");
    if (!itemColumns.has("quantidade_enviada")) db.exec("ALTER TABLE digital_envio_itens ADD COLUMN quantidade_enviada INTEGER CHECK (quantidade_enviada IS NULL OR (typeof(quantidade_enviada)='integer' AND quantidade_enviada>=0))");
    if (!alreadyRecorded) db.prepare("INSERT INTO schema_migrations(version,name,applied_at) VALUES(?,?,?)").run(VERSION, "digital_quantities_v1", new Date().toISOString());
    db.exec("COMMIT");
    return !alreadyRecorded || !shipmentColumns.has("itens_digital") || !itemColumns.has("quantidade_enviada");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

module.exports = { VERSION, applyDigitalQuantitiesMigration };
