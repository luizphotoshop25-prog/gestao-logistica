const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { listPackage } = require("@electron/asar");

async function main() {
  const packageDirectory = process.env.GESTAO_PACKAGED_DIR || "release/win-unpacked";
  const archive = path.resolve(packageDirectory, "resources/app.asar");
  assert.ok(fs.existsSync(archive), `Pacote não encontrado: ${archive}`);

  const packageJson = JSON.parse(fs.readFileSync("package.json", "utf8"));
  const files = await listPackage(archive);
  const packagedFiles = new Set(files.map((file) => file.replace(/\\/g, "/").replace(/^\//, "")));
  const mainFiles = packageJson.build.files
    .filter((file) => file.startsWith("electron/") && file.endsWith(".cjs"))
    .map((file) => path.resolve(file));
  const externalRequires = new Set();

  for (const file of mainFiles) {
    const source = fs.readFileSync(file, "utf8");
    for (const [, request] of source.matchAll(/\brequire\(["']([^"']+)["']\)/g)) {
      if (request.startsWith("node:") || request === "electron" || request.startsWith(".")) continue;
      const segments = request.split("/");
      externalRequires.add(segments[0].startsWith("@") ? segments.slice(0, 2).join("/") : segments[0]);
    }
  }

  for (const dependency of externalRequires) {
    assert.ok(packageJson.dependencies?.[dependency], `${dependency} precisa estar em dependencies`);
    assert.ok(packagedFiles.has(`node_modules/${dependency}/package.json`), `${dependency} ausente de app.asar`);
  }

  console.log(`Dependências de runtime empacotadas: ${[...externalRequires].sort().join(", ")}`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
