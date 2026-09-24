const path = require("node:path");
const readline = require("node:readline/promises");
const { stdin, stdout } = require("node:process");
const database = require("../electron/database.cjs");
const { createPasswordHash } = require("../server/api-server.cjs");

async function main() {
  const dataDirectory = process.env.GESTAO_SERVER_DATA;
  const userDataPath = process.env.GESTAO_USER_DATA;
  if (dataDirectory) database.initializeDataDirectory(dataDirectory);
  else {
    if (!userDataPath || !path.isAbsolute(userDataPath)) throw new Error("GESTAO_SERVER_DATA ou GESTAO_USER_DATA absoluto é obrigatório.");
    database.initialize({ getPath: () => userDataPath });
  }
  const terminal = readline.createInterface({ input: stdin, output: stdout });
  try {
    const nome = (await terminal.question("Nome: ")).trim();
    const usuario = (await terminal.question("Usuário: ")).trim();
    const role = (await terminal.question("Perfil (coordinator/employee) [employee]: ")).trim() || "employee";
    const senha = await terminal.question("Senha: ");
    const result = database.createUser({ nome, usuario, role, senhaHash: createPasswordHash(senha) });
    if (!result.ok) throw new Error(result.message);
    console.log("Usuário criado:", result.user.usuario);
  } finally { terminal.close(); database.close(); }
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
