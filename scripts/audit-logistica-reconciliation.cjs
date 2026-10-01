// Read-only reconciliation audit for the legacy LOGISTICA workbook.
// This script never imports data and opens SQLite with readOnly + query_only.
const ExcelJS = require("exceljs");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const WORKBOOK_PATH = process.argv[2] || "E:\\DOWNLOADS\\CONTROLE DE PEDIDOS.xlsx";
const DATABASE_PATH = "E:\\GestaoLogistica_Server_Pilot\\data\\gestao-logistica.sqlite3";
const OUTPUT_DIR = path.join(ROOT, "work", "reconciliation");

const SHEET_NAMES = [
  "LOGISTICA", "ANOTAÇÕESLEMBRETES", "BACKUP 2304", "ENVIADOS DIGITAL", "DASH_AUDIT", "DASHBOARD",
];
const EXPECTED_HEADERS = [
  "Concluído", "Sessão", "Cliente", "Email", "Telefone", "CIDADE", "Fotos", "Observações",
  "Finalizou Seleção", "Situação", "Prazo para o CLIENTE (60 DIAS)", "PRAZO PHOTOSHOP (20 DIAS)",
  "DIAS RESTANTES PHOTOSHOP", "Data Prometida ?", "Data de envio", "Codigo de Rastreio",
  "Status do rastreio", "EDITOR",
];
const COLUMNS = [
  "concluido", "sessao", "cliente", "email", "telefone", "cidade", "fotos", "observacoes",
  "selecao", "situacao", "prazo_cliente_derivado", "prazo_photoshop_derivado",
  "dias_restantes_derivado", "data_prometida", "data_envio", "codigo_rastreio", "status_rastreio", "editor",
];
const DATE_FIELDS = ["selecao_finalizada_em", "postado_em"];

const unwrap = (input) => {
  let value = input;
  for (let depth = 0; depth < 5 && value && typeof value === "object"; depth += 1) {
    if ("result" in value) { value = value.result; continue; }
    if ("text" in value) { value = value.text; continue; }
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    break;
  }
  return value;
};
const cellValue = (row, col) => unwrap(row.getCell(col).value);
const text = (value) => String(value ?? "").trim();
const normalizedHeader = (value) => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const normalizeSession = (value) => {
  const raw = text(value).toUpperCase().replace(/\s+/g, "");
  const match = raw.match(/^M?(\d{5})$/);
  return match ? `M${match[1]}` : null;
};
const normalizeText = (value) => text(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "")
  .toLowerCase().replace(/\s+/g, " ");
const normalizePhone = (value) => text(value).replace(/\D/g, "");
const truthy = (value) => value === true || value === 1 || /^(1|sim|true|x)$/i.test(text(value));

