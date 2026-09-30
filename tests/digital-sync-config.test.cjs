const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadDigitalSyncConfig } = require('../server/lan-server.cjs');

test('piloto carrega configuração persistente sem habilitar escrita', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'digital-sync-config-'));
  const file = path.join(dir, 'digital-sync.config.json');
  const previous = Object.fromEntries([
    'DIGITAL_SYNC_ENABLED', 'DIGITAL_SYNC_WRITE_ENABLED', 'DIGITAL_SYNC_INTERVAL_MINUTES',
    'DIGITAL_SYNC_RECENT_ORDERS', 'DIGITAL_SYNC_MAX_SCAN_PAGES', 'DIGITAL_SYNC_REQUEST_DELAY_MS',
    'DIGITAL_SYNC_MAX_IMPORTS_PER_CYCLE'
  ].map((key) => [key, process.env[key]]));
  try {
    for (const key of Object.keys(previous)) delete process.env[key];
    const disabled = loadDigitalSyncConfig(dir);
    assert.equal(disabled.enabled, false);
    assert.equal(disabled.writeEnabled, false);
    fs.writeFileSync(file, JSON.stringify({
      DIGITAL_SYNC_ENABLED: 'true', DIGITAL_SYNC_WRITE_ENABLED: 'false',
      DIGITAL_SYNC_INTERVAL_MINUTES: '30', DIGITAL_SYNC_RECENT_ORDERS: '50',
      DIGITAL_SYNC_MAX_SCAN_PAGES: '4', DIGITAL_SYNC_REQUEST_DELAY_MS: '500',
    }));
    assert.equal(loadDigitalSyncConfig(dir).maxImportsPerCycle, 1,
      'configuração existente mantém compatibilidade e adota o limite seguro padrão');
    fs.writeFileSync(file, JSON.stringify({
      DIGITAL_SYNC_ENABLED: 'true', DIGITAL_SYNC_WRITE_ENABLED: 'false',
      DIGITAL_SYNC_INTERVAL_MINUTES: '30', DIGITAL_SYNC_RECENT_ORDERS: '50',
      DIGITAL_SYNC_MAX_SCAN_PAGES: '4', DIGITAL_SYNC_REQUEST_DELAY_MS: '500',
      DIGITAL_SYNC_MAX_IMPORTS_PER_CYCLE: '1',
    }));
    process.env.DIGITAL_SYNC_WRITE_ENABLED = 'true';
    const active = loadDigitalSyncConfig(dir);
    assert.equal(active.enabled, true);
    assert.equal(active.writeEnabled, false);
    assert.equal(active.intervalMinutes, 30);
    assert.equal(active.recentOrders, 50);
    assert.equal(active.maxScanPages, 4);
    assert.equal(active.requestDelayMs, 500);
    assert.equal(active.maxImportsPerCycle, 1);
    fs.writeFileSync(file, '{"DIGITAL_SYNC_ENABLED":"true"}');
    assert.throws(() => loadDigitalSyncConfig(dir), /DIGITAL_CONFIG_ERROR/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
