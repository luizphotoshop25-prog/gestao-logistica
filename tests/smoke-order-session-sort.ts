import assert from "node:assert/strict";
import { sortOrdersBySession } from "../src/utils/session-sort.ts";

const rows = [
  { sessao: "M999", id: "m999" },
  { sessao: "M1000", id: "m1000" },
  { sessao: "m01000", id: "m01000" },
  { sessao: "M50213", id: "m50213" },
  { sessao: "sem-sessao", id: "invalid-text" },
  { sessao: "M49885", id: "m49885" },
  { sessao: "", id: "invalid-empty" },
  { sessao: null, id: "invalid-null" },
  { sessao: "M000", id: "m000" },
  { sessao: "M999999999999999999999999", id: "large" },
];

const ascending = sortOrdersBySession(rows, "ascending");
const descending = sortOrdersBySession(rows, "descending");
assert.deepEqual(ascending.slice(0, 7).map(row => row.id), ["m000", "m999", "m01000", "m1000", "m49885", "m50213", "large"]);
assert.deepEqual(descending.slice(0, 7).map(row => row.id), ["large", "m50213", "m49885", "m01000", "m1000", "m999", "m000"]);
assert.deepEqual(ascending.slice(7).map(row => row.id), ["invalid-empty", "invalid-null", "invalid-text"]);
assert.deepEqual(descending.slice(7).map(row => row.id), ["invalid-empty", "invalid-null", "invalid-text"]);
assert.deepEqual(rows.map(row => row.id), ["m999", "m1000", "m01000", "m50213", "invalid-text", "m49885", "invalid-empty", "invalid-null", "m000", "large"], "Sorting must not mutate the input");
assert.deepEqual(sortOrdersBySession([], "ascending"), []);
assert.equal(sortOrdersBySession([{ sessao: "M12" }], "descending")[0].sessao, "M12");

const selected = rows.filter(row => row.id !== "invalid-text" && row.id !== "m000").filter(row => String(row.sessao ?? "").toLowerCase().includes("m"));
assert.deepEqual(sortOrdersBySession(selected, "ascending").map(row => row.id), ["m999", "m01000", "m1000", "m49885", "m50213", "large"]);

console.log("Ordenação por sessão: 10 cenários aprovados (direções, comprimentos, formatos inválidos, estabilidade de entrada, conjunto vazio/único e composição com filtro/busca).");
