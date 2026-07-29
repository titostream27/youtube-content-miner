# Homelab deployment runbook

Everything needed to run this on a self-hosted box, for a single operator.
Written to be executed top to bottom.

**Target shape:** one Docker container on the AelfLab homelab (Windows 11), one
persistent volume, reached through the existing Cloudflare Tunnel. No external
database server, no queue, no object storage.

Integrated into AelfLab Hub as a launcher entry — see section 9.

---

## 1. Prerequisites

### Host requirements

| Requirement | Minimum | Notes |
|---|---|---|
| CPU | 2 cores | Scoring is I/O-bound, waiting on APIs |
| RAM | 1 GB for the container | A run holds one transcript plus scoring batches in memory. Compose caps it at 1 GB |
| Disk | 3 GB + growth | Image is ~900 MB (measured). Data grows slowly: a 3-hour transcript is ~1 MB, clips are rows |
| OS | Windows 11 (the AelfLab host) | Commands below use PowerShell |
| Docker | Docker Desktop with WSL2 backend | `docker compose version` |
| Free port | **8083** | Follows 8081 Hub / 8082 redirect. **Not 3000** — Open WebUI owns it |
| Outbound HTTPS | required | `googleapis.com`, `youtube.com`, plus whichever AI provider you use |
| Cloudflare Tunnel | already running | Route `miner.aelflab.com` → 8083 |

**No database server is needed.** Storage is SQLite — a single file on a mounted
volume. Given a single operator and a write pattern of one pipeline run at a
time, this is the correct choice rather than a compromise: no connection
management, no separate container to keep alive, and backups are one command.
Postgres would mean reimplementing `src/lib/db/repositories/` for no gain at this
scale.

### Verified on this image