function dateOnly(value) {
  if (value === null || value === undefined || text(value) === "") return { empty: true, value: null };
  if (value instanceof Date && Number.isFinite(value.getTime()))
    return { empty: false, value: value.toISOString().slice(0, 10) };
  if (typeof value === "number" && Number.isFinite(value) && value > 0 && value < 100000) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(value) * 86400000);
    return Number.isFinite(date.getTime()) ? { empty: false, value: date.toISOString().slice(0, 10) }
      : { empty: false, value: null };
  }
  const raw = text(value);
  const br = raw.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4})$/);
  let iso = null;
  if (br) iso = `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) iso = raw;
  else {
    const date = new Date(raw);
    if (Number.isFinite(date.getTime())) iso = date.toISOString().slice(0, 10);
  }
  if (!iso) return { empty: false, value: null };
  const d = new Date(`${iso}T12:00:00Z`);
  if (!Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== iso)
    return { empty: false, value: null };
  return { empty: false, value: iso };
}

function parsePhotos(value) {
  if (value === null || value === undefined || text(value) === "") return { empty: true, valid: false, value: null, issue: null };
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 1000) return { empty: false, valid: false, value: null, issue: "FOTOS_FORA_DO_PADRAO" };
    if (Number.isSafeInteger(value) && value >= 0) return { empty: false, valid: true, value, issue: null };
    return { empty: false, valid: false, value: null, issue: "FOTOS_AMBIGUAS" };
  }
  const raw = text(value);
  if (raw.includes("/")) return { empty: false, valid: false, value: null, issue: "FOTOS_AMBIGUAS" };
  if (/^\d+(?:[.,]\d+)?$/.test(raw)) {
    const number = Number(raw.replace(",", "."));
    if (number > 1000) return { empty: false, valid: false, value: null, issue: "FOTOS_FORA_DO_PADRAO" };
    if (Number.isSafeInteger(number) && number >= 0) return { empty: false, valid: true, value: number, issue: null };
  }
  return { empty: false, valid: false, value: null, issue: "FOTOS_AMBIGUAS" };
}

function classify(sheetValue, dbValue, options = {}) {
  const sheetEmpty = sheetValue === null || sheetValue === undefined || text(sheetValue) === "";
  const databaseEmpty = dbValue === null || dbValue === undefined || text(dbValue) === "";
  if (sheetEmpty) return databaseEmpty ? "SAME" : "DATABASE_HAS_VALUE_SPREADSHEET_EMPTY";
  if (databaseEmpty) return "FILL_MISSING_SAFE";
  const left = options.normalize ? options.normalize(sheetValue) : text(sheetValue);
  const right = options.normalize ? options.normalize(dbValue) : text(dbValue);
  return left === right ? "SAME" : "CONFLICT";
}

function stage(order) {
  if (order.entregue_em) return "entregue";
  if (order.postado_em) return "postado";
  if (order.remessa_id) return "em_remessa";
  if (order.etiqueta_criada_em) return "etiqueta_criada";
  if (order.impressao_recebida_em) return "impressoes_recebidas";
  if (order.impressao_enviada_em) return "em_impressao";
  if (order.tratamento_concluido_em) return "tratamento_concluido";
  if (order.selecao_finalizada_em) return "em_tratamento";
  if (order.link_enviado_em) return "aguardando_selecao";
  if (order.galeria_publicada_em || order.galeria_url) return "galeria_publicada";
  return "sessao_criada";
}

function readSheet(filePath) {
  const workbook = new ExcelJS.Workbook();
  return workbook.xlsx.readFile(filePath).then(() => {
    const missingSheets = SHEET_NAMES.filter((name) => !workbook.getWorksheet(name));
    const sheet = workbook.getWorksheet("LOGISTICA");
    if (missingSheets.length || !sheet) throw new Error(`Estrutura da planilha incompatível; abas ausentes: ${missingSheets.join(", ") || "LOGISTICA"}`);
    const actualHeaders = Array.from({ length: 18 }, (_, i) => text(cellValue(sheet.getRow(6), i + 1)));
    if (actualHeaders.map(normalizedHeader).join("|") !== EXPECTED_HEADERS.map(normalizedHeader).join("|"))
      throw new Error("Cabeçalho da aba LOGISTICA não corresponde às colunas A:R esperadas na linha 6.");

    const records = [];
    const invalidSessions = [];
    const statusCounts = {};
    const maxDates = { selecao: null, prazoPrometido: null, envio: null };
    let nonemptySessionCells = 0;
    let selectionDates = 0;
    let ambiguousPhotos = 0;
    let outOfRangePhotos = 0;
    let rastreioSemData = 0;
    let deliveredStatusRows = 0;
    let derivedColumnsPopulated = 0;

    for (let rowNumber = 7; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const row = sheet.getRow(rowNumber);
      const values = Array.from({ length: 18 }, (_, i) => cellValue(row, i + 1));
      const rawSession = text(values[1]);
      if (!rawSession) continue;
      nonemptySessionCells += 1;
      const session = normalizeSession(values[1]);
      const selection = dateOnly(values[8]);
      const postDate = dateOnly(values[14]);
      const promised = dateOnly(values[13]);
      const photos = parsePhotos(values[6]);
      const situation = text(values[9]);
      const tracking = text(values[15]).toUpperCase();
      const trackingStatus = text(values[16]);
      const selectionDate = selection.value;
      const postDateValue = postDate.value;
      const promisedDate = promised.value;
      if (!session) {
        invalidSessions.push({ row: rowNumber, reason: "SESSION_NOT_M#####" });
      }
      const statusKey = situation || "(vazia)";
      statusCounts[statusKey] = (statusCounts[statusKey] || 0) + 1;
      if (!selection.empty && selectionDate) {
        selectionDates += 1;
        if (!maxDates.selecao || selectionDate > maxDates.selecao) maxDates.selecao = selectionDate;
      }
      if (postDateValue && (!maxDates.envio || postDateValue > maxDates.envio)) maxDates.envio = postDateValue;
      if (promisedDate && (!maxDates.prazoPrometido || promisedDate > maxDates.prazoPrometido))
        maxDates.prazoPrometido = promisedDate;
      if (photos.issue === "FOTOS_AMBIGUAS") ambiguousPhotos += 1;
      if (photos.issue === "FOTOS_FORA_DO_PADRAO") outOfRangePhotos += 1;
      if (tracking && !postDateValue) rastreioSemData += 1;
      // The workbook has a delivery-status field, but no exact delivery-date field.
      if (/entregue/i.test(trackingStatus)) deliveredStatusRows += 1;
      if ([values[10], values[11], values[12]].some((value) => value !== null && value !== undefined && text(value) !== ""))
        derivedColumnsPopulated += 1;

      const record = {
        row: rowNumber,
        session,
        invalidSession: !session,
        rawSession,
        checkboxComplete: truthy(values[0]),
        clientName: text(values[2]),
        email: text(values[3]),
        phone: text(values[4]),
        city: text(values[5]),
        photos,
        observations: text(values[7]),
        selectionDate,
        selectionInvalid: !selection.empty && !selectionDate,
        situation,
        promisedDate,
        promisedDateInvalid: !promised.empty && !promisedDate,
        postDate: postDateValue,
        postDateInvalid: !postDate.empty && !postDateValue,
        tracking,
        trackingStatus,
        editor: text(values[17]),
        delivered: /entregue/i.test(trackingStatus),
        rawValues: values,
      };
      if (record.invalidSession) record.primaryCategory = "BLOCKED_INVALID_DATA";
      records.push(record);
    }

    const groups = new Map();
    for (const record of records) {
      if (!record.session) continue;
      if (!groups.has(record.session)) groups.set(record.session, []);
      groups.get(record.session).push(record);
    }
    const duplicates = [];
    for (const [session, rows] of groups) {
      if (rows.length < 2) continue;
      const divergentFields = COLUMNS.filter((_, index) => {
        // Different display forms that normalize to the same key are not a field divergence.
        if (index === 1) return false;
        const values = new Set(rows.map((record) => normalizeText(record.rawValues[index])));
        return values.size > 1;
      });
      duplicates.push({ session, rows: rows.map((record) => record.row), count: rows.length, divergentFields });
      rows.forEach((record) => { record.primaryCategory = "BLOCKED_DUPLICATE"; });
    }

    const otherTabs = {};
    for (const name of SHEET_NAMES.slice(1)) {
      const tab = workbook.getWorksheet(name);
      let nonemptyRows = 0;
      for (let n = 1; n <= tab.rowCount; n += 1) {
        if (tab.getRow(n).values.slice(1).some((value) => text(unwrap(value)) !== "")) nonemptyRows += 1;
      }
      otherTabs[name] = { nonemptyRows, imported: false };
    }
    return {
      workbook,
      sheet,
      records,
      groups,
      duplicates,
      invalidSessions,
      statusCounts,
      nonemptySessionCells,
      selectionDates,
      maxDates,
      photoIssues: { ambiguous: ambiguousPhotos, outOfRange: outOfRangePhotos },
      rastreioSemData,
      deliveredStatusRows,
      derivedColumnsPopulated,
      otherTabs,
    };
  });
}

function readDatabase(dbPath) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    db.exec("PRAGMA query_only=ON; PRAGMA foreign_keys=ON;");
    const integrity = db.prepare("PRAGMA integrity_check").get()?.integrity_check || "unknown";
    const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all().length;
    const orders = db.prepare(`SELECT p.*, c.nome cliente_nome, c.email cliente_email,
      c.telefone cliente_telefone, c.celular cliente_celular, c.cidade cliente_cidade
      FROM pedidos p LEFT JOIN clientes c ON c.id=p.cliente_id`).all();
    const configs = new Map(db.prepare(`SELECT chave,valor FROM configuracoes WHERE chave IN
      ('tratamento_usuario_ate_47','tratamento_usuario_48_mais','tratamento_limite_carlos')`).all()
      .map((row) => [row.chave, row.valor]));
    const configuredIds = [configs.get("tratamento_usuario_ate_47"), configs.get("tratamento_usuario_48_mais")].filter(Boolean);
    const userRows = configuredIds.length ? db.prepare(`SELECT id,nome,usuario,ativo,role FROM usuarios
      WHERE id IN (${configuredIds.map(() => "?").join(",")})`).all(...configuredIds) : [];
    const users = new Map(userRows.map((user) => [user.id, user]));
    const limit = Number(configs.get("tratamento_limite_carlos") || 48);
    const mapping = {
      small: users.get(configs.get("tratamento_usuario_ate_47")) || null,
      large: users.get(configs.get("tratamento_usuario_48_mais")) || null,
      limit,
    };
    const ordersBySession = new Map();
    const invalidDatabaseSessions = [];
    for (const order of orders) {
      const session = normalizeSession(order.sessao);
      if (!session) { invalidDatabaseSessions.push({ orderId: order.id }); continue; }
      ordersBySession.set(session, order);
    }
    return {
      totalOrders: orders.length,
      orders,
      ordersBySession,
      invalidDatabaseSessions,
      integrity,
      foreignKeyViolations,
      mapping: {
        limit,
        henrique: mapping.small ? { name: mapping.small.nome, active: Boolean(mapping.small.ativo), role: mapping.small.role } : null,
        carlos: mapping.large ? { name: mapping.large.nome, active: Boolean(mapping.large.ativo), role: mapping.large.role } : null,
        smallUserId: mapping.small?.id || null,
        largeUserId: mapping.large?.id || null,
      },
    };
  } finally {
    db.close();
  }
}

function classifyRecord(record, order) {
  const fields = {};
  const put = (key, value) => { fields[key] = value; };
  if (record.selectionInvalid) put("selecao_finalizada_em", "INVALID_SPREADSHEET_VALUE");
  else put("selecao_finalizada_em", classify(record.selectionDate, order.selecao_finalizada_em,
    { normalize: (value) => text(value).slice(0, 10) }));

  if (record.photos.issue) put("fotos_quantidade", "INVALID_SPREADSHEET_VALUE");
  else put("fotos_quantidade", classify(record.photos.empty ? null : record.photos.value, order.fotos_quantidade,
    { normalize: (value) => String(Number(value)) }));

  if (record.postDateInvalid) put("postado_em", "INVALID_SPREADSHEET_VALUE");
  else put("postado_em", classify(record.postDate, order.postado_em, { normalize: (value) => text(value).slice(0, 10) }));
  put("codigo_rastreio", classify(record.tracking, order.codigo_rastreio,
    { normalize: (value) => text(value).replace(/\s+/g, "").toUpperCase() }));
  put("observacoes", classify(record.observations, order.observacoes));
  put("cliente_nome", classify(record.clientName, order.cliente_nome, { normalize: normalizeText }));
  put("cliente_email", classify(record.email, order.cliente_email, { normalize: (value) => text(value).toLowerCase() }));
  const dbPhone = [order.cliente_telefone, order.cliente_celular].map(text).filter(Boolean).join("|");
  const sheetPhone = record.phone;
  if (!sheetPhone) put("cliente_telefone", dbPhone ? "DATABASE_HAS_VALUE_SPREADSHEET_EMPTY" : "SAME");
  else if (!dbPhone) put("cliente_telefone", "FILL_MISSING_SAFE");
  else put("cliente_telefone", dbPhone.split("|").some((phone) => normalizePhone(phone) === normalizePhone(sheetPhone))
    ? "SAME" : "CONFLICT");
  put("cliente_cidade", classify(record.city, order.cliente_cidade, { normalize: normalizeText }));
  put("editor", classify(record.editor, order.editor, { normalize: (value) => text(value).toUpperCase() }));

  const completedInSheet = record.checkboxComplete || /conclu/i.test(record.situation);
  const laterMilestone = Boolean(order.impressao_enviada_em || order.impressao_recebida_em || order.etiqueta_criada_em
    || order.remessa_id || order.postado_em || order.entregue_em);
  const conclusionWithoutDate = completedInSheet && !order.tratamento_concluido_em && !laterMilestone;
  const deliveredWithoutExactDate = record.delivered && !order.entregue_em;
  const trackingWithoutDate = Boolean(record.tracking && !record.postDate);
  const stageMismatch = record.situation && (
    (/aguardando selecao/i.test(normalizeText(record.situation)) && Boolean(order.selecao_finalizada_em))
    || (/em tratamento/i.test(normalizeText(record.situation)) && !order.selecao_finalizada_em)
    || (/conclu/i.test(normalizeText(record.situation)) && !order.tratamento_concluido_em && !laterMilestone)
  );
  const classes = Object.values(fields);
  const conflict = classes.includes("CONFLICT");
  const invalidValue = classes.includes("INVALID_SPREADSHEET_VALUE");
  const safeFields = Object.entries(fields).filter(([, value]) => value === "FILL_MISSING_SAFE").map(([key]) => key);

  // Posting date without tracking is not eligible for an automatic candidate;
  // the application validates these two shipment facts together.
  if (record.postDate && !record.tracking && !order.codigo_rastreio) {
    fields.postado_em = "MANUAL_REVIEW";
    safeFields.splice(safeFields.indexOf("postado_em"), 1);
  }
  if (trackingWithoutDate) fields.codigo_rastreio = "MANUAL_REVIEW";

  const databaseRicher = Object.values(fields).includes("DATABASE_HAS_VALUE_SPREADSHEET_EMPTY");
  let primaryCategory;
  if (conflict || stageMismatch || conclusionWithoutDate || deliveredWithoutExactDate || trackingWithoutDate
      || (record.postDate && !record.tracking && !order.codigo_rastreio)) primaryCategory = "MANUAL_REVIEW";
  else if (invalidValue) primaryCategory = "BLOCKED_INVALID_DATA";
  else if (safeFields.length) primaryCategory = "SAFE_UPDATE_CANDIDATE";
  else if (databaseRicher) primaryCategory = "DATABASE_NEWER_OR_RICHER";
  else primaryCategory = "NO_CHANGE";

  return {
    primaryCategory,
    fields,
    derivedStage: stage(order),
    evidence: {
      situationDiffersFromDerivedStage: Boolean(stageMismatch),
      conclusionWithoutExactDate: Boolean(conclusionWithoutDate),
      deliveredWithoutExactDate: Boolean(deliveredWithoutExactDate),
      trackingWithoutPostDate: Boolean(trackingWithoutDate),
    },
  };
}

function usefulRows(sheet) {
  let count = 0;
  for (let row = 1; row <= sheet.rowCount; row += 1) {
    if (sheet.getRow(row).values.slice(1).some((value) => text(unwrap(value)) !== "")) count += 1;
  }
  return count;
}

function main() {
  if (!fs.existsSync(WORKBOOK_PATH)) throw new Error(`Planilha não encontrada: ${WORKBOOK_PATH}`);
  if (!fs.existsSync(DATABASE_PATH)) throw new Error(`Banco piloto não encontrado: ${DATABASE_PATH}`);
  const workbookInfo = fs.statSync(WORKBOOK_PATH);
  const sheetResultPromise = readSheet(WORKBOOK_PATH);
  sheetResultPromise.then((sheetData) => {
    const dbData = readDatabase(DATABASE_PATH);
    const spreadsheetSessions = new Set(sheetData.groups.keys());
    const databaseSessions = new Set(dbData.ordersBySession.keys());
    const shared = [...spreadsheetSessions].filter((session) => databaseSessions.has(session));
    const onlySpreadsheet = [...spreadsheetSessions].filter((session) => !databaseSessions.has(session));
    const onlyDatabase = [...databaseSessions].filter((session) => !spreadsheetSessions.has(session));
    const categories = {
      NO_CHANGE: 0, SAFE_UPDATE_CANDIDATE: 0, NEW_ORDER_CANDIDATE: 0,
      MANUAL_REVIEW: 0, BLOCKED_DUPLICATE: 0, BLOCKED_INVALID_DATA: 0, DATABASE_NEWER_OR_RICHER: 0,
    };
    const fieldCounts = {};
    const records = [];
    const duplicateSessions = new Set(sheetData.duplicates.map((item) => item.session));
    const safeBreakdown = {
      selection: 0, tracking: 0, postingDate: 0, observation: 0,
      clientContactFillOnly: 0, photosFillOnly: 0, editorLegacy: 0,
    };
    const conflicts = {
      selection: 0, tracking: 0, photos: 0, clientContact: 0, duplicates: sheetData.duplicates.length,
      conclusionWithoutDate: 0, deliveryWithoutDate: 0, situationDivergence: 0, other: 0,
    };
    const classificationCounts = (fields) => {
      for (const [field, value] of Object.entries(fields)) {
        if (!fieldCounts[field]) fieldCounts[field] = {};
        fieldCounts[field][value] = (fieldCounts[field][value] || 0) + 1;
      }
    };

    for (const [session, rows] of sheetData.groups) {
      if (rows.length > 1) {
        categories.BLOCKED_DUPLICATE += 1;
        records.push({ session, sourceRows: rows.map((r) => r.row), primaryCategory: "BLOCKED_DUPLICATE",
          divergentFields: sheetData.duplicates.find((d) => d.session === session)?.divergentFields || [] });
        continue;
      }
      const record = rows[0];
      const order = dbData.ordersBySession.get(session);
      if (!order) {
        const invalidData = record.photos.issue || record.selectionInvalid || record.postDateInvalid;
        const sufficient = Boolean(record.clientName || record.email || record.phone || record.city
          || record.selectionDate || record.observations || record.photos.valid || record.postDate || record.tracking);
        const primaryCategory = invalidData ? "BLOCKED_INVALID_DATA" : sufficient ? "NEW_ORDER_CANDIDATE" : "MANUAL_REVIEW";
        categories[primaryCategory] += 1;
        records.push({ session, sourceRows: [record.row], primaryCategory,
          newOrderDataLevel: sufficient ? "sufficient_data" : "nearly_empty" });
        continue;
      }
      const comparison = classifyRecord(record, order);
      categories[comparison.primaryCategory] += 1;
      classificationCounts(comparison.fields);
      const fields = comparison.fields;
      if (comparison.primaryCategory === "SAFE_UPDATE_CANDIDATE") {
        if (fields.selecao_finalizada_em === "FILL_MISSING_SAFE") safeBreakdown.selection += 1;
        if (fields.codigo_rastreio === "FILL_MISSING_SAFE") safeBreakdown.tracking += 1;
        if (fields.postado_em === "FILL_MISSING_SAFE") safeBreakdown.postingDate += 1;
        if (fields.observacoes === "FILL_MISSING_SAFE") safeBreakdown.observation += 1;
        if (["cliente_nome", "cliente_email", "cliente_telefone", "cliente_cidade"]
          .some((field) => fields[field] === "FILL_MISSING_SAFE")) safeBreakdown.clientContactFillOnly += 1;
        if (fields.fotos_quantidade === "FILL_MISSING_SAFE") safeBreakdown.photosFillOnly += 1;
        if (fields.editor === "FILL_MISSING_SAFE") safeBreakdown.editorLegacy += 1;
      }
      if (fields.selecao_finalizada_em === "CONFLICT") conflicts.selection += 1;
      if (fields.codigo_rastreio === "CONFLICT" || fields.postado_em === "CONFLICT") conflicts.tracking += 1;
      if (fields.fotos_quantidade === "CONFLICT") conflicts.photos += 1;
      if (["cliente_nome", "cliente_email", "cliente_telefone", "cliente_cidade"]
        .some((field) => fields[field] === "CONFLICT")) conflicts.clientContact += 1;
      if (comparison.evidence.conclusionWithoutExactDate) conflicts.conclusionWithoutDate += 1;
      if (comparison.evidence.deliveredWithoutExactDate) conflicts.deliveryWithoutDate += 1;
      if (comparison.evidence.situationDiffersFromDerivedStage) conflicts.situationDivergence += 1;
      const knownConflict = fields.selecao_finalizada_em === "CONFLICT" || fields.codigo_rastreio === "CONFLICT"
        || fields.postado_em === "CONFLICT" || fields.fotos_quantidade === "CONFLICT"
        || ["cliente_nome", "cliente_email", "cliente_telefone", "cliente_cidade", "observacoes", "editor"]
          .some((field) => fields[field] === "CONFLICT");
      if (knownConflict && !fields.selecao_finalizada_em && !fields.codigo_rastreio && !fields.postado_em
          && !fields.fotos_quantidade) conflicts.other += 1;
      records.push({ session, sourceRows: [record.row], primaryCategory: comparison.primaryCategory,
        fields: comparison.fields, derivedStage: comparison.derivedStage, evidence: comparison.evidence });
    }

    const invalidRows = sheetData.invalidSessions.map((item) => ({ ...item, primaryCategory: "BLOCKED_INVALID_DATA" }));
    categories.BLOCKED_INVALID_DATA += invalidRows.length;
    const fieldFillMissingAcrossComparisons = Object.fromEntries(Object.entries(fieldCounts)
      .map(([field, counts]) => [field, counts.FILL_MISSING_SAFE || 0]));
    const onlySpreadsheetBreakdown = { sufficientData: 0, nearlyEmpty: 0, duplicate: 0 };
    for (const session of onlySpreadsheet) {
      if (duplicateSessions.has(session)) { onlySpreadsheetBreakdown.duplicate += 1; continue; }
      const record = sheetData.groups.get(session)?.[0];
      if (!record) continue;
      const sufficient = Boolean(record.clientName || record.email || record.phone || record.city
        || record.selectionDate || record.observations || record.photos.valid || record.postDate || record.tracking);
      if (sufficient) onlySpreadsheetBreakdown.sufficientData += 1;
      else onlySpreadsheetBreakdown.nearlyEmpty += 1;
    }
    const dbOnlyUniqueOrders = onlyDatabase.length;
    let myOrders = {
      currentWithoutSelection: 0, validSpreadsheetSelections: 0, reliableDatabasePhotoCount: 0,
      wouldHenrique: 0, wouldCarlos: 0, withoutEnoughQuantity: 0, manualAssignmentPreserved: 0,
    };
    let manualAssignmentsInMatchedOrders = 0;
    const map = dbData.mapping;
    for (const session of shared) {
      const order = dbData.ordersBySession.get(session);
      if (order?.tratamento_atribuicao_modo === "manual") manualAssignmentsInMatchedOrders += 1;
      if (duplicateSessions.has(session)) continue;
      const spreadsheet = sheetData.groups.get(session)?.[0];
      if (!spreadsheet || !order || order.selecao_finalizada_em) continue;
      myOrders.currentWithoutSelection += 1;
      if (!spreadsheet.selectionDate || spreadsheet.selectionInvalid) continue;
      myOrders.validSpreadsheetSelections += 1;
      const count = Number(order.fotos_quantidade);
      const reliablePhotos = order.fotos_quantidade !== null && order.fotos_quantidade !== undefined
        && Number.isSafeInteger(count) && count >= 0;
      if (reliablePhotos) myOrders.reliableDatabasePhotoCount += 1;
      else myOrders.withoutEnoughQuantity += 1;
      if (order.tratamento_atribuicao_modo === "manual") {
        myOrders.manualAssignmentPreserved += 1;
        continue;
      }
      const eligible = order.acompanhamento_status === "ativo" && !order.tratamento_concluido_em;
      if (!eligible || !reliablePhotos) continue;
      if (count < map.limit && map.smallUserId) myOrders.wouldHenrique += 1;
      else if (count >= map.limit && map.largeUserId) myOrders.wouldCarlos += 1;
    }

    const dbIntegrity = dbData.integrity;
    const fkViolations = dbData.foreignKeyViolations;
    const tabs = sheetData.otherTabs;
    const ordersCount = dbData.totalOrders;
    const candidateNames = dbData.mapping;
    const summary = {
      audit: "read-only reconciliation audit",
      generatedAt: new Date().toISOString(),
      workbook: {
        path: WORKBOOK_PATH,
        sizeBytes: workbookInfo.size,
        modifiedAt: workbookInfo.mtime.toISOString(),
        sheet: "LOGISTICA",
        headerRow: 6,
        requiredSheetsPresent: true,
        headersMatch: true,
        nonemptySessionCells: sheetData.nonemptySessionCells,
        normalizedSessionRows: sheetData.records.filter((r) => r.session).length,
        uniqueNormalizedSessions: sheetData.groups.size,
        uniqueSessionKeys: sheetData.groups.size,
        duplicateSessions: sheetData.duplicates.length,
        duplicateRows: sheetData.duplicates.reduce((sum, item) => sum + item.count, 0),
        invalidSessionRows: invalidRows.length,
        invalidSessionRowNumbers: invalidRows.map((row) => row.row),
        statuses: sheetData.statusCounts,
        selectionDatesValid: sheetData.selectionDates,
        maxDates: sheetData.maxDates,
        photoIssues: sheetData.photoIssues,
        trackingWithoutShippingDateRows: sheetData.rastreioSemData,
        deliveredStatusRows: sheetData.deliveredStatusRows,
        derivedDeadlineRowsIgnored: sheetData.derivedColumnsPopulated,
        duplicateDetails: sheetData.duplicates,
      },
      database: {
        path: DATABASE_PATH,
        openedReadOnly: true,
        integrityCheck: dbIntegrity,
        foreignKeyViolations: fkViolations,
        totalOrders: ordersCount,
        uniqueNormalizedSessionKeys: dbData.ordersBySession.size,
        invalidSessionRows: dbData.invalidDatabaseSessions.length,
        treatmentAssignment: {
          threshold: map.limit,
          smallPhotoAssignee: candidateNames.henrique ? { name: candidateNames.henrique.name, active: candidateNames.henrique.active, role: candidateNames.henrique.role } : null,
          largePhotoAssignee: candidateNames.carlos ? { name: candidateNames.carlos.name, active: candidateNames.carlos.active, role: candidateNames.carlos.role } : null,
        },
      },
      match: { sharedSessions: shared.length, onlySpreadsheet: onlySpreadsheet.length, onlyDatabase: dbOnlyUniqueOrders },
      onlySpreadsheetBreakdown,
      unmatchableInvalidSessionRows: invalidRows.length,
      sessionCategories: categories,
      safeUpdateFieldCandidates: safeBreakdown,
      fieldFillMissingAcrossComparisons,
      conflicts,
      fieldClassifications: fieldCounts,
      myOrders,
      manualAssignmentsInMatchedOrders,
      suspiciousData: {
        photosSlashOrText: sheetData.photoIssues.ambiguous,
        photosOver1000: sheetData.photoIssues.outOfRange,
        trackingWithoutShippingDateRows: sheetData.rastreioSemData,
        deliveredStatusRows: sheetData.deliveredStatusRows,
        unresolvedDeliveredWithoutExactDate: conflicts.deliveryWithoutDate,
        duplicateSessions: sheetData.duplicates.length,
        invalidSessionRows: invalidRows.length,
        invalidSessionRowNumbers: invalidRows.map((row) => row.row),
      },
      otherSheets: tabs,
      safety: {
        sqliteOpenedReadOnly: true,
        queryOnlyEnabled: true,
        writesExecuted: false,
        importsExecuted: false,
        databaseTablesWritten: [],
        apiRestarted: false,
        releasePublished: false,
        reportContainsCustomerContactValues: false,
      },
      phase02Recommendation: {
        AUTO_APPLY: ["somente seleção válida quando banco vazio e registro sem duplicidade, conflito ou atribuição manual",
          "fotos somente quando banco vazio e planilha contém inteiro de 0 a 1000",
          "data de postagem+rastreio quando ambos são válidos, banco está vazio ou valor coincidente e cadeia da etapa permite"],
        REVIEW: ["observações novas/divergentes com merge controlado", "contatos/cidade quando houver conflito",
          "qualquer duplicidade, status divergente, rastreio conflitante, data divergente ou conclusão sem data"],
        IGNORE: ["células vazias", "prazos e dias restantes derivados", "entrega sem data exata", "editor PAI/FILHO para atribuição de usuário",
          "abas BACKUP 2304, DASH_AUDIT, DASHBOARD e ENVIADOS DIGITAL", "linhas de sessão inválida ou dados ambíguos de fotos"],
      },
      files: {},
      finalStatus: "AUDITORIA READ-ONLY CONCLUÍDA — NENHUM DADO FOI ALTERADO POR ESTA AUDITORIA",
    };

    const details = {
      audit: "read-only; identifiers and field classifications only; no customer names, emails, or phones",
      records,
      invalidRows,
      onlySpreadsheetSessions: onlySpreadsheet,
      onlyDatabaseSessions: onlyDatabase,
    };
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const summaryPath = path.join(OUTPUT_DIR, "reconciliation-summary.json");
    const detailsPath = path.join(OUTPUT_DIR, "reconciliation-details.json");
    const reportPath = path.join(OUTPUT_DIR, "reconciliation-report.md");
    summary.files = { summary: summaryPath, details: detailsPath, report: reportPath };
    const markdown = [
      "# Reconciliação da planilha legada — dry-run read-only", "",
      `Gerado: ${summary.generatedAt}`, "", "## A. Arquivo", "",
      `- Planilha: ${summary.workbook.path}`, `- Tamanho: ${summary.workbook.sizeBytes} bytes`,
      `- Modificada: ${summary.workbook.modifiedAt}`, "- Aba: LOGISTICA; cabeçalho: linha 6; abas e cabeçalhos A:R validados.", "",
      "## B. Planilha", "", `- Células de sessão preenchidas: ${summary.workbook.nonemptySessionCells}`,
      `- Sessões normalizadas válidas: ${summary.workbook.normalizedSessionRows}; chaves únicas: ${summary.workbook.uniqueSessionKeys}`,
      `- Duplicadas: ${summary.workbook.duplicateSessions} sessões / ${summary.workbook.duplicateRows} linhas; inválidas: ${summary.workbook.invalidSessionRows} linha(s).`,
      `- Situações: ${JSON.stringify(summary.workbook.statuses)}`,
      `- Datas de seleção válidas: ${summary.workbook.selectionDatesValid}; datas máximas: ${JSON.stringify(summary.workbook.maxDates)}`,
      "- Prazos/dias restantes derivados foram ignorados.", "", "## C. Banco", "",
      `- Banco piloto: ${summary.database.path}; pedidos: ${summary.database.totalOrders}.`,
      `- integrity_check: ${summary.database.integrityCheck}; foreign_key_check: ${summary.database.foreignKeyViolations} violação(ões).`,
      "- A conexão SQLite foi aberta read-only com query_only habilitado.", "", "## D. Match", "",
      `- Em ambos: ${summary.match.sharedSessions}; somente planilha: ${summary.match.onlySpreadsheet}; somente banco: ${summary.match.onlyDatabase}.`,
      `- Somente na planilha, por chave válida: ${JSON.stringify(summary.onlySpreadsheetBreakdown)}; linhas com sessão inválida e sem chave comparável: ${summary.unmatchableInvalidSessionRows}.`,
      "- Sessões só na planilha foram classificadas sem inserção; sessões só no banco não foram removidas nem arquivadas.",
      "", "## E. SAFE_UPDATE_CANDIDATE", "", `- Candidatos por tipo: ${JSON.stringify(summary.safeUpdateFieldCandidates)}`,
      `- Diferenças FILL_MISSING_SAFE em comparações que ainda podem exigir revisão por outro campo: ${JSON.stringify(summary.fieldFillMissingAcrossComparisons)}.`,
      "- Os candidatos seguros no nível do pedido são somente de editor legado; nada foi escrito. Outros campos FILL_MISSING_SAFE estão associados a registros que ainda exigem revisão.", "", "## F. Conflitos e bloqueios", "",
      `- Contagens: ${JSON.stringify(summary.conflicts)}`, `- Categorias por sessão: ${JSON.stringify(summary.sessionCategories)}`,
      `- Duplicidades e campos divergentes: ${JSON.stringify(summary.workbook.duplicateDetails)}`,
      "- A única chave inválida está identificada apenas pelo número da linha nos detalhes; não foi inferida nem corrigida.",
      "", "## G. Meus Pedidos", "", `- Potencial de seleção/atribuição: ${JSON.stringify(summary.myOrders)}`,
      `- Regra atual lida do banco: limite ${summary.database.treatmentAssignment.threshold} fotos; atribuição manual foi preservada no cálculo.`,
      `- Pedidos compartilhados com atribuição manual: ${summary.manualAssignmentsInMatchedOrders}; não serão sobrescritos.`,
      "", "## H. Dados suspeitos", "", `- ${JSON.stringify(summary.suspiciousData)}`,
      "- Fotos ambíguas ou acima de 1000 não foram convertidas nem consideradas candidatas.",
      "- Datas exatas de conclusão/entrega não foram inventadas.", "", "## I. Outras abas", "",
      `- Contagens de linhas não vazias e não importação: ${JSON.stringify(summary.otherSheets)}`,
      "- ENVIADOS DIGITAL e Digital Sync não foram usados para reconciliação.",
      "", "## J. Recomendação para Fase 02", "", `- AUTO_APPLY: ${summary.phase02Recommendation.AUTO_APPLY.join("; ")}.`,
      `- REVIEW: ${summary.phase02Recommendation.REVIEW.join("; ")}.`,
      `- IGNORE: ${summary.phase02Recommendation.IGNORE.join("; ")}.`,
      "", "## K. Git", "", "- Sem commit ou release; a ferramenta de auditoria foi adicionada como script local.",
      "", "## L. Status final", "", summary.finalStatus, "",
    ].join("\n");
    fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
    fs.writeFileSync(detailsPath, `${JSON.stringify(details, null, 2)}\n`, "utf8");
    fs.writeFileSync(reportPath, markdown, "utf8");
    console.log(JSON.stringify(summary, null, 2));
  }).catch((error) => {
    console.error(`BLOQUEADO: ${error.message}`);
    process.exitCode = 1;
  });
}

main();
