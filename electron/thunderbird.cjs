const fs = require("node:fs");
const path = require("node:path");

const SENDER = "nao-responda@epics.com.br";

function decodeMimeWords(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, (_match, charset, encoding, content) => {
    try {
      if (encoding.toLowerCase() === "b") return Buffer.from(content, "base64").toString("utf8");
      const decoded = content.replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_m, hex) =>
        String.fromCharCode(Number.parseInt(hex, 16)));
      return Buffer.from(decoded, "latin1").toString(/utf-?8/i.test(charset) ? "utf8" : "latin1");
    } catch {
      return content;
    }
  });
}

function decodeQuotedPrintable(value) {
  const decoded = String(value || "")
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  return Buffer.from(decoded, "latin1").toString("latin1");
}

function unfoldHeaders(headerText) {
  return String(headerText || "").replace(/\r?\n[\t ]+/g, " ");
}

function headerValue(headers, name) {
  const match = headers.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
  return match ? match[1].trim() : "";
}

function htmlToText(html) {
  return String(html || "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/p\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ");
}

function localDate(isoValue) {
  const date = new Date(isoValue);
  if (Number.isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function findInbox() {
  const thunderbirdRoot = path.join(process.env.APPDATA || "", "Thunderbird");
  const profilesFile = path.join(thunderbirdRoot, "profiles.ini");
  if (!fs.existsSync(profilesFile)) return null;
  const profiles = fs.readFileSync(profilesFile, "utf8");
  const installDefault = profiles.match(/^Default=(Profiles[\\/][^\r\n]+)$/m)?.[1];
  const profileRelative = installDefault || profiles.match(/^Path=(Profiles[\\/][^\r\n]+)$/m)?.[1];
  if (!profileRelative) return null;
  const profilePath = path.join(thunderbirdRoot, ...profileRelative.split(/[\\/]/));
  const prefsPath = path.join(profilePath, "prefs.js");
  if (!fs.existsSync(prefsPath)) return null;
  const prefs = fs.readFileSync(prefsPath, "utf8");
  const server = [...prefs.matchAll(/mail\.server\.(server\d+)\.hostname",\s*"([^"]+)"/g)]
    .find((match) => /manoelguimaraes\.com\.br$/i.test(match[2]));
  if (!server) return null;
  const directoryMatch = prefs.match(new RegExp(`mail\\.server\\.${server[1]}\\.directory-rel",\\s*"\\[ProfD\\]([^"\\r\\n]+)`));
  if (!directoryMatch) return null;
  const accountPath = path.join(profilePath, ...directoryMatch[1].replace(/^[\\/]/, "").split(/[\\/]/));
  const inboxPath = path.join(accountPath, "INBOX");
  return fs.existsSync(inboxPath) ? inboxPath : null;
}

function parseMessage(rawMessage) {
  const boundary = rawMessage.search(/\r?\n\r?\n/);
  if (boundary < 0) return null;
  const headers = unfoldHeaders(rawMessage.slice(0, boundary));
  const from = decodeMimeWords(headerValue(headers, "From"));
  if (!from.toLowerCase().includes(SENDER)) return null;
  const subject = decodeMimeWords(headerValue(headers, "Subject"));
  if (!/finalizaram uma seleção de fotos:/i.test(subject)) return null;
  const sessao = subject.match(/\bM\d+\b/i)?.[0]?.toUpperCase();
  const messageId = headerValue(headers, "Message-ID");
  const received = new Date(headerValue(headers, "Date"));
  if (!sessao || !messageId || Number.isNaN(received.getTime())) return null;

  const body = decodeQuotedPrintable(rawMessage.slice(boundary));
  const text = htmlToText(body);
  const countMatch = text.match(/Selecionad[oa]s?:\s*(\d+)\s*de\s*(\d+)/i);
  const lightroomStart = text.search(/Usando o Adobe Lightroom/i);
  const windowsStart = text.search(/Usando o Windows/i);
  const listSection = lightroomStart >= 0
    ? text.slice(lightroomStart, windowsStart > lightroomStart ? windowsStart : undefined)
    : text;
  const codes = [...new Set(listSection.match(/\b\d{7,}\b/g) || [])];

  return {
    messageId,
    sessao,
    recebidoEm: received.toISOString(),
    dataFinalizacao: localDate(received),
    quantidadeSelecionada: countMatch ? Number(countMatch[1]) : codes.length || null,
    quantidadeTotal: countMatch ? Number(countMatch[2]) : null,
    codigos: codes,
  };
}

function readSelections() {
  const inboxPath = findInbox();
  if (!inboxPath) return { ok: false, message: "Caixa de entrada local do Thunderbird não encontrada.", records: [] };
  const content = fs.readFileSync(inboxPath, "latin1");
  const starts = [];
  const separator = /^From .+$/gm;
  for (let match = separator.exec(content); match; match = separator.exec(content)) starts.push(match.index);
  const records = [];
  for (let index = 0; index < starts.length; index += 1) {
    const parsed = parseMessage(content.slice(starts[index], starts[index + 1] || content.length));
    if (parsed) records.push(parsed);
  }
  records.sort((left, right) => left.recebidoEm.localeCompare(right.recebidoEm));
  return { ok: true, inboxPath, records };
}

function sync(database) {
  const result = readSelections();
  if (!result.ok) return result;
  return { ok: true, ...database.importThunderbirdSelections(result.records) };
}

module.exports = { readSelections, sync };
