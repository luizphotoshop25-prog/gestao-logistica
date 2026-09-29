type SessionRecord = { sessao?: unknown };

export function getSessionNumber(session: unknown): bigint | null {
  if (typeof session !== "string") return null;
  const match = session.trim().match(/^M(\d+)$/i);
  if (!match) return null;
  try { return BigInt(match[1]); } catch { return null; }
}

function compareSessionText(left: unknown, right: unknown): number {
  const a = typeof left === "string" ? left.trim() : "";
  const b = typeof right === "string" ? right.trim() : "";
  return a.localeCompare(b, "pt-BR", { numeric: true, sensitivity: "base" }) || a.localeCompare(b, "pt-BR");
}

export function sortOrdersBySession<T extends SessionRecord>(orders: readonly T[], direction: "ascending" | "descending"): T[] {
  return [...orders].sort((left, right) => {
    const leftNumber = getSessionNumber(left.sessao);
    const rightNumber = getSessionNumber(right.sessao);
    if (leftNumber === null && rightNumber === null) return compareSessionText(left.sessao, right.sessao);
    if (leftNumber === null) return 1;
    if (rightNumber === null) return -1;
    if (leftNumber === rightNumber) return compareSessionText(left.sessao, right.sessao);
    const comparison = leftNumber < rightNumber ? -1 : 1;
    return direction === "descending" ? -comparison : comparison;
  });
}
