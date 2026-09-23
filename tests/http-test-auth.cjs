const { createPasswordHash } = require("../server/api-server.cjs");
const TEST_PASSWORD = "Senha-Sintetica-2026!";
function createTestUser(database, usuario = "usuario-teste", nome = "Usuário Teste") { const result = database.createUser({ nome, usuario, senhaHash: createPasswordHash(TEST_PASSWORD) }); if (!result.ok) throw new Error(result.message); return result.user; }
async function login(origin, usuario = "usuario-teste", senha = TEST_PASSWORD) { const response = await fetch(origin + "/api/auth/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usuario, senha }) }); const body = await response.json(); if (!response.ok) throw new Error(body.message); return body; }
const authHeaders = (token) => ({ Authorization: "Bearer " + token });
module.exports = { TEST_PASSWORD, createTestUser, login, authHeaders };
