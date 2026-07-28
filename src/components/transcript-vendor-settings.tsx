'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { cn } from '@/lib/utils/cn';
import { Card, CardHeader, Pill } from '@/components/ui/primitives';

/**
 * Transcript vendor setup: choose a vendor, then paste the key.
 *
 * The flow is deliberately two-step. Vendors differ in request shape, time unit
 * and whether long videos come back asynchronously, and getting any of those
 * wrong produces a transcript that looks fine and is quietly unusable. Selecting
 * the vendor first lets the preset fill those in, so the operator only supplies
 * the one thing that cannot be preset - the credential.
 *
 * Test runs before Save, against the real provider path, because discovering a
 * misconfiguration during an archive-mining run is expensive.
 */

export interface VendorOption {
  id: 'supadata' | 'custom';
  label: string;
  docsUrl: string;
  verified: boolean;
  freeTierNote: string;
  notes: string;
  urlTemplate: string;
  authHeader: string;
  authScheme: string | null;
  timeUnit: 'ms' | 's';
  asynchronous: boolean;
}

export interface VendorStatus {
  configured: boolean;
  vendorId: 'supadata' | 'custom' | null;
  vendorLabel: string | null;
  urlTemplate: string | null;
  authHeader: string | null;
  timeUnit: 'ms' | 's' | null;
  pollUrlTemplate?: string | null;
  hasApiKey: boolean;
  source: 'env' | 'database' | null;
  managedByEnvironment: boolean;
}

interface TestCheck {
  label: string;
  pass: boolean;
  detail: string;
}

interface TestResult {
  ok: boolean;
  videoId: string;
  elapsedMs: number;
  viaJob: boolean;
  reason: string | null;
  language?: string | null;
  stats?: {
    segments: number;
    words: number;
    durationSec: number;
    wordsPerSecond: number;
    sentences: number;
    punctuationRatio: number;
    medianSegmentSec: number;
  };
  preview?: string;
  checks: TestCheck[];
}

