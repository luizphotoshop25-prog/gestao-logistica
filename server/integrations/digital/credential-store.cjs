const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const FILE_NAME = "digital-sync.credential.dpapi";
const PS_CODE = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$mode = '__MODE__'
$inputText = [Console]::In.ReadToEnd()
$entropy = [Text.Encoding]::UTF8.GetBytes('GestaoLogistica.DigitalSync.v1')
if ($mode -eq 'protect') {
  $raw = [Text.Encoding]::UTF8.GetBytes($inputText)
  $output = [Security.Cryptography.ProtectedData]::Protect($raw, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Convert]::ToBase64String($output))
} elseif ($mode -eq 'unprotect') {
  $raw = [Convert]::FromBase64String($inputText)
  $output = [Security.Cryptography.ProtectedData]::Unprotect($raw, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
  [Console]::Out.Write([Text.Encoding]::UTF8.GetString($output))
} else { exit 2 }
`;

async function dpapi(mode, input) {
  if (process.platform !== "win32") throw new Error("DIGITAL_CREDENTIAL_PLATFORM_UNSUPPORTED");
  if (mode !== "protect" && mode !== "unprotect") throw new Error("DIGITAL_CREDENTIAL_STORE_ERROR");
  const encoded = Buffer.from(PS_CODE.replace("__MODE__", mode), "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
      { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { output += chunk; if (output.length > 16384) child.kill(); });
    // Error output may contain protected data or paths. Never forward it.
    child.stderr.resume();
    child.on("error", () => reject(new Error("DIGITAL_CREDENTIAL_STORE_ERROR")));
    child.on("close", (code) => code === 0 ? resolve(output.trim())
      : reject(new Error("DIGITAL_CREDENTIAL_STORE_ERROR")));
    child.stdin.end(input);
  });
}

function credentialPath(dataDir) {
  if (!path.isAbsolute(dataDir)) throw new Error("DIGITAL_CONFIG_ERROR");
  return path.join(dataDir, FILE_NAME);
}

async function saveCredential(dataDir, credential) {
  if (typeof credential?.username !== "string" || !credential.username
    || typeof credential?.password !== "string" || !credential.password)
    throw new Error("DIGITAL_CREDENTIAL_MISSING");
  const target = credentialPath(dataDir);
  const protectedText = await dpapi("protect", JSON.stringify(credential));
  if (!protectedText) throw new Error("DIGITAL_CREDENTIAL_STORE_ERROR");
  fs.mkdirSync(dataDir, { recursive: true });
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, protectedText, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fs.renameSync(temporary, target);
  } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { force: true }); }
}

async function loadCredential(dataDir) {
  const target = credentialPath(dataDir);
  if (!fs.existsSync(target)) throw new Error("DIGITAL_CREDENTIAL_MISSING");
  let parsed;
  try { parsed = JSON.parse(await dpapi("unprotect", fs.readFileSync(target, "utf8"))); }
  catch { throw new Error("DIGITAL_CREDENTIAL_STORE_ERROR"); }
  if (typeof parsed?.username !== "string" || typeof parsed?.password !== "string"
    || !parsed.username || !parsed.password) throw new Error("DIGITAL_CREDENTIAL_STORE_ERROR");
  return parsed;
}

module.exports = { FILE_NAME, credentialPath, saveCredential, loadCredential };
