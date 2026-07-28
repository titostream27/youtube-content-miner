# Homelab deployment runbook

Everything needed to run this on a self-hosted box, for a single operator.
Written to be executed top to bottom.

**Target shape:** one Docker container, one persistent volume, behind an existing
reverse proxy. No external database server, no queue, no object storage.

---

## 1. Prerequisites

### Host requirements

| Requirement | Minimum | Notes |
|---|---|---|
| CPU | 2 cores | Scoring is I/O-bound, waiting on APIs |
| RAM | 1 GB for the container | A run holds one transcript plus scoring batches in memory. Compose caps it at 1 GB |
| Disk | 3 GB + growth | Image is ~900 MB (measured). Data grows slowly: a 3-hour transcript is ~1 MB, clips are rows |
| Docker | Engine 24+ with Compose v2 | `docker compose version` |
| Outbound HTTPS | required | `googleapis.com`, `youtube.com`, plus whichever AI provider you use |
| Reverse proxy | recommended | Anything that already terminates TLS on your homelab |

**No database server is needed.** Storage is SQLite — a single file on a mounted
volume. Given a single operator and a write pattern of one pipeline run at a
time, this is the correct choice rather than a compromise: no connection
management, no separate container to keep alive, and backups are one command.
Postgres would mean reimplementing `src/lib/db/repositories/` for no gain at this
scale.

### Verified on this image

The runbook below was executed against a real build, not written from intent.
Confirmed working: container start, Basic auth enforcement (401 without
credentials, including on the vendor-key endpoint), `/api/health`, all five pages,
`db:seed` and `npm run pipeline` from inside the container, the backup script
including its integrity check, data surviving a container restart on the volume,
and `yt-dlp` extracting real captions from YouTube from inside the container.

### What is bundled in the image

- Node.js 22 (Debian slim)
- `yt-dlp` — the free transcript path
- `sqlite3` CLI — used by the backup script
- The full dependency tree, because `npm run pipeline` (scheduled discovery)
  needs the TypeScript runner

### Credentials — all optional

The app runs with an empty `.env`. Each key unlocks a capability:

| Variable | Without it | Get one from |
|---|---|---|
| `YOUTUBE_API_KEY` | Discovery serves a synthetic demo catalogue instead of real podcasts | Google Cloud Console → YouTube Data API v3 |
| One AI provider key | Scoring falls back to the deterministic heuristic engine (confidence capped at 82%) | Any of ten providers; see `/settings` |
| Transcript vendor key | Free paths are used instead — see section 4 | Chosen in the app, not here |

**Read this before buying a transcript vendor.** The blocking that makes free
caption extraction unreliable was measured from a datacenter IP. A homelab on a
residential connection is a different situation, and `yt-dlp` may work for you
without paying anything. Test that first (section 4) — it could save the
subscription entirely.

---

## 2. Deploy

```bash
# On the homelab host
git clone https://github.com/titostream27/youtube-content-miner.git /srv/content-miner
cd /srv/content-miner

cp .env.example .env
# Edit .env. Everything is optional; start with YOUTUBE_API_KEY and one AI key.

docker compose up -d --build
docker compose logs -f app        # ctrl-c once you see the ready line
```

Verify:

```bash
curl -s localhost:3000/api/health | head -c 400
```

Expected: `"status":"ok"`, `"database":"connected"`, and a `transcriptProviders`
array showing which providers are ready.

Populate something to look at:

```bash
docker compose exec app npm run db:seed
```

That runs the real pipeline across eight topics. With no keys it uses the demo
catalogue — useful for confirming the whole chain works before spending anything.

---

## 3. Access control

**The application has no login of its own.** Anything that can reach port 3000
can trigger runs that spend your API credits, and can write a transcript vendor
API key. Compose therefore binds to `127.0.0.1:3000`, so only this host can reach
it.

Pick one:

### Option A — private network only (simplest, recommended)

Expose it over Tailscale/WireGuard and never publish it publicly. Nothing else to
configure.

### Option B — reverse proxy with auth

Standard for a homelab already running Caddy, Traefik or nginx. Example for
Caddy:

```caddyfile
miner.aelflab.com {
    basicauth {
        # generate with: docker run --rm caddy caddy hash-password
        operator $2a$14$...hash...
    }
    reverse_proxy 127.0.0.1:3000
}
```

### Option C — application-level Basic auth (defence in depth)

Independent of the proxy, so a misconfigured proxy rule is not the only barrier.
Since `aelflab.com` resolves publicly, this is worth enabling **in addition to**
A or B:

```bash
# in .env
APP_BASIC_AUTH_USER=operator
APP_BASIC_AUTH_PASSWORD=<long random string>
```

Inert unless both are set. `/api/health` stays open so the container healthcheck
keeps working; it exposes only provider names and library counts.

---

## 4. Transcript acquisition — test the free path first

This decides whether you need a paid vendor.

```bash
# Pick a real podcast episode, ideally 1-3 hours long
docker compose exec app npx tsx scripts/diagnose-transcript.ts <videoId>
```

The script reports each provider in order, what it returned, and — critically —
whether a failure was anti-bot enforcement or the captions genuinely not
existing.

**If `ytdlp` succeeds:** you are done. Nothing to buy. Set
`TRANSCRIPT_PROVIDERS=ytdlp,captions` in `.env` to skip the vendor slot entirely.

**If everything reports blocked:** your connection is being treated like a
datacenter. Then either:

