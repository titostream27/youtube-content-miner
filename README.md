# AI Podcast Producer Assistant

Podcast content intelligence. You type a topic; the pipeline finds relevant long-form episodes, decides which are worth paying to analyse, extracts transcripts, scores every candidate moment, and hands back only the ones worth cutting — with timecodes, reasoning, and publish-ready copy.

It does not edit video. It does not replace the editor. It removes the 90% of the workflow that is spent *looking* for moments.

> **Mission:** turn every podcast into weeks of high-performing short-form content.

---

## Why this exists

The editor's current workflow:

```
podcast -> watch 1-3 hours -> hunt for moments -> note timestamps -> start editing
```

Only the last step is craft. This tool deletes the middle three and outputs a ranked shot list.

**This is not** an AI clipper, a video editor, or a subtitle generator. It is a decision-support system: it tells you *which* moments to cut and *why*, then gets out of the way.

---

## Quick start

```bash
npm install
npm run db:seed     # runs the real pipeline across 8 topics to populate the library
npm run dev         # http://localhost:3000
```

**No API keys required.** With an empty `.env`, discovery serves a synthetic demo catalogue and scoring runs on the deterministic heuristic engine. Every stage — opportunity scoring, segmentation, clip scoring, thresholds, export — behaves exactly as it does in production. Clone it, run it, and watch the whole pipeline work before spending anything.

To go live, copy `.env.example` to `.env.local` and add a `YOUTUBE_API_KEY` and any one AI provider key.

---

## The pipeline

```
topic ──► discovery ──► episode ranking ──► [COST GATE] ──► transcript
                                                               │
       export ◄── threshold filter ◄── clip scoring ◄── moment detection
```

| Step | What happens | Where |
|---|---|---|
| 1 | **Discovery.** A topic is expanded into the queries a researcher would actually run. No YouTube URLs needed. | `lib/youtube/discovery.ts`, `lib/ai/agents/discovery-agent.ts` |
| 2 | **Episode Opportunity Score.** 8 weighted factors, computed from metadata *before* any transcript is fetched. Below threshold, an episode is never transcribed. | `lib/scoring/episode-opportunity.ts` |
| 3 | **Transcript extraction.** Cache → configurable provider chain (hosted vendor → yt-dlp → direct scrape → STT). | `lib/transcript/` |
| 4 | **Moment detection.** Cues are rebuilt into sentences, then a sliding window enumerates every 15–90s candidate and keeps the best non-overlapping set. | `lib/moments/segmentation.ts` |
| 5 | **Clip scoring.** 10 dimensions per moment. | `lib/scoring/clip-score.ts` |
| 6 | **Confidence.** Separate from score — how much to trust the number. | `lib/scoring/confidence.ts` |
| 7 | **Threshold filtering.** No fixed clip count. Output volume tracks source quality. | `lib/domain/thresholds.ts` |
| 8–10 | **Metadata + explanation.** Title, hook, caption, editing notes, category, and why it was chosen. | `lib/ai/agents/clip-*.ts` |

### Priority tiers

| Score | Tier | Meaning |
|---|---|---|
| 95+ | Publish Immediately | Send straight to the editor, no review |
| 90–94 | High Priority | Queue in the current batch |
| 85–89 | Good Candidate | Cut when the priority queue is clear |
| 80–84 | Optional | Only if the calendar has gaps |
| <80 | Archive | Retained for model training, never surfaced |

---

## Two design decisions worth reading

### 1. The clip score is not a weighted average

A flat average of ten dimensions makes every dimension a *requirement*. Under that model a masterclass on compound interest gets marked down for not being controversial, and a devastating personal story gets marked down for having no teaching value. Average the ten and almost nothing clears 80 — the tiers collapse into one bucket and the product stops making decisions.

Short-form clips don't win by being adequate at ten things. They win by being exceptional at one or two while not failing at the few things that are mandatory. So:

```
score = 0.55 × mean(2 strongest DRIVER dimensions)
      + 0.45 × weighted(GATES: standalone 0.4, clarity 0.3, hook 0.3)
```

…then a duration multiplier (the short-form retention curve) and hard quality caps. A clip that can't stand alone without the surrounding hour is capped at 87 no matter how brilliant it is, and the cap reason is surfaced to the editor — *"why is this an 87 and not a 95"* is the question they actually ask.

