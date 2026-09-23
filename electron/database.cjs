const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { DatabaseSync } = require("node:sqlite");

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
  dataDirectory = path.join(app.getPath("userData"), "GestaoLogistica");
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
    CREATE TABLE IF NOT EXISTS eventos (
      id TEXT PRIMARY KEY,
      pedido_id TEXT NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
      tipo TEXT NOT NULL,
      descricao TEXT NOT NULL,
      criado_em TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_pedidos_cliente ON pedidos(cliente_id);
    CREATE INDEX IF NOT EXISTS idx_pedidos_prazo ON pedidos(prazo_tratamento_em);
    CREATE INDEX IF NOT EXISTS idx_pedidos_rastreio ON pedidos(codigo_rastreio);
    CREATE INDEX IF NOT EXISTS idx_pedido_itens_pedido ON pedido_itens(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_pedido_observacoes_siwin_pedido ON pedido_observacoes_siwin(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_selecoes_email_pedido ON selecoes_email(pedido_id);
    CREATE INDEX IF NOT EXISTS idx_selecoes_email_sessao ON selecoes_email(sessao);
  `);
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
  ensureOrderRevision();
  ensureSelectionEmailColumns();
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

function ensureClientColumns() {
  const existing = new Set(db.prepare("PRAGMA table_info(clientes)").all().map((column) => column.name));
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
  db.exec("PRAGMA wal_checkpoint(FULL)");
  fs.copyFileSync(source, target);
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
      r.data_planejada remessa_data_planejada
      FROM pedidos p LEFT JOIN clientes c ON c.id=p.cliente_id
      LEFT JOIN remessas r ON r.id=p.remessa_id
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
      r.data_planejada remessa_data_planejada
    FROM pedidos p LEFT JOIN clientes c ON c.id=p.cliente_id
    LEFT JOIN remessas r ON r.id=p.remessa_id WHERE p.id=?`).get(clean(orderId));
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
    events: db.prepare("SELECT id,tipo,descricao,criado_em FROM eventos WHERE pedido_id=? ORDER BY criado_em DESC LIMIT 100").all(order.id),
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
    db.prepare("INSERT INTO eventos VALUES (?,?,?,?,?)").run(
      id(), orderId, "edicao", `Informações atualizadas: ${normalized.filter(([field]) => field !== "prazo_tratamento_em" && field !== "prazo_maximo_em" && field !== "atualizado_em").map(([field]) => field).join(", ")}.`, now(),
    );
    db.exec("COMMIT");
    return getOrder(orderId);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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
  db.prepare("INSERT INTO eventos VALUES (?,?,?,?,?)").run(
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
    const insertEvent = db.prepare("INSERT INTO eventos VALUES (?,?,?,?,?)");
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
  if (selection.pedido_id) db.prepare("INSERT INTO eventos VALUES (?,?,?,?,?)").run(
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
  const addEvent = db.prepare("INSERT INTO eventos VALUES (?,?,?,?,?)");
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
    id,siwin_cad,siwin_estudio,nome,email,telefone,celular,logradouro,numero,complemento,bairro,cidade,uf,cep,
    siwin_cadastrado_em,siwin_sincronizado_em,criado_em,atualizado_em
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  ON CONFLICT(siwin_cad) DO UPDATE SET
    siwin_estudio=MAX(clientes.siwin_estudio,excluded.siwin_estudio),
    nome=excluded.nome,email=excluded.email,telefone=excluded.telefone,celular=excluded.celular,
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
      } else {
        insertOrder.run(id(), session, client.id, Number.isFinite(chargedPhotos) ? chargedPhotos : null,
          "siwin", row.PED || null, clean(row.SITUACAO) || null,
          orderDate, deliveryDate, sessionDate, timestamp, timestamp);
        importedOrders += 1;
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
  const insertEvent = db.prepare("INSERT INTO eventos VALUES (?,?,?,?,?)");
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
  const order = db.prepare("SELECT * FROM pedidos WHERE id=?").get(clean(input.id));
  if (!order) return { ok: false, message: "Pedido não encontrado." };
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
  }[deriveStage(order)];
  if (expectedField !== field)
    return { ok: false, message: "Esta ação não corresponde à etapa atual do pedido. Abra a ficha para revisar." };
  db.prepare(`UPDATE pedidos SET ${field}=?, atualizado_em=?, revisao=revisao+1 WHERE id=?`).run(value, now(), order.id);
  if (field === "impressao_enviada_em" && !clean(order.fornecedor_impressao))
    db.prepare("UPDATE pedidos SET fornecedor_impressao='Digital Fotos' WHERE id=?").run(order.id);
  if (field === "selecao_finalizada_em") {
    db.prepare("UPDATE pedidos SET prazo_tratamento_em=?, prazo_maximo_em=? WHERE id=?").run(
      addCalendarDays(value, 20),
      addCalendarDays(value, 60),
      order.id,
    );
  }
  db.prepare("INSERT INTO eventos VALUES (?,?,?,?,?)").run(
    id(),
    order.id,
    field,
    `Etapa registrada em ${value}.`,
    now(),
  );
  return { ok: true };
}


function close() {
  if (!db) return;
  db.close();
  db = null;
  dataDirectory = null;
}

module.exports = {
  initialize,
  close,
  getStatus,
  listOrders,
  getDashboard,
  importSafeRows,
  updateMilestone,
  listClients,
  getOrder,
  updateOrder,
  addAttachment,
  getAttachmentPath,
  getSiwinStatus,
  shouldRefreshSiwinScope,
  getMaxSiwinCad,
  getUnlinkedSessions,
  linkSiwinSessions,
  syncSiwinClients,
  markSiwinStudioClients,
  syncSiwinOrders,
  replaceSiwinOrderItems,
  replaceSiwinOrderObservations,
  importThunderbirdSelections,
  getSelectionEmail,
  bulkUpdateOrders,
  markSelectionEmail,
};