The runbook below was executed against a real build, not written from intent.
Confirmed working: container start, the optional Basic auth layer (401 without
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

```powershell
# On the AelfLab host. Kept alongside the other Hermes workspace projects.
git clone https://github.com/titostream27/youtube-content-miner.git D:\homelab\hermes-workspace\content-miner
cd D:\homelab\hermes-workspace\content-miner

Copy-Item .env.example .env
# Edit .env. Everything is optional; start with YOUTUBE_API_KEY and one AI key.

docker compose up -d --build
docker compose logs -f app        # ctrl-c once you see the ready line
```

Verify:

```powershell
curl.exe -s http://127.0.0.1:8083/api/health
```

Expected: `"status":"ok"`, `"database":"connected"`, and a `transcriptProviders`
array showing which providers are ready.

Populate something to look at:

```powershell
docker compose exec app npm run db:seed
```

That runs the real pipeline across eight topics. With no keys it uses the demo
catalogue — useful for confirming the whole chain works before spending anything.

The Hub monitoring row will show `N clips (demo)` once this succeeds. The
`(demo)` suffix disappears when `YOUTUBE_API_KEY` is set.

---

## 3. Access control

The AelfLab convention is Cloudflare Access in front of the tunnel, with no
authentication at the application layer — the same as Hub, finance and pdf. This
follows that.

### Route the hostname

```powershell
& "C:\Program Files (x86)\cloudflared\cloudflared.exe" tunnel route dns <tunnel-id> miner.aelflab.com
```

Add the ingress rule to `C:\Users\Home\.cloudflared\config.yml`:

```yaml
  - hostname: miner.aelflab.com
    service: http://127.0.0.1:8083
```

Then copy the user config to the service config and restart cloudflared, as with
any tunnel change on this host.

### Confirm the Access policy before exposing it

**Do this before the hostname is reachable, not after.** `AGENTS.md` already
records that `finance.aelflab.com` and `pdf.aelflab.com` are used by applications
but were not confirmed to be covered by a tunnel route or an Access policy. The
same gap here is worse, because this app has endpoints that are not merely
readable:

| Endpoint | Consequence if reachable without auth |
|---|---|
| `PUT /api/settings/transcript` | Writes a transcript vendor API key |
| `POST /api/runs` | Spends AI credits and YouTube quota |
| `POST /api/episodes/:id/analyze` | Spends AI credits |

Verify with `cloudflared tunnel route dns` and the Access policy list for
`miner.aelflab.com` specifically.

### Interim layer while Access is unconfirmed

The app ships optional HTTP Basic auth, inert unless both variables are set:

```bash
APP_BASIC_AUTH_USER=operator
APP_BASIC_AUTH_PASSWORD=<long random string>
```

This is **not** the preferred mechanism here and not a replacement for Access —
it exists so that a hostname which turns out to be unprotected does not leave the
vendor-key endpoint open. Leave it off once the Access policy is confirmed, or
keep it as a second layer. `/api/health` stays open either way so the Hub
monitoring probe keeps working; it exposes provider names and library counts, no
secrets.

Compose binds to `127.0.0.1:8083`, so nothing reaches the app except through the
tunnel on this host.

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

The PRD's *continuous discovery* milestone: the dashboard fills itself before you
open it.

This host uses Windows Scheduled Tasks, following the existing `AelfLab_Hub` and
`AelfLab_Redirect` pattern — not cron.

Create `D:\homelab\hermes-workspace\content-miner\run-topic.bat`:

```bat
@echo off
cd /d D:\homelab\hermes-workspace\content-miner
docker compose exec -T app npm run pipeline -- --topic %1 >> D:\homelab\logs\content-miner.log 2>&1
```

Register the tasks:

```powershell
$dir = "D:\homelab\hermes-workspace\content-miner"

# Topic sweeps, staggered so quota and tokens spread across the morning
schtasks /create /tn "AelfLab_Miner_AI"      /tr "$dir\run-topic.bat `"artificial intelligence`"" /sc daily /st 06:15 /f
schtasks /create /tn "AelfLab_Miner_Startup" /tr "$dir\run-topic.bat `"startup`""                 /sc daily /st 06:45 /f

# New episodes from tracked channels
schtasks /create /tn "AelfLab_Miner_Tracked" /tr "cmd /c cd /d $dir && docker compose exec -T app npm run pipeline -- --mode tracked_channels" /sc daily /st 07:15 /f

# Nightly backup
schtasks /create /tn "AelfLab_Miner_Backup"  /tr "cmd /c cd /d $dir && docker compose exec -T app scripts/backup-db.sh /data/backups" /sc daily /st 03:30 /f
```

Use the CLI rather than `POST /api/runs` for scheduled work. Runs are synchronous
and a long one can exceed the HTTP route's 300-second ceiling; the CLI has no such
limit.

**Spend control.** Each run analyses at most `MAX_EPISODES_ANALYSED_PER_RUN`
(default 4) episodes and scores at most `MAX_SCORED_SEGMENTS_PER_EPISODE`
(default 40) moments. Four scheduled runs a day is therefore a bounded,
predictable cost. Raise the caps deliberately rather than by adding tasks.

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

**Is it using real data?** Three signals, in order of how quickly you will notice:

1. The header shows a *Demo catalogue* badge whenever `YOUTUBE_API_KEY` is unset.
2. The Hub monitoring row reads `N clips (demo)`.
3. Clips and episodes show `Demo clip · no video` where the YouTube link would be,
   because fixture ids are not real video ids.

A missing key degrades to synthetic data rather than failing loudly — convenient
for evaluation, misleading afterwards.

### Switching from demo data to real podcasts

Demo rows are not upgraded in place; they stay in the database as synthetic
entries. Clear them and re-run:

```powershell
# 1. Add the key
notepad .env          # YOUTUBE_API_KEY=...
docker compose up -d

# 2. Drop the synthetic catalogue (tracked channels are preserved)
docker compose exec app npm run db:reset

# 3. Mine something real
docker compose exec app npm run pipeline -- --topic "artificial intelligence"
```

Confirm the badge is gone and clips now link to youtube.com.

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


---

## 9. AelfLab Hub integration

The Hub is a launcher and monitoring dashboard, so this app is registered there
rather than absorbed into it. The Hub changes live in the `aelflab-hub` repo.

**Why not mount it inside the Hub's FastAPI process**, the way `finance` and `pdf`
are. Those are Python routers sharing one process and one SQLite file. This is a
Next.js application with its own database and its own runtime; there is no router
to include. Making the Hub reverse-proxy it instead would mean owning asset
paths and streaming behaviour for no benefit, when a tunnel hostname already does
that correctly.

What the integration consists of:

| Piece | Where |
|---|---|
| Launcher tile → `miner.aelflab.com` | `index.html`, `apps` array |
| Monitoring row showing clip count | `index.html`, `renderMonitor` |
| Health probe → `GET 127.0.0.1:8083/api/health` | `backend/main.py`, `miner_health()` |
| `/miner` → 307 redirect to the subdomain | `backend/main.py` |
| Address override | `MINER_URL` env var on the Hub |

The probe reports `N clips`, appends `(demo)` when `YOUTUBE_API_KEY` is unset, and
returns `Offline` on any failure. It cannot raise: a stopped container must not
break the Hub's `/api/status`, which the whole dashboard depends on.

`(demo)` in the Hub is the fastest way to catch the most likely misconfiguration —
a missing YouTube key degrades to a synthetic catalogue rather than failing, which
is convenient during evaluation and misleading afterwards.
