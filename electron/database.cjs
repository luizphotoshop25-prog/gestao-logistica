const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { applyDigitalQuantitiesMigration } = require("./digital-quantities-migration.cjs");
const { insertShipmentWithEvent, normalizeDigitalShipmentNumber,
  validateShipmentQuantities } = require("./digital-shipment-write.cjs");
const { DatabaseSync } = require("node:sqlite");
const solicitationNotifications = require("./solicitation-notifications.cjs");

let db;
let dataDirectory;

const now = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const clean = (value) => String(value ?? "").trim();
const digits = (value) => clean(value).replace(/\D/g, "");
const normalizedEmail = (value) => clean(value).toLowerCase();
const normalizedText = (value) =>
  clean(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ");
const normalizeSiwinDocument = (value) => {
  const document = clean(value).replace(/\D/g, "");
  return document.length === 11 || document.length === 14 ? document : null;
};

function businessDate(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type)?.value;
  return `${value("year")}-${value("month")}-${value("day")}`;
}

function addCalendarDays(isoDate, days) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(isoDate))) return null;
  const date = new Date(`${isoDate}T12:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function initialize(app) {
  const configuredDataDirectory = process.env.GESTAO_SERVER_DATA;
  return initializeDataDirectory(configuredDataDirectory || path.join(app.getPath("userData"), "GestaoLogistica"));
}

function initializeDataDirectory(directory) {
  if (!directory || !path.isAbsolute(directory)) throw new Error("Diretório de dados absoluto é obrigatório.");
  dataDirectory = path.resolve(directory);
  fs.mkdirSync(path.join(dataDirectory, "backups"), { recursive: true });
  fs.mkdirSync(path.join(dataDirectory, "comprovantes"), { recursive: true });
  db = new DatabaseSync(path.join(dataDirectory, "gestao-logistica.sqlite3"));
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS configuracoes (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS clientes (
      id TEXT PRIMARY KEY,
      siwin_cad INTEGER,
      siwin_estudio INTEGER NOT NULL DEFAULT 0,
      nome TEXT,
      documento TEXT,
      email TEXT,
      telefone TEXT,
      celular TEXT,
      logradouro TEXT,
      numero TEXT,
      complemento TEXT,
      bairro TEXT,
      cidade TEXT,
      uf TEXT,
      cep TEXT,
      siwin_cadastrado_em TEXT,
      siwin_sincronizado_em TEXT,
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS remessas (
      id TEXT PRIMARY KEY,
      data_planejada TEXT NOT NULL,
      postada_em TEXT,
      observacoes TEXT,
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pedidos (
      id TEXT PRIMARY KEY,
      sessao TEXT NOT NULL UNIQUE,
      cliente_id TEXT REFERENCES clientes(id) ON UPDATE CASCADE ON DELETE SET NULL,
      fotos_quantidade INTEGER,
      observacoes TEXT,
      editor TEXT,
      galeria_url TEXT,
      galeria_publicada_em TEXT,
      link_enviado_em TEXT,
      selecao_finalizada_em TEXT,
      prazo_tratamento_em TEXT,
      prazo_maximo_em TEXT,
      tratamento_concluido_em TEXT,
      impressao_enviada_em TEXT,
      fornecedor_impressao TEXT,
      impressao_recebida_em TEXT,
      etiqueta_criada_em TEXT,
      remessa_id TEXT REFERENCES remessas(id) ON UPDATE CASCADE ON DELETE SET NULL,
      postado_em TEXT,
      codigo_rastreio TEXT,
      entregue_em TEXT,
      acompanhamento_status TEXT NOT NULL DEFAULT 'ativo',
      origem TEXT NOT NULL DEFAULT 'manual',
      linha_origem INTEGER,
      revisao INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS anexos (
      id TEXT PRIMARY KEY,
      pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,
      nome_arquivo TEXT NOT NULL,
      caminho TEXT NOT NULL,
      criado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pedido_itens (
      id TEXT PRIMARY KEY,
      pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      siwin_ped_ms INTEGER NOT NULL UNIQUE,
      produto TEXT NOT NULL,
      quantidade REAL,
      fotos INTEGER,
      valor_unitario REAL,
      desconto REAL,
      valor_total REAL,
      cobrado INTEGER NOT NULL DEFAULT 0,
      situacao TEXT,
      tipo_foto TEXT,
      ampliacao TEXT,
      sincronizado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pedido_observacoes_siwin (
      id TEXT PRIMARY KEY,
      pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      siwin_ped_obs INTEGER NOT NULL UNIQUE,
      usuario TEXT,
      cadastrado_em TEXT,
      observacao TEXT NOT NULL,
      sincronizado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS selecoes_email (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL UNIQUE,
      pedido_id TEXT REFERENCES pedidos(id) ON DELETE SET NULL,
      sessao TEXT NOT NULL,
      recebido_em TEXT NOT NULL,
      data_finalizacao TEXT NOT NULL,
      quantidade_selecionada INTEGER,
      quantidade_total INTEGER,
      codigos_json TEXT NOT NULL,
      status TEXT NOT NULL,
      conferida_em TEXT,
      fotos_separadas_em TEXT,
      processado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS usuarios (
      id TEXT PRIMARY KEY,
      nome TEXT NOT NULL,
      usuario TEXT NOT NULL UNIQUE COLLATE NOCASE,
      senha_hash TEXT NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('coordinator','employee')),
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessoes (
      id TEXT PRIMARY KEY,
      usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      criado_em TEXT NOT NULL,
      expira_em TEXT NOT NULL,
      revogado_em TEXT
    );
    CREATE TABLE IF NOT EXISTS solicitacoes (
      id TEXT PRIMARY KEY,
      descricao TEXT NOT NULL,
      observacao TEXT,
      sessao_codigo TEXT,
      responsavel_usuario_id TEXT NOT NULL REFERENCES usuarios(id) ON DELETE RESTRICT,
      criado_por_usuario_id TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
      criado_por_nome TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_progress','completed','cancelled')),
      prazo_em TEXT,
      solicitada_em TEXT NOT NULL,
      iniciado_em TEXT,
      concluido_em TEXT,
      cancelado_em TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
    );
    CREATE TABLE IF NOT EXISTS eventos (
      id TEXT PRIMARY KEY,
      pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,
      descricao TEXT NOT NULL,
      usuario_id TEXT REFERENCES usuarios(id) ON DELETE SET NULL,
      criado_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos(cliente_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_prazo ON pedidos(prazo_tratamento_em);
    CREATE INDEX IF NOT EXISTS idx_pedidos_rastreio ON pedidos(codigo_rastreio);
    CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido ON pedido_itens(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_pedido_observacoes_siwin_pedido ON pedido_observacoes_siwin(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_selecoes_email_pedido ON selecoes_email(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_selecoes_email_sessao ON selecoes_email(sessao);
    CREATE INDEX IF NOT EXISTS idx_sessoes_token ON sessoes(token_hash);
    CREATE INDEX IF NOT EXISTS idx_solicitacoes_responsavel ON solicitacoes(responsavel_usuario_id,status,prazo_em);
    CREATE INDEX IF NOT EXISTS idx_solicitacoes_status_prazo ON solicitacoes(status,prazo_em);
  `);
  ensureUserRoleColumn();
  ensureClientColumns();
  db.exec("DROP INDEX IF EXISTS idx_clientes_siwin_cad; CREATE UNIQUE INDEX idx_clientes_siwin_cad ON clientes(siwin_cad);");
  const orderColumns = db.prepare("PRAGMA table_info(pedidos)").all().map((column) => column.name);
  if (
    orderColumns.includes("prazo_maximo_legado_em") &&
    !orderColumns.includes("prazo_maximo_em")
  ) {
    db.exec("ALTER TABLE pedidos RENAME COLUMN prazo_maximo_legado_em TO prazo_maximo_em");
  }
  ensureOrderColumns();
  ensureTreatmentAssignment();
  ensureOrderRevision();
  ensureSelectionEmailColumns();
  ensureEventColumns();
  ensureDigitalShipmentSchema();
  applyDigitalQuantitiesMigration(db);
  solicitationNotifications.install(db, createSafetyBackup);
  initializeTreatmentAssignment();
  if (!getConfiguration("migracao_selecoes_conferidas_v1")) {
    db.prepare("UPDATE selecoes_email SET conferida_em=coalesce(conferida_em,processado_em)").run();
    setConfiguration("migracao_selecoes_conferidas_v1", now());
  }
  if (!getConfiguration("migracao_fotos_cobradas_itens_v1")) {
    createSafetyBackup("recalculo-fotos-cobradas");
    db.prepare(`UPDATE pedidos SET fotos_quantidade=(
      SELECT COALESCE(SUM(CASE WHEN i.cobrado=1 THEN i.fotos ELSE 0 END),0)
      FROM pedido_itens i WHERE i.pedido_id=pedidos.id
    ) WHERE EXISTS (SELECT 1 FROM pedido_itens i WHERE i.pedido_id=pedidos.id)`).run();
    setConfiguration("migracao_fotos_cobradas_itens_v1", now());
  }
  setConfiguration("prazo_tratamento_dias", "20", true);
  setConfiguration("prazo_tratamento_modo", "corridos", true);
  setConfiguration("prazo_maximo_dias", "60", true);
  setConfiguration("prazo_maximo_modo", "corridos", true);
  createDailyBackup();
  return getStatus();
}

function ensureOrderColumns() {
  const existing = new Set(db.prepare("PRAGMA table_info(pedidos)").all().map((column) => column.name));
  const columns = {
    siwin_ped: "INTEGER",
    siwin_situacao: "TEXT",
    siwin_pedido_em: "TEXT",
    siwin_prev_entrega_em: "TEXT",
    siwin_sessao_em: "TEXT",
    acompanhamento_status: "TEXT NOT NULL DEFAULT 'ativo'",
  };
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE pedidos ADD COLUMN ${name} ${type}`);
  }
}

function ensureTreatmentAssignment() {
  const existing = new Set(db.prepare("PRAGMA table_info(pedidos)").all().map((column) => column.name));
  const needsMigration = !existing.has("tratamento_responsavel_usuario_id") || !existing.has("tratamento_atribuicao_modo");
  if (needsMigration) {
    createSafetyBackup("atribuicao-tratamento");
    db.exec("BEGIN IMMEDIATE");
    try {
      if (!existing.has("tratamento_responsavel_usuario_id"))
        db.exec("ALTER TABLE pedidos ADD COLUMN tratamento_responsavel_usuario_id TEXT REFERENCES usuarios(id) ON DELETE SET NULL");
      if (!existing.has("tratamento_atribuicao_modo"))
        db.exec("ALTER TABLE pedidos ADD COLUMN tratamento_atribuicao_modo TEXT NOT NULL DEFAULT 'auto' CHECK (tratamento_atribuicao_modo IN ('auto','manual'))");
      db.exec("CREATE INDEX IF NOT EXISTS idx_pedidos_tratamento_responsavel ON pedidos(tratamento_responsavel_usuario_id, tratamento_concluido_em, acompanhamento_status)");
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function ensureUserRoleColumn() {
  const columns = db.prepare("PRAGMA table_info(usuarios)").all();
  if (!columns.some((column) => column.name === "role")) {
    db.exec("ALTER TABLE usuarios ADD COLUMN role TEXT NOT NULL DEFAULT 'employee' CHECK (role IN ('coordinator','employee'))");
  }
}

function ensureOrderRevision() {
  const columns = db.prepare("PRAGMA table_info(pedidos)").all();
  if (columns.some((column) => column.name === "revisao")) return;
  createSafetyBackup("revisao-pedidos");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec("ALTER TABLE pedidos ADD COLUMN revisao INTEGER NOT NULL DEFAULT 1");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureSelectionEmailColumns() {
  const existing = new Set(db.prepare("PRAGMA table_info(selecoes_email)").all().map((column) => column.name));
  const columns = { conferida_em: "TEXT", fotos_separadas_em: "TEXT" };
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE selecoes_email ADD COLUMN ${name} ${type}`);
  }
}

function ensureEventColumns() {
  const existing = new Set(db.prepare("PRAGMA table_info(eventos)").all().map((column) => column.name));
  if (!existing.has("usuario_id")) db.exec("ALTER TABLE eventos ADD COLUMN usuario_id TEXT REFERENCES usuarios(id) ON DELETE SET NULL");
}