export function TranscriptVendorSettings({
  vendors,
  status,
}: {
  vendors: VendorOption[];
  status: VendorStatus;
}) {
  const router = useRouter();

  const [vendorId, setVendorId] = useState<'supadata' | 'custom' | null>(status.vendorId);
  const [apiKey, setApiKey] = useState('');
  const [videoId, setVideoId] = useState('');
  const [urlTemplate, setUrlTemplate] = useState(status.urlTemplate ?? '');
  const [authHeader, setAuthHeader] = useState(status.authHeader ?? '');
  const [timeUnit, setTimeUnit] = useState<'ms' | 's'>(status.timeUnit ?? 's');
  const [pollUrlTemplate, setPollUrlTemplate] = useState(status.pollUrlTemplate ?? '');

  const [busy, setBusy] = useState<null | 'save' | 'test' | 'clear'>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<TestResult | null>(null);

  const selected = vendors.find((vendor) => vendor.id === vendorId) ?? null;
  const locked = status.managedByEnvironment;

  function chooseVendor(vendor: VendorOption): void {
    setVendorId(vendor.id);
    setError(null);
    setMessage(null);
    setTest(null);
    // Preset fills the contract details; the operator supplies only the key.
    setUrlTemplate(vendor.urlTemplate);
    setAuthHeader(vendor.authHeader);
    setTimeUnit(vendor.timeUnit);
  }

  function currentPayload(): Record<string, unknown> {
    return {
      vendorId,
      apiKey: apiKey.trim().length > 0 ? apiKey.trim() : undefined,
      urlTemplate: urlTemplate.trim() || undefined,
      authHeader: authHeader.trim() || undefined,
      timeUnit,
      pollUrlTemplate: pollUrlTemplate.trim() || undefined,
    };
  }

  async function save(): Promise<void> {
    if (!vendorId) return;
    setBusy('save');
    setError(null);
    setMessage(null);

    try {
      const response = await fetch('/api/settings/transcript', {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(currentPayload()),
      });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Save failed (${response.status})`);

      setMessage('Saved. The hosted provider is now first in the transcript chain.');
      setApiKey('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Save failed');
    } finally {
      setBusy(null);
    }
  }

  async function runTest(): Promise<void> {
    if (!vendorId) return;
    setBusy('test');
    setError(null);
    setMessage(null);
    setTest(null);

    try {
      const response = await fetch('/api/settings/transcript/test', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          ...currentPayload(),
          videoId: videoId.trim() || undefined,
        }),
      });
      const body = (await response.json()) as TestResult & { error?: string };
      if (!response.ok) throw new Error(body.error ?? `Test failed (${response.status})`);
      setTest(body);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Test failed');
    } finally {
      setBusy(null);
    }
  }

  async function clear(): Promise<void> {
    setBusy('clear');
    setError(null);
    setMessage(null);

    try {
      const response = await fetch('/api/settings/transcript', { method: 'DELETE' });
      const body = (await response.json()) as { error?: string };
      if (!response.ok) throw new Error(body.error ?? 'Could not clear');

      setVendorId(null);
      setApiKey('');
      setTest(null);
      setMessage('Vendor and key removed.');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Could not clear');
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Transcript vendor"
        description="Pick a vendor, then paste its API key. This is what makes third-party extraction reliable."
        action={
          status.configured ? (
            <Pill
              className={
                status.hasApiKey
                  ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
                  : 'bg-amber-500/10 text-amber-300 ring-amber-500/20'
              }
            >
              {status.hasApiKey ? `${status.vendorLabel} connected` : 'key missing'}
            </Pill>
          ) : (
            <Pill>not configured</Pill>
          )
        }
      />

      <div className="space-y-5 px-5 py-5">
        {locked ? (
          <p className="rounded-lg bg-sky-500/10 px-3 py-2 text-xs leading-relaxed text-sky-200/90 ring-1 ring-inset ring-sky-500/20">
            Credentials are pinned by <code className="font-mono">TRANSCRIPT_API_URL</code> in the
            environment, so they cannot be changed here. That is the right setup for a shared
            deployment. Unset it to manage the vendor from this page.
          </p>
        ) : null}

        {/* Step 1 - choose the vendor */}
        <div>
          <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
            1 · Choose a vendor
          </p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {vendors.map((vendor) => (
              <button
                key={vendor.id}
                type="button"
                disabled={locked}
                onClick={() => chooseVendor(vendor)}
                className={cn(
                  'rounded-lg border px-3 py-2.5 text-left transition-colors disabled:opacity-50',
                  vendorId === vendor.id
                    ? 'border-sky-500/40 bg-sky-500/10'
                    : 'border-[var(--color-line)] hover:border-slate-600 hover:bg-[var(--color-surface-hover)]',
                )}
              >
                <span className="flex items-center gap-2">
                  <span
                    className={cn(
                      'text-xs font-semibold',
                      vendorId === vendor.id ? 'text-sky-200' : 'text-slate-300',
                    )}
                  >
                    {vendor.label}
                  </span>
                  {vendor.verified ? (
                    <Pill
                      title="Request and response contract confirmed against the vendor's published documentation."
                      className="bg-emerald-500/10 text-emerald-300 ring-emerald-500/20"
                    >
                      verified
                    </Pill>
                  ) : (
                    <Pill title="You supply the endpoint details.">manual setup</Pill>
                  )}
                </span>
                <span className="mt-1 block text-[11px] leading-snug text-slate-500">
                  {vendor.notes}
                </span>
                <span className="mt-1.5 block text-[11px] text-slate-600">
                  {vendor.freeTierNote}
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Step 2 - the key */}
        {selected ? (
          <div className="space-y-4">
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                2 · Paste the API key
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                <input
                  type="password"
                  autoComplete="off"
                  disabled={locked}
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                  placeholder={
                    status.hasApiKey ? 'A key is stored. Enter a new one to replace it.' : 'Paste the key'
                  }
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-black/25 px-3 py-2 font-mono text-xs text-slate-200 placeholder:font-sans placeholder:text-slate-600 focus:border-sky-500/50 focus:outline-none disabled:opacity-50"
                />
                {selected.docsUrl ? (
                  <a
                    href={selected.docsUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="shrink-0 rounded-lg bg-slate-500/10 px-3 py-2 text-[11px] text-slate-300 ring-1 ring-inset ring-slate-500/25 hover:bg-slate-500/20"
                  >
                    Vendor docs
                  </a>
                ) : null}
              </div>
              <p className="mt-1.5 text-[11px] leading-relaxed text-slate-500">
                Stored in the local SQLite database as plaintext, and never returned by any API or
                rendered on any page. Fine for a single-operator install on your own machine; for a
                shared deployment use the environment variable instead.
              </p>
            </div>

            {/* Contract details - preset, but editable for custom vendors */}
            <details open={selected.id === 'custom'} className="rounded-lg border border-[var(--color-line)]">
              <summary className="cursor-pointer px-3 py-2 text-xs text-slate-400 hover:text-slate-200">
                Request details {selected.verified ? '(prefilled from the verified preset)' : ''}
              </summary>
              <div className="space-y-3 border-t border-[var(--color-line)] px-3 py-3">
                <Field label="Request URL" hint="Use {videoUrl} or {videoId} as the placeholder.">
                  <input
                    disabled={locked}
                    value={urlTemplate}
                    onChange={(event) => setUrlTemplate(event.target.value)}
                    placeholder="https://api.example.com/transcript?url={videoUrl}"
                    className="w-full rounded-md border border-[var(--color-line)] bg-black/25 px-2 py-1.5 font-mono text-[11px] text-slate-300 focus:border-sky-500/50 focus:outline-none disabled:opacity-50"
                  />
                </Field>

                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Auth header">
                    <input
                      disabled={locked}
                      value={authHeader}
                      onChange={(event) => setAuthHeader(event.target.value)}
                      placeholder="x-api-key"
                      className="w-full rounded-md border border-[var(--color-line)] bg-black/25 px-2 py-1.5 font-mono text-[11px] text-slate-300 focus:border-sky-500/50 focus:outline-none disabled:opacity-50"
                    />
                  </Field>

                  <Field
                    label="Time unit"
                    hint="Wrong unit misplaces every clip timecode. The test detects this."
                  >
                    <select
                      disabled={locked}
                      value={timeUnit}
                      onChange={(event) => setTimeUnit(event.target.value as 'ms' | 's')}
                      className="w-full rounded-md border border-[var(--color-line)] bg-black/25 px-2 py-1.5 text-[11px] text-slate-300 focus:border-sky-500/50 focus:outline-none disabled:opacity-50"
                    >
                      <option value="s">seconds</option>
                      <option value="ms">milliseconds</option>
                    </select>
                  </Field>
                </div>

                {selected.asynchronous ? (
                  <Field
                    label="Job poll URL"
                    hint="Long videos are answered with a job id, which is polled to completion - the normal path for full episodes. Leave blank to use the vendor default; it follows the request URL's host automatically if you point that elsewhere."
                  >
                    <input
                      disabled={locked}
                      value={pollUrlTemplate}
                      onChange={(event) => setPollUrlTemplate(event.target.value)}
                      placeholder="https://api.example.com/transcript/{jobId}"
                      className="w-full rounded-md border border-[var(--color-line)] bg-black/25 px-2 py-1.5 font-mono text-[11px] text-slate-300 focus:border-sky-500/50 focus:outline-none disabled:opacity-50"
                    />
                  </Field>
                ) : null}
              </div>
            </details>

            {/* Step 3 - verify */}
            <div>
              <p className="text-[11px] font-medium uppercase tracking-wider text-slate-500">
                3 · Test before saving
              </p>
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <input
                  value={videoId}
                  onChange={(event) => setVideoId(event.target.value)}
                  placeholder="Video ID to test (ideally a real long episode)"
                  className="min-w-0 flex-1 rounded-lg border border-[var(--color-line)] bg-black/25 px-3 py-2 text-xs text-slate-200 placeholder:text-slate-600 focus:border-sky-500/50 focus:outline-none"
                />
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void runTest()}
                  className="shrink-0 rounded-lg bg-slate-500/15 px-3 py-2 text-xs font-medium text-slate-200 ring-1 ring-inset ring-slate-500/30 hover:bg-slate-500/25 disabled:opacity-50"
                >
                  {busy === 'test' ? 'Testing...' : 'Test connection'}
                </button>
              </div>
              <p className="mt-1.5 text-[11px] text-slate-500">
                Test a two-hour episode, not a short clip. Truncation and async handling only show
                up on long videos.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                disabled={locked || busy !== null || !vendorId}
                onClick={() => void save()}
                className="rounded-lg bg-sky-500/20 px-4 py-2 text-sm font-medium text-sky-100 ring-1 ring-inset ring-sky-500/40 hover:bg-sky-500/30 disabled:opacity-50"
              >
                {busy === 'save' ? 'Saving...' : 'Save vendor'}
              </button>

              {status.configured && !locked ? (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void clear()}
                  className="rounded-lg px-3 py-2 text-xs text-slate-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-50"
                >
                  Remove
                </button>
              ) : null}
            </div>
          </div>
        ) : null}

        {message ? (
          <p className="rounded-lg bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300 ring-1 ring-inset ring-emerald-500/20">
            {message}
          </p>
        ) : null}

        {error ? (
          <p className="rounded-lg bg-rose-500/10 px-3 py-2 text-xs text-rose-300 ring-1 ring-inset ring-rose-500/20">
            {error}
          </p>
        ) : null}

        {test ? <TestReport test={test} /> : null}
      </div>
    </Card>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <p className="text-[11px] font-medium text-slate-400">{label}</p>
      <div className="mt-1">{children}</div>
      {hint ? <p className="mt-1 text-[11px] text-slate-600">{hint}</p> : null}
    </div>
  );
}

function TestReport({ test }: { test: TestResult }) {
  return (
    <div className="rounded-lg border border-[var(--color-line)] bg-black/20 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Pill
          className={
            test.ok
              ? 'bg-emerald-500/10 text-emerald-300 ring-emerald-500/20'
              : 'bg-rose-500/10 text-rose-300 ring-rose-500/20'
          }
        >
          {test.ok ? 'usable' : 'not usable yet'}
        </Pill>
        <span className="numeric text-[11px] text-slate-500">
          {test.videoId} · {(test.elapsedMs / 1000).toFixed(1)}s
          {test.viaJob ? ' · async job' : ''}
          {test.language ? ` · ${test.language}` : ''}
        </span>
      </div>

      {test.reason ? (
        <p className="mt-2 text-xs leading-relaxed text-rose-300/90">{test.reason}</p>
      ) : null}

      {test.stats ? (
        <p className="numeric mt-2 text-[11px] text-slate-400">
          {test.stats.segments} segments · {test.stats.words} words ·{' '}
          {Math.round(test.stats.durationSec)}s span · {test.stats.sentences} sentences ·{' '}
          {test.stats.wordsPerSecond} words/sec
        </p>
      ) : null}

      {test.checks.length > 0 ? (
        <ul className="mt-3 space-y-1.5">
          {test.checks.map((check) => (
            <li key={check.label} className="flex gap-2 text-[11px]">
              <span className={check.pass ? 'text-emerald-400' : 'text-amber-400'}>
                {check.pass ? '✓' : '!'}
              </span>
              <span className="min-w-0">
                <span className="font-medium text-slate-300">{check.label}</span>
                <span className="text-slate-500"> — {check.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {test.preview ? (
        <p className="mt-3 border-t border-[var(--color-line)] pt-2 text-[11px] leading-relaxed text-slate-500">
          {test.preview}
        </p>
      ) : null}
    </div>
  );
}
