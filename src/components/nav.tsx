'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/utils/cn';

const LINKS = [
  { href: '/', label: 'Dashboard' },
  { href: '/discover', label: 'Discover' },
  { href: '/clips', label: 'Clips' },
  { href: '/episodes', label: 'Episodes' },
  { href: '/settings', label: 'AI Agents' },
] as const;

export function Nav() {
  const pathname = usePathname();

  const isActive = (href: string): boolean =>
    href === '/' ? pathname === '/' : pathname.startsWith(href);

  return (
    <nav className="flex items-center gap-1">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={cn(
            'rounded-lg px-3 py-1.5 text-sm transition-colors',
            isActive(link.href)
              ? 'bg-[var(--color-surface-hover)] font-medium text-slate-100'
              : 'text-slate-400 hover:bg-[var(--color-surface-raised)] hover:text-slate-200',
          )}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
