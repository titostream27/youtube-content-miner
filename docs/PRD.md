# AI Podcast Producer Assistant — PRD v1

> Source product requirements document. Kept in the repository so implementation
> decisions can be traced back to intent. Where the implementation deviates or
> extends beyond this document, the reason is recorded inline under
> **Implementation note**.

---

## Vision

Build an AI that acts as a **Senior Podcast Content Producer**.

The AI does not edit video. The AI does not replace the editor. The AI helps the
editor find the best moments across thousands of hours of podcasts in minutes.

**Mission:** turn every podcast into weeks of high-performing short-form content.

---

## Core problem

The editor's workflow today:

```
podcast
  ↓
watch 1–3 hours
  ↓
hunt for interesting parts
  ↓
note timestamps
  ↓
only then start editing
```

90% of the time is spent purely on *finding* moments. This product removes that
process.

---

## Positioning

**Not:**

- an AI clipper
- a video editor
- a subtitle generator

**But:** an AI Podcast Producer Assistant — an AI Podcast Content Intelligence
Platform. The product supports decision-making.

---

## Target market

**Primary:** podcast creators (US).

**Secondary:** podcast agencies, media companies, content repurposing agencies,
marketing agencies.

---

## MVP goal

The user only enters a topic. Examples: AI, Startup, Marketing, Finance,
Business, Psychology, Health.

The AI then performs the entire workflow automatically.

---

## Complete workflow

```
user
  ↓
input topic
  ↓
AI search engine
  ↓
episode ranking
  ↓
transcript extraction
  ↓
moment detection
  ↓
clip scoring
  ↓
threshold filtering
  ↓
export
```

---

## Step 1 — AI podcast discovery

The user does not supply a YouTube URL. The user types a topic such as
"Artificial Intelligence" or "Startup", and the AI finds relevant podcasts.

Example output columns: Episode · Channel · Duration · Views · Published ·
Episode Opportunity Score.

> **Implementation note.** A raw topic is a poor YouTube query — it returns
> explainer channels and news clips rather than long-form interviews. A
> Discovery Agent expands the topic into the queries a professional researcher
> would run. Because each expanded query costs 100 units of YouTube quota, the
> count is capped hard and a deterministic fallback expansion exists.

---

## Step 2 — Episode Opportunity Score

Computed *before* any transcript is processed. Determines whether an episode is
worth analysing at all.

Parameters:

- topic relevance
- video duration
- engagement
- view velocity
- upload date
- channel quality
- discussion density
- expected clip density

Output: a score from 0–100. Episodes below the threshold are not analysed. This
saves AI cost.

> **Implementation note.** The eight parameters are normalised to 0–100 and
> combined with explicit weights (`src/lib/scoring/weights.ts`). Topic relevance
> carries the most weight because analysing an off-topic episode is pure wasted
> spend; upload recency is weighted lightly so archive mining (Mode C) can still
> surface a strong three-year-old episode.
>
> An optional Episode Triage Agent adds a semantic judgement — metadata
> heuristics cannot tell that an episode titled "The Bottleneck Moved" is about
> AI. That judgement is *blended* into the deterministic factors at 45%, never
> substituted for them, so a hallucinated 95 cannot promote a junk episode on its
> own and a provider outage cannot stop the pipeline.

---

## Step 3 — Transcript extraction

The AI retrieves the transcript. If a transcript is available, use it. If not,
generate one using speech-to-text.

> **Implementation note.** Resolution order, cheapest first: local cache →
> caption track → speech-to-text. Transcription is the most expensive step, so
> each video is transcribed at most once, ever.
>
> The speech-to-text fallback is currently a typed seam rather than a working
> implementation: it requires audio extraction and segmentation under provider
> upload limits, running outside the request cycle. It reports precisely why it
> cannot proceed. See `src/lib/transcript/stt.ts`.

---

## Step 4 — Moment detection

The transcript is split into many segments, for example 15–90 seconds. Every
segment is analysed.

> **Implementation note.** Caption cues are the wrong unit — they are 3–8 word
> fragments cut on display timing, so cutting on a cue boundary produces clips
> that start mid-sentence. Cues are first rebuilt into sentences (with fallbacks
> for unpunctuated ASR tracks), then a sliding window enumerates every 15–90s
> candidate and a greedy pass keeps the best non-overlapping set.
>
> A cheap lexical salience score decides which candidates are worth spending a
> model call on. Sponsor reads carry the heaviest penalty: they are fluent,
> confident, and full of concrete numbers, so nothing else catches them.

---

## Step 5 — Clip scoring

Every segment receives a score. Parameters:

Hook · Curiosity · Emotion · Storytelling · Standalone · Shareability ·
Clarity · Controversy · Teaching Value · Entertainment

Output: a final score from 0–100.

> **Implementation note — the most significant design decision in the project.**
>
> These ten dimensions are *not* combined with a flat weighted average. A flat
> average makes every dimension a requirement: a masterclass on compound interest
> is penalised for not being controversial, and a devastating personal story is
> penalised for having no teaching value. Under that model almost nothing clears
> 80, the Step 7 tiers collapse into a single bucket, and the product stops
> making decisions.
>
> Short-form clips do not win by being adequate at ten things. They win by being
> exceptional at one or two while not failing at the few things that are
> mandatory. So the dimensions are split:
>
> - **Gates** (prerequisites): `standalone`, `clarity`, `hook`
> - **Drivers** (what makes a clip travel): the other seven, plus `hook` again
>
> ```
> score = 0.55 × mean(2 strongest drivers)
>       + 0.45 × weighted(standalone 0.4, clarity 0.3, hook 0.3)
> ```
>
> followed by a duration multiplier reflecting the short-form retention curve,
> and hard quality caps. `hook` appears in both sets deliberately: it is a
> prerequisite (no hook, no views) and also enough to carry a clip on its own.

