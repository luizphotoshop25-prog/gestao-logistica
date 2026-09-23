import { ChevronLeft, ChevronRight } from "lucide-react";

type Props = { page: number; totalPages: number; totalItems: number; pageSize: number; onChange(page: number): void };

export function Pagination({ page, totalPages, totalItems, pageSize, onChange }: Props) {
  const start = (page - 1) * pageSize + 1;
  const end = Math.min(totalItems, page * pageSize);
  return <footer className="pagination" aria-label="Paginação dos pedidos">
    <span>Exibindo <strong>{start}–{end}</strong> de <strong>{totalItems}</strong></span>
    <div><button onClick={() => onChange(page - 1)} disabled={page <= 1} aria-label="Página anterior"><ChevronLeft size={16} /></button><span>Página <strong>{page}</strong> de {totalPages}</span><button onClick={() => onChange(page + 1)} disabled={page >= totalPages} aria-label="Próxima página"><ChevronRight size={16} /></button></div>
  </footer>;
}
