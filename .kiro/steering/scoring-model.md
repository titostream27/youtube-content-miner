# Scoring model conventions

Rules that keep the two scoring models coherent. Breaking any of these silently
degrades the product rather than failing loudly, so they are written down.

## Thresholds are absolute

The Step 7 tiers (95+ / 90–94 / 85–89 / 80–84 / <80) mean the same thing
regardless of which engine produced the score. Any new scoring engine must be
calibrated onto that same 0–100 scale — filler in the 20s–40s, a well-shaped
moment in the 80s. Do not "fix" a low-scoring engine by lowering thresholds.

## Engines produce dimensions, never final scores

An engine (LLM or heuristic) returns the ten dimension scores plus copy. The
final score, the tier, and the confidence are always computed by
`src/lib/scoring/`. This is why swapping models cannot silently redefine
"Publish Immediately".

## The clip score is not a weighted average

It is `0.55 × mean(top 2 drivers) + 0.45 × weighted(gates)`, then a duration
multiplier, then hard quality caps. See the long comment in
`src/lib/scoring/weights.ts` before changing any of it. A flat average collapses
the tiers — that was tried and it does not work.

## Weights must sum to 1

`weights.ts` asserts this at import time. Keep the assertion.

## Confidence is derived from evidence, not from the score

The one permitted exception is proximity to a tier boundary. If you add a
confidence component, it must describe evidence quality.

## The heuristic engine must stay honest

Its confidence ceiling (82) is a product decision, not a bug. It recognises the
*shape* of a good moment through lexical patterns; it does not understand
meaning. Do not raise the ceiling to make demo numbers look better.

## Every agent must degrade, never fail

If a provider errors, times out, or returns malformed JSON, those segments fall
through to the heuristic engine and the run continues with a warning. No agent is
allowed to abort a run. `clip_scoring` is the only role marked non-optional and
even it has a fallback.

## Cost gates are load-bearing

The Episode Opportunity Score gate, the per-run analysis cap, the per-episode
segment cap, and the transcript cache exist to keep runs affordable. Do not
bypass them for convenience — expose an explicit override instead, as
`POST /api/episodes/:videoId/analyze` does.

## SQL lives only in repositories

All SQL belongs in `src/lib/db/repositories/`. Pages, routes and pipeline code
call repository functions. This is what keeps a future Postgres migration to one
folder.

## Never downgrade a completed analysis

An episode is routinely rediscovered by a later run on an unrelated topic where
it legitimately fails the relevance gate. It still has clips in the library.
`markEpisodeSkipped` guards against this; keep that guard.


## Transcript acquisition invariants

**Never claim a transcript source we cannot verify.** The confidence model rates
human-authored captions well above ASR, so mislabelling the source silently
inflates confidence. The yt-dlp provider makes two passes (manual, then auto)
specifically because yt-dlp writes both to identically named files. Do not
collapse it into one pass to save a subprocess spawn.

**A failure reason must distinguish enforcement from absence.** "This video has
no captions" and "we were blocked" need completely different fixes. Every
provider returns `blocked: boolean` alongside its reason, and the zero-byte
HTTP 200 that YouTube returns for a refused caption request must never be
reported as malformed JSON.

**Speech-to-text is not a workaround for blocking.** It needs the audio, which
faces the same anti-bot layer at roughly a hundred times the cost. If STT is
implemented, it is for fidelity - speaker diarization - not availability. Choose
a provider that offers diarization; a plain Whisper endpoint buys nothing the
caption track was not already giving.

**Licence is not decoration.** `episodes.license` comes from the Data API and
drives a real operational decision when mining channels the user does not own.
Keep it surfaced next to the score, keep it in exports, and do not default it to
anything optimistic - unknown means unknown.

## Schema changes

`SCHEMA_SQL` uses `CREATE TABLE IF NOT EXISTS`, so adding a column there only
affects fresh installs. Every new column also needs an entry in
`applyColumnMigrations` in `db/client.ts`. That function is additive only -
anything that rewrites or drops data belongs in a real versioned migration.