---

## Step 6 — Confidence

In addition to a score, the AI provides a confidence value. For example:
score 96, confidence 93%. Higher confidence means the AI is more certain.

> **Implementation note.** Score and confidence answer different questions —
> "how good is this clip?" versus "how much should you trust that score?".
> Confidence is derived from evidence quality (transcript reliability, speech
> density, engine self-certainty, signal coherence, proximity to a tier
> boundary), never from the score itself.
>
> The deterministic heuristic engine is capped at 82% confidence. It detects the
> *shape* of a good moment through lexical patterns; it does not understand
> meaning. Capping it keeps "high confidence" honest.

---

## Step 7 — Threshold

The product does not use a fixed clip count. It uses thresholds.

| Score | Tier |
|---|---|
| 95+ | Publish Immediately |
| 90–94 | High Priority |
| 85–89 | Good Candidate |
| 80–84 | Optional |
| <80 | Archive |

> **Implementation note.** Output volume tracks source quality. A three-hour
> episode may yield 14 great moments; another may yield zero. Archive-tier clips
> are still persisted — they are the training dataset described under
> *Long-term moat* — but they never reach the editor.

---

## Step 8 — Clip metadata

Every clip produces: Title · Start Time · End Time · Duration · Score ·
Confidence · Category · Why This Works · Suggested Hook · Suggested Caption ·
Editing Notes.

> **Implementation note.** Scoring and copywriting are different skills and want
> different settings — scoring wants a low temperature and a sceptical frame,
> copywriting wants a higher temperature and a creative one. They are separate
> agents. Metadata refinement runs only on clips that already cleared the
> threshold, so no tokens are spent writing captions for clips nobody will cut.

---

## Step 9 — Categories

Business · Finance · Marketing · Startup · Motivation · Funny · Story ·
Psychology · Mindset · Leadership · Health · Productivity · Controversial ·
Educational · News · Inspirational

---

## Step 10 — AI explanation

The AI must explain why a clip was selected. For example: Strong Hook ·
Unexpected Statement · High Emotion · Clear Ending · Good Standalone Clip.

> **Implementation note.** Explanations include *negative* tags. When a quality
> cap limits a clip's score, the reason is surfaced — "Needs surrounding context
> to make sense". "Why is this an 87 and not a 95" is the question an editor
> actually asks, and it is more actionable than the number.

---

## Export

**MVP:** CSV, TXT.

**Future:** EDL, XML, FCPXML, Premiere markers, DaVinci markers.

> **Implementation note.** Both formats carry absolute timecodes, a deep link to
> the exact second, and the reasoning behind each pick. Export accepts the same
> filters as the clip list, so a download always matches what was on screen.
> `formatSmpteTimecode()` already produces the frame-accurate timecodes the NLE
> formats will need.

---

## Discovery modes

**Mode A — Search by topic.** Input: "Artificial Intelligence". Output: podcasts
from many channels.

**Mode B — Track channels.** Input: a list of channels. The AI monitors them for
new episodes.

**Mode C — Archive mining.** Input: one channel. Output: the best clips from its
entire catalogue.

> **Implementation note.** Mode C walks the uploads playlist rather than paging
> search results — 1 quota unit per 50 videos instead of 100 per page.

---

## Future — continuous discovery

Every day the AI finds new podcasts, analyses them, and finds new clips. The user
simply opens the dashboard.

> **Implementation note.** `scripts/run-pipeline.ts` is the entry point. Point
> cron at it.

---

## AI dashboard

Today:

| Metric | Example |
|---|---|
| Podcasts found | 52 |
| Episodes analysed | 18 |
| Potential clips | 127 |
| High priority | 34 |
| Publish immediately | 11 |

---

## Long-term AI learning

If the user connects analytics, the AI learns from views, retention, CTR,
shares, comments, and likes. The model gets smarter.

> **Implementation note.** The `clip_performance` table is already schemad for
> these fields.

---

## Long-term moat

The moat does not come from the LLM. It comes from the clip dataset, creator
feedback, analytics, the ranking model, and the scoring model. More data means
more accuracy.

> **Implementation note.** `clip_feedback` records every editor verdict from day
> one, via `PATCH /api/clips/:id`. That accumulating labelled dataset — not the
> base model — is what a future re-ranker learns from.

---

## Success metric

Not the number of clips. **High-confidence clips that are genuinely published.**

Target: the creator opens the dashboard, sees 11 under *Publish Immediately*, and
sends all of them straight to the editor.

---

## Product principles

1. The AI finds podcasts automatically.
2. The AI selects the best episodes.
3. The AI selects the best moments.
4. The AI explains its reasoning.
5. The AI prioritises quality.
6. The editor keeps using their favourite software.
7. The product focuses on intelligence, not editing.

---

## Future vision

The AI Podcast Producer Assistant grows into a **Podcast Intelligence Platform**
capable of finding new podcasts, spotting rising topics, finding the best
moments, assigning priority, and helping editors produce content at scale.

Ultimate goal: a system that turns thousands of hours of podcasts into thousands
of high-quality short-form pieces automatically, so the content team focuses only
on editing and publishing.
