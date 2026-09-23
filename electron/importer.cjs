const ExcelJS = require("exceljs");
const fs = require("node:fs");
const path = require("node:path");

const clean = (value) => String(value ?? "").trim();
const unwrap = (input) => {
  let value = input;
  for (let depth = 0; depth < 4 && value && typeof value === "object"; depth += 1) {
    if ("result" in value) {
      value = value.result;
      continue;
    }
    if ("text" in value) {
      value = value.text;
      continue;
    }
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || "").join("");
    break;
  }
  return value;
};
const normalizeHeader = (value) =>
  clean(unwrap(value))
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
const normalizeSession = (value) => {
  const raw = clean(unwrap(value)).toUpperCase().replace(/\s+/g, "");
  const digits = raw.replace(/^M/, "");
  return /^\d+$/.test(digits) ? `M${digits}` : raw;
};
const toIsoDate = (value) => {
  const raw = unwrap(value);
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString().slice(0, 10);
  if (typeof raw === "number" && Number.isFinite(raw)) {
    const date = new Date(Date.UTC(1899, 11, 30) + Math.round(raw) * 86400000);
    return date.toISOString().slice(0, 10);
  }
  const text = clean(raw);
  const br = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (br) return `${br[3]}-${br[2].padStart(2, "0")}-${br[1].padStart(2, "0")}`;
  return /^\d{4}-\d{2}-\d{2}/.test(text) ? text.slice(0, 10) : null;
};
const truthy = (value) => {
  const raw = unwrap(value);
  return raw === true || raw === 1 || /^(1|sim|true)$/i.test(clean(raw));
};
const cellValue = (row, column) => (column > 0 ? row.getCell(column).value : null);

async function previewSpreadsheet(filePath) {
  const workbook = new ExcelJS.Workbook();
  const extension = path.extname(filePath).toLowerCase();
  if (extension === ".csv") {
    const sample = fs.readFileSync(filePath, "utf8").slice(0, 8192).split(/\r?\n/).find((line) => line.trim()) || "";
    const delimiter = (sample.match(/;/g) || []).length > (sample.match(/,/g) || []).length ? ";" : ",";
    await workbook.csv.readFile(filePath, { parserOptions: { delimiter, ignoreEmpty: true } });
  } else {
    await workbook.xlsx.readFile(filePath);
  }
  const sheet = workbook.getWorksheet("LOGISTICA") || workbook.worksheets[0];
  if (!sheet) throw new Error("A planilha não possui abas legíveis.");

  let headerRowNumber = 0;
  let headers = [];
  for (let index = 1; index <= Math.min(sheet.rowCount, 25); index += 1) {
    const values = sheet.getRow(index).values.slice(1).map(normalizeHeader);
    if (values.includes("sessao") && values.some((value) => value.includes("finalizou selecao"))) {
      headerRowNumber = index;
      headers = values;
      break;
    }
  }
  if (!headerRowNumber) throw new Error("Cabeçalho da aba LOGISTICA não foi reconhecido.");

  const column = (pattern) => headers.findIndex((header) => pattern.test(header)) + 1;
  const columns = {
    concluido: column(/^concluido$/),
    sessao: column(/^sessao$/),
    cliente: column(/^cliente$/),
    email: column(/^email$/),
    telefone: column(/^telefone$/),
    cidade: column(/^cidade$/),
    fotos: column(/^fotos$/),
    observacoes: column(/^observacoes$/),
    selecao: column(/^finalizou selecao$/),
    situacao: column(/^situacao$/),
    prazoMaximo: column(/prazo para o cliente/),
    postado: column(/^data de envio$/),
    rastreio: column(/codigo de rastreio/),
    statusRastreio: column(/status do rastreio/),
    editor: column(/^editor$/),
  };
  if (!columns.sessao) throw new Error("Coluna Sessão não encontrada.");

  const rows = [];
  for (let line = headerRowNumber + 1; line <= sheet.rowCount; line += 1) {
    const row = sheet.getRow(line);
    const session = normalizeSession(cellValue(row, columns.sessao));
    if (!session) continue;
    const situation = clean(unwrap(cellValue(row, columns.situacao)));
    const trackingStatus = clean(unwrap(cellValue(row, columns.statusRastreio)));
    rows.push({
      linha: line,
      sessao: session,
      clienteNome: clean(unwrap(cellValue(row, columns.cliente))),
      clienteEmail: clean(unwrap(cellValue(row, columns.email))),
      clienteTelefone: clean(unwrap(cellValue(row, columns.telefone))),
      clienteCidade: clean(unwrap(cellValue(row, columns.cidade))),
      fotosQuantidade: Number(unwrap(cellValue(row, columns.fotos))) || null,
      observacoes: clean(unwrap(cellValue(row, columns.observacoes))),
      selecaoFinalizadaEm: toIsoDate(cellValue(row, columns.selecao)),
      prazoMaximoLegadoEm: toIsoDate(cellValue(row, columns.prazoMaximo)),
      tratamentoConcluido: truthy(cellValue(row, columns.concluido)) || /conclu/i.test(situation),
      postadoEm: toIsoDate(cellValue(row, columns.postado)),
      codigoRastreio: clean(unwrap(cellValue(row, columns.rastreio))).toUpperCase(),
      entregue: /entregue/i.test(trackingStatus),
      editor: clean(unwrap(cellValue(row, columns.editor))),
      warnings: [],
      eligible: true,
    });
  }

  const counts = new Map();
  for (const row of rows) counts.set(row.sessao, (counts.get(row.sessao) || 0) + 1);
  for (const row of rows) {
    if (!/^M\d+$/.test(row.sessao)) row.warnings.push("sessao_invalida");
    if ((counts.get(row.sessao) || 0) > 1) row.warnings.push("sessao_duplicada");
    if (!row.clienteNome && !row.clienteEmail && !row.clienteTelefone)
      row.warnings.push("cliente_sem_identificacao");
    if (row.codigoRastreio && !row.postadoEm) row.warnings.push("rastreio_sem_data_postagem");
    if (row.fotosQuantidade && row.fotosQuantidade > 1000) row.warnings.push("fotos_fora_do_padrao");
    row.eligible = !row.warnings.includes("sessao_invalida") && !row.warnings.includes("sessao_duplicada");
  }

  return {
    ok: true,
    filePath,
    sheet: sheet.name,
    headerRow: headerRowNumber,
    total: rows.length,
    eligible: rows.filter((row) => row.eligible).length,
    blocked: rows.filter((row) => !row.eligible).length,
    missingClient: rows.filter((row) => row.warnings.includes("cliente_sem_identificacao")).length,
    trackingWithoutDate: rows.filter((row) => row.warnings.includes("rastreio_sem_data_postagem")).length,
    rows,
  };
}

module.exports = { previewSpreadsheet };
