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

const owner = process.env.GESTAO_UPDATE_GITHUB_OWNER || "";
const repo = process.env.GESTAO_UPDATE_GITHUB_REPO || "";
if (Boolean(owner) !== Boolean(repo)) {
  throw new Error("Defina juntos GESTAO_UPDATE_GITHUB_OWNER e GESTAO_UPDATE_GITHUB_REPO para builds com update.");
}
if (owner && (!/^[A-Za-z0-9-]+$/.test(owner) || !/^[A-Za-z0-9._-]+$/.test(repo))) {
  throw new Error("Owner/repo do GitHub inválidos para a origem de atualização.");
}

module.exports = {
  ...packageJson.build,
  ...(outputDirectory ? { directories: { ...packageJson.build.directories, output: outputDirectory } } : {}),
  ...(localElectronDist ? { electronDist: localElectronDist } : {}),
  publish: owner && repo ? [{ provider: "github", owner, repo, releaseType: "release" }] : [],
};
