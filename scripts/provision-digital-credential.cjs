const path = require("node:path");
const { saveCredential } = require("../server/integrations/digital/credential-store.cjs");

function hiddenInput(label) {
  return new Promise((resolve, reject) => {
    if (!process.stdin.isTTY || !process.stdin.setRawMode) return reject(new Error("INTERACTIVE_TERMINAL_REQUIRED"));
    let value = "";
    process.stdout.write(label);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (chunk) => {
      const input = chunk.toString("utf8");
      if (input === "\u0003") { cleanup(); reject(new Error("USER_INTERRUPTED")); return; }
      if (input === "\r" || input === "\n") { cleanup(); process.stdout.write("\n"); resolve(value); return; }
      if (input === "\u007f" || input === "\b") { value = value.slice(0, -1); return; }
      if (/^[\x20-\x7e]+$/.test(input)) value += input;
    };
    function cleanup() { process.stdin.off("data", onData); process.stdin.setRawMode(false); process.stdin.pause(); }
    process.stdin.on("data", onData);
  });
}

async function main() {
  if (process.argv.length !== 2) throw new Error("CREDENTIAL_ARGUMENTS_FORBIDDEN");
  const dataDir = process.env.GESTAO_SERVER_DATA;
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error("DIGITAL_CONFIG_ERROR");
  let username, password;
  try {
    username = await hiddenInput("Login Digital (entrada oculta): ");
    password = await hiddenInput("Senha Digital (entrada oculta): ");
    await saveCredential(dataDir, { username, password });
    process.stdout.write("CREDENCIAL_DIGITAL_PROVISIONADA\n");
  } finally { username = undefined; password = undefined; }
}
main().catch((error) => { process.stderr.write(`${error.message.startsWith("DIGITAL_") ? error.message : "DIGITAL_CREDENTIAL_STORE_ERROR"}\n`);
  process.exitCode = 1; });
