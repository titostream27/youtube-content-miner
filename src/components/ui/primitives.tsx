import type { ReactNode } from 'react';
import { cn } from '@/lib/utils/cn';

/** Small presentational building blocks shared across pages. */

export function Card({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-raised)]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function CardHeader({
  title,
  description,
  action,
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b border-[var(--color-line)] px-5 py-4">
      <div className="min-w-0">
        <h2 className="text-sm font-semibold tracking-tight text-slate-100">{title}</h2>
        {description ? <p className="mt-1 text-xs text-slate-400">{description}</p> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

export function SectionTitle({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-4">
      <h2 className="text-xs font-semibold uppercase tracking-[0.14em] text-slate-500">
        {children}
      </h2>
      {hint ? <span className="text-xs text-slate-500">{hint}</span> : null}
    </div>
  );
}

export function Pill({
  children,
  className,
  title,
}: {
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-medium',
        'bg-slate-500/10 text-slate-300 ring-1 ring-inset ring-slate-500/20',
        className,
      )}
    >
      {children}
    </span>
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-[var(--color-line)] px-6 py-14 text-center">
      <p className="text-sm font-medium text-slate-300">{title}</p>
      <p className="max-w-md text-xs leading-relaxed text-slate-500">{description}</p>
      {action}
    </div>
  );
}

/**
 * Horizontal meter. Used for both clip dimensions and episode factors so the
 * two scoring models read the same way.
 */
export function Meter({
  label,
  value,
  max = 100,
  hint,
  emphasis = false,
}: {
  label: string;
  value: number;
  max?: number;
  hint?: string;
  emphasis?: boolean;
}) {
  const pct = Math.max(0, Math.min(100, (value / max) * 100));

  const barColor =
    value >= 80
      ? 'bg-emerald-500'
      : value >= 65
        ? 'bg-sky-500'
        : value >= 50
          ? 'bg-amber-500'
          : 'bg-slate-600';

  return (
    <div title={hint}>
      <div className="flex items-baseline justify-between gap-2">
        <span
          className={cn(
            'truncate text-[11px]',
            emphasis ? 'font-medium text-slate-200' : 'text-slate-400',
          )}
        >
          {label}
        </span>
        <span className="numeric text-[11px] tabular-nums text-slate-400">{Math.round(value)}</span>
      </div>
      <div className="mt-1 h-1 overflow-hidden rounded-full bg-slate-700/60">
        <div className={cn('h-full rounded-full', barColor)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function KeyValue({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <dt className="text-xs text-slate-500">{label}</dt>
      <dd className="text-right text-xs font-medium text-slate-300">{value}</dd>
    </div>
  );
}


/**
 * Headline counter. The dashboard's "today" row is the product's primary
 * surface, so these are large, quiet, and never decorated with sparklines that
 * would compete with the number itself.
 */
export function Stat({
  label,
  value,
  hint,
  accent = 'neutral',
  href,
}: {
  label: string;
  value: ReactNode;
  hint?: string;
  accent?: 'neutral' | 'primary' | 'success';
  href?: string;
}) {
  const valueColor =
    accent === 'success'
      ? 'text-emerald-300'
      : accent === 'primary'
        ? 'text-sky-300'
        : 'text-slate-100';

  const content = (
    <>
      <p className="text-[11px] font-medium uppercase tracking-[0.12em] text-slate-500">{label}</p>
      <p className={cn('numeric mt-2 text-3xl font-semibold tabular-nums', valueColor)}>{value}</p>
      {hint ? <p className="mt-1 text-[11px] leading-snug text-slate-500">{hint}</p> : null}
    </>
  );

  const className = cn(
    'rounded-xl border border-[var(--color-line)] bg-[var(--color-surface-raised)] px-4 py-4',
    href && 'transition-colors hover:border-slate-600 hover:bg-[var(--color-surface-hover)]',
  );

  if (href) {
    return (
      <a href={href} className={className}>
        {content}
      </a>
    );
  }

  return <div className={className}>{content}</div>;
}
