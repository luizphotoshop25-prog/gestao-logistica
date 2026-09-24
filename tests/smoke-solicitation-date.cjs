const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const source = fs.readFileSync(path.join(__dirname, "../src/utils/solicitation-date.ts"), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const testModule = { exports: {} };
vm.runInNewContext(compiled, { module: testModule, exports: testModule.exports, Date, Intl, Boolean, Number, String, Math });
const { formatSolicitationDeadline, isSolicitationDueToday } = testModule.exports;
const now = new Date("2026-09-24T12:00:00-03:00");

assert.equal(formatSolicitationDeadline("2026-09-24T18:00:00.000Z", false, now), "Hoje • 15:00");
assert.equal(formatSolicitationDeadline("2026-09-25T13:00:00.000Z", false, now), "Amanhã • 10:00");
assert.equal(formatSolicitationDeadline("2026-09-22T18:00:00.000Z", true, now), "Atrasada há 2 dias");
assert.equal(isSolicitationDueToday("2026-09-24T18:00:00.000Z", now), true);
console.log("Prazo de solicitações: Hoje, Amanhã, atraso e fuso America/Sao_Paulo aprovados.");
