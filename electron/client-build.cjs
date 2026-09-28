const fs = require("node:fs");
const path = require("node:path");
const { OFFICIAL_REMOTE_CONFIG_URL } = require("./remote-config.cjs");

function loadClientBuild({ isPackaged, resourcesPath }) {
  if (!isPackaged) return { variant: "development" };
  const markerPath = path.join(resourcesPath, "client-build.json");
  if (!fs.existsSync(markerPath)) throw new Error("O tipo deste cliente instalado não foi provisionado; o banco local não será iniciado.");
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, "utf8")); } catch { throw new Error("O tipo deste cliente instalado está inválido; o banco local não será iniciado."); }
  if (marker?.variant === "remote" && marker.remoteConfigUrl === OFFICIAL_REMOTE_CONFIG_URL) return marker;
  if (marker?.variant === "local") return marker;
  throw new Error("O tipo deste cliente instalado não é aprovado; o banco local não será iniciado.");
}

module.exports = { loadClientBuild };
