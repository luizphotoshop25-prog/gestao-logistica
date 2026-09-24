const packageJson = require("./package.json");
const path = require("node:path");
const fs = require("node:fs");
const outputDirectory = process.env.GESTAO_BUILD_OUTPUT_DIR || "";
const localElectronDist = process.env.GESTAO_ELECTRON_DIST || "";
if (outputDirectory && !/^[A-Za-z0-9_-]+$/.test(outputDirectory)) {
  throw new Error("GESTAO_BUILD_OUTPUT_DIR deve ser somente um nome de pasta simples.");
}
if (localElectronDist && (!path.isAbsolute(localElectronDist) || !fs.existsSync(path.join(localElectronDist, "electron.exe")))) {
  throw new Error("GESTAO_ELECTRON_DIST precisa apontar para uma distribuição Electron Windows local válida.");
}

const owner = "luizphotoshop25-prog";
const repo = "gestao-logistica";

module.exports = {
  ...packageJson.build,
  ...(outputDirectory ? { directories: { ...packageJson.build.directories, output: outputDirectory } } : {}),
  ...(localElectronDist ? { electronDist: localElectronDist } : {}),
  publish: [{ provider: "github", owner, repo, releaseType: "release" }],
};
