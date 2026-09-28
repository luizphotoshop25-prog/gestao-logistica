const saoPauloDate = (value: Date) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || "00";
  return `${part("year")}-${part("month")}-${part("day")}`;
};

export function formatSolicitationDeadline(value: string | null, overdue = false, now = new Date()) {
  if (!value) return "Sem prazo";
  const deadline = new Date(value);
  if (!Number.isFinite(deadline.getTime())) return "Prazo inválido";
  const today = saoPauloDate(now);
  const deadlineDay = saoPauloDate(deadline);
  if (overdue) {
    const dayDistance = Math.floor((Date.parse(`${today}T12:00:00Z`) - Date.parse(`${deadlineDay}T12:00:00Z`)) / 86400000);
    return dayDistance < 1 ? "Atrasada há menos de 1 dia" : `Atrasada há ${dayDistance} ${dayDistance === 1 ? "dia" : "dias"}`;
  }
  const tomorrow = new Date(`${today}T12:00:00Z`);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const tomorrowDay = tomorrow.toISOString().slice(0, 10);
  const time = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", hour: "2-digit", minute: "2-digit" }).format(deadline);
  if (deadlineDay === today) return `Hoje • ${time}`;
  if (deadlineDay === tomorrowDay) return `Amanhã • ${time}`;
  const date = new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", day: "2-digit", month: "short" }).format(deadline).replace(/\./g, "").replace(" de ", " ");
  return `${date} • ${time}`;
}

export function isSolicitationDueToday(value: string | null, now = new Date()) {
  if (!value) return false;
  const deadline = new Date(value);
  return Number.isFinite(deadline.getTime()) && saoPauloDate(deadline) === saoPauloDate(now);
}

export function sortSolicitationsByUrgency<T extends { status: string; atrasada: boolean; prazo_em: string | null; created_at: string }>(items: T[], now = new Date()) {
  const priority = (item: T) => {
    if (item.status === "completed" || item.status === "cancelled") return 4;
    if (item.atrasada) return 0;
    if (isSolicitationDueToday(item.prazo_em, now)) return 1;
    if (!item.prazo_em || !Number.isFinite(Date.parse(item.prazo_em))) return 3;
    return 2;
  };
  return [...items].sort((a, b) => {
    const priorityDifference = priority(a) - priority(b);
    if (priorityDifference) return priorityDifference;
    if (priority(a) === 2) return Date.parse(a.prazo_em!) - Date.parse(b.prazo_em!);
    return Date.parse(b.created_at) - Date.parse(a.created_at);
  });
}

export function toLocalDateTimeInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function formatSolicitationDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat("pt-BR", { timeZone: "America/Sao_Paulo", dateStyle: "short", timeStyle: "short" }).format(date) : "—";
}