Full reasoning in [`src/lib/scoring/weights.ts`](src/lib/scoring/weights.ts).

### 2. Score and confidence are different questions

- **Score** — how good is this clip?
- **Confidence** — how much should you trust that score?

A 96 at 93% goes to the editor. A 96 at 54% needs someone to watch 30 seconds first. Confidence is derived from *evidence quality* — transcript reliability, speech density, engine self-certainty, signal coherence, distance from a tier boundary — never from the score itself.

The heuristic engine's confidence is **capped at 82%**. It detects the *shape* of a good moment via lexical patterns; it does not understand meaning. Capping it keeps "high confidence" honest.

---

## Transcript acquisition: the hard part

Mining podcasts you do not own means YouTube's anti-bot layer is a first-class engineering constraint, not an edge case. Measured from a datacenter IP:

| Method | Result |
|---|---|
| Direct watch-page scrape → `timedtext` | Track list is visible, but the caption download returns **HTTP 200 with a zero-byte body** — a silent refusal |
| `yt-dlp`, default player clients | Refused: *"a PO token was not provided"* |
| `yt-dlp --extractor-args youtube:player_client=android` | **Works** — real json3 files, correct cue timing. Rate limits appear under load |
| Same, on another video | `Sign in to confirm you're not a bot` |

Two things follow from this.

**First, acquisition has to be configurable.** What works depends on where you deploy — a laptop on a home connection behaves nothing like a cloud host. So it is an ordered chain, set by `TRANSCRIPT_PROVIDERS`:

| Provider | When it makes sense |
|---|---|
| `hosted` | Cloud deployments. A vendor maintains the proxy pool and tracks token changes for a fraction of a cent per video. **Choose the vendor and paste its key in the app** under *AI Agents → Transcript vendor* |
| `ytdlp` | Free, subtitle-only (`--skip-download`, never audio). Reliable at volume with a residential proxy or cookies |
| `captions` | Zero-config fallback. Fine locally, usually refused from a datacenter |
| `stt` | Last resort. See below |

### Choosing a vendor

Vendor setup is in the app, not the env file: pick a vendor, paste the key, and run the connection test. Presets carry the request contract, the time unit, and whether long videos come back asynchronously — the three details that otherwise produce a transcript that looks fine and is quietly unusable.

The connection test is the point. It checks the things that make a vendor unusable *here*, each of which can return HTTP 200 and still be broken:

| Check | Why it matters |
|---|---|
| Per-segment timestamps | Without them there are no clip in/out points at all |
| Time unit | Milliseconds read as seconds misplaces every timecode. Detected from words-per-second, which needs no second API call |
| Punctuation | Segmentation cuts on sentence boundaries; low punctuation weakens every downstream score |
| Segment granularity | One giant blob is unusable; caption-like granularity is ideal |
| Coverage | A vendor that truncates long videos looks like "this episode had few moments" |

Test against a real two-hour episode, not a short clip — truncation and async handling only appear on long videos.

Keys chosen in the app are stored in the local SQLite database as plaintext and are never returned by any API or rendered on any page. That is appropriate for a single-operator install; for a shared deployment set `TRANSCRIPT_API_URL` in the environment, which takes precedence and locks the UI.

Every provider reports *why* it failed and whether the failure was enforcement or genuine absence — because "this video has no captions" and "we were blocked" need completely different fixes. To see the chain run against a real video:

```bash
npx tsx scripts/diagnose-transcript.ts dQw4w9WgXcQ
```

**Second, speech-to-text is not the answer to blocking.** Transcribing needs the audio, and downloading audio faces the same anti-bot layer while costing roughly two orders of magnitude more — dollars per episode instead of fractions of a cent. For a 400-episode archive that is the difference between roughly nothing and several hundred dollars, *and you still need the proxy*.

STT's real value is fidelity, specifically **speaker diarization**, which YouTube's ASR does not provide at all. Knowing whether the host or the guest delivered a line materially improves the `standalone` judgement. If you enable it, pick a provider that offers diarization rather than a plain Whisper endpoint, or the spend buys nothing the caption track was not already giving.

## Reuse rights

When mining channels you do not own, the binding constraint is not technical — it is publishing rights. So the licence is treated as first-class data, pulled from the Data API's `status` part at no extra quota cost and surfaced next to the score:

