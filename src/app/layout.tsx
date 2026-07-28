import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';
import { Nav } from '@/components/nav';
import { describeConfig } from '@/lib/config';
import { Pill } from '@/components/ui/primitives';

export const metadata: Metadata = {
  title: 'AI Podcast Producer Assistant',
  description:
    'Podcast content intelligence. Find the best short-form moments across thousands of hours of podcasts in minutes.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // Read once per request so every page shows the same mode banner.
  const config = describeConfig();

  return (
    <html lang="en">
      <body className="min-h-screen font-sans antialiased">
        <header className="sticky top-0 z-20 border-b border-[var(--color-line)] bg-[var(--color-surface)]/85 backdrop-blur">
          <div className="mx-auto flex max-w-[1400px] flex-wrap items-center gap-x-6 gap-y-3 px-6 py-3">
            <Link href="/" className="group flex items-baseline gap-2">
              <span className="text-sm font-semibold tracking-tight text-slate-100">
                Podcast Producer
              </span>
              <span className="hidden text-[11px] text-slate-500 sm:inline">
                content intelligence
              </span>
            </Link>

            <Nav />

            <div className="ml-auto flex items-center gap-2">
              <Pill
                title={
                  config.youtube === 'demo'
                    ? 'No YOUTUBE_API_KEY set. Discovery is serving a synthetic demo catalogue.'
                    : 'Discovery is querying the live YouTube Data API.'
                }
                className={
                  config.youtube === 'demo'
                    ? 'bg-amber-500/10 text-amber-300 ring-amber-500/20'
                    : 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
                }
              >
                {config.youtube === 'demo' ? 'Demo catalogue' : 'Live YouTube'}
              </Pill>

              <Pill
                title={
                  config.scoring === 'llm'
                    ? `Clip scoring is running on ${config.llmModelLabel}.`
                    : 'No AI provider configured. Scoring uses the deterministic heuristic engine.'
                }
                className={
                  config.scoring === 'llm'
                    ? 'bg-sky-500/10 text-sky-300 ring-sky-500/20'
                    : 'bg-slate-500/10 text-slate-300 ring-slate-500/20'
                }
              >
                {config.scoring === 'llm' ? config.llmModelLabel : 'Heuristic scoring'}
              </Pill>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-[1400px] px-6 py-8">{children}</main>

        <footer className="mx-auto max-w-[1400px] px-6 pb-10 pt-4">
          <p className="text-[11px] leading-relaxed text-slate-600">
            This tool finds and ranks moments. It does not edit video - clips are handed to the
            editor as timecodes, reasoning and copy.
          </p>
        </footer>
      </body>
    </html>
  );
}
