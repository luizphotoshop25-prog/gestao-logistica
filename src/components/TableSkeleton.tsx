export function TableSkeleton({ rows, columns }: { rows: number; columns: number }) {
  return <>{Array.from({ length: rows }, (_, row) => <tr className="skeleton-row" key={row}>{Array.from({ length: columns }, (_, column) => <td key={column}><span style={{ width: `${Math.max(34, 82 - column * 5)}%` }} /></td>)}</tr>)}</>;
}
