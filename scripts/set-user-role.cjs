const path = require("node:path");
const database = require("../electron/database.cjs");

function main() {
  const dataDirectory = process.env.GESTAO_SERVER_DATA;
  const [usuario, role] = process.argv.slice(2);
  if (!dataDirectory || !path.isAbsolute(dataDirectory)) throw new Error("GESTAO_SERVER_DATA absoluto é obrigatório.");
  if (!usuario || !role) throw new Error("Uso: node scripts/set-user-role.cjs <usuario> <coordinator|employee>");
  database.initializeDataDirectory(dataDirectory);
  try {
    const result = database.setUserRole(usuario, role);
    if (!result.ok) throw new Error(result.message || "Perfil não atualizado.");
    console.log(`Perfil atualizado para ${usuario}: ${role}.`);
  } finally { database.close(); }
}

try { main(); }
catch (error) { console.error(error.message); process.exitCode = 1; }
