const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/utils/solicitation-date.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const testModule = { exports: {} };
vm.runInNewContext(compiled, { module: testModule, exports: testModule.exports, Date, Intl, Boolean, Number, String, Math });
const { formatSolicitationDeadline, isSolicitationDueToday, sortSolicitationsByUrgency } = testModule.exports;
const now = new Date("2026-09-24T12:00:00-03:00");

assert.equal(formatSolicitationDeadline("2026-09-24T18:00:00.000Z", false, now), "Hoje • 15:00");
assert.equal(formatSolicitationDeadline("2026-09-25T13:00:00.000Z", false, now), "Amanhã • 10:00");
assert.equal(formatSolicitationDeadline("2026-09-22T18:00:00.000Z", true, now), "Atrasada há 2 dias");
assert.equal(isSolicitationDueToday("2026-09-24T18:00:00.000Z", now), true);
assert.equal(isSolicitationDueToday("invalid", now), false);
const ordered = sortSolicitationsByUrgency([
  { id: "none", status: "pending", atrasada: false, prazo_em: null, created_at: "2026-09-24T10:00:00.000Z" },
  { id: "tomorrow", status: "pending", atrasada: false, prazo_em: "2026-09-25T13:00:00.000Z", created_at: "2026-09-24T10:00:00.000Z" },
  { id: "today", status: "pending", atrasada: false, prazo_em: "2026-09-24T18:00:00.000Z", created_at: "2026-09-24T10:00:00.000Z" },
  { id: "late", status: "pending", atrasada: true, prazo_em: "2026-09-22T18:00:00.000Z", created_at: "2026-09-24T10:00:00.000Z" },
  { id: "closed", status: "completed", atrasada: false, prazo_em: "2026-09-22T18:00:00.000Z", created_at: "2026-09-24T10:00:00.000Z" },
], now);
assert.deepEqual(Array.from(ordered, (item) => item.id), ["late", "today", "tomorrow", "none", "closed"]);
console.log("Prazo de solicitações: Hoje, Amanhã, atraso, ordenação operacional e fuso America/Sao_Paulo aprovados.");
