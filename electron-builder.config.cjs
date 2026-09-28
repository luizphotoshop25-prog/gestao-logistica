const packageJson = require("./package.json");
const path = require("node:path");
const fs = require("node:fs");
const outputDirectory = process.env.GESTAO_BUILD_OUTPUT_DIR || "";
const localElectronDist = process.env.GESTAO_ELECTRON_DIST || "";
const remoteClientBuild = process.env.GESTAO_CLIENT_BUILD === "remote";
if (outputDirectory && !/^[A-Za-z0-9_-]+$/.test(outputDirectory)) {
  throw new Error("GESTAO_BUILD_OUTPUT_DIR deve ser somente um nome de pasta simples.");
}
if (localElectronDist && (!path.isAbsolute(localElectronDist) || !fs.existsSync(path.join(localElectronDist, "electron.exe")))) {
  throw new Error("GESTAO_ELECTRON_DIST precisa apontar para uma distribuição Electron Windows local válida.");
}
if (process.env.GESTAO_CLIENT_BUILD && !remoteClientBuild) throw new Error("GESTAO_CLIENT_BUILD deve ser remote quando informado.");
const clientMarkerPath = path.join(__dirname, "build", remoteClientBuild ? "remote-client.json" : "local-client.json");
if (!fs.existsSync(clientMarkerPath)) throw new Error("Manifesto do tipo de cliente ausente.");

const owner = "luizphotoshop25-prog";
const repo = "gestao-logistica";

module.exports = {
  ...packageJson.build,
  ...(outputDirectory ? { directories: { ...packageJson.build.directories, output: outputDirectory } } : {}),
  ...(localElectronDist ? { electronDist: localElectronDist } : {}),
  extraResources: [...(packageJson.build.extraResources || []), { from: clientMarkerPath, to: "client-build.json" }],
  nsis: {
    ...packageJson.build.nsis,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: packageJson.build.productName,
  },
  publish: [{ provider: "github", owner, repo, releaseType: "release" }],
};