- **CC BY · reusable** — the owner licensed the video for reuse with attribution
- **Standard licence** — publishing needs the owner's permission, an official clipping programme, or another basis you have established

Clips can be filtered by licence and it is included in every export, because a copyright strike is the largest operational risk a clipping workflow carries. The tool reports the licence; it does not give legal advice, and the publishing decision stays with the operator.

## AI provider architecture

The pipeline is a crew of five specialised agents, not one prompt. Each can run on a different provider and model, because their cost profiles differ by orders of magnitude.

| Agent | Job | Suggested tier |
|---|---|---|
| Discovery | Expand a topic into real search queries | cheap + fast |
| Episode Triage | Judge topical fit and clip density from metadata | cheap |
| Moment Detection | Drop sponsor reads, trim dead lead-in | mid |
| **Clip Scoring** | Score 10 dimensions and explain | **spend here** |
| Clip Metadata | Write publish-ready copy | mid, higher temperature |

Ten providers are supported across three wire protocols — OpenAI, Anthropic, Google Gemini, Groq, OpenRouter, Mistral, DeepSeek, xAI, Together, and Ollama for fully local runs.

```bash
# one key is enough to get started
OPENAI_API_KEY=sk-...

# or split by cost profile
GROQ_API_KEY=gsk_...
ANTHROPIC_API_KEY=sk-ant-...
AGENT_DISCOVERY_PROVIDER=groq
AGENT_CLIP_SCORING_PROVIDER=anthropic
AGENT_CLIP_SCORING_MODEL=claude-sonnet-4-5

# force the deterministic engine for reproducible runs
AI_PROVIDER=heuristic
```

Adding a vendor that speaks an existing protocol is a data change in [`src/lib/ai/providers/catalog.ts`](src/lib/ai/providers/catalog.ts) — no new transport code.

**Every agent degrades rather than fails.** If a provider is down, a batch returns malformed JSON, or no key is set, those segments fall through to the heuristic engine. A partial provider failure costs quality, not an entire archive-mining run.

Visit `/settings` to see which agent is on which model and exactly which environment variable controls it.

---

## Discovery modes

- **Mode A — Topic.** Type "artificial intelligence". The discovery agent expands it, then results are ranked.
- **Mode B — Tracked channels.** A watch list monitored for new episodes. Paste a channel ID, URL, `@handle`, or just the show's name.
- **Mode C — Archive mining.** Point at one channel and mine its entire back catalogue. Walks the uploads playlist at 1 quota unit per 50 videos instead of 100 per search page.

---

## Cost controls

Quota and tokens are the binding constraints, so they are explicit:

| Control | Default | Effect |
|---|---|---|
| `EPISODE_SCORE_THRESHOLD` | 60 | Below this, an episode is never transcribed |
| `MAX_EPISODES_ANALYSED_PER_RUN` | 4 | Spend cap per run, even if 40 episodes qualify |
| `MAX_SCORED_SEGMENTS_PER_EPISODE` | 40 | Only the highest-salience moments reach a model |
| Transcript cache | — | Each video is transcribed at most once, ever |
| Salience pre-filter | — | Sponsor reads and filler are dropped before any paid call |

Every YouTube call is metered; `/api/health` reports quota consumed by the current process.

---

## API

| Route | Purpose |
|---|---|
| `POST /api/runs` | Execute the pipeline. Accepts per-agent provider overrides. |
| `GET /api/runs` | Recent runs |
| `GET /api/clips` | Clip library — filter by tier, category, status, episode, channel, score, confidence |
| `PATCH /api/clips/:id` | Set workflow status and record an editor verdict |
| `GET /api/episodes` | Episode ranking, including what was skipped and why |
| `GET /api/episodes/:videoId` | Episode detail with clips and transcript state |
| `POST /api/episodes/:videoId/analyze` | Re-run steps 3–8 for one episode, bypassing the gate |
| `GET /api/channels/tracked` · `POST` · `DELETE` | Mode B watch list |
| `GET /api/export?format=csv\|txt` | Export using the same filters as `/api/clips` |
| `GET /api/ai/agents` | Provider and agent status (never returns key material) |
| `GET /api/health` | Liveness, database, quota |

