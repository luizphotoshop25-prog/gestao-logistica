const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const builder = require("../electron-builder.config.cjs");
const remoteBuild = process.env.GESTAO_CLIENT_BUILD === "remote";
const markerResource = (builder.extraResources || []).find((resource) => resource.to === "client-build.json");

assert.equal(builder.nsis.createDesktopShortcut, true);
assert.equal(builder.nsis.createStartMenuShortcut, true);
assert.equal(builder.nsis.shortcutName, "Gestão Logística");
assert.ok(markerResource, "every packaged build must declare its client type");
assert.equal(JSON.parse(fs.readFileSync(markerResource.from, "utf8")).variant, remoteBuild ? "remote" : "local");
assert.equal(markerResource.to, "client-build.json");
console.log(`Atalhos Desktop/Menu Iniciar e pacote ${remoteBuild ? "CLIENTE REMOTO" : "local"} aprovados.`);
