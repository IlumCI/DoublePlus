export function Pagination({
  page,
  pages,
  onPage,
}: {
  page: number;
  pages: number;
  onPage: (p: number) => void;
}) {
  if (pages <= 1) return null;
  return (
    <nav className="nb-page" aria-label="Pagination">
      <button type="button" className="nb-btn" onClick={() => onPage(page - 1)} disabled={page <= 1}>
        ← PREV
      </button>
      <span className="info">
        {page} / {pages}
      </span>
      <button type="button" className="nb-btn" onClick={() => onPage(page + 1)} disabled={page >= pages}>
        NEXT →
      </button>
    </nav>
  );
}