function ensureDigitalShipmentSchema() {
  const hasShipments = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='digital_envios'").get();
  const hasItems = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='digital_envio_itens'").get();
  const hasEvents = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='digital_envio_eventos'").get();
  if (hasShipments && hasItems && hasEvents) return;
  createSafetyBackup("enviados-digital");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS digital_envios (
        id TEXT PRIMARY KEY,
        numero_pedido_digital TEXT NOT NULL,
        data_envio TEXT NOT NULL,
        criado_por_usuario_id TEXT REFERENCES usuarios(id) ON UPDATE CASCADE ON DELETE SET NULL,
        criado_em TEXT NOT NULL,
        atualizado_em TEXT NOT NULL,
        revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1)
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_digital_envios_numero ON digital_envios(numero_pedido_digital COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS idx_digital_envios_data ON digital_envios(data_envio,criado_em);
      CREATE TABLE IF NOT EXISTS digital_envio_itens (
        id TEXT PRIMARY KEY,
        digital_envio_id TEXT NOT NULL REFERENCES digital_envios(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        criado_em TEXT NOT NULL,
        UNIQUE(digital_envio_id,pedido_id)
      );
      CREATE INDEX IF NOT EXISTS idx_digital_envio_itens_envio ON digital_envio_itens(digital_envio_id);
      CREATE INDEX IF NOT EXISTS idx_digital_envio_itens_pedido ON digital_envio_itens(pedido_id,digital_envio_id);
      CREATE TABLE IF NOT EXISTS digital_envio_eventos (
        id TEXT PRIMARY KEY,
        digital_envio_id TEXT NOT NULL REFERENCES digital_envios(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        usuario_id TEXT REFERENCES usuarios(id) ON UPDATE CASCADE ON DELETE SET NULL,
        acao TEXT NOT NULL,
        descricao TEXT NOT NULL,
        criado_em TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_digital_envio_eventos_envio ON digital_envio_eventos(digital_envio_id,criado_em);
    `);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function ensureClientColumns() {
  const existing = new Set(db.prepare("PRAGMA table_info(clientes)").all().map((column) => column.name));
  if (!existing.has("documento")) {
    createSafetyBackup("migracao-documento-cliente");
    db.exec("ALTER TABLE clientes ADD COLUMN documento TEXT");
  }
  const columns = {
    siwin_cad: "INTEGER",
    siwin_estudio: "INTEGER NOT NULL DEFAULT 0",
    celular: "TEXT",
    logradouro: "TEXT",
    numero: "TEXT",
    complemento: "TEXT",
    bairro: "TEXT",
    uf: "TEXT",
    cep: "TEXT",
    siwin_cadastrado_em: "TEXT",
    siwin_sincronizado_em: "TEXT",
  };
  for (const [name, type] of Object.entries(columns)) {
    if (!existing.has(name)) db.exec(`ALTER TABLE clientes ADD COLUMN ${name} ${type}`);
  }
}

function setConfiguration(key, value, onlyIfMissing = false) {
  if (onlyIfMissing && db.prepare("SELECT 1 FROM configuracoes WHERE chave = ?").get(key)) return;
  db.prepare(`INSERT INTO configuracoes (chave, valor, atualizado_em) VALUES (?, ?, ?)
    ON CONFLICT(chave) DO UPDATE SET valor=excluded.valor, atualizado_em=excluded.atualizado_em`).run(
    key,
    value,
    now(),
  );
}

function resolveTreatmentAssignee(photoCount, assignments = {}) {
  if (photoCount === null || photoCount === undefined || photoCount === "") return null;
  const count = Number(photoCount);
  if (!Number.isSafeInteger(count) || count < 0) return null;
  const limit = Number(assignments.limit ?? 48);
  if (!Number.isSafeInteger(limit) || limit < 1) return null;
  return count < limit ? (assignments.smallUserId || null) : (assignments.largeUserId || null);
}

function isTreatmentSelectionFinalized(order) {
  return Boolean(clean(order?.selecao_finalizada_em));
}

function resolveEligibleTreatmentAssignee(order, photoCount, assignmentConfig = treatmentAssignmentConfig(), options = {}) {
  const preserveCompletedHistory = !options.allowHistorical
    && (Boolean(order.tratamento_concluido_em) || order.acompanhamento_status !== "ativo");
  if (preserveCompletedHistory) return order.tratamento_responsavel_usuario_id || null;
  if (!isTreatmentSelectionFinalized(order)) return null;
  return resolveTreatmentAssignee(photoCount, assignmentConfig);
}

function treatmentAssignmentConfig() {
  const activeId = (key) => {
    const configured = getConfiguration(key);
    return configured && db.prepare("SELECT id FROM usuarios WHERE id=? AND ativo=1").get(configured)?.id || null;
  };
  return {
    smallUserId: activeId("tratamento_usuario_ate_47"),
    largeUserId: activeId("tratamento_usuario_48_mais"),
    limit: Number(getConfiguration("tratamento_limite_carlos") || 48),
  };
}

function initializeTreatmentAssignment() {
  const config = treatmentAssignmentConfig();
  if (!config.smallUserId) {
    const henrique = db.prepare("SELECT id FROM usuarios WHERE ativo=1 AND (usuario=? COLLATE NOCASE OR nome=? COLLATE NOCASE) ORDER BY CASE WHEN usuario=? COLLATE NOCASE THEN 0 ELSE 1 END LIMIT 1")
      .get("henrique", "Henrique", "henrique");
    if (henrique) setConfiguration("tratamento_usuario_ate_47", henrique.id, true);
  }
  if (!config.largeUserId) {
    const carlos = db.prepare("SELECT id FROM usuarios WHERE ativo=1 AND (usuario=? COLLATE NOCASE OR nome=? COLLATE NOCASE OR usuario=? COLLATE NOCASE OR nome=? COLLATE NOCASE) ORDER BY CASE WHEN usuario=? COLLATE NOCASE THEN 0 ELSE 1 END LIMIT 1")
      .get("Carlos", "Carlos", "funcionario_teste", "Funcionário Teste", "Carlos");
    if (carlos) setConfiguration("tratamento_usuario_48_mais", carlos.id, true);
  }
  setConfiguration("tratamento_limite_carlos", "48", true);
  const mapping = treatmentAssignmentConfig();
  if (mapping.smallUserId && mapping.largeUserId && !getConfiguration("tratamento_atribuicao_backfill_v1")) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const pending = db.prepare(`SELECT id,fotos_quantidade,tratamento_responsavel_usuario_id
        FROM pedidos WHERE tratamento_atribuicao_modo='auto' AND selecao_finalizada_em IS NOT NULL
          AND acompanhamento_status='ativo' AND tratamento_concluido_em IS NULL`).all();
      const update = db.prepare("UPDATE pedidos SET tratamento_responsavel_usuario_id=?,atualizado_em=? WHERE id=? AND tratamento_atribuicao_modo='auto'");
      const event = db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,usuario_id,criado_em) VALUES (?,?,?,?,NULL,?)");
      for (const order of pending) {
        const assignee = resolveTreatmentAssignee(order.fotos_quantidade, mapping);
        if (assignee === order.tratamento_responsavel_usuario_id) continue;
        update.run(assignee, now(), order.id);
        event.run(id(), order.id, "atribuicao_tratamento", "Atribuição automática do responsável pelo tratamento aplicada no backfill inicial.", now());
      }
      setConfiguration("tratamento_atribuicao_backfill_v1", now());
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
}

function setAutomaticTreatmentAssignment(orderId, photoCount, assignmentConfig = treatmentAssignmentConfig(), options = {}) {
  const current = db.prepare(`SELECT tratamento_atribuicao_modo,tratamento_responsavel_usuario_id,
    selecao_finalizada_em,tratamento_concluido_em,acompanhamento_status
    FROM pedidos WHERE id=?`).get(orderId);
  if (!current || current.tratamento_atribuicao_modo === "manual") return;
  const assignee = resolveEligibleTreatmentAssignee(current, photoCount, assignmentConfig, options);
  if (assignee === current.tratamento_responsavel_usuario_id) return;
  db.prepare("UPDATE pedidos SET tratamento_responsavel_usuario_id=? WHERE id=? AND tratamento_atribuicao_modo='auto'").run(assignee, orderId);
  const description = options.reason || (!isTreatmentSelectionFinalized(current)
    ? "Atribuição automática removida porque a seleção do cliente ainda não foi finalizada."
    : !current.tratamento_responsavel_usuario_id
      ? "Responsável pelo tratamento atribuído automaticamente após finalização da seleção."
      : "Responsável pelo tratamento recalculado automaticamente conforme a quantidade de fotos.");
  db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,usuario_id,criado_em) VALUES (?,?,?,?,NULL,?)")
    .run(id(), orderId, "atribuicao_tratamento", description, now());
}

function treatmentEligibilityAudit() {
  const config = treatmentAssignmentConfig();
  const count = (sql, ...params) => Number(db.prepare(sql).get(...params).total || 0);
  const operational = "acompanhamento_status='ativo' AND tratamento_concluido_em IS NULL";
  const eligible = `selecao_finalizada_em IS NOT NULL AND ${operational} AND tratamento_atribuicao_modo='auto'`;
  const correctTarget = `((fotos_quantidade>=0 AND fotos_quantidade<? AND tratamento_responsavel_usuario_id=?)
    OR (fotos_quantidade>=? AND tratamento_responsavel_usuario_id=?))`;
  return {
    integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
    foreignKeyViolations: db.prepare("PRAGMA foreign_key_check").all().length,
    autoAssignedWithoutSelection: count(`SELECT COUNT(*) total FROM pedidos
      WHERE tratamento_atribuicao_modo='auto' AND selecao_finalizada_em IS NULL
      AND tratamento_responsavel_usuario_id IS NOT NULL`),
    operationalAutoAssignedWithoutSelection: count(`SELECT COUNT(*) total FROM pedidos
      WHERE tratamento_atribuicao_modo='auto' AND selecao_finalizada_em IS NULL
      AND tratamento_responsavel_usuario_id IS NOT NULL AND ${operational}`),
    manualAssignedBeforeSelection: count(`SELECT COUNT(*) total FROM pedidos
      WHERE tratamento_atribuicao_modo='manual' AND selecao_finalizada_em IS NULL
      AND tratamento_responsavel_usuario_id IS NOT NULL`),
    eligibleAutomaticCorrect: count(`SELECT COUNT(*) total FROM pedidos WHERE ${eligible}
      AND fotos_quantidade>=0 AND ${correctTarget}`, config.limit, config.smallUserId, config.limit, config.largeUserId),
    eligibleAutomaticIncorrect: count(`SELECT COUNT(*) total FROM pedidos WHERE ${eligible}
      AND fotos_quantidade>=0 AND tratamento_responsavel_usuario_id IS NOT NULL
      AND NOT ${correctTarget}`, config.limit, config.smallUserId, config.limit, config.largeUserId),
    eligibleAutomaticUnassigned: count(`SELECT COUNT(*) total FROM pedidos WHERE ${eligible}
      AND fotos_quantidade>=0 AND tratamento_responsavel_usuario_id IS NULL`),
    eligibleAutomaticWithoutQuantity: count(`SELECT COUNT(*) total FROM pedidos WHERE ${eligible}
      AND fotos_quantidade IS NULL`),
    limit: config.limit,
    configuredUsersAvailable: Boolean(config.smallUserId && config.largeUserId),
  };
}

function reconcileTreatmentAssignmentEligibility() {
  const marker = "tratamento_elegibilidade_selecao_v1";
  if (getConfiguration(marker)) return { ok: true, alreadyApplied: true, audit: treatmentEligibilityAudit(), backup: null, clearedPremature: 0, correctedEligible: 0 };
  const config = treatmentAssignmentConfig();
  if (config.limit !== 48) throw new Error("Reconciliação cancelada: o limite configurado de Carlos não é 48.");
  if (!config.smallUserId || !config.largeUserId) throw new Error("Reconciliação cancelada: os dois responsáveis automáticos não estão configurados como usuários ativos.");
  const before = treatmentEligibilityAudit();
  if (before.integrity !== "ok" || before.foreignKeyViolations !== 0)
    throw new Error("Reconciliação cancelada: a integridade SQLite precisa estar íntegra e sem violações de chaves estrangeiras.");
  const backup = createSafetyBackup("elegibilidade-selecao-v1");
  let clearedPremature = 0;
  let correctedEligible = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const premature = db.prepare(`SELECT id FROM pedidos WHERE tratamento_atribuicao_modo='auto'
      AND selecao_finalizada_em IS NULL AND tratamento_responsavel_usuario_id IS NOT NULL`).all();
    const clear = db.prepare(`UPDATE pedidos SET tratamento_responsavel_usuario_id=NULL,atualizado_em=?
      WHERE id=? AND tratamento_atribuicao_modo='auto' AND selecao_finalizada_em IS NULL
      AND tratamento_responsavel_usuario_id IS NOT NULL`);
    const event = db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,usuario_id,criado_em) VALUES (?,?,?,?,NULL,?)");
    for (const order of premature) {
      const result = clear.run(now(), order.id);
      if (!result.changes) continue;
      clearedPremature += 1;
      event.run(id(), order.id, "atribuicao_tratamento",
        "Atribuição automática removida porque a seleção do cliente ainda não foi finalizada.", now());
    }
    const selected = db.prepare(`SELECT id,fotos_quantidade,tratamento_responsavel_usuario_id
      FROM pedidos WHERE tratamento_atribuicao_modo='auto' AND selecao_finalizada_em IS NOT NULL
      AND tratamento_concluido_em IS NULL AND acompanhamento_status='ativo'
      AND fotos_quantidade>=0`).all();
    const update = db.prepare(`UPDATE pedidos SET tratamento_responsavel_usuario_id=?,atualizado_em=?
      WHERE id=? AND tratamento_atribuicao_modo='auto' AND selecao_finalizada_em IS NOT NULL
      AND tratamento_concluido_em IS NULL AND acompanhamento_status='ativo'`);
    for (const order of selected) {
      const assignee = resolveTreatmentAssignee(order.fotos_quantidade, config);
      if (!assignee || assignee === order.tratamento_responsavel_usuario_id) continue;
      const result = update.run(assignee, now(), order.id);
      if (!result.changes) continue;
      correctedEligible += 1;
      event.run(id(), order.id, "atribuicao_tratamento",
        "Responsável pelo tratamento corrigido na reconciliação de elegibilidade.", now());
    }
    setConfiguration(marker, now());
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  const audit = treatmentEligibilityAudit();
  return { ok: audit.integrity === "ok" && audit.foreignKeyViolations === 0,
    alreadyApplied: false, before, audit, backup, clearedPremature, correctedEligible };
}

function getLocalOperatorId() {
  return getLocalOperator()?.id || null;
}

function getLocalOperator() {
  return db.prepare("SELECT id,nome,usuario,role FROM usuarios WHERE ativo=1 AND role='coordinator' ORDER BY CASE WHEN usuario='henrique' COLLATE NOCASE THEN 0 ELSE 1 END, nome COLLATE NOCASE LIMIT 1").get()
    || { id: "ipc-local", nome: "Usuário local", usuario: "local", role: "coordinator" };
}

function assignmentBackfillCounts() {
  const counts = db.prepare(`SELECT
    sum(CASE WHEN tratamento_atribuicao_modo='auto' AND fotos_quantidade>=0 AND fotos_quantidade<? AND tratamento_responsavel_usuario_id=? THEN 1 ELSE 0 END) henrique,
    sum(CASE WHEN tratamento_atribuicao_modo='auto' AND fotos_quantidade>=? AND tratamento_responsavel_usuario_id=? THEN 1 ELSE 0 END) carlos,
    sum(CASE WHEN fotos_quantidade IS NULL THEN 1 ELSE 0 END) semQuantidade
    FROM pedidos`).get(treatmentAssignmentConfig().limit, treatmentAssignmentConfig().smallUserId,
    treatmentAssignmentConfig().limit, treatmentAssignmentConfig().largeUserId);
  return { henrique: Number(counts.henrique || 0), carlos: Number(counts.carlos || 0), semQuantidade: Number(counts.semQuantidade || 0) };
}

function createDailyBackup() {
  const source = path.join(dataDirectory, "gestao-logistica.sqlite3");
  if (!fs.existsSync(source)) return null;
  const date = businessDate();
  const target = path.join(dataDirectory, "backups", `gestao-logistica-${date}.sqlite3`);
  if (!fs.existsSync(target)) {
    db.exec("PRAGMA wal_checkpoint(FULL)");
    fs.copyFileSync(source, target);
  }
  return target;
}

function createSafetyBackup(reason) {
  const source = path.join(dataDirectory, "gestao-logistica.sqlite3");
  const safeReason = clean(reason).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "") || "operacao";
  const stamp = now().replace(/[:.]/g, "-");
  const target = path.join(dataDirectory, "backups", `antes-${safeReason}-${stamp}.sqlite3`);
  const checkpoint = db.prepare("PRAGMA wal_checkpoint(FULL)").get();
  if (Number(checkpoint?.busy) !== 0) throw new Error("Backup cancelado: o checkpoint WAL não foi concluído sem bloqueio.");
  fs.copyFileSync(source, target);
  let copy;
  try {
    copy = new DatabaseSync(target, { readOnly: true });
    const integrity = copy.prepare("PRAGMA integrity_check").get()?.integrity_check;
    const foreignKeyViolations = copy.prepare("PRAGMA foreign_key_check").all().length;
    if (integrity !== "ok" || foreignKeyViolations !== 0)
      throw new Error("Backup cancelado: a cópia não passou nas verificações de integridade.");
  } catch (error) {
    try { copy?.close(); } catch {}
    fs.rmSync(target, { force: true });
    throw error;
  }
  copy.close();
  return target;
}

function getStatus() {
  return {
    ok: true,
    databasePath: path.join(dataDirectory, "gestao-logistica.sqlite3"),
    dataDirectory,
    integrity: db.prepare("PRAGMA integrity_check").get().integrity_check,
  };
}

function deriveStage(row) {
  if (row.entregue_em) return "entregue";
  if (row.postado_em) return "postado";
  if (row.remessa_id) return "em_remessa";
  if (row.etiqueta_criada_em) return "etiqueta_criada";
  if (row.impressao_recebida_em) return "impressoes_recebidas";
  if (row.impressao_enviada_em) return "em_impressao";
  if (row.tratamento_concluido_em) return "tratamento_concluido";
  if (row.selecao_finalizada_em) return "em_tratamento";
  if (row.link_enviado_em) return "aguardando_selecao";
  if (row.galeria_publicada_em || row.galeria_url) return "galeria_publicada";
  return "sessao_criada";
}

function daysBetween(from, to) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(from)) || !/^\d{4}-\d{2}-\d{2}$/.test(clean(to))) return null;
  return Math.round((new Date(`${to}T12:00:00Z`) - new Date(`${from}T12:00:00Z`)) / 86400000);
}

const editableDateFields = new Set([
  "galeria_publicada_em", "link_enviado_em", "selecao_finalizada_em", "tratamento_concluido_em",
  "impressao_enviada_em", "impressao_recebida_em", "etiqueta_criada_em", "postado_em", "entregue_em",
]);

function validIsoDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(clean(value))) return false;
  const parsed = new Date(`${value}T12:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function latestMovement(row) {
  const candidates = [
    row.ultimo_evento_em, row.ultima_selecao_recebida_em, row.galeria_publicada_em, row.link_enviado_em,
    row.selecao_finalizada_em, row.tratamento_concluido_em, row.impressao_enviada_em,
    row.impressao_recebida_em, row.etiqueta_criada_em, row.postado_em, row.entregue_em, row.criado_em,
  ].map(clean).filter(Boolean).sort();
  return candidates.at(-1) || null;
}

function operationalInfo(row, today) {
  const stage = row.etapa || deriveStage(row);
  const historyLimit = addCalendarDays(today, -180);
  const trackingLimit = addCalendarDays(today, -120);
  const historical = row.acompanhamento_status !== "ativo" || stage === "entregue"
    || (row.origem === "siwin" && stage === "sessao_criada" && (row.siwin_sessao_em || row.siwin_pedido_em)
      && (row.siwin_sessao_em || row.siwin_pedido_em) < historyLimit)
    || (row.origem === "planilha_original" && stage === "tratamento_concluido"
      && row.selecao_finalizada_em && row.selecao_finalizada_em < historyLimit)
    || (stage === "postado" && row.postado_em && row.postado_em < trackingLimit);
  if (historical) return { bucket: null, responsavel: "Histórico", acao: "Consultar", urgencia: null, urgenciaDias: null };

  if (!row.cliente_id || !clean(row.cliente_nome))
    return { bucket: "alerts", responsavel: "Cadastro", acao: "Identificar cliente", urgencia: "Cliente não identificado", urgenciaDias: null };
  if (stage === "postado" && !row.codigo_rastreio)
    return { bucket: "alerts", responsavel: "Correios", acao: "Informar rastreio", urgencia: "Postado sem rastreio", urgenciaDias: null };
  if (["impressoes_recebidas", "etiqueta_criada", "em_remessa"].includes(stage) && !clean(row.cliente_logradouro))
    return { bucket: "alerts", responsavel: "Cadastro", acao: "Completar endereço", urgencia: "Endereço incompleto", urgenciaDias: null };
  if (stage === "em_tratamento" && row.prazo_maximo_em && row.prazo_maximo_em < today) {
    const overdue = daysBetween(row.prazo_maximo_em, today);
    return { bucket: "alerts", responsavel: "Tratamento", acao: "Priorizar tratamento", urgencia: `${overdue} dia(s) além do prazo máximo`, urgenciaDias: overdue };
  }
  if (stage === "em_tratamento" && row.prazo_tratamento_em && row.prazo_tratamento_em < today) {
    const overdue = daysBetween(row.prazo_tratamento_em, today);
    return { bucket: "alerts", responsavel: "Tratamento", acao: "Cobrar tratamento", urgencia: `${overdue} dia(s) atrasado`, urgenciaDias: overdue };
  }
  if (stage === "em_tratamento" && row.prazo_tratamento_em && row.prazo_tratamento_em <= addCalendarDays(today, 3)) {
    const remaining = daysBetween(today, row.prazo_tratamento_em);
    return { bucket: "alerts", responsavel: "Tratamento", acao: "Acompanhar prazo", urgencia: remaining === 0 ? "Vence hoje" : `Vence em ${remaining} dia(s)`, urgenciaDias: -remaining };
  }

  if (row.selecoes_pendentes > 0)
    return { bucket: "needs_me", responsavel: "Você", acao: "Conferir e separar seleção", urgencia: "Seleção nova", urgenciaDias: null };
  if (stage === "sessao_criada" && row.siwin_sessao_em && row.siwin_sessao_em > today)
    return { bucket: "waiting", responsavel: "Estúdio", acao: "Aguardando ensaio", urgencia: `Ensaio em ${row.siwin_sessao_em.split("-").reverse().join("/")}`, urgenciaDias: null };
  const needsMe = {
    sessao_criada: "Publicar galeria na EPICS",
    galeria_publicada: "Enviar link da galeria",
    tratamento_concluido: "Enviar fotos à Digital Fotos",
    impressoes_recebidas: "Criar etiqueta dos Correios",
    etiqueta_criada: "Incluir na remessa de sexta",
  };
  if (needsMe[stage]) return { bucket: "needs_me", responsavel: "Você", acao: needsMe[stage], urgencia: null, urgenciaDias: null };

  if (stage === "em_remessa" && row.remessa_data_planejada && row.remessa_data_planejada <= today)
    return { bucket: "needs_me", responsavel: "Você", acao: "Postar remessa", urgencia: row.remessa_data_planejada < today ? "Remessa atrasada" : "Postar hoje", urgenciaDias: null };

  const waiting = {
    aguardando_selecao: ["Cliente", "Aguardando seleção"],
    em_tratamento: ["Tratamento", "Aguardando tratamento"],
    em_impressao: ["Digital Fotos", "Aguardando impressões"],
    em_remessa: ["Remessa", "Aguardando postagem de sexta"],
    postado: ["Correios", "Aguardando entrega"],
  };
  if (waiting[stage]) return { bucket: "waiting", responsavel: waiting[stage][0], acao: waiting[stage][1], urgencia: null, urgenciaDias: null };
  return { bucket: null, responsavel: "—", acao: "Consultar", urgencia: null, urgenciaDias: null };
}

function listOrders(options = {}) {
  const search = clean(options.search).toLowerCase();
  const rows = db
    .prepare(`SELECT p.*, c.nome cliente_nome, c.email cliente_email, c.telefone cliente_telefone,
      c.celular cliente_celular, c.siwin_cad cliente_siwin_cad,
      (SELECT COUNT(*) FROM selecoes_email se WHERE se.pedido_id=p.id AND se.conferida_em IS NULL) selecoes_pendentes,
      (SELECT MAX(e.criado_em) FROM eventos e WHERE e.pedido_id=p.id) ultimo_evento_em,
      (SELECT MAX(se.recebido_em) FROM selecoes_email se WHERE se.pedido_id=p.id) ultima_selecao_recebida_em,
      c.cidade cliente_cidade, c.logradouro cliente_logradouro, c.cep cliente_cep,
      r.data_planejada remessa_data_planejada, u.nome tratamento_responsavel_nome
      FROM pedidos p LEFT JOIN clientes c ON c.id=p.cliente_id
      LEFT JOIN remessas r ON r.id=p.remessa_id
      LEFT JOIN usuarios u ON u.id=p.tratamento_responsavel_usuario_id
      WHERE (? = '' OR lower(p.sessao) LIKE ? OR lower(coalesce(c.nome,'')) LIKE ?
        OR lower(coalesce(p.codigo_rastreio,'')) LIKE ? OR lower(coalesce(c.email,'')) LIKE ?
        OR lower(coalesce(c.telefone,'')) LIKE ? OR lower(coalesce(c.celular,'')) LIKE ?
        OR CAST(coalesce(c.siwin_cad,'') AS TEXT) LIKE ?)
      ORDER BY CASE WHEN p.prazo_tratamento_em IS NULL THEN 1 ELSE 0 END, p.prazo_tratamento_em, p.sessao`)
    .all(search, ...Array(7).fill(`%${search}%`));
  const today = businessDate();
  const enriched = rows.map((row) => {
    const staged = { ...row, etapa: deriveStage(row) };
    const info = operationalInfo(staged, today);
    return { ...staged, ultima_movimentacao_em: latestMovement(staged), operacional_bucket: info.bucket, responsavel_atual: info.responsavel,
      acao_recomendada: info.acao, urgencia_texto: info.urgencia, urgencia_dias: info.urgenciaDias };
  });
  const filter = clean(options.filter);
  if (options.scope === "mine") return enriched.filter((row) => row.tratamento_responsavel_usuario_id === clean(options.userId)
    && isTreatmentSelectionFinalized(row) && !row.tratamento_concluido_em && row.acompanhamento_status === "ativo");
  if (!filter || filter === "all") return enriched;
  if (filter === "needs_me") return enriched.filter((row) => row.operacional_bucket === "needs_me");
  if (filter === "waiting") return enriched.filter((row) => row.operacional_bucket === "waiting");
  if (filter === "alerts") return enriched.filter((row) => row.operacional_bucket === "alerts");
  const inThreeDays = addCalendarDays(today, 3);
  const historyLimit = addCalendarDays(today, -180);
  if (filter === "work") return enriched.filter((row) => row.acompanhamento_status === "ativo"
    && row.etapa !== "entregue"
    && !(row.origem === "siwin" && row.etapa === "sessao_criada" && row.siwin_pedido_em && row.siwin_pedido_em < historyLimit));
  if (filter === "new_selections")
    return enriched.filter((row) => row.acompanhamento_status === "ativo" && row.selecoes_pendentes > 0);
  if (filter === "due_3")
    return enriched.filter((row) => row.acompanhamento_status === "ativo" && row.etapa === "em_tratamento"
      && row.prazo_tratamento_em >= today && row.prazo_tratamento_em <= inThreeDays);
  if (filter === "overdue")
    return enriched.filter((row) => row.acompanhamento_status === "ativo" && row.etapa === "em_tratamento" && row.prazo_tratamento_em < today);
  if (filter === "max_overdue")
    return enriched.filter((row) => row.acompanhamento_status === "ativo" && !row.tratamento_concluido_em
      && row.prazo_maximo_em && row.prazo_maximo_em < today);
  if (filter === "treated_ready")
    return enriched.filter((row) => row.acompanhamento_status === "ativo" && row.etapa === "tratamento_concluido");
  if (filter === "ready_label")
    return enriched.filter((row) => row.acompanhamento_status === "ativo" && row.impressao_recebida_em && !row.etiqueta_criada_em);
  if (filter === "shipment")
    return enriched.filter((row) => row.acompanhamento_status === "ativo" && row.remessa_id && !row.postado_em);
  if (filter === "archived") return enriched.filter((row) => row.acompanhamento_status !== "ativo");
  if (filter === "review_history")
    return enriched.filter((row) => row.acompanhamento_status === "ativo" && row.origem === "siwin"
      && row.etapa === "sessao_criada" && row.siwin_pedido_em && row.siwin_pedido_em < historyLimit);
  if (filter === "missing_client") return enriched.filter((row) => !row.cliente_id);
  return enriched.filter((row) => row.etapa === filter);
}

function normalizeDigitalSession(value) {
  const session = clean(value).replace(/\s+/g, "");
  if (!/^M?\d+$/i.test(session)) return null;
  return `M${session.replace(/^M/i, "")}`.toUpperCase();
}

const digitalShipmentSummarySql = `SELECT s.id,s.numero_pedido_digital,s.data_envio,s.itens_digital,s.criado_por_usuario_id,
    s.criado_em,s.atualizado_em,s.revision,
    CASE WHEN EXISTS (SELECT 1 FROM digital_envio_eventos ae WHERE ae.digital_envio_id=s.id
      AND ae.acao='digital_sync_created' AND ae.usuario_id IS NULL)
      THEN 'DigitalSyncService' ELSE coalesce(u.nome,'Usuário local') END registrado_por,
    count(i.id) sessoes_quantidade,
    s.itens_digital fotos_quantidade_soma,
    CASE WHEN s.itens_digital IS NULL THEN 1 ELSE 0 END fotos_quantidade_desconhecida
  FROM digital_envios s LEFT JOIN usuarios u ON u.id=s.criado_por_usuario_id
  LEFT JOIN digital_envio_itens i ON i.digital_envio_id=s.id
  LEFT JOIN pedidos p ON p.id=i.pedido_id`;

function getDigitalShipment(idValue) {
  const shipmentId = clean(idValue);
  const shipment = db.prepare(`${digitalShipmentSummarySql} WHERE s.id=? GROUP BY s.id`).get(shipmentId);
  if (!shipment) return null;
  const items = db.prepare(`SELECT p.id pedido_id,p.sessao,c.nome cliente_nome,i.quantidade_enviada,i.quantidade_enviada fotos_quantidade
    FROM digital_envio_itens i JOIN pedidos p ON p.id=i.pedido_id
    LEFT JOIN clientes c ON c.id=p.cliente_id
    WHERE i.digital_envio_id=? ORDER BY p.sessao COLLATE NOCASE`).all(shipmentId);
  const events = db.prepare(`SELECT e.id,e.acao,e.descricao,e.criado_em,e.usuario_id,
      CASE WHEN e.acao='digital_sync_created' AND e.usuario_id IS NULL
        THEN 'DigitalSyncService' ELSE coalesce(u.nome,'Usuário local') END usuario_nome
    FROM digital_envio_eventos e LEFT JOIN usuarios u ON u.id=e.usuario_id
    WHERE e.digital_envio_id=? ORDER BY e.criado_em DESC,e.id DESC`).all(shipmentId);
  return { ...shipment, sessoes_quantidade: Number(shipment.sessoes_quantidade || 0),
    fotos_quantidade_desconhecida: Number(shipment.fotos_quantidade_desconhecida || 0), items, events };
}

function getDigitalShipmentsForOrder(orderIdValue) {
  const orderId = clean(orderIdValue);
  if (!db.prepare("SELECT 1 FROM pedidos WHERE id=?").get(orderId)) return { ok: false, error: "NOT_FOUND", message: "Pedido não encontrado." };
  const rows = db.prepare(`${digitalShipmentSummarySql}
    WHERE EXISTS (SELECT 1 FROM digital_envio_itens ix WHERE ix.digital_envio_id=s.id AND ix.pedido_id=?)
    GROUP BY s.id ORDER BY s.data_envio,s.criado_em`).all(orderId);
  return { ok: true, rows: rows.map((row) => ({ ...row, sessoes_quantidade: Number(row.sessoes_quantidade || 0),
    fotos_quantidade_desconhecida: Number(row.fotos_quantidade_desconhecida || 0) })) };
}

function listDigitalShipments(options = {}) {
  const page = Math.max(1, Math.trunc(Number(options.page) || 1));
  const pageSize = Math.min(100, Math.max(1, Math.trunc(Number(options.pageSize) || 20)));
  const search = clean(options.search);
  const compact = search.replace(/\s+/g, "");
  const session = normalizeDigitalSession(compact);
  const from = clean(options.from);
  const to = clean(options.to);
  if ((from && !validIsoDate(from)) || (to && !validIsoDate(to)) || (from && to && from > to))
    return { ok: false, error: "INVALID_DATE_RANGE", message: "O período informado é inválido." };

  const where = [];
  const params = [];
  if (search) {
    if (session) {
      where.push(`(s.numero_pedido_digital=? COLLATE NOCASE OR EXISTS (
        SELECT 1 FROM digital_envio_itens ix JOIN pedidos px ON px.id=ix.pedido_id
        WHERE ix.digital_envio_id=s.id AND px.sessao=? COLLATE NOCASE))`);
      params.push(compact, session);
    } else {
      const escaped = search.toLowerCase().replace(/[\\%_]/g, "\\$&");
      where.push(`(s.numero_pedido_digital=? COLLATE NOCASE OR EXISTS (
        SELECT 1 FROM digital_envio_itens ix JOIN pedidos px ON px.id=ix.pedido_id
        LEFT JOIN clientes cx ON cx.id=px.cliente_id
        WHERE ix.digital_envio_id=s.id AND lower(coalesce(cx.nome,'')) LIKE ? ESCAPE '\\'))`);
      params.push(compact, `%${escaped}%`);
    }
  }
  if (from) { where.push("s.data_envio>=?"); params.push(from); }
  if (to) { where.push("s.data_envio<=?"); params.push(to); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  let orderBy = "s.data_envio DESC,s.criado_em DESC,s.id DESC";
  if (options.sort === "date-asc") orderBy = "s.data_envio ASC,s.criado_em ASC,s.id ASC";
  else if (options.sort === "number-asc" || options.sort === "number-desc") {
    const direction = options.sort === "number-asc" ? "ASC" : "DESC";
    orderBy = `CASE WHEN s.numero_pedido_digital<>'' AND s.numero_pedido_digital NOT GLOB '*[^0-9]*' THEN 0 ELSE 1 END ASC,
      CASE WHEN s.numero_pedido_digital<>'' AND s.numero_pedido_digital NOT GLOB '*[^0-9]*' THEN length(s.numero_pedido_digital) END ${direction},
      s.numero_pedido_digital COLLATE NOCASE ${direction},s.data_envio DESC,s.criado_em DESC`;
  }
  const total = db.prepare(`SELECT count(*) total FROM digital_envios s ${clause}`).get(...params).total;
  const rows = db.prepare(`${digitalShipmentSummarySql} ${clause} GROUP BY s.id ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize)
    .map((row) => ({ ...row, sessoes_quantidade: Number(row.sessoes_quantidade || 0),
      fotos_quantidade_desconhecida: Number(row.fotos_quantidade_desconhecida || 0) }));

  let sessionResult = null;
  if (session) {
    const order = db.prepare(`SELECT p.id,p.sessao,p.fotos_quantidade,c.nome cliente_nome
      FROM pedidos p LEFT JOIN clientes c ON c.id=p.cliente_id WHERE p.sessao=? COLLATE NOCASE`).get(session) || null;
    sessionResult = { found: Boolean(order), order, shipments: order ? getDigitalShipmentsForOrder(order.id).rows : [] };
  }
  return { ok: true, rows, total, page, pageSize, totalPages: Math.ceil(total / pageSize), session: sessionResult };
}

function resolveDigitalShipmentSessions(input) {
  const values = Array.isArray(input?.sessions) ? input.sessions : [];
  if (!values.length || values.length > 500) return { ok: false, error: "INVALID_SESSIONS", message: "Informe de 1 a 500 sessões." };
  const normalizedValues = values.map(normalizeDigitalSession);
  if (normalizedValues.some((value) => !value))
    return { ok: false, error: "INVALID_SESSIONS", message: "Uma ou mais sessões têm formato inválido." };
  const normalized = [...new Set(normalizedValues)];
  const lookup = db.prepare(`SELECT p.id,p.sessao,p.fotos_quantidade,c.nome cliente_nome
    FROM pedidos p LEFT JOIN clientes c ON c.id=p.cliente_id WHERE p.sessao=? COLLATE NOCASE`);
  const prior = db.prepare(`SELECT s.id,s.numero_pedido_digital,s.data_envio,
      CASE WHEN EXISTS (SELECT 1 FROM digital_envio_eventos ae WHERE ae.digital_envio_id=s.id
        AND ae.acao='digital_sync_created' AND ae.usuario_id IS NULL)
        THEN 'DigitalSyncService' ELSE coalesce(u.nome,'Usuário local') END registrado_por
    FROM digital_envio_itens i JOIN digital_envios s ON s.id=i.digital_envio_id
    LEFT JOIN usuarios u ON u.id=s.criado_por_usuario_id WHERE i.pedido_id=?
    ORDER BY s.data_envio DESC,s.criado_em DESC`);
  const rows = normalized.map((sessao) => {
    const order = lookup.get(sessao) || null;
    return order ? { ...order, priorShipments: prior.all(order.id) } : { sessao, notFound: true };
  });
  return { ok: true, rows, notFound: rows.filter((row) => row.notFound).map((row) => row.sessao) };
}

function digitalShipmentActor(actorUserId, actorRole) {
  if (!["coordinator", "employee"].includes(actorRole)) return { error: "FORBIDDEN" };
  const userId = clean(actorUserId);
  if (!userId) return actorRole === "coordinator" ? { user: null } : { error: "FORBIDDEN" };
  const user = db.prepare("SELECT id,nome,role,ativo FROM usuarios WHERE id=?").get(userId);
  return user?.ativo === 1 && user.role === actorRole ? { user } : { error: "FORBIDDEN" };
}

function normalizedShipmentInput(input) {
  const number = normalizeDigitalShipmentNumber(input?.numeroPedidoDigital);
  const date = clean(input?.dataEnvio);
  const pedidoIds = Array.isArray(input?.pedidoIds) ? [...new Set(input.pedidoIds.map(clean).filter(Boolean))] : [];
  if (!number || number.length > 80) return { error: "INVALID_NUMBER", message: "Informe um número de pedido Digital válido (até 80 caracteres)." };
  if (!validIsoDate(date)) return { error: "INVALID_DATE", message: "Informe uma data de envio válida." };
  if (!pedidoIds.length || pedidoIds.length > 500) return { error: "INVALID_SESSIONS", message: "Selecione de 1 a 500 sessões existentes." };
  const hasDigitalTotal = Object.hasOwn(input || {}, "itensDigital");
  const digitalTotal = hasDigitalTotal ? normalizeDigitalQuantity(input.itensDigital, "INVALID_DIGITAL_TOTAL") : undefined;
  if (digitalTotal?.error) return digitalTotal;
  const hasSessionQuantities = Object.hasOwn(input || {}, "quantidadesEnviadas");
  const quantities = new Map();
  if (hasSessionQuantities) {
    if (!input.quantidadesEnviadas || typeof input.quantidadesEnviadas !== "object" || Array.isArray(input.quantidadesEnviadas)) return { error: "INVALID_SESSION_QUANTITY", message: "Uma ou mais quantidades por sessão são inválidas." };
    for (const [orderId, value] of Object.entries(input.quantidadesEnviadas)) {
      if (!pedidoIds.includes(orderId)) continue;
      const quantity = normalizeDigitalQuantity(value, "INVALID_SESSION_QUANTITY");
      if (quantity?.error) return { error: quantity.error, message: "Uma ou mais quantidades por sessão são inválidas." };
      quantities.set(orderId, quantity);
    }
  }
  const found = db.prepare(`SELECT id,sessao,fotos_quantidade FROM pedidos WHERE id IN (${pedidoIds.map(() => "?").join(",")})`).all(...pedidoIds);
  if (found.length !== pedidoIds.length) return { error: "ORDER_NOT_FOUND", message: "Uma ou mais sessões não existem mais no Gestão Logística." };
  return { number, date, pedidoIds, orders: found, hasDigitalTotal, digitalTotal, hasSessionQuantities, quantities };
}

function normalizeDigitalQuantity(value, error) {
  if (value === null || value === "") return null;
  if (!Number.isSafeInteger(value) || value < 0) return { error, message: "A quantidade deve ser um número inteiro igual ou maior que zero." };
  return value;
}

const DIGITAL_TOTAL_EXCEEDED = "A soma das quantidades das sessões não pode ser maior que o total de itens do pedido Digital.";
function digitalQuantitiesExceedTotal(total, quantities) {
  return validateShipmentQuantities(total ?? null,
    [...quantities].map(([pedidoId, quantidadeEnviada]) => ({ pedidoId, quantidadeEnviada })))
    === "DIGITAL_ITEMS_EXCEEDED";
}

function priorDigitalShipments(pedidoIds, exceptShipmentId = "") {
  if (!pedidoIds.length) return [];
  const rows = db.prepare(`SELECT p.id pedido_id,p.sessao,s.id envio_id,s.numero_pedido_digital,s.data_envio,
      CASE WHEN EXISTS (SELECT 1 FROM digital_envio_eventos ae WHERE ae.digital_envio_id=s.id
        AND ae.acao='digital_sync_created' AND ae.usuario_id IS NULL)
        THEN 'DigitalSyncService' ELSE coalesce(u.nome,'Usuário local') END registrado_por
    FROM digital_envio_itens i JOIN digital_envios s ON s.id=i.digital_envio_id
    JOIN pedidos p ON p.id=i.pedido_id LEFT JOIN usuarios u ON u.id=s.criado_por_usuario_id
    WHERE i.pedido_id IN (${pedidoIds.map(() => "?").join(",")}) AND s.id<>?
    ORDER BY s.data_envio DESC,s.criado_em DESC`).all(...pedidoIds, exceptShipmentId);
  return rows;
}

function insertDigitalShipmentEvent(shipmentId, userId, action, description) {
  db.prepare("INSERT INTO digital_envio_eventos (id,digital_envio_id,usuario_id,acao,descricao,criado_em) VALUES (?,?,?,?,?,?)")
    .run(id(), shipmentId, userId || null, action, description, now());
}

function createDigitalShipment(input) {
  const actor = digitalShipmentActor(input?.actorUserId, input?.actorRole);
  if (actor.error) return { ok: false, error: actor.error, message: "Usuário não autorizado a registrar envios." };
  const values = normalizedShipmentInput(input);
  if (values.error) return { ok: false, error: values.error, message: values.message };
  const shipmentId = id();
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    if (values.hasSessionQuantities && digitalQuantitiesExceedTotal(values.digitalTotal, values.quantities)) {
      db.exec("ROLLBACK"); return { ok: false, error: "DIGITAL_ITEMS_EXCEEDED", message: DIGITAL_TOTAL_EXCEEDED };
    }
    const duplicate = db.prepare("SELECT id FROM digital_envios WHERE numero_pedido_digital=? COLLATE NOCASE").get(values.number);
    if (duplicate) { db.exec("ROLLBACK"); return { ok: false, error: "DUPLICATE_DIGITAL_ORDER", existingId: duplicate.id, message: "Este pedido da Digital já foi registrado." }; }
    const prior = priorDigitalShipments(values.pedidoIds);
    if (prior.length && input?.confirmReenvio !== true) {
      db.exec("ROLLBACK");
      return { ok: false, error: "DUPLICATE_SESSIONS", priorShipments: prior,
        message: `${new Set(prior.map((row) => row.pedido_id)).size} das sessões selecionadas já possui envio registrado.` };
    }
    const who = actor.user?.nome || "Usuário local";
    const quantitiesDescription = values.pedidoIds.map((orderId) => {
      const session = values.orders.find((order) => order.id === orderId)?.sessao || orderId;
      const quantity = values.quantities.get(orderId);
      return `${session}=${quantity == null ? "não informada" : quantity}`;
    }).join(", ");
    insertShipmentWithEvent(db, { id: shipmentId, number: values.number, date: values.date,
      total: values.hasDigitalTotal ? values.digitalTotal : null,
      actorUserId: actor.user?.id || null, timestamp,
      items: values.pedidoIds.map((pedidoId) => ({ pedidoId,
        quantidadeEnviada: values.quantities.get(pedidoId) ?? null })), action: "created",
      description: `${who} registrou o pedido Digital ${values.number} com ${values.pedidoIds.length} sessões; total Digital ${values.hasDigitalTotal && values.digitalTotal !== null ? values.digitalTotal : "não informado"}; quantidades enviadas: ${quantitiesDescription}.` });
    db.exec("COMMIT");
    return { ok: true, shipment: getDigitalShipment(shipmentId) };
  } catch (error) {
    db.exec("ROLLBACK");
    if (String(error.message).includes("UNIQUE")) return { ok: false, error: "DUPLICATE_DIGITAL_ORDER", message: "Este pedido da Digital já foi registrado." };
    throw error;
  }
}

function updateDigitalShipment(input) {
  const actor = digitalShipmentActor(input?.actorUserId, input?.actorRole);
  if (actor.error) return { ok: false, error: actor.error, message: "Usuário não autorizado a editar envios." };
  const shipmentId = clean(input?.id);
  const revision = input?.revision;
  if (!Number.isSafeInteger(revision) || revision < 1) return { ok: false, error: "REVISION_REQUIRED", message: "A revisão é obrigatória. Reabra o pedido Digital." };
  const current = db.prepare("SELECT * FROM digital_envios WHERE id=?").get(shipmentId);
  if (!current) return { ok: false, error: "NOT_FOUND", message: "Pedido Digital não encontrado." };
  if (actor.user?.role !== "coordinator" && current.criado_por_usuario_id !== actor.user?.id)
    return { ok: false, error: "FORBIDDEN", message: "Funcionários só podem editar os próprios registros." };
  if (current.revision !== revision) return { ok: false, error: "REVISION_CONFLICT", revisionAtual: current.revision, message: "Este registro foi alterado por outra pessoa. Reabra o pedido Digital." };
  const values = normalizedShipmentInput(input);
  if (values.error) return { ok: false, error: values.error, message: values.message };
  const existingIds = db.prepare("SELECT pedido_id FROM digital_envio_itens WHERE digital_envio_id=?").all(shipmentId).map((row) => row.pedido_id);
  const existingSet = new Set(existingIds);
  const nextSet = new Set(values.pedidoIds);
  const added = values.pedidoIds.filter((orderId) => !existingSet.has(orderId));
  const removed = existingIds.filter((orderId) => !nextSet.has(orderId));
  db.exec("BEGIN IMMEDIATE");
  try {
    const nextTotal = values.hasDigitalTotal ? values.digitalTotal : current.itens_digital ?? null;
    const currentQuantities = new Map(db.prepare("SELECT pedido_id,quantidade_enviada FROM digital_envio_itens WHERE digital_envio_id=?").all(shipmentId).map((item) => [item.pedido_id, item.quantidade_enviada]));
    const nextQuantities = new Map(values.pedidoIds.map((orderId) => [orderId, values.hasSessionQuantities ? (values.quantities.has(orderId) ? values.quantities.get(orderId) : null) : (currentQuantities.get(orderId) ?? null)]));
    if (digitalQuantitiesExceedTotal(nextTotal, nextQuantities)) {
      db.exec("ROLLBACK"); return { ok: false, error: "DIGITAL_ITEMS_EXCEEDED", message: DIGITAL_TOTAL_EXCEEDED };
    }
    const duplicate = db.prepare("SELECT id FROM digital_envios WHERE numero_pedido_digital=? COLLATE NOCASE AND id<>?").get(values.number, shipmentId);
    if (duplicate) { db.exec("ROLLBACK"); return { ok: false, error: "DUPLICATE_DIGITAL_ORDER", existingId: duplicate.id, message: "Este pedido da Digital já foi registrado." }; }
    const prior = priorDigitalShipments(added, shipmentId);
    if (prior.length && input?.confirmReenvio !== true) {
      db.exec("ROLLBACK");
      return { ok: false, error: "DUPLICATE_SESSIONS", priorShipments: prior,
        message: `${new Set(prior.map((row) => row.pedido_id)).size} das sessões adicionadas já possui envio registrado.` };
    }
    const timestamp = now();
    const update = db.prepare(`UPDATE digital_envios SET numero_pedido_digital=?,data_envio=?,itens_digital=?,atualizado_em=?,revision=revision+1
      WHERE id=? AND revision=?`).run(values.number, values.date, nextTotal, timestamp, shipmentId, revision);
    if (update.changes !== 1) { db.exec("ROLLBACK"); return { ok: false, error: "REVISION_CONFLICT", message: "Este registro foi alterado por outra pessoa. Reabra o pedido Digital." }; }
    const oldNumber = current.numero_pedido_digital;
    const oldDate = current.data_envio;
    if (oldNumber !== values.number) insertDigitalShipmentEvent(shipmentId, actor.user?.id, "number_changed", `Número do pedido Digital alterado de ${oldNumber} para ${values.number}.`);
    if (oldDate !== values.date) insertDigitalShipmentEvent(shipmentId, actor.user?.id, "date_changed", `Data do envio alterada de ${oldDate} para ${values.date}.`);
    if (current.itens_digital !== nextTotal) insertDigitalShipmentEvent(shipmentId, actor.user?.id, "digital_total_changed", `Total de itens Digital alterado de ${current.itens_digital ?? "não informado"} para ${nextTotal ?? "não informado"}.`);
    const insert = db.prepare("INSERT INTO digital_envio_itens (id,digital_envio_id,pedido_id,criado_em,quantidade_enviada) VALUES (?,?,?,?,?)");
    for (const orderId of added) {
      insert.run(id(), shipmentId, orderId, timestamp, nextQuantities.get(orderId) ?? null);
      const session = values.orders.find((order) => order.id === orderId)?.sessao || orderId;
      const quantity = nextQuantities.get(orderId);
      insertDigitalShipmentEvent(shipmentId, actor.user?.id, "item_added", `Sessão ${session} adicionada ao pedido Digital ${values.number}; quantidade enviada ${quantity == null ? "não informada" : quantity}.`);
    }
    const setQuantity = db.prepare("UPDATE digital_envio_itens SET quantidade_enviada=? WHERE digital_envio_id=? AND pedido_id=?");
    for (const orderId of values.pedidoIds.filter((orderId) => existingSet.has(orderId))) {
      const priorQuantity = currentQuantities.get(orderId) ?? null;
      const nextQuantity = nextQuantities.get(orderId) ?? null;
      if (priorQuantity !== nextQuantity) {
        setQuantity.run(nextQuantity, shipmentId, orderId);
        const session = values.orders.find((order) => order.id === orderId)?.sessao || orderId;
        insertDigitalShipmentEvent(shipmentId, actor.user?.id, "session_quantity_changed", `Quantidade enviada da sessão ${session} alterada de ${priorQuantity ?? "não informada"} para ${nextQuantity ?? "não informada"}.`);
      }
    }
    const remove = db.prepare("DELETE FROM digital_envio_itens WHERE digital_envio_id=? AND pedido_id=?");
    for (const orderId of removed) {
      const session = db.prepare("SELECT sessao FROM pedidos WHERE id=?").get(orderId)?.sessao || orderId;
      remove.run(shipmentId, orderId);
      insertDigitalShipmentEvent(shipmentId, actor.user?.id, "item_removed", `Sessão ${session} removida do pedido Digital ${values.number}.`);
    }
    db.exec("COMMIT");
    return { ok: true, shipment: getDigitalShipment(shipmentId) };
  } catch (error) {
    db.exec("ROLLBACK");
    if (String(error.message).includes("UNIQUE")) return { ok: false, error: "DUPLICATE_DIGITAL_ORDER", message: "Este pedido da Digital já foi registrado." };
    throw error;
  }
}

function listClients(options = {}) {
  const search = clean(options.search).toLowerCase();
  const limit = Math.min(Math.max(Number(options.limit) || 200, 1), 500);
  return db.prepare(`SELECT c.*,
      (SELECT COUNT(*) FROM pedidos p WHERE p.cliente_id=c.id) pedidos_quantidade
    FROM clientes c
    WHERE (c.siwin_estudio=1 OR EXISTS (SELECT 1 FROM pedidos px WHERE px.cliente_id=c.id))
      AND (?='' OR lower(coalesce(c.nome,'')) LIKE ? OR lower(coalesce(c.email,'')) LIKE ?
      OR lower(coalesce(c.telefone,'')) LIKE ? OR CAST(coalesce(c.siwin_cad,'') AS TEXT) LIKE ?)
    ORDER BY c.nome LIMIT ?`).all(search, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, limit);
}

function getOrder(orderId) {
  const order = db.prepare(`SELECT p.*, c.nome cliente_nome, c.email cliente_email,
      c.telefone cliente_telefone, c.celular cliente_celular, c.logradouro cliente_logradouro,
      c.numero cliente_numero, c.complemento cliente_complemento, c.bairro cliente_bairro,
      c.cidade cliente_cidade, c.uf cliente_uf, c.cep cliente_cep, c.siwin_cad cliente_siwin_cad,
      r.data_planejada remessa_data_planejada, u.nome tratamento_responsavel_nome
    FROM pedidos p LEFT JOIN clientes c ON c.id=p.cliente_id
    LEFT JOIN remessas r ON r.id=p.remessa_id
    LEFT JOIN usuarios u ON u.id=p.tratamento_responsavel_usuario_id WHERE p.id=?`).get(clean(orderId));
  if (!order) return { ok: false, message: "Pedido não encontrado." };
  return {
    ok: true,
    order: { ...order, etapa: deriveStage(order) },
    attachments: db.prepare("SELECT id,tipo,nome_arquivo,criado_em FROM anexos WHERE pedido_id=? ORDER BY criado_em DESC").all(order.id),
    items: db.prepare(`SELECT id,siwin_ped_ms,produto,quantidade,fotos,valor_unitario,desconto,
      valor_total,cobrado,situacao,tipo_foto,ampliacao FROM pedido_itens
      WHERE pedido_id=? ORDER BY siwin_ped_ms`).all(order.id),
    siwinObservations: db.prepare(`SELECT id,siwin_ped_obs,usuario,cadastrado_em,observacao
      FROM pedido_observacoes_siwin WHERE pedido_id=?
      ORDER BY cadastrado_em DESC,siwin_ped_obs DESC`).all(order.id),
    selectionEmails: db.prepare(`SELECT id,message_id,sessao,recebido_em,data_finalizacao,
      quantidade_selecionada,quantidade_total,codigos_json,status,conferida_em,fotos_separadas_em
      FROM selecoes_email WHERE pedido_id=? ORDER BY recebido_em DESC`).all(order.id)
      .map((item) => ({ ...item, codigos: JSON.parse(item.codigos_json || "[]") })),
    events: db.prepare(`SELECT e.id,e.tipo,e.descricao,e.usuario_id,u.nome usuario_nome,u.usuario usuario_login,e.criado_em
      FROM eventos e LEFT JOIN usuarios u ON u.id=e.usuario_id
      WHERE e.pedido_id=? ORDER BY e.criado_em DESC LIMIT 100`).all(order.id),
  };
}

function getOrderClientProfile(orderId) {
  const row = db.prepare(`SELECT p.cliente_id, c.nome, c.documento, c.email, c.telefone, c.celular,
      c.logradouro, c.numero, c.complemento, c.bairro, c.cidade, c.uf, c.cep
    FROM pedidos p LEFT JOIN clientes c ON c.id=p.cliente_id WHERE p.id=?`).get(clean(orderId));
  if (!row) return { ok: false, error: "NOT_FOUND", message: "Pedido não encontrado." };
  if (!row.cliente_id) return { ok: true, linked: false, profile: null };
  return {
    ok: true,
    linked: true,
    profile: {
      nomeCompleto: row.nome,
      documento: row.documento,
      email: row.email,
      telefone: row.telefone,
      celular: row.celular,
      logradouro: row.logradouro,
      numero: row.numero,
      complemento: row.complemento,
      bairro: row.bairro,
      cidade: row.cidade,
      uf: row.uf,
      cep: row.cep,
    },
  };
}

function updateOrder(input) {
  const orderId = clean(input?.id);
  const expectedRevision = input?.revisao;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) return { ok: false, error: "REVISION_REQUIRED", message: "A revisão do pedido é obrigatória. Reabra a ficha." };
  const values = input?.values && typeof input.values === "object" ? input.values : {};
  const allowed = new Set([
    "galeria_url", "galeria_publicada_em", "link_enviado_em", "selecao_finalizada_em",
    "tratamento_concluido_em", "impressao_enviada_em", "fornecedor_impressao",
    "impressao_recebida_em", "etiqueta_criada_em", "postado_em", "codigo_rastreio",
    "entregue_em", "observacoes", "fotos_quantidade",
    "acompanhamento_status",
  ]);
  const entries = Object.entries(values).filter(([field]) => allowed.has(field));
  if (!entries.length) return { ok: false, message: "Nenhuma informação válida foi enviada." };
  const order = db.prepare("SELECT * FROM pedidos WHERE id=?").get(orderId);
  if (!order) return { ok: false, message: "Pedido não encontrado." };
  if (order.revisao !== expectedRevision) return { ok: false, error: "REVISION_CONFLICT", revisaoAtual: order.revisao, message: "Este pedido foi alterado por outro usuário. Suas alterações não foram salvas. Reabra a ficha para consultar a versão atual." };
  for (const [field, value] of entries) {
    if (editableDateFields.has(field) && clean(value) && !validIsoDate(clean(value)))
      return { ok: false, message: `A data informada em ${field} é inválida.` };
    if (field === "fotos_quantidade" && clean(value) && (!Number.isFinite(Number(value)) || Number(value) < 0))
      return { ok: false, message: "A quantidade de fotos deve ser um número igual ou maior que zero." };
  }
  if (clean(values.galeria_url) && !/^https?:\/\//i.test(clean(values.galeria_url)))
    return { ok: false, message: "A URL da galeria deve começar com http:// ou https://." };
  const normalized = entries.map(([field, value]) => {
    if (field === "fotos_quantidade") {
      const quantity = clean(value) === "" ? null : Number(value);
      return [field, Number.isFinite(quantity) && quantity >= 0 ? Math.trunc(quantity) : null];
    }
    if (field === "codigo_rastreio") return [field, clean(value).toUpperCase() || null];
    return [field, clean(value) || null];
  }).filter(([field, value]) => String(order[field] ?? "") !== String(value ?? ""));
  if (!normalized.length) return { ...getOrder(orderId), unchanged: true, message: "Nenhuma alteração para salvar." };
  const merged = { ...order, ...Object.fromEntries(normalized) };
  const prerequisites = {
    tratamento_concluido_em: ["selecao_finalizada_em", "Registre primeiro a finalização da seleção."],
    impressao_enviada_em: ["tratamento_concluido_em", "Conclua o tratamento antes de enviar para impressão."],
    impressao_recebida_em: ["impressao_enviada_em", "Registre primeiro o envio para a Digital Fotos."],
    etiqueta_criada_em: ["impressao_recebida_em", "Registre primeiro o recebimento das impressões."],
    postado_em: ["etiqueta_criada_em", "Registre primeiro a criação da etiqueta."],
    entregue_em: ["postado_em", "Registre primeiro a postagem."],
  };
  for (const [field, value] of normalized) {
    const rule = prerequisites[field];
    if (value && rule && !clean(merged[rule[0]])) return { ok: false, message: rule[1] };
  }
  if (clean(merged.postado_em) && !clean(merged.codigo_rastreio))
    return { ok: false, message: "Informe o código de rastreio antes de registrar a postagem." };
  const selection = normalized.find(([field]) => field === "selecao_finalizada_em");
  if (selection) {
    if (!selection[1]) {
      const downstreamFields = ["tratamento_concluido_em", "impressao_enviada_em", "impressao_recebida_em",
        "etiqueta_criada_em", "postado_em", "entregue_em"];
      if (downstreamFields.some((field) => clean(merged[field])))
        return { ok: false, message: "Não é possível remover a seleção enquanto houver etapas posteriores registradas." };
    }
    normalized.push(["prazo_tratamento_em", addCalendarDays(selection[1], 20)]);
    normalized.push(["prazo_maximo_em", addCalendarDays(selection[1], 60)]);
  }
  normalized.push(["atualizado_em", now()]);
  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = db.prepare(`UPDATE pedidos SET ${normalized.map(([field]) => `${field}=?`).join(",")}, revisao=revisao+1 WHERE id=? AND revisao=?`)
      .run(...normalized.map(([, value]) => value), orderId, expectedRevision);
    if (updated.changes !== 1) {
      db.exec("ROLLBACK");
      return { ok: false, error: "REVISION_CONFLICT", message: "Este pedido foi alterado por outro usuário. Suas alterações não foram salvas. Reabra a ficha para consultar a versão atual." };
    }
    db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,usuario_id,criado_em) VALUES (?,?,?,?,?,?)").run(
      id(), orderId, "edicao", `Informações atualizadas: ${normalized.filter(([field]) => !["prazo_tratamento_em", "prazo_maximo_em", "atualizado_em", "tratamento_responsavel_usuario_id"].includes(field)).map(([field]) => field).join(", ")}.`, clean(input?.usuarioId) || null, now(),
    );
    if (order.tratamento_atribuicao_modo !== "manual"
      && normalized.some(([field]) => field === "fotos_quantidade" || field === "selecao_finalizada_em")) {
      const current = db.prepare("SELECT fotos_quantidade FROM pedidos WHERE id=?").get(orderId);
      setAutomaticTreatmentAssignment(orderId, current?.fotos_quantidade, treatmentAssignmentConfig());
    }
    db.exec("COMMIT");
    return getOrder(orderId);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function updateTreatmentAssignee(input) {
  const orderId = clean(input?.id);
  const revision = input?.revisao;
  if (input?.actorRole !== "coordinator") return { ok: false, error: "FORBIDDEN", message: "Somente a coordenação pode alterar o responsável pelo tratamento." };
  if (!Number.isSafeInteger(revision) || revision < 1) return { ok: false, error: "REVISION_REQUIRED", message: "A revisão do pedido é obrigatória. Reabra a ficha." };
  const order = db.prepare("SELECT * FROM pedidos WHERE id=?").get(orderId);
  if (!order) return { ok: false, message: "Pedido não encontrado." };
  if (order.revisao !== revision) return { ok: false, error: "REVISION_CONFLICT", revisaoAtual: order.revisao, message: "Este pedido foi alterado por outra pessoa. Reabra a ficha." };
  const userId = clean(input?.responsavelUsuarioId);
  const user = userId ? db.prepare("SELECT id,nome FROM usuarios WHERE id=? AND ativo=1").get(userId) : null;
  if (userId && !user) return { ok: false, message: "Selecione um usuário ativo." };
  const oldUser = order.tratamento_responsavel_usuario_id
    ? db.prepare("SELECT nome FROM usuarios WHERE id=?").get(order.tratamento_responsavel_usuario_id) : null;
  if (order.tratamento_atribuicao_modo === "manual" && order.tratamento_responsavel_usuario_id === (user?.id || null))
    return { ...getOrder(orderId), unchanged: true };
  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = db.prepare(`UPDATE pedidos SET tratamento_responsavel_usuario_id=?, tratamento_atribuicao_modo='manual',
      atualizado_em=?, revisao=revisao+1 WHERE id=? AND revisao=?`)
      .run(user?.id || null, now(), orderId, revision);
    if (updated.changes !== 1) { db.exec("ROLLBACK"); return { ok: false, error: "REVISION_CONFLICT", message: "Este pedido foi alterado por outra pessoa. Reabra a ficha." }; }
    const oldName = oldUser?.nome || "Não atribuído";
    const newName = user?.nome || "Não atribuído";
    db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,usuario_id,criado_em) VALUES (?,?,?,?,?,?)")
      .run(id(), orderId, "atribuicao_tratamento", `Responsável pelo tratamento alterado manualmente de ${oldName} para ${newName}.`, clean(input?.actorUserId) || null, now());
    db.exec("COMMIT");
    return getOrder(orderId);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function restoreAutomaticTreatmentAssignee(input) {
  const orderId = clean(input?.id);
  const revision = input?.revisao;
  if (input?.actorRole !== "coordinator") return { ok: false, error: "FORBIDDEN", message: "Somente a coordenação pode restaurar a atribuição automática." };
  if (!Number.isSafeInteger(revision) || revision < 1) return { ok: false, error: "REVISION_REQUIRED", message: "A revisão do pedido é obrigatória. Reabra a ficha." };
  const order = db.prepare("SELECT * FROM pedidos WHERE id=?").get(orderId);
  if (!order) return { ok: false, message: "Pedido não encontrado." };
  if (order.revisao !== revision) return { ok: false, error: "REVISION_CONFLICT", revisaoAtual: order.revisao, message: "Este pedido foi alterado por outra pessoa. Reabra a ficha." };
  const assignee = resolveEligibleTreatmentAssignee(order, order.fotos_quantidade, treatmentAssignmentConfig(), { allowHistorical: true });
  if (order.tratamento_atribuicao_modo === "auto" && order.tratamento_responsavel_usuario_id === assignee)
    return { ...getOrder(orderId), unchanged: true };
  db.exec("BEGIN IMMEDIATE");
  try {
    const updated = db.prepare(`UPDATE pedidos SET tratamento_responsavel_usuario_id=?, tratamento_atribuicao_modo='auto',
      atualizado_em=?, revisao=revisao+1 WHERE id=? AND revisao=?`)
      .run(assignee, now(), orderId, revision);
    if (updated.changes !== 1) { db.exec("ROLLBACK"); return { ok: false, error: "REVISION_CONFLICT", message: "Este pedido foi alterado por outra pessoa. Reabra a ficha." }; }
    db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,usuario_id,criado_em) VALUES (?,?,?,?,?,?)")
      .run(id(), orderId, "atribuicao_tratamento", "Atribuição automática do responsável pelo tratamento restaurada.", clean(input?.actorUserId) || null, now());
    db.exec("COMMIT");
    return getOrder(orderId);
  } catch (error) { db.exec("ROLLBACK"); throw error; }
}

function addAttachment(orderId, type, sourcePath) {
  const order = db.prepare("SELECT id FROM pedidos WHERE id=?").get(clean(orderId));
  if (!order) return { ok: false, message: "Pedido não encontrado." };
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile())
    return { ok: false, message: "Arquivo não encontrado." };
  const attachmentId = id();
  const originalName = path.basename(sourcePath);
  const extension = path.extname(originalName).toLowerCase();
  const storedName = `${order.id}-${Date.now()}-${attachmentId.slice(0, 8)}${extension}`;
  const target = path.join(dataDirectory, "comprovantes", storedName);
  fs.copyFileSync(sourcePath, target);
  db.prepare("INSERT INTO anexos VALUES (?,?,?,?,?,?)").run(
    attachmentId, order.id, clean(type) || "comprovante", originalName, target, now(),
  );
  db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,criado_em) VALUES (?,?,?,?,?)").run(
    id(), order.id, "anexo", `Arquivo anexado: ${originalName}.`, now(),
  );
  return { ok: true, attachment: { id: attachmentId, tipo: clean(type), nome_arquivo: originalName } };
}

function getAttachmentPath(attachmentId) {
  const attachment = db.prepare("SELECT caminho FROM anexos WHERE id=?").get(clean(attachmentId));
  return attachment?.caminho || null;
}

function getDashboard() {
  const rows = listOrders();
  const stages = {};
  for (const row of rows) stages[row.etapa] = (stages[row.etapa] || 0) + 1;
  const today = businessDate();
  return {
    total: rows.length,
    clientes: Number(db.prepare(`SELECT COUNT(*) total FROM clientes c
      WHERE c.siwin_estudio=1 OR EXISTS (SELECT 1 FROM pedidos p WHERE p.cliente_id=c.id)`).get().total),
    stages,
    tratamentoAtrasado: rows.filter(
      (row) => row.etapa === "em_tratamento" && row.prazo_tratamento_em < today,
    ).length,
    semCliente: rows.filter((row) => !row.cliente_id).length,
    queues: {
      needsMe: rows.filter((row) => row.operacional_bucket === "needs_me").length,
      waiting: rows.filter((row) => row.operacional_bucket === "waiting").length,
      alerts: rows.filter((row) => row.operacional_bucket === "alerts").length,
      work: rows.filter((row) => row.acompanhamento_status === "ativo" && row.etapa !== "entregue"
        && !(row.origem === "siwin" && row.etapa === "sessao_criada" && row.siwin_pedido_em
          && row.siwin_pedido_em < addCalendarDays(today, -180))).length,
      newSelections: rows.filter((row) => row.acompanhamento_status === "ativo" && row.selecoes_pendentes > 0).length,
      due3: rows.filter((row) => row.acompanhamento_status === "ativo" && row.etapa === "em_tratamento"
        && row.prazo_tratamento_em >= today && row.prazo_tratamento_em <= addCalendarDays(today, 3)).length,
      maxOverdue: rows.filter((row) => row.acompanhamento_status === "ativo" && !row.tratamento_concluido_em
        && row.prazo_maximo_em && row.prazo_maximo_em < today).length,
      treatedReady: rows.filter((row) => row.acompanhamento_status === "ativo" && row.etapa === "tratamento_concluido").length,
      readyLabel: rows.filter((row) => row.acompanhamento_status === "ativo" && row.impressao_recebida_em && !row.etiqueta_criada_em).length,
      shipment: rows.filter((row) => row.acompanhamento_status === "ativo" && row.remessa_id && !row.postado_em).length,
      archived: rows.filter((row) => row.acompanhamento_status !== "ativo").length,
      reviewHistory: rows.filter((row) => row.acompanhamento_status === "ativo" && row.origem === "siwin"
        && row.etapa === "sessao_criada" && row.siwin_pedido_em && row.siwin_pedido_em < addCalendarDays(today, -180)).length,
    },
  };
}

function nextFriday() {
  const date = new Date(`${businessDate()}T12:00:00Z`);
  const offset = (5 - date.getUTCDay() + 7) % 7;
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

function bulkUpdateOrders(input = {}) {
  const orderIds = [...new Set((Array.isArray(input.ids) ? input.ids : []).map(clean).filter(Boolean))];
  if (!orderIds.length) return { ok: false, message: "Selecione pelo menos um pedido." };
  const action = clean(input.action);
  const allowed = new Set(["archive", "activate", "conclude_previous", "printing_sent", "prints_received", "label_created", "add_shipment", "posted"]);
  if (!allowed.has(action)) return { ok: false, message: "Ação em massa inválida." };
  const placeholders = orderIds.map(() => "?").join(",");
  const existing = db.prepare(`SELECT * FROM pedidos WHERE id IN (${placeholders})`).all(...orderIds)
    .map((row) => ({ ...row, etapa: deriveStage(row) }));
  if (!existing.length) return { ok: false, message: "Nenhum pedido válido foi encontrado." };
  const requiredStage = {
    printing_sent: "tratamento_concluido",
    prints_received: "em_impressao",
    label_created: "impressoes_recebidas",
    add_shipment: "etiqueta_criada",
    posted: "em_remessa",
  };
  const skipped = [];
  const eligible = existing.filter((order) => {
    if (requiredStage[action] && order.etapa !== requiredStage[action]) {
      skipped.push(`${order.sessao}: está em ${deriveStage(order).replaceAll("_", " ")}`);
      return false;
    }
    if (action === "add_shipment" && !clean(order.codigo_rastreio)) {
      skipped.push(`${order.sessao}: sem código de rastreio`);
      return false;
    }
    if (action === "posted" && !clean(order.codigo_rastreio)) {
      skipped.push(`${order.sessao}: sem código de rastreio`);
      return false;
    }
    return true;
  });
  if (!eligible.length) return { ok: false, updated: 0, skipped: skipped.length,
    message: `Nenhum pedido foi alterado. ${skipped.slice(0, 3).join("; ")}.` };
  const existingIds = eligible.map((row) => row.id);
  const existingPlaceholders = existingIds.map(() => "?").join(",");
  const date = clean(input.date) || businessDate();
  if (!validIsoDate(date)) return { ok: false, message: "A data informada é inválida." };
  if (["add_shipment", "posted", "archive", "conclude_previous"].includes(action)) createSafetyBackup(`acao-em-massa-${action}`);
  db.exec("BEGIN IMMEDIATE");
  try {
    let description;
    if (action === "archive" || action === "activate" || action === "conclude_previous") {
      const status = action === "archive" ? "arquivado" : action === "activate" ? "ativo" : "concluido_anteriormente";
      db.prepare(`UPDATE pedidos SET acompanhamento_status=?,atualizado_em=?,revisao=revisao+1 WHERE id IN (${existingPlaceholders})`).run(status, now(), ...existingIds);
      description = `Acompanhamento alterado para ${status.replaceAll("_", " ")}.`;
    } else if (action === "add_shipment") {
      const friday = clean(input.date) || nextFriday();
      let shipment = db.prepare("SELECT id FROM remessas WHERE data_planejada=? AND postada_em IS NULL ORDER BY criado_em LIMIT 1").get(friday);
      if (!shipment) {
        shipment = { id: id() };
        db.prepare("INSERT INTO remessas VALUES (?,?,?,?,?,?)").run(shipment.id, friday, null, null, now(), now());
      }
      db.prepare(`UPDATE pedidos SET remessa_id=?,atualizado_em=?,revisao=revisao+1 WHERE id IN (${existingPlaceholders})`).run(shipment.id, now(), ...existingIds);
      description = `Incluído na remessa planejada para ${friday}.`;
    } else {
      const fields = { printing_sent: "impressao_enviada_em", prints_received: "impressao_recebida_em", label_created: "etiqueta_criada_em", posted: "postado_em" };
      const field = fields[action];
      db.prepare(`UPDATE pedidos SET ${field}=?,atualizado_em=?,revisao=revisao+1 WHERE id IN (${existingPlaceholders})`).run(date, now(), ...existingIds);
      if (action === "printing_sent") db.prepare(`UPDATE pedidos SET fornecedor_impressao=coalesce(nullif(fornecedor_impressao,''),'Digital Fotos') WHERE id IN (${existingPlaceholders})`).run(...existingIds);
      description = `Etapa ${field} registrada em ${date}.`;
    }
    const insertEvent = db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,criado_em) VALUES (?,?,?,?,?)");
    for (const order of eligible) insertEvent.run(id(), order.id, `massa_${action}`, description, now());
    db.exec("COMMIT");
    return { ok: true, updated: eligible.length, skipped: skipped.length, skippedDetails: skipped.slice(0, 20),
      message: `${eligible.length} pedido(s) atualizado(s)${skipped.length ? `; ${skipped.length} ignorado(s) por segurança` : ""}.` };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function markSelectionEmail(input = {}) {
  const emailId = clean(input.id);
  const field = clean(input.field);
  if (!["conferida_em", "fotos_separadas_em"].includes(field)) return { ok: false, message: "Marcação inválida." };
  const selection = db.prepare("SELECT id,pedido_id FROM selecoes_email WHERE id=?").get(emailId);
  if (!selection) return { ok: false, message: "Seleção não encontrada." };
  const value = clean(input.value) || now();
  db.prepare(`UPDATE selecoes_email SET ${field}=? WHERE id=?`).run(value, emailId);
  if (selection.pedido_id) db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,criado_em) VALUES (?,?,?,?,?)").run(
    id(), selection.pedido_id, field, field === "conferida_em" ? "Seleção conferida." : "Fotos marcadas como separadas.", now(),
  );
  return { ok: true };
}

function getConfiguration(key) {
  return db.prepare("SELECT valor FROM configuracoes WHERE chave=?").get(key)?.valor || null;
}

function getSiwinStatus() {
  return {
    ok: true,
    lastCad: Number(getConfiguration("siwin_ultimo_cad") || 0),
    lastSync: getConfiguration("siwin_ultima_sincronizacao"),
    lastImported: Number(getConfiguration("siwin_ultima_quantidade") || 0),
  };
}

function shouldRefreshSiwinScope() {
  return clean(getConfiguration("siwin_escopo_estudio_em")).slice(0, 10) !== now().slice(0, 10);
}

function getMaxSiwinCad() {
  return Number(db.prepare("SELECT COALESCE(MAX(siwin_cad), 0) valor FROM clientes").get().valor);
}

function getUnlinkedSessions() {
  return db.prepare("SELECT sessao FROM pedidos WHERE cliente_id IS NULL ORDER BY sessao").all().map((row) => row.sessao);
}

function linkSiwinSessions(rows) {
  if (!Array.isArray(rows) || !rows.length) return { linked: 0, unmatched: getUnlinkedSessions().length };
  const findClient = db.prepare("SELECT id FROM clientes WHERE siwin_cad=?");
  const findOrder = db.prepare("SELECT id FROM pedidos WHERE sessao=? AND cliente_id IS NULL");
  const link = db.prepare("UPDATE pedidos SET cliente_id=?, atualizado_em=?, revisao=revisao+1 WHERE id=? AND cliente_id IS NULL");
  const addEvent = db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,criado_em) VALUES (?,?,?,?,?)");
  let linked = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const sessionDigits = clean(row.SESSAO || row.SESSAO_PROFISSIONAL).replace(/\D/g, "");
      if (!sessionDigits) continue;
      const session = `M${sessionDigits}`;
      const order = findOrder.get(session);
      const client = findClient.get(Number(row.CAD));
      if (!order || !client) continue;
      const result = link.run(client.id, now(), order.id);
      if (Number(result.changes) > 0) {
        linked += 1;
        addEvent.run(id(), order.id, "siwin_cliente", `Cliente vinculado automaticamente pelo SIWIN (CAD ${row.CAD}).`, now());
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { linked, unmatched: getUnlinkedSessions().length };
}

function syncSiwinClients(rows) {
  if (!Array.isArray(rows)) throw new Error("Resposta inv\u00e1lida do SIWIN.");
  const timestamp = now();
  const upsert = db.prepare(`INSERT INTO clientes (
    id,siwin_cad,siwin_estudio,nome,documento,email,telefone,celular,logradouro,numero,complemento,bairro,cidade,uf,cep,
    siwin_cadastrado_em,siwin_sincronizado_em,criado_em,atualizado_em
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(siwin_cad) DO UPDATE SET
    siwin_estudio=MAX(clientes.siwin_estudio,excluded.siwin_estudio),
    nome=excluded.nome,documento=COALESCE(excluded.documento,clientes.documento),email=excluded.email,telefone=excluded.telefone,celular=excluded.celular,
    logradouro=excluded.logradouro,numero=excluded.numero,complemento=excluded.complemento,
    bairro=excluded.bairro,cidade=excluded.cidade,uf=excluded.uf,cep=excluded.cep,
    siwin_cadastrado_em=excluded.siwin_cadastrado_em,
    siwin_sincronizado_em=excluded.siwin_sincronizado_em,atualizado_em=excluded.atualizado_em`);
  const findExisting = db.prepare("SELECT 1 FROM clientes WHERE siwin_cad=?");
  let imported = 0;
  let updated = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const siwinCad = Number(row.CAD);
      if (!Number.isInteger(siwinCad) || siwinCad <= 0) continue;
      const existed = Boolean(findExisting.get(siwinCad));
      upsert.run(
        id(),
        siwinCad,
        Number(row.ESTUDIO) === 1 ? 1 : 0,
        clean(row.NOME) || null,
        normalizeSiwinDocument(row.DOCUMENTO),
        normalizedEmail(row.E_MAIL) || null,
        clean(row.FONE) || null,
        clean(row.CELULAR) || null,
        clean(row.LOGRADOURO) || null,
        clean(row.NUMERO) || null,
        clean(row.COMPLEMENTO) || null,
        clean(row.BAIRRO) || null,
        clean(row.CIDADE) || null,
        clean(row.UF) || null,
        clean(row.CEP) || null,
        row.CADASTRO ? new Date(row.CADASTRO).toISOString() : null,
        timestamp,
        timestamp,
        timestamp,
      );
      if (existed) updated += 1;
      else imported += 1;
    }
    setConfiguration("siwin_ultimo_cad", String(getMaxSiwinCad()));
    setConfiguration("siwin_ultima_sincronizacao", timestamp);
    setConfiguration("siwin_ultima_quantidade", String(imported));
    db.exec("COMMIT");
    return { ok: true, imported, updated, total: rows.length, lastSync: timestamp };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getSiwinClientCads() {
  return db.prepare("SELECT siwin_cad AS CAD FROM clientes WHERE siwin_cad IS NOT NULL ORDER BY siwin_cad").all().map((row) => Number(row.CAD));
}

function syncSiwinClientDocuments(rows) {
  if (!Array.isArray(rows)) throw new Error("Resposta inválida do SIWIN.");
  const update = db.prepare(`UPDATE clientes SET documento=?
    WHERE siwin_cad=? AND ? IS NOT NULL AND documento IS NOT ?`);
  let updated = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const siwinCad = Number(row.CAD);
      const documento = normalizeSiwinDocument(row.DOCUMENTO);
      if (!Number.isInteger(siwinCad) || siwinCad <= 0 || !documento) continue;
      updated += Number(update.run(documento, siwinCad, documento, documento).changes);
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return { updated };
}

function markSiwinStudioClients(codes) {
  if (!Array.isArray(codes)) throw new Error("Escopo de clientes do SIWIN inválido.");
  const mark = db.prepare("UPDATE clientes SET siwin_estudio=1,atualizado_em=? WHERE siwin_cad=?");
  let marked = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE clientes SET siwin_estudio=0 WHERE siwin_cad IS NOT NULL").run();
    const timestamp = now();
    for (const value of codes) marked += Number(mark.run(timestamp, Number(value.CAD)).changes);
    setConfiguration("siwin_escopo_estudio_em", timestamp);
    db.exec("COMMIT");
    return marked;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function syncSiwinOrders(rows) {
  if (!Array.isArray(rows)) throw new Error("Resposta de sessões do SIWIN inválida.");
  const findClient = db.prepare("SELECT id FROM clientes WHERE siwin_cad=?");
  const findOrder = db.prepare("SELECT id FROM pedidos WHERE sessao=?");
  const insertOrder = db.prepare(`INSERT INTO pedidos (
    id,sessao,cliente_id,fotos_quantidade,origem,siwin_ped,siwin_situacao,siwin_pedido_em,siwin_prev_entrega_em,siwin_sessao_em,criado_em,atualizado_em
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateOrder = db.prepare(`UPDATE pedidos SET
    cliente_id=COALESCE(cliente_id,?),siwin_ped=COALESCE(?,siwin_ped),siwin_situacao=?,
    siwin_pedido_em=?,siwin_prev_entrega_em=?,siwin_sessao_em=?,
    fotos_quantidade=CASE WHEN origem='siwin' OR fotos_quantidade IS NULL THEN ? ELSE fotos_quantidade END,
    atualizado_em=?,revisao=revisao+1 WHERE id=?`);
  let importedOrders = 0;
  let updatedOrders = 0;
  const timestamp = now();
  const assignmentConfig = treatmentAssignmentConfig();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of rows) {
      const sessionDigits = clean(row.SESSAO || row.SESSAO_PROFISSIONAL).replace(/\D/g, "");
      const client = findClient.get(Number(row.CAD));
      if (!sessionDigits || !client) continue;
      const session = `M${sessionDigits}`;
      const existing = findOrder.get(session);
      const orderDate = row.PEDIDO_DATA ? new Date(row.PEDIDO_DATA).toISOString().slice(0, 10) : null;
      const deliveryDate = row.PREV_ENTREGA ? new Date(row.PREV_ENTREGA).toISOString().slice(0, 10) : null;
      const sessionDate = row.DATA_SESSAO ? new Date(row.DATA_SESSAO).toISOString().slice(0, 10) : null;
      const chargedPhotos = row.FOTOS_COBRADAS == null ? null : Number(row.FOTOS_COBRADAS);
      if (existing) {
        updateOrder.run(client.id, row.PED || null, clean(row.SITUACAO) || null, orderDate, deliveryDate, sessionDate,
          Number.isFinite(chargedPhotos) ? chargedPhotos : null, timestamp, existing.id);
        updatedOrders += 1;
        setAutomaticTreatmentAssignment(existing.id, Number.isFinite(chargedPhotos) && chargedPhotos >= 0 ? Math.trunc(chargedPhotos) : null, assignmentConfig);
      } else {
        insertOrder.run(id(), session, client.id, Number.isFinite(chargedPhotos) ? chargedPhotos : null,
          "siwin", row.PED || null, clean(row.SITUACAO) || null,
          orderDate, deliveryDate, sessionDate, timestamp, timestamp);
        importedOrders += 1;
        const inserted = db.prepare("SELECT id FROM pedidos WHERE sessao=?").get(session);
        if (inserted) setAutomaticTreatmentAssignment(inserted.id, Number.isFinite(chargedPhotos) && chargedPhotos >= 0 ? Math.trunc(chargedPhotos) : null, assignmentConfig);
      }
    }
    db.exec("COMMIT");
    return { importedOrders, updatedOrders };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function replaceSiwinOrderItems(rows) {
  if (!Array.isArray(rows)) throw new Error("Resposta de produtos do SIWIN inválida.");
  const byOrder = new Map();
  for (const row of rows) {
    const ped = Number(row.PED);
    if (!Number.isInteger(ped)) continue;
    if (!byOrder.has(ped)) byOrder.set(ped, []);
    byOrder.get(ped).push(row);
  }
  const findOrder = db.prepare("SELECT id FROM pedidos WHERE siwin_ped=?");
  const clearItems = db.prepare("DELETE FROM pedido_itens WHERE pedido_id=?");
  const insertItem = db.prepare(`INSERT INTO pedido_itens (
    id,pedido_id,siwin_ped_ms,produto,quantidade,fotos,valor_unitario,desconto,valor_total,
    cobrado,situacao,tipo_foto,ampliacao,sincronizado_em
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const updateChargedPhotos = db.prepare("UPDATE pedidos SET fotos_quantidade=?,atualizado_em=?,revisao=revisao+1 WHERE id=?");
  let syncedItems = 0;
  let recalculatedOrders = 0;
  const timestamp = now();
  const assignmentConfig = treatmentAssignmentConfig();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [ped, items] of byOrder) {
      const order = findOrder.get(ped);
      if (!order) continue;
      clearItems.run(order.id);
      for (const row of items) {
        const total = Number(row.VL_TOTAL) || 0;
        insertItem.run(id(), order.id, Number(row.PED_MS), clean(row.PRODUTO) || "Produto sem descrição",
          Number(row.QTDE) || 0, Number(row.FOTOS) || 0, Number(row.PU) || 0, Number(row.VL_DESC) || 0,
          total, total > 0 ? 1 : 0, clean(row.SITUACAO) || null, clean(row.TIPO_FOTO_DESCR) || null,
          clean(row.AMPLIACAO) || null, timestamp);
        syncedItems += 1;
      }
      const chargedPhotos = items.reduce((total, row) => total + (Number(row.VL_TOTAL) > 0 ? Number(row.FOTOS) || 0 : 0), 0);
      updateChargedPhotos.run(chargedPhotos, timestamp, order.id);
      setAutomaticTreatmentAssignment(order.id, chargedPhotos, assignmentConfig);
      recalculatedOrders += 1;
    }
    db.exec("COMMIT");
    return { syncedItems, recalculatedOrders };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function replaceSiwinOrderObservations(rows, pedIds = []) {
  if (!Array.isArray(rows)) throw new Error("Resposta de observações do SIWIN inválida.");
  const byOrder = new Map();
  for (const row of rows) {
    const ped = Number(row.PED);
    if (!Number.isInteger(ped)) continue;
    if (!byOrder.has(ped)) byOrder.set(ped, []);
    byOrder.get(ped).push(row);
  }
  const findOrder = db.prepare("SELECT id FROM pedidos WHERE siwin_ped=?");
  const clearObservations = db.prepare("DELETE FROM pedido_observacoes_siwin WHERE pedido_id=?");
  const insertObservation = db.prepare(`INSERT INTO pedido_observacoes_siwin (
    id,pedido_id,siwin_ped_obs,usuario,cadastrado_em,observacao,sincronizado_em
  ) VALUES (?,?,?,?,?,?,?)`);
  let syncedObservations = 0;
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const ped of pedIds) {
      const order = findOrder.get(Number(ped));
      if (!order) continue;
      clearObservations.run(order.id);
      for (const row of byOrder.get(Number(ped)) || []) {
        const observation = clean(row.OBS);
        if (!observation) continue;
        insertObservation.run(id(), order.id, Number(row.PED_OBS), clean(row.USUARIO) || null,
          row.CADASTRO ? new Date(row.CADASTRO).toISOString() : null, observation, timestamp);
        syncedObservations += 1;
      }
    }
    db.exec("COMMIT");
    return { syncedObservations };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function importThunderbirdSelections(records) {
  if (!Array.isArray(records)) throw new Error("Mensagens do Thunderbird inválidas.");
  const insertEmail = db.prepare(`INSERT OR IGNORE INTO selecoes_email (
    id,message_id,pedido_id,sessao,recebido_em,data_finalizacao,quantidade_selecionada,
    quantidade_total,codigos_json,status,processado_em
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
  const findOrder = db.prepare("SELECT * FROM pedidos WHERE upper(sessao)=upper(?) LIMIT 1");
  const linkEmail = db.prepare("UPDATE selecoes_email SET pedido_id=?,status='vinculado' WHERE id=?");
  const insertEvent = db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,criado_em) VALUES (?,?,?,?,?)");
  let imported = 0;
  let linked = 0;
  let datesSet = 0;
  const timestamp = now();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const record of records) {
      const messageId = clean(record.messageId);
      const sessao = clean(record.sessao).toUpperCase();
      const finalDate = clean(record.dataFinalizacao);
      if (!messageId || !/^M\d+$/.test(sessao) || !/^\d{4}-\d{2}-\d{2}$/.test(finalDate)) continue;
      const emailId = id();
      const order = findOrder.get(sessao);
      const result = insertEmail.run(emailId, messageId, order?.id || null, sessao,
        clean(record.recebidoEm), finalDate, Number(record.quantidadeSelecionada) || null,
        Number(record.quantidadeTotal) || null, JSON.stringify(record.codigos || []),
        order ? "vinculado" : "sem_pedido", timestamp);
      if (!Number(result.changes)) continue;
      imported += 1;
      if (!order) continue;
      linked += 1;
      if (!order.selecao_finalizada_em) {
        db.prepare(`UPDATE pedidos SET selecao_finalizada_em=?,prazo_tratamento_em=?,
          prazo_maximo_em=?,atualizado_em=?,revisao=revisao+1 WHERE id=?`).run(finalDate,
          addCalendarDays(finalDate, 20), addCalendarDays(finalDate, 60), timestamp, order.id);
        setAutomaticTreatmentAssignment(order.id, order.fotos_quantidade, treatmentAssignmentConfig());
        datesSet += 1;
        insertEvent.run(id(), order.id, "selecao_email",
          `Seleção recebida pelo Thunderbird e registrada em ${finalDate.split("-").reverse().join("/")}.`, timestamp);
      } else {
        insertEvent.run(id(), order.id, "selecao_email_repetida",
          `Novo e-mail de finalização recebido em ${finalDate.split("-").reverse().join("/")}; a data original foi preservada.`, timestamp);
      }
    }

    const pending = db.prepare(`SELECT id,sessao,data_finalizacao FROM selecoes_email
      WHERE pedido_id IS NULL ORDER BY recebido_em`).all();
    for (const email of pending) {
      const order = findOrder.get(email.sessao);
      if (!order) continue;
      linkEmail.run(order.id, email.id);
      linked += 1;
      if (!order.selecao_finalizada_em) {
        db.prepare(`UPDATE pedidos SET selecao_finalizada_em=?,prazo_tratamento_em=?,
          prazo_maximo_em=?,atualizado_em=?,revisao=revisao+1 WHERE id=?`).run(email.data_finalizacao,
          addCalendarDays(email.data_finalizacao, 20), addCalendarDays(email.data_finalizacao, 60), timestamp, order.id);
        setAutomaticTreatmentAssignment(order.id, order.fotos_quantidade, treatmentAssignmentConfig());
        datesSet += 1;
        insertEvent.run(id(), order.id, "selecao_email",
          `Seleção vinculada pelo Thunderbird e registrada em ${email.data_finalizacao.split("-").reverse().join("/")}.`, timestamp);
      } else {
        insertEvent.run(id(), order.id, "selecao_email_repetida",
          `E-mail de finalização vinculado em ${email.data_finalizacao.split("-").reverse().join("/")}; a data original foi preservada.`, timestamp);
      }
    }
    db.exec("COMMIT");
    const unmatched = db.prepare("SELECT COUNT(*) total FROM selecoes_email WHERE pedido_id IS NULL").get().total;
    return { imported, linked, datesSet, unmatched, total: db.prepare("SELECT COUNT(*) total FROM selecoes_email").get().total };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function getSelectionEmail(emailId) {
  const row = db.prepare(`SELECT se.*,p.sessao pedido_sessao FROM selecoes_email se
    INNER JOIN pedidos p ON p.id=se.pedido_id WHERE se.id=?`).get(clean(emailId));
  if (!row) return null;
  return { ...row, codigos: JSON.parse(row.codigos_json || "[]") };
}

function findOrCreateClient(row, timestamp) {
  const email = normalizedEmail(row.clienteEmail);
  const phone = digits(row.clienteTelefone);
  const name = normalizedText(row.clienteNome);
  const city = normalizedText(row.clienteCidade);
  let existing = null;
  if (email) existing = db.prepare("SELECT id FROM clientes WHERE lower(trim(email))=? LIMIT 1").get(email);
  if (!existing && phone)
    existing = db
      .prepare("SELECT id FROM clientes WHERE replace(replace(replace(replace(telefone,' ',''),'-',''),'(',''),')','') LIKE ? LIMIT 1")
      .get(`%${phone}`);
  if (!existing && name && city) {
    const candidates = db.prepare("SELECT id,nome,cidade FROM clientes").all();
    existing = candidates.find(
      (item) => normalizedText(item.nome) === name && normalizedText(item.cidade) === city,
    );
  }
  if (existing) return existing.id;
  if (!clean(row.clienteNome) && !email && !phone) return null;
  const clientId = id();
  db.prepare(`INSERT INTO clientes (id,nome,email,telefone,cidade,criado_em,atualizado_em)
    VALUES (?,?,?,?,?,?,?)`).run(clientId, clean(row.clienteNome) || null, clean(row.clienteEmail) || null,
    clean(row.clienteTelefone) || null, clean(row.clienteCidade) || null, timestamp, timestamp);
  return clientId;
}

function importSafeRows(preview) {
  const eligible = Array.isArray(preview?.rows) ? preview.rows.filter((row) => row.eligible) : [];
  createSafetyBackup("importacao-planilha");
  const insertOrder = db.prepare(`INSERT OR IGNORE INTO pedidos (
    id,sessao,cliente_id,fotos_quantidade,observacoes,editor,selecao_finalizada_em,
    prazo_tratamento_em,prazo_maximo_em,tratamento_concluido_em,postado_em,
    codigo_rastreio,entregue_em,origem,linha_origem,criado_em,atualizado_em
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  let imported = 0;
  let skipped = 0;
  const assignmentConfig = treatmentAssignmentConfig();
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const row of eligible) {
      const timestamp = now();
      const clientId = findOrCreateClient(row, timestamp);
      const result = insertOrder.run(
        id(),
        row.sessao,
        clientId,
        row.fotosQuantidade,
        row.observacoes || null,
        row.editor || null,
        row.selecaoFinalizadaEm || null,
        addCalendarDays(row.selecaoFinalizadaEm, 20),
        addCalendarDays(row.selecaoFinalizadaEm, 60),
        row.tratamentoConcluido ? row.selecaoFinalizadaEm || timestamp.slice(0, 10) : null,
        row.postadoEm || null,
        row.codigoRastreio || null,
        row.entregue ? row.postadoEm || timestamp.slice(0, 10) : null,
        "planilha_original",
        row.linha,
        timestamp,
        timestamp,
      );
      if (Number(result.changes) > 0) imported += 1;
      else skipped += 1;
      if (Number(result.changes) > 0) {
        const order = db.prepare("SELECT id FROM pedidos WHERE sessao=?").get(row.sessao);
        if (order) setAutomaticTreatmentAssignment(order.id, row.fotosQuantidade, assignmentConfig, { allowHistorical: true });
      }
    }
    db.exec("COMMIT");
    return { ok: true, imported, skipped, dashboard: getDashboard() };
  } catch (error) {
    db.exec("ROLLBACK");
    return { ok: false, message: error.message, imported: 0, skipped: eligible.length };
  }
}

function updateMilestone(input) {
  const allowed = new Set([
    "galeria_publicada_em",
    "link_enviado_em",
    "selecao_finalizada_em",
    "tratamento_concluido_em",
    "impressao_enviada_em",
    "impressao_recebida_em",
    "etiqueta_criada_em",
    "postado_em",
    "entregue_em",
  ]);
  const field = clean(input.field);
  if (!allowed.has(field)) return { ok: false, message: "Etapa inválida." };
  const orderId = clean(input.id);
  const value = clean(input.value) || businessDate();
  if (!validIsoDate(value)) return { ok: false, message: "A data informada é inválida." };
  const expectedField = {
    sessao_criada: "galeria_publicada_em",
    galeria_publicada: "link_enviado_em",
    aguardando_selecao: "selecao_finalizada_em",
    em_tratamento: "tratamento_concluido_em",
    tratamento_concluido: "impressao_enviada_em",
    em_impressao: "impressao_recebida_em",
    impressoes_recebidas: "etiqueta_criada_em",
    postado: "entregue_em",
  };
  db.exec("BEGIN IMMEDIATE");
  try {
    const order = db.prepare("SELECT * FROM pedidos WHERE id=?").get(orderId);
    if (!order) { db.exec("ROLLBACK"); return { ok: false, message: "Pedido não encontrado." }; }
    if (expectedField[deriveStage(order)] !== field) {
      db.exec("ROLLBACK");
      return { ok: false, message: "Esta ação não corresponde à etapa atual do pedido. Abra a ficha para revisar." };
    }
    if (field === "selecao_finalizada_em") {
      db.prepare(`UPDATE pedidos SET ${field}=?,prazo_tratamento_em=?,prazo_maximo_em=?,
        atualizado_em=?,revisao=revisao+1 WHERE id=?`).run(value,
        addCalendarDays(value, 20), addCalendarDays(value, 60), now(), order.id);
      setAutomaticTreatmentAssignment(order.id, order.fotos_quantidade, treatmentAssignmentConfig());
    } else if (field === "impressao_enviada_em" && !clean(order.fornecedor_impressao)) {
      db.prepare(`UPDATE pedidos SET ${field}=?,fornecedor_impressao='Digital Fotos',
        atualizado_em=?,revisao=revisao+1 WHERE id=?`).run(value, now(), order.id);
    } else {
      db.prepare(`UPDATE pedidos SET ${field}=?,atualizado_em=?,revisao=revisao+1 WHERE id=?`).run(value, now(), order.id);
    }
    db.prepare("INSERT INTO eventos (id,pedido_id,tipo,descricao,criado_em) VALUES (?,?,?,?,?)").run(
      id(), order.id, field, `Etapa registrada em ${value}.`, now(),
    );
    db.exec("COMMIT");
    return { ok: true };
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}


function close() {
  if (!db) return;
  db.close();
  db = null;
  dataDirectory = null;
}

function createUser(input) {
  const nome = clean(input?.nome);
  const usuario = clean(input?.usuario).toLowerCase();
  const senhaHash = clean(input?.senhaHash);
  const role = clean(input?.role || "employee");
  if (!nome || !usuario || !senhaHash) return { ok: false, message: "Nome, usuário e senha são obrigatórios." };
  if (!/^[a-z0-9._-]{3,40}$/.test(usuario)) return { ok: false, message: "Usuário inválido." };
  if (!["coordinator", "employee"].includes(role)) return { ok: false, message: "Perfil inválido." };
  try {
    const userId = id();
    const timestamp = now();
    db.prepare("INSERT INTO usuarios (id,nome,usuario,senha_hash,ativo,role,criado_em,atualizado_em) VALUES (?,?,?,?,1,?,?,?)").run(userId, nome, usuario, senhaHash, role, timestamp, timestamp);
    return { ok: true, user: { id: userId, nome, usuario, ativo: true, role } };
  } catch (error) {
    if (String(error.message).includes("UNIQUE")) return { ok: false, message: "Usuário já existe." };
    throw error;
  }
}

function getUserForLogin(usuario) { return db.prepare("SELECT * FROM usuarios WHERE usuario=? COLLATE NOCASE").get(clean(usuario)); }
function listActiveUsers() { return db.prepare("SELECT id,nome,usuario,role FROM usuarios WHERE ativo=1 ORDER BY nome COLLATE NOCASE").all(); }
function setUserRole(usuario, role) {
  const normalizedRole = clean(role);
  if (!["coordinator", "employee"].includes(normalizedRole)) return { ok: false, message: "Perfil inválido." };
  const existing = db.prepare("SELECT id,role FROM usuarios WHERE usuario=? COLLATE NOCASE").get(clean(usuario));
  if (!existing) return { ok: false, message: "Usuário não encontrado." };
  if (existing.role === "coordinator" && normalizedRole === "employee"
    && db.prepare("SELECT COUNT(*) count FROM usuarios WHERE ativo=1 AND role='coordinator'").get().count <= 1) {
    return { ok: false, message: "Não é possível remover o último coordenador ativo." };
  }
  const result = db.prepare("UPDATE usuarios SET role=?,atualizado_em=? WHERE usuario=? COLLATE NOCASE").run(normalizedRole, now(), clean(usuario));
  return { ok: result.changes === 1 };
}
function createSession(input) {
  const sessionId = id();
  db.prepare("INSERT INTO sessoes (id,usuario_id,token_hash,criado_em,expira_em) VALUES (?,?,?,?,?)").run(sessionId, input.usuarioId, input.tokenHash, now(), input.expiraEm);
  return sessionId;
}
function getSessionUser(tokenHash) {
  return db.prepare(`SELECT u.id,u.nome,u.usuario,u.ativo,u.role,s.id sessao_id,s.expira_em
    FROM sessoes s JOIN usuarios u ON u.id=s.usuario_id
    WHERE s.token_hash=? AND s.revogado_em IS NULL AND s.expira_em>?`).get(clean(tokenHash), now()) || null;
}
function revokeSession(tokenHash) { return db.prepare("UPDATE sessoes SET revogado_em=? WHERE token_hash=? AND revogado_em IS NULL").run(now(), clean(tokenHash)).changes > 0; }
function setUserActive(userId, active) {
  const result = db.prepare("UPDATE usuarios SET ativo=?,atualizado_em=? WHERE id=?").run(active ? 1 : 0, now(), clean(userId));
  if (!active) db.prepare("UPDATE sessoes SET revogado_em=? WHERE usuario_id=? AND revogado_em IS NULL").run(now(), clean(userId));
  return { ok: result.changes === 1 };
}

const solicitationSelect = `SELECT s.*,assignee.nome responsavel_nome,assignee.usuario responsavel_usuario,
  creator.nome criado_por_nome_join FROM solicitacoes s
  JOIN usuarios assignee ON assignee.id=s.responsavel_usuario_id
  LEFT JOIN usuarios creator ON creator.id=s.criado_por_usuario_id`;

function formatSolicitation(row) {
  if (!row) return null;
  const { criado_por_nome_join, ...item } = row;
  const prazo = item.prazo_em ? Date.parse(item.prazo_em) : NaN;
  return {
    ...item,
    criado_por_nome: criado_por_nome_join || item.criado_por_nome,
    atrasada: Number.isFinite(prazo) && prazo < Date.now() && !["completed", "cancelled"].includes(item.status),
  };
}

function listSolicitations({ userId, role } = {}) {
  if (role !== "coordinator" && role !== "employee") return [];
  if (role === "employee" && !userId) return [];
  const where = role === "employee" ? "WHERE s.responsavel_usuario_id=?" : "";
  const rows = db.prepare(`${solicitationSelect} ${where}
    ORDER BY CASE s.status WHEN 'pending' THEN 0 WHEN 'in_progress' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
    CASE WHEN s.prazo_em IS NULL THEN 1 ELSE 0 END,s.prazo_em,s.created_at DESC`)
    .all(...(role === "employee" ? [userId] : []));
  return rows.map(formatSolicitation);
}

function getSolicitation(solicitationId, { userId, role = "coordinator" } = {}) {
  if (role !== "coordinator" && role !== "employee") return null;
  if (role === "employee" && !userId) return null;
  const where = role === "employee" ? " AND s.responsavel_usuario_id=?" : "";
  const row = db.prepare(`${solicitationSelect} WHERE s.id=?${where}`)
    .get(...(role === "employee" ? [clean(solicitationId), userId] : [clean(solicitationId)]));
  return formatSolicitation(row);
}

function validateSolicitationInput(input, { partial = false } = {}) {
  const values = {};
  if (!partial || Object.hasOwn(input || {}, "descricao")) {
    values.descricao = clean(input?.descricao);
    if (!values.descricao || values.descricao.length > 2000) return { error: "A solicitação é obrigatória e deve ter até 2.000 caracteres." };
  }
  if (!partial || Object.hasOwn(input || {}, "observacao")) {
    values.observacao = clean(input?.observacao) || null;
    if ((values.observacao || "").length > 4000) return { error: "A observação deve ter até 4.000 caracteres." };
  }
  if (!partial || Object.hasOwn(input || {}, "sessao_codigo")) {
    values.sessao_codigo = clean(input?.sessao_codigo).toUpperCase() || null;
    if (values.sessao_codigo && !/^M\d{1,12}$/.test(values.sessao_codigo)) return { error: "Informe uma sessão válida, como M49999." };
    if (values.sessao_codigo && !db.prepare("SELECT 1 FROM pedidos WHERE upper(sessao)=?").get(values.sessao_codigo)) return { error: "Sessão não encontrada." };
  }
  if (!partial || Object.hasOwn(input || {}, "responsavel_usuario_id")) {
    values.responsavel_usuario_id = clean(input?.responsavel_usuario_id);
    if (!values.responsavel_usuario_id) return { error: "Selecione um responsável." };
    if (!db.prepare("SELECT 1 FROM usuarios WHERE id=? AND ativo=1").get(values.responsavel_usuario_id)) return { error: "O responsável precisa ser um usuário ativo." };
  }
  if (!partial || Object.hasOwn(input || {}, "prazo_em")) {
    const raw = clean(input?.prazo_em);
    if (raw && !Number.isFinite(Date.parse(raw))) return { error: "O prazo informado é inválido." };
    values.prazo_em = raw ? new Date(raw).toISOString() : null;
  }
  return { values };
}

function createSolicitation(input) {
  const validated = validateSolicitationInput(input);
  if (validated.error) return { ok: false, message: validated.error };
  const timestamp = now();
  const solicitationId = id();
  db.prepare(`INSERT INTO solicitacoes (id,descricao,observacao,sessao_codigo,responsavel_usuario_id,
    criado_por_usuario_id,criado_por_nome,status,prazo_em,solicitada_em,created_at,updated_at,revision)
    VALUES (?,?,?,?,?,?,?,'pending',?,?,?, ?,1)`)
    .run(solicitationId, validated.values.descricao, validated.values.observacao, validated.values.sessao_codigo,
      validated.values.responsavel_usuario_id, clean(input?.criado_por_usuario_id) || null,
      clean(input?.criado_por_nome) || "Usuário local", validated.values.prazo_em, timestamp, timestamp, timestamp);
  solicitationNotifications.assigned(db, solicitationId, validated.values.responsavel_usuario_id, timestamp);
  return { ok: true, solicitation: getSolicitation(solicitationId) };
}

function updateSolicitation({ id: solicitationId, revision, values = {} }) {
  const expectedRevision = Number(revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return { ok: false, error: "REVISION_REQUIRED", message: "Reabra a solicitação para obter sua revisão atual." };
  const current = db.prepare("SELECT * FROM solicitacoes WHERE id=?").get(clean(solicitationId));
  if (!current) return { ok: false, error: "NOT_FOUND", message: "Solicitação não encontrada." };
  if (current.revision !== expectedRevision) return { ok: false, error: "REVISION_CONFLICT", revisionAtual: current.revision, message: "A solicitação foi alterada por outra pessoa. Atualize os dados antes de salvar." };
  const validated = validateSolicitationInput(values, { partial: true });
  if (validated.error) return { ok: false, message: validated.error };
  const changed = Object.entries(validated.values).filter(([field, value]) => String(current[field] ?? "") !== String(value ?? ""));
  if (!changed.length) return { ok: true, solicitation: getSolicitation(solicitationId), unchanged: true };
  const assignments = changed.map(([field]) => `${field}=?`).join(",");
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`UPDATE solicitacoes SET ${assignments},updated_at=?,revision=revision+1 WHERE id=? AND revision=?`)
      .run(...changed.map(([, value]) => value), now(), clean(solicitationId), expectedRevision);
    if (result.changes !== 1) {
      db.exec("ROLLBACK");
      return { ok: false, error: "REVISION_CONFLICT", message: "A solicitação foi alterada por outra pessoa. Atualize os dados antes de salvar." };
    }
    solicitationNotifications.reconcile(db, clean(solicitationId), now());
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { ok: true, solicitation: getSolicitation(solicitationId) };
}

function transitionSolicitation({ id: solicitationId, revision, action, actorUserId, actorRole }) {
  if (!(["coordinator", "employee"].includes(actorRole))) return { ok: false, error: "FORBIDDEN", message: "Perfil sem permissão para alterar solicitações." };
  const expectedRevision = Number(revision);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return { ok: false, error: "REVISION_REQUIRED", message: "Reabra a solicitação para obter sua revisão atual." };
  const current = db.prepare("SELECT * FROM solicitacoes WHERE id=?").get(clean(solicitationId));
  if (!current || (actorRole !== "coordinator" && current.responsavel_usuario_id !== actorUserId)) return { ok: false, error: "NOT_FOUND", message: "Solicitação não encontrada." };
  if (current.revision !== expectedRevision) return { ok: false, error: "REVISION_CONFLICT", revisionAtual: current.revision, message: "A solicitação foi alterada por outra pessoa. Atualize os dados antes de continuar." };

  let status;
  const timestamp = now();
  let startedAt = current.iniciado_em;
  let completedAt = current.concluido_em;
  let cancelledAt = current.cancelado_em;
  if (action === "start" && current.status === "pending") { status = "in_progress"; startedAt = timestamp; }
  else if (action === "complete" && ["pending", "in_progress"].includes(current.status)) { status = "completed"; completedAt = timestamp; }
  else if (action === "cancel" && actorRole === "coordinator" && ["pending", "in_progress"].includes(current.status)) { status = "cancelled"; cancelledAt = timestamp; }
  else if (action === "reopen" && actorRole === "coordinator" && ["completed", "cancelled"].includes(current.status)) {
    status = "pending"; startedAt = null; completedAt = null; cancelledAt = null;
  } else return { ok: false, error: "INVALID_TRANSITION", message: "Essa mudança de status não está disponível para esta solicitação." };

  db.exec("BEGIN IMMEDIATE");
  try {
    const result = db.prepare(`UPDATE solicitacoes SET status=?,iniciado_em=?,concluido_em=?,cancelado_em=?,updated_at=?,revision=revision+1
      WHERE id=? AND revision=?`)
      .run(status, startedAt, completedAt, cancelledAt, timestamp, clean(solicitationId), expectedRevision);
    if (result.changes !== 1) {
      db.exec("ROLLBACK");
      return { ok: false, error: "REVISION_CONFLICT", message: "A solicitação foi alterada por outra pessoa. Atualize os dados antes de continuar." };
    }
    solicitationNotifications.reconcile(db, clean(solicitationId), timestamp);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  return { ok: true, solicitation: getSolicitation(solicitationId) };
}

function pollSolicitationNotifications(userId, at = new Date()) {
  const delivered = solicitationNotifications.poll(db, clean(userId), at);
  const rows = solicitationNotifications.list(db, clean(userId));
  return { ok: true, delivered, rows };
}
function listSolicitationNotifications(userId) {
  return { ok: true, rows: solicitationNotifications.list(db, clean(userId)) };
}
function updateSolicitationNotification(userId, input, at = new Date()) {
  return solicitationNotifications.update(db, clean(userId), clean(input?.id), input?.action, Number(input?.minutes), at);
}

module.exports = {
  initialize,
  initializeDataDirectory,
  close,
  getStatus,
  listOrders,
  listDigitalShipments,
  getDigitalShipment,
  getDigitalShipmentsForOrder,
  resolveDigitalShipmentSessions,
  createDigitalShipment,
  updateDigitalShipment,
  getDashboard,
  importSafeRows,
  updateMilestone,
  listClients,
  getOrder,
  getOrderClientProfile,
  updateOrder,
  updateTreatmentAssignee,
  restoreAutomaticTreatmentAssignee,
  getLocalOperatorId,
  getLocalOperator,
  assignmentBackfillCounts,
  resolveTreatmentAssignee,
  treatmentEligibilityAudit,
  reconcileTreatmentAssignmentEligibility,
  createUser,
  listActiveUsers,
  setUserRole,
  getUserForLogin,
  createSession,
  getSessionUser,
  revokeSession,
  setUserActive,
  listSolicitations,
  getSolicitation,
  createSolicitation,
  updateSolicitation,
  transitionSolicitation,
  pollSolicitationNotifications,
  listSolicitationNotifications,
  updateSolicitationNotification,
  addAttachment,
  getAttachmentPath,
  getSiwinStatus,
  shouldRefreshSiwinScope,
  getMaxSiwinCad,
  getUnlinkedSessions,
  linkSiwinSessions,
  syncSiwinClients,
  getSiwinClientCads,
  syncSiwinClientDocuments,
  markSiwinStudioClients,
  syncSiwinOrders,
  replaceSiwinOrderItems,
  replaceSiwinOrderObservations,
  importThunderbirdSelections,
  getSelectionEmail,
  bulkUpdateOrders,
  markSelectionEmail,
};
