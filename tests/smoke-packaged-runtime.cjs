const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createPackage, extractAll, extractFile, listPackage } = require("@electron/asar");
const builderConfig = require("../electron-builder.config.cjs");

const timeoutMs = 45000;
const explicitRuntimeModule = "electron/digital-shipment-write.cjs";
const dependencyAllowlist = new Set(["electron", ...Object.keys(require("../package.json").dependencies || {})]);

function normalizeAsarPath(file) {
  return file.replace(/\\/g, "/").replace(/^\/+/, "");
}

function resolveRelativeModule(fromFile, request, files) {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), request));
  const candidates = [base, `${base}.cjs`, `${base}.js`, `${base}.json`, `${base}.node`, `${base}/index.cjs`, `${base}/index.js`, `${base}/index.json`];
  return candidates.find((candidate) => files.has(candidate));
}

function auditRuntimeGraph(files, archive) {
  const packageJson = JSON.parse(extractFile(archive, "package.json").toString("utf8"));
  assert.equal(packageJson.main, "electron/bootstrap.cjs", "O entry point deve iniciar pelo bootstrap de recuperação.");
  const visited = new Set();
  const pending = [normalizeAsarPath(packageJson.main), "electron/recovery-preload.cjs"];
  const externalDependencies = new Set();

  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) continue;
    assert.ok(files.has(current), `PACKAGED_RUNTIME_MISSING_MODULE: ${current}`);
    visited.add(current);
    if (!/\.(?:cjs|js)$/.test(current)) continue;
    const source = extractFile(archive, current).toString("utf8");
    const requests = [...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)|\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)]
      .map((match) => match[1] || match[2]);
    for (const request of requests) {
      if (request.startsWith("node:") || request === "electron") continue;
      if (request.startsWith(".")) {
        const resolved = resolveRelativeModule(current, request, files);
        assert.ok(resolved, `PACKAGED_RUNTIME_MISSING_MODULE: ${current} -> ${request}`);
        if (/\.(?:cjs|js)$/.test(resolved)) pending.push(resolved);
      } else {
        const segments = request.split("/");
        const name = segments[0].startsWith("@") ? segments.slice(0, 2).join("/") : segments[0];
        externalDependencies.add(name);
      }
    }
  }

  assert.ok(files.has(explicitRuntimeModule), `PACKAGED_RUNTIME_MISSING_MODULE: ${explicitRuntimeModule}`);
  for (const dependency of externalDependencies) {
    assert.ok(dependencyAllowlist.has(dependency), `Dependência de runtime ausente de package.json: ${dependency}`);
    assert.ok(files.has(`node_modules/${dependency}/package.json`), `PACKAGED_RUNTIME_MISSING_MODULE: node_modules/${dependency}/package.json`);
  }
  return { packageJson, visited, externalDependencies };
}

function readMarker(directory, name) {
  const marker = path.join(directory, `${name}.json`);
  return fs.existsSync(marker) ? JSON.parse(fs.readFileSync(marker, "utf8")) : null;
}

function waitForMarker(directory, names, child, milliseconds = timeoutMs) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const poll = () => {
      for (const name of names) {
        const result = readMarker(directory, name);
        if (result) return resolve({ name, result });
      }
      if (child.exitCode !== null) return reject(new Error(`PACKAGED_RUNTIME_EXITED_EARLY: ${child.exitCode}`));
      if (Date.now() - started > milliseconds) return reject(new Error(`PACKAGED_RUNTIME_TIMEOUT: ${names.join(", ")}`));
      setTimeout(poll, 150);
    };
    poll();
  });
}

function launchPackaged(executable, smokeDirectory, interactive = false) {
  const appDataDirectory = path.join(smokeDirectory, "appdata");
  fs.mkdirSync(appDataDirectory, { recursive: true });
  const child = spawn(executable, [], {
    cwd: path.dirname(executable),
    windowsHide: true,
    stdio: "ignore",
    env: {
      ...process.env,
      APPDATA: appDataDirectory,
      GESTAO_PACKAGED_RUNTIME_SMOKE_DIR: smokeDirectory,
      ...(interactive ? { GESTAO_PACKAGED_RUNTIME_INTERACTIVE_SMOKE: "1" } : {}),
    },
  });
  child.on("error", () => {});
  return child;
}

async function waitForExit(child, milliseconds = 15000) {
  if (child.exitCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("PACKAGED_RUNTIME_DID_NOT_EXIT")), milliseconds);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
  });
}

