function createSqliteSyncAdapter(sql) {
  if (!sql || typeof sql.exec !== "function") throw new Error("SQLite Cloudflare indisponível.");

  function execute(query, bindings = []) {
    const statement = String(query).trim();
    // DO transactions serialize SQLite access; the filesystem lock timeout is unsupported.
    if (/^PRAGMA\s+busy_timeout\s*=\s*\d+\s*;?$/i.test(statement)) return null;
    if (/^(BEGIN(?:\s+IMMEDIATE)?|COMMIT|END|ROLLBACK)(?:\s*;)?$/i.test(statement)) {
      // A Durable Object wraps a complete API operation in transactionSync.
      // The existing domain methods retain their transaction markers for Node.
      return null;
    }
    return sql.exec(query, ...bindings);
  }

  return {
    exec(query) { return execute(query); },
    prepare(query) {
      return {
        all(...bindings) { return execute(query, bindings).toArray(); },
        get(...bindings) { return execute(query, bindings).toArray()[0]; },
        run(...bindings) {
          execute(query, bindings);
          const changes = Number(sql.exec("SELECT changes() AS changes").toArray()[0]?.changes || 0);
          const lastInsertRowid = sql.exec("SELECT last_insert_rowid() AS id").toArray()[0]?.id ?? 0;
          return { changes, lastInsertRowid };
        },
      };
    },
  };
}

module.exports = { createSqliteSyncAdapter };
