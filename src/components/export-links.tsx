import { EXPORT_FORMATS } from '@/lib/export';

/**
 * PRD "Export".
 *
 * The links carry the caller's current filters, so a download is always exactly
 * the set of clips on screen rather than the whole library.
 */
export function ExportLinks({ query }: { query: Record<string, string | undefined> }) {
  const base = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value.length > 0) base.set(key, value);
  }

  return (
    <div className="flex items-center gap-1.5">
      <span className="text-[11px] text-slate-500">Export</span>
      {EXPORT_FORMATS.map((descriptor) => {
        const params = new URLSearchParams(base);
        params.set('format', descriptor.format);

        return (
          <a
            key={descriptor.format}
            href={`/api/export?${params.toString()}`}
            title={descriptor.description}
            className="rounded-md bg-slate-500/10 px-2 py-1 text-[11px] font-medium text-slate-300 ring-1 ring-inset ring-slate-500/25 hover:bg-slate-500/20 hover:text-slate-100"
          >
            {descriptor.label}
          </a>
        );
      })}
    </div>
  );
}