Mixed-provider run:

```bash
curl -X POST localhost:3000/api/runs -H 'content-type: application/json' -d '{
  "mode": "topic",
  "topic": "artificial intelligence",
  "agents": {
    "discovery":    { "provider": "groq" },
    "clip_scoring": { "provider": "anthropic", "model": "claude-sonnet-4-5" }
  }
}'
```

---

## Commands

```bash
npm run dev            # dev server
npm run build          # production build
npm run typecheck      # tsc --noEmit
npm run lint           # eslint
npm run db:seed        # populate via real pipeline runs
npm run db:reset       # clear pipeline data, keep tracked channels
npm run pipeline -- --topic "startup"                  # CLI run (Mode A)
npm run pipeline -- --mode tracked_channels            # Mode B
npm run pipeline -- --mode archive --channel <id>      # Mode C
```

`scripts/run-pipeline.ts` is the entry point for the *Continuous Discovery* milestone — point cron at it and the dashboard fills itself every morning.

`scripts/diagnose-transcript.ts <videoId>` shows which transcript providers ran, what each reported, and whether a failure was enforcement or genuine absence.

`scripts/verify-ai-path.ts` exercises all five agents against a local mock provider, so provider transport, JSON recovery, schema validation, per-role routing, and LLM-tier confidence can be verified without spending a cent.

---

## Stack

Next.js 16 (App Router) · React 19 · TypeScript (strict, `noUncheckedIndexedAccess`) · Tailwind v4 · SQLite via `better-sqlite3` · Zod

SQLite fits the workload: a single-writer analysis pipeline with read-heavy dashboards. All SQL is confined to `src/lib/db/repositories/` — moving to Postgres means reimplementing those modules and nothing else.

```
src/
├── app/                  routes + API
├── components/           UI
└── lib/
    ├── domain/           types, 16 categories, threshold tiers
    ├── scoring/          opportunity, clip score, confidence, weights, lexicons
    ├── moments/          sentence rebuilding + window enumeration
    ├── ai/
    │   ├── providers/    10 vendors, 3 protocols
    │   ├── agents/       5 role-specific agents
    │   └── heuristic-engine.ts
    ├── youtube/          Data API client, discovery, captions, demo catalogue
    ├── transcript/       resolution chain + STT seam
    ├── pipeline/         orchestrator + single-episode analysis
    ├── db/               schema + repositories
    └── export/           CSV / TXT
```

---

## Known limitations

- **Speech-to-text is a seam, not an implementation.** Episodes with no caption track cannot be transcribed yet. Doing it properly needs a media pipeline (audio extraction plus segmentation under provider upload limits) running outside the request cycle. The typed entry point exists and reports precisely why it cannot proceed — see [`src/lib/transcript/stt.ts`](src/lib/transcript/stt.ts).
- **Caption extraction uses an internal YouTube endpoint.** The Data API can confirm a caption track exists but only its owner can download it. Failures are treated as normal and fall through to STT.
- **Runs are synchronous.** Fine for a handful of episodes; mining a 400-episode archive needs a job queue.
- **Demo catalogue is synthetic.** The transcripts in `lib/youtube/fixtures.ts` are original text written to span a realistic quality range. It is labelled as demo data everywhere it surfaces.

## Roadmap

Tracked against the PRD's future milestones:

- **Export formats** — EDL, XML, FCPXML, Premiere and DaVinci markers. `formatSmpteTimecode()` already produces the frame-accurate timecodes these need.
- **Continuous discovery** — scheduled runs so the dashboard is populated before the user opens it.
- **Analytics feedback loop** — `clip_performance` is already schemad for views, retention, CTR, shares, likes.
- **Learned re-ranking** — `clip_feedback` accumulates every editor verdict from day one. That dataset, not the base model, is the long-term moat.

---

## Success metric

Not clip count. **High-confidence clips that actually get published.**

The target: the creator opens the dashboard, sees 11 under *Publish Immediately*, and forwards all of them to the editor without watching a single episode.

## Product principles

1. AI finds the podcasts. 2. AI picks the episodes. 3. AI picks the moments. 4. AI explains itself. 5. Quality over volume. 6. The editor keeps their own software. 7. Focus on intelligence, not editing.

Full product requirements: [`docs/PRD.md`](docs/PRD.md).
