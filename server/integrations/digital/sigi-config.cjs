const CONFIG_URL = "https://digitalfotos.revelacaoweb.com.br/sigi-config.json";
const ONLINE_URL = "https://cdn.sigi.com.br/sigi-online.json";

function digitalOptions(env = process.env) {
  const integer = (name, fallback, min, max) => {
    const raw = env[name];
    if (raw === undefined || raw === "") return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("DIGITAL_CONFIG_ERROR");
    return value;
  };
  return Object.freeze({
    enabled: env.DIGITAL_SYNC_ENABLED === "true",
    writeEnabled: env.DIGITAL_SYNC_WRITE_ENABLED === "true",
    intervalMinutes: integer("DIGITAL_SYNC_INTERVAL_MINUTES", 30, 1, 1440),
    recentOrders: integer("DIGITAL_SYNC_RECENT_ORDERS", 50, 1, 500),
    maxScanPages: integer("DIGITAL_SYNC_MAX_SCAN_PAGES", 4, 1, 20),
    maxImportsPerCycle: integer("DIGITAL_SYNC_MAX_IMPORTS_PER_CYCLE", 1, 1, 100),
    requestDelayMs: integer("DIGITAL_SYNC_REQUEST_DELAY_MS", 500, 0, 5000),
    timeoutMs: integer("DIGITAL_SYNC_TIMEOUT_MS", 120000, 1000, 3600000),
    pageSize: 25
  });
}

async function discoverSigiConfiguration(fetchImpl = fetch, timeoutMs = 15000) {
  async function json(url) {
    let response;
    try { response = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(timeoutMs) }); }
    catch { throw new Error("DIGITAL_CONFIG_ERROR"); }
    if (!response.ok) throw new Error("DIGITAL_CONFIG_ERROR");
    try { return await response.json(); } catch { throw new Error("DIGITAL_CONFIG_ERROR"); }
  }
  const site = await json(CONFIG_URL);
  const online = await json(ONLINE_URL);
  const version = String(online?.versaoWS ?? "");
  if (!/^[0-9]+(?:\.[0-9]+){3}$/.test(version) || typeof site?.Zid !== "string" || !site.Zid)
    throw new Error("DIGITAL_CONFIG_ERROR");
  const baseUrl = new URL(`https://online-ws.sigi.com.br/${version}/`);
  if (baseUrl.protocol !== "https:" || baseUrl.hostname !== "online-ws.sigi.com.br")
    throw new Error("DIGITAL_CONFIG_ERROR");
  return { baseUrl, version, zid: site.Zid };
}

module.exports = { CONFIG_URL, ONLINE_URL, digitalOptions, discoverSigiConfiguration };