async function main() {
  const packageDirectory = path.resolve(process.env.GESTAO_PACKAGED_DIR || "release/win-unpacked");
  const archive = path.join(packageDirectory, "resources", "app.asar");
  const markerPath = path.join(packageDirectory, "resources", "client-build.json");
  const executable = path.join(packageDirectory, "Gestão Logística.exe");
  assert.ok(fs.existsSync(archive), `Pacote não encontrado: ${archive}`);
  assert.ok(fs.existsSync(executable), `Executável empacotado não encontrado: ${executable}`);
  const remoteBuild = process.env.GESTAO_CLIENT_BUILD === "remote";
  assert.ok(fs.existsSync(markerPath), "Manifesto do perfil não foi incluído nos recursos do aplicativo.");
  assert.equal(JSON.parse(fs.readFileSync(markerPath, "utf8")).variant, remoteBuild ? "remote" : "local");
  assert.equal(builderConfig.nsis.createDesktopShortcut, true);
  assert.equal(builderConfig.nsis.createStartMenuShortcut, true);
  assert.equal(builderConfig.nsis.shortcutName, "Gestão Logística");

  const archiveEntries = await listPackage(archive);
  const packagedFiles = new Set(archiveEntries.map(normalizeAsarPath));
  const graph = auditRuntimeGraph(packagedFiles, archive);
  console.log(`Grafo runtime validado: ${graph.visited.size} módulos relativos; dependências externas: ${[...graph.externalDependencies].sort().join(", ")}.`);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-packaged-runtime-"));
  const originalArchive = path.join(tempRoot, "app.asar.original");
  fs.copyFileSync(archive, originalArchive);
  try {
    const successDirectory = path.join(tempRoot, "success");
    fs.mkdirSync(successDirectory, { recursive: true });
    const successProcess = launchPackaged(executable, successDirectory);
    const success = await waitForMarker(successDirectory, ["application-window-ready", "recovery-error"], successProcess);
    assert.equal(success.name, "application-window-ready", `Runtime real entrou em recuperação: ${JSON.stringify(success.result)}`);
    assert.ok(readMarker(successDirectory, "main-entry-loaded"), "O main process empacotado não carregou o entry point.");
    await waitForExit(successProcess);
    console.log("Runtime empacotado real inicializou o main process e abriu a janela.");

    const singleInstanceDirectory = path.join(tempRoot, "single-instance");
    fs.mkdirSync(singleInstanceDirectory, { recursive: true });
    const primaryInstance = launchPackaged(executable, singleInstanceDirectory, true);
    await waitForMarker(singleInstanceDirectory, ["application-window-ready"], primaryInstance);
    const duplicateInstance = launchPackaged(executable, singleInstanceDirectory, true);
    await waitForExit(duplicateInstance);
    assert.equal(primaryInstance.exitCode, null, "A segunda execução encerrou a instância principal em vez de apenas sair.");
    await new Promise((resolve) => setTimeout(resolve, 750));
    assert.equal(primaryInstance.exitCode, null, "A instância principal não permaneceu ativa após a segunda execução.");
    await waitForExit(primaryInstance, 12000);
    assert.equal(primaryInstance.exitCode, 0, "A instância principal não encerrou normalmente após o smoke.");
    console.log("O runtime empacotado mantém uma única instância e encerra a execução duplicada.");

    const extractedDirectory = path.join(tempRoot, "fault-injection");
    await extractAll(archive, extractedDirectory);
    const missingModule = path.join(extractedDirectory, explicitRuntimeModule.replace(/\//g, path.sep));
    assert.ok(fs.existsSync(missingModule), `O pacote de teste não contém o módulo para injeção: ${explicitRuntimeModule}`);
    fs.unlinkSync(missingModule);
    const brokenArchive = path.join(tempRoot, "app.asar.missing-module");
    await createPackage(extractedDirectory, brokenArchive);
    fs.copyFileSync(brokenArchive, archive);
    const recoveryDirectory = path.join(tempRoot, "recovery");
    fs.mkdirSync(recoveryDirectory, { recursive: true });
    const recoveryProcess = launchPackaged(executable, recoveryDirectory);
    const recovery = await waitForMarker(recoveryDirectory, ["recovery-window-ready"], recoveryProcess);
    assert.equal(recovery.result.updaterEnabled, true, "O updater não ficou ativo no modo de recuperação.");
    const failure = readMarker(recoveryDirectory, "recovery-error");
    assert.equal(failure?.code, "MODULE_NOT_FOUND", "A falha sintética não foi tratada como MODULE_NOT_FOUND.");
    assert.equal(recoveryProcess.exitCode, null, "O processo encerrou antes de manter a tela de recuperação aberta.");
    await waitForExit(recoveryProcess);
    console.log("Falha sintética MODULE_NOT_FOUND manteve o bootstrap e o updater disponíveis em modo de recuperação.");
  } finally {
    if (fs.existsSync(originalArchive)) fs.copyFileSync(originalArchive, archive);
    const resolvedTemp = path.resolve(tempRoot);
    const resolvedOsTemp = path.resolve(os.tmpdir());
    const relative = path.relative(resolvedOsTemp, resolvedTemp);
    assert.ok(relative && !relative.startsWith("..") && !path.isAbsolute(relative), "Recusa limpar um diretório fora do diretório temporário próprio.");
    try {
      fs.rmSync(resolvedTemp, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
    } catch (error) {
      console.warn(`Temp do smoke será removido em nova execução: ${error.code || error.message}`);
    }
  }
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});