- Add a residential proxy: `YTDLP_PROXY=http://user:pass@host:port`
- Or configure a hosted vendor in the app: **AI Agents → Transcript vendor**.
  Choose a vendor, paste its key, and run the connection test — it verifies the
  response is actually usable here (timestamps present, time unit correct,
  punctuation, coverage), not merely that the request succeeded. Test with a long
  episode; truncation and asynchronous handling only appear on those.

Keys entered in the app are stored in the SQLite file as plaintext. For a
single-operator box on your own hardware that is reasonable. `TRANSCRIPT_API_URL`
in `.env` takes precedence and locks the UI, if you prefer that.

### Keeping yt-dlp current

A stale `yt-dlp` is the most common cause of extraction breaking, because YouTube
changes the surface it depends on.

```bash
# quick fix, lost on container recreate
docker compose exec app yt-dlp -U

# durable: bump YTDLP_VERSION in docker-compose.yml, then
docker compose up -d --build
```

---

## 5. Scheduled discovery

The PRD's *continuous discovery* milestone: cron fills the dashboard before you
open it.

```cron
# Topic sweeps, staggered so quota and tokens are spread across the morning
15 6 * * *  cd /srv/content-miner && docker compose exec -T app npm run pipeline -- --topic "artificial intelligence" >> /var/log/content-miner.log 2>&1
45 6 * * *  cd /srv/content-miner && docker compose exec -T app npm run pipeline -- --topic "startup" >> /var/log/content-miner.log 2>&1

# New episodes from tracked channels
15 7 * * *  cd /srv/content-miner && docker compose exec -T app npm run pipeline -- --mode tracked_channels >> /var/log/content-miner.log 2>&1

# Nightly backup
30 3 * * *  cd /srv/content-miner && docker compose exec -T app scripts/backup-db.sh /data/backups >> /var/log/content-miner-backup.log 2>&1
```

Use the CLI rather than `POST /api/runs` for scheduled work. Runs are synchronous
and a long one can exceed the HTTP route's 300-second ceiling; the CLI has no
such limit.

**Spend control.** Each run analyses at most
`MAX_EPISODES_ANALYSED_PER_RUN` (default 4) episodes and scores at most
`MAX_SCORED_SEGMENTS_PER_EPISODE` (default 40) moments. Four cron entries per day
is therefore a bounded, predictable cost. Raise the caps deliberately, not by
adding cron lines.

---

## 6. Backups

```bash
docker compose exec app scripts/backup-db.sh /data/backups
```

Uses `sqlite3 .backup`, not `cp`. The database runs in WAL mode, so a plain copy
can capture a main file whose recent commits are still in the write-ahead log —
restoring to an older state, or failing integrity checks. `.backup` snapshots
consistently while the app is running, so no downtime. The script verifies
integrity, prints the clip and feedback row counts, gzips, and keeps the newest
14.

Copy the archives off the host. `clip_feedback` is the one table you cannot
regenerate: episodes and transcripts can be re-fetched, accumulated editorial
judgement cannot.

Restore:

```bash
docker compose stop app
gunzip -c backups/content-miner-<stamp>.db.gz > /var/lib/docker/volumes/content-miner_content-miner-data/_data/content-miner.db
docker compose start app
```

---

## 7. Operating notes

**Is it using real data?** The header shows a *Demo catalogue* badge whenever
`YOUTUBE_API_KEY` is unset. Check it after any config change — a missing key
degrades to synthetic data rather than failing loudly, which is convenient for
evaluation and misleading in production.

**YouTube quota.** 10,000 units/day by default. A topic search costs 100 units
per expanded query, so a topic run is roughly 300. Archive mining walks the
uploads playlist at 1 unit per 50 videos, which is far cheaper. `/api/health`
reports usage for the current process.

**AI cost.** Route agents by cost profile — a cheap fast model for discovery, a
strong one only for clip scoring:

```bash
AGENT_DISCOVERY_PROVIDER=groq
AGENT_CLIP_SCORING_PROVIDER=anthropic
```

**Re-scoring after a model change.** Old and new scores are not comparable, and a
mixed library makes the threshold tiers meaningless:

```bash
docker compose exec app npm run db:reset   # clears clips, keeps tracked channels
```

**Logs.** `docker compose logs -f app`, capped at 3 × 10 MB. There is no
structured logging or error reporting — for a single-operator deployment,
`docker logs` plus the warnings surfaced in each run report is the whole story.

**Upgrades.**

```bash
cd /srv/content-miner
scripts/backup-db.sh          # first
git pull
docker compose up -d --build
```

Additive schema changes apply automatically on first connection
(`applyColumnMigrations` in `src/lib/db/client.ts`).

---

## 8. Known limits of this deployment

Stated plainly so nothing is a surprise later:

- **Runs are synchronous.** No queue, no progress bar, no resumability. Long runs
  in the browser show only a spinner. Partial progress does survive a failure —
  episodes are persisted as each completes — so a timeout costs the remaining
  episodes, not the finished ones. Use the CLI for anything large.
- **Single writer.** SQLite plus one operator is fine; two concurrent runs are
  not a supported pattern.
- **No login in the app by default.** Section 3 is not optional if the port is
  reachable from anywhere untrusted.
- **Speech-to-text is unimplemented.** Episodes with no caption track at all
  cannot be transcribed. It would not solve blocking either — that needs audio,
  which faces the same enforcement at far greater cost.
- **The scoring model is uncalibrated.** Thresholds come from reasoning, not from
  measurement against human judgement. Before trusting *Publish Immediately*
  blindly, mine 30-50 clips, judge them yourself, and compare. If the
  correlation is weak, the weights in `src/lib/scoring/weights.ts` need tuning —
  and it is much cheaper to learn that now.
