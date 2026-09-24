const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const database = require("../electron/database.cjs");
const { createPasswordHash } = require("../server/api-server.cjs");

function makeUser(usuario, role) {
  const result = database.createUser({ nome: usuario, usuario, role, senhaHash: createPasswordHash("synthetic-only") });
  assert.equal(result.ok, true, result.message);
  return result.user;
}

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gestao-solicitacoes-"));
  try {
    const legacyDirectory = path.join(root, "legacy");
    fs.mkdirSync(legacyDirectory);
    const legacy = new DatabaseSync(path.join(legacyDirectory, "gestao-logistica.sqlite3"));
    legacy.exec(`CREATE TABLE usuarios (id TEXT PRIMARY KEY,nome TEXT NOT NULL,usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
      senha_hash TEXT NOT NULL,ativo INTEGER NOT NULL DEFAULT 1,criado_em TEXT NOT NULL,atualizado_em TEXT NOT NULL);
      INSERT INTO usuarios VALUES ('legacy-id','Legacy','legacy','synthetic',1,'2026-01-01','2026-01-01');`);
    legacy.close();
    database.initializeDataDirectory(legacyDirectory);
    assert.equal(database.getUserForLogin("legacy").role, "employee");
    database.close();

    const dataDirectory = path.join(root, "fresh");
    database.initializeDataDirectory(dataDirectory);
    const coordinator = makeUser("coordenador-teste", "coordinator");
    const employeeA = makeUser("funcionario-a", "employee");
    const employeeB = makeUser("funcionario-b", "employee");
    assert.equal(database.listActiveUsers().length, 3);
    assert.equal(database.setUserRole("coordenador-teste", "employee").ok, false, "não pode remover o último coordenador");

    assert.equal(database.importSafeRows({ rows: [{ eligible: true, linha: 1, sessao: "M99887", clienteNome: "Fixture Solicitação", clienteEmail: "solicitacao@example.invalid", clienteTelefone: "00000000000", clienteCidade: "TESTE", fotosQuantidade: 1, selecaoFinalizadaEm: null, tratamentoConcluido: false }] }).ok, true);
    const deadline = new Date(Date.now() - 2 * 86400000).toISOString();
    const created = database.createSolicitation({
      descricao: "Separar fotos da seleção",
      observacao: "Somente fixture sintética.",
      sessao_codigo: "m99887",
      responsavel_usuario_id: employeeA.id,
      criado_por_usuario_id: coordinator.id,
      criado_por_nome: coordinator.nome,
      prazo_em: deadline,
    });
    assert.equal(created.ok, true, created.message);
    const first = created.solicitation;
    assert.equal(first.sessao_codigo, "M99887");
    assert.equal(first.criado_por_nome, coordinator.nome);
    assert.equal(first.atrasada, true);
    assert.deepEqual(database.listSolicitations({ userId: employeeA.id, role: "employee" }).map((item) => item.id), [first.id]);
    assert.deepEqual(database.listSolicitations({ userId: employeeB.id, role: "employee" }), []);
    assert.equal(database.getSolicitation(first.id, { userId: employeeB.id, role: "employee" }), null);
    assert.equal(database.transitionSolicitation({ id: first.id, revision: first.revision, action: "start", actorUserId: employeeB.id, actorRole: "employee" }).error, "NOT_FOUND");

    const started = database.transitionSolicitation({ id: first.id, revision: first.revision, action: "start", actorUserId: employeeA.id, actorRole: "employee" });
    assert.equal(started.solicitation.status, "in_progress");
    assert.ok(started.solicitation.iniciado_em);
    assert.equal(database.transitionSolicitation({ id: first.id, revision: first.revision, action: "complete", actorUserId: employeeA.id, actorRole: "employee" }).error, "REVISION_CONFLICT");
    const completed = database.transitionSolicitation({ id: first.id, revision: started.solicitation.revision, action: "complete", actorUserId: employeeA.id, actorRole: "employee" });
    assert.equal(completed.solicitation.status, "completed");
    assert.ok(completed.solicitation.concluido_em);
    assert.equal(completed.solicitation.atrasada, false);

    const reopened = database.transitionSolicitation({ id: first.id, revision: completed.solicitation.revision, action: "reopen", actorUserId: coordinator.id, actorRole: "coordinator" });
    assert.equal(reopened.solicitation.status, "pending");
    assert.equal(reopened.solicitation.concluido_em, null);
    const updated = database.updateSolicitation({ id: first.id, revision: reopened.solicitation.revision, values: { descricao: "Conferir seleção de fotos", responsavel_usuario_id: employeeB.id, prazo_em: null } });
    assert.equal(updated.solicitation.responsavel_usuario_id, employeeB.id);
    assert.equal(updated.solicitation.prazo_em, null);
    assert.equal(database.listSolicitations({ userId: employeeA.id, role: "employee" }).length, 0);
    assert.equal(database.listSolicitations({ userId: employeeB.id, role: "employee" }).length, 1);
    const cancelled = database.transitionSolicitation({ id: first.id, revision: updated.solicitation.revision, action: "cancel", actorUserId: coordinator.id, actorRole: "coordinator" });
    assert.equal(cancelled.solicitation.status, "cancelled");
    assert.equal(cancelled.solicitation.atrasada, false);
    const optionalSession = database.createSolicitation({ descricao: "Tarefa sem sessão vinculada", responsavel_usuario_id: employeeA.id, criado_por_nome: "Local" });
    assert.equal(optionalSession.ok, true, optionalSession.message);
    assert.equal(optionalSession.solicitation.sessao_codigo, null);

    const inspection = new DatabaseSync(path.join(dataDirectory, "gestao-logistica.sqlite3"), { readOnly: true });
    assert.equal(inspection.prepare("PRAGMA integrity_check").get().integrity_check, "ok");
    inspection.close();
    console.log("Solicitações SQLite: migração de roles, acesso por responsável, prazo calculado, fluxo, revisão e sessão opcional aprovados.");
  } finally {
    database.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
