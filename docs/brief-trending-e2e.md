# Master Brief — Trending Discovery + E2E Terjadwal (content-miner)

**Tujuan:** content-miner sekarang menemukan episode hanya dari topik yang diketik manual (`--topic`). Brief ini membuatnya **menemukan sendiri topik dari YouTube Trending harian**, lalu menjalankan E2E **terjadwal** dari discovery → analisis → render → QC → **approval user** → publish.

**Dua tahap:**
- **Tahap 1 — Bangun Code** (dikerjakan subagent Claude Opus 5): tranding discovery + mode `trending` + scheduler + approval gate.
- **Tahap 2 — Operasi Harian** (cron Hermes): jalankan scheduler, kirim ringkasan, minta approval, publish.

---

## A. Konteks Codebase (hasil audit — sudah diverifikasi)

**Root:** `D:\homelab\hermes-workspace\content-miner` (Next.js 16 / TS strict / SQLite better-sqlite3 / Zod)

**Pipeline yang SUDAH ada & berfungsi:**
| Modul | Peran |
|---|---|
| `src/lib/youtube/client.ts` | Client YouTube API v3, metered. `QUOTA_COST`, `request(endpoint,...)`. Endpoint: `search`(100), `videos`(1), `channels`(1), `playlistItems`(1), `captions`(50) |
| `src/lib/youtube/discovery.ts` | Mode A `discoverByTopic`, B `discoverFromChannels`, C `mineChannelArchive` → `EpisodeCandidate[]` |
| `src/lib/ai/agents/discovery-agent.ts` | `planDiscovery(topic)` → `searchQueries[]` (LLM, Query expansion) |
| `src/lib/pipeline/orchestrator.ts` | `runPipeline(options)` → full workflow discovery→ranking→analisis→clip→completeRun |
| `src/lib/pipeline/auto-process.ts` | `autoProcessRun(runId)` → render (8084) → SEO → **publish (8085)** otomatis, fire-and-forget dari `POST /api/runs` (`autoProcess:true`) |
| `scripts/run-pipeline.ts` | CLI entry: `npm run pipeline -- --topic X` / `--mode tracked_channels` / `--mode archive` |
| `src/app/api/clips/[id]/publish/route.ts` | Publish gate lengkap: render done, QC passed, boundary refined, ending complete, rights approved, SEO ada `seoTitle` |
| `src/app/api/clips/[id]/schedule/route.ts` | Jadwalkan publish, butuh rights+QC+render done |

**Config (`src/lib/config.ts`) — env penting:**
- `AI_PROVIDER=deepseek` (default), node-agent juga bisa deepseek
- `RENDER_SERVICE_URL=http://host.docker.internal:8084` (yg dipakai server-side)
- `POSTER_SERVICE_URL=<kosong>` → default `http://host.docker.internal:8085` (pakai default, jangan ubah)
- `PUBLISH_PRIVACY=public`
- `YOUTUBE_API_KEY` SET, `DEMO_MODE=false` → **live mode aktif** ✅
- Playwright/YT: `YT_CLIENT_ID/YT_CLIENT_SECRET/YT_REFRESH_TOKEN` ada (upload OAuth)

**Skema DB (`src/lib/db/schema.ts`):** tabel `runs`, `episodes`, `clips`, `channels`, dll. Clip punya kolom `render_status`, `qc_status`, `boundary_status`, `rights_status`, `publish_status`, `seo_title`.

**Render service:** FastAPI port **8084** (`/api/render/async`, `/api/render/status/:id`, file di `/files/...`).
**Poster service:** FastAPI port **8085** (`/api/publish`) — upload YouTube via OAuth.

---

## B. Tahap 1 — Bangun Code

### B1. Trending discovery — `src/lib/youtube/client.ts`

Tambahkan fungsi **`listTrendingVideos`** memakai `videos.list?chart=mostPopular`:

```ts
export async function listTrendingVideos(params: {
  regionCode?: string;      // default 'ID' (atau 'US'). Buat satu fungsi, region bisa dipilih.
  videoCategoryId?: string; // opsional; tanpa ini YouTube balikin tren semua kategori
  maxResults?: number;      // default 25, cap 50
}): Promise<VideoItem[]>
```

- **Quota:** `videos.list` = **1 unit/call** (super murah vs `search` 100). Tidak perlu tambah di `QUOTA_COST` (key `videos` sudah ada).
- Pakai `part: 'snippet,contentDetails,statistics,status'` — reuse `request()` yang sudah ada.
- Catatan: **`videoDuration` TIDAK tersedia** di `videos.list` (hanya di `search`). Maka trending akan berisi video pendek/shorts juga. Filter durasi > `SEGMENT_MIN_SEC` di downstream atau biarkan scoring menyingkirkannya.

### B2. Ekstrak topik dari trending — `src/lib/ai/agents/trending-topic-agent.ts` (BARU)

Dari `VideoItem[]` trending, hasilkan **topik discovery** (1–3 topik) yang layak jadi input `--topic`.

Dua mode:
- **LLM** (`planTrendingTopics(videos)`): kirim list judul/deskripsi/kategori → return `{ topics: string[], rationale }` via `runJsonAgent` (ikuti pola `discovery-agent.ts`). Recap topik agar tidak duplicate.
- **Heuristic fallback**: cluster judul via token overlap + frekuensi, ambil top N (misal 3).

Reuse `isAgentActive('trending_topic', overrides)` + `runJsonAgent`. Tambah role `trending_topic` ke `src/lib/ai/agents/roles.ts` (ikuti pola role lain — name, label, purpose, providerEnv, modelEnv, temperature, maxOutputTokens). Default model ikut AI_PROVIDER (deepseek).

### B3. Mode `trending` — `src/lib/youtube/discovery.ts` + `src/lib/pipeline/orchestrator.ts`

1. `discovery.ts`: tambah **`discoverFromTrending({ regionCode?, maxResults? })`** → ambil `listTrendingVideos` → hydrate detail channel (pakai `hydrateVideos` / `listChannels`) → kembalikan `DiscoveryOutcome`. Filter: drop video durasi < 60 detik (Shorts) dan non-embeddable.
2. `orchestrator.ts` `runDiscovery()`: tambah cabang `mode === 'trending'`:
   - Panggil `planTrendingTopics(videos)` → pilih 1 topik terbaik (dengan rationale).
   - Untuk topik = `topic` baru, jalankan **Mode A** (`discovery-agent` → `searchVideos`) seperti sekarang.
   - Atau langsung pakai trending episode sebagai candidate. **Keputusan desain:** lebih baik pakai trending sebagai *seed topik*, lalu discovery normal (Mode A) untuk dapat long-form interviews. Karena trending asli sering bukan podcast. Tulis rationale di goal subagent.
   - Simpan `topic` hasil ekstraksi di `createRun({ mode:'trending', topic })`.
3. `domain/types.ts`: `DiscoveryMode` tambah `'trending'` (cek tipe union-nya dan patchnya di semua tempat yang switch mode, termasuk `run-pipeline.ts`, UI pages, `scripts`).
4. `scripts/run-pipeline.ts`: tambah parse `--mode trending` (tanpa wajib `--topic`).

### B4. Scheduler E2E baru — `scripts/scheduled-run.ts` (BARU)

Entry point untuk cron. Alur:

```
1. listTrendingVideos(regionCode='ID')
2. planTrendingTopics → pilih topik terbaik
3. runPipeline({ mode:'trending', force:false })   // full discovery→analisis→clip
4. autoProcessScheduled(runId)                     // render+SEO+QC TANPA publish otomatis
5. Output: JSON summary { runId, topic, clipsReadyForApproval[], clipsBlocked[], aiUsage }
```

Cetak summary ke stdout (Hermes cron `no_agent` mode baca ini) **dan** tulis ke file `data/scheduled-<runId>.json`.

### B5. Approval gate — `src/lib/pipeline/scheduled-process.ts` (BARU)

**Jangan ubah behavior `autoProcessRun` bawaan** (dipake UI). Buat versi khusus:

**`autoProcessScheduled(runId)`** — copy path dari `auto-process.ts` tapi:
- Lakukan render + SEO + poll QC **persis sama**.
- **HENTIKAN sebelum publish.** Update clip ke state baru `publish_status='awaiting_approval'`.
- Clip yang lolos semua gate (render done, QC passed, boundary refined, rights approved, SEO ada) → daftar `ready`.
- Clip yang render/QC gagal → jangan publish, catat error.

### B6. Approval → publish — endpoint action baru

Tambah **`POST /api/clips/:id/approve-publish`** (route baru, pola `publish/route.ts`):
- Set `publish_status='approve_requested'` sementara (anti double-publish).
- Panggil poster service publish (sama seperti `publish/route.ts`).
- Atau lebih simpel: **reuse `POST /api/clips/:id/publish`** yang sudah ada — dia sudah punya SEMUA gate + poster call. Brief tahap 2 tinggal panggil endpoint ini setelah user approve. **Rekomendasi: reuse endpoint publish, JANGAN bikin route baru.** Approval = operator/user memanggil endpoint ini.
- `publish_status='awaiting_approval'` hanya penanda di DB bahwa clip menunggu; tidak ada state-machine baru yang rumit.

### B7. Config env baru (`src/lib/config.ts`)

```ts
trending: {
  regionCode: readString('TRENDING_REGION') ?? 'ID',
  maxVideos: readInt('TRENDING_MAX_VIDEOS', 25),
  maxTopics: readInt('TRENDING_MAX_TOPICS', 3),
  autoApproval: readBool('TRENDING_AUTO_APPROVAL', false), // false=default, wajib approval user
},
```
Tambahkan ke `.env.example` (bukan `.env`).

### B8. Validasi & test (WAJIB)

- `npm run typecheck` → 0 error
- `npm run lint` → 0 error
- `npm run build` → sukses
- Unit test mode trending: mock `listTrendingVideos`, tes heuristic topic extractor. Ikuti pola test `src/lib/moments/__tests__/*.test.ts` (vitest). Tambahkan di direktori test yang sesuai.
- Jangan jalankan pipeline live yang mahal selama build. Cukup pastikan type+lint+build+tests hijau.

> ⚠️ **PENTING:** Buat perubahan minimal & konsisten dengan pola file yang sudah ada. Jangan refactor modul yang tidak terkait. Jangan ubah `auto-process.ts` behavior bawaan. Ikuti struktur file, error handling, dan metering quota yang sudah ada.

---

## C. Tahap 2 — Operasi Harian (cron, dikerjakan Hermes setelah Tahap 1 beres)

Setelah Tahap 1 selesai & SDH di-build, setup cron Hermes harian:

1. **Cron** (mis. `0 8 * * *` WIB, atau waktu pilihan Tito):
   ```bash
   cd D:\homelab\hermes-workspace\content-miner
   node --experimental-strip-types scripts/scheduled-run.ts --mode trending
   ```
   (atau `npm run` versi TSX — pakai cara yang konsisten dengan `run-pipeline.ts`).
2. **Ringkasan ke Telegram:** cron kirim output ringkasan (runId, topik, jumlah clip siap-approval, clip gagal).
3. **Approval:** Tito merespon di Telegram dengan persetujuan → Hermes panggil `POST /api/clips/:id/publish` (endpoint public yang sudah ada, punya semua gate) untuk tiap clip yang disetujui.
4. **Laporan hasil publish** dikirim balik ke Tito (URL video).

> Tahap 2 baru dieksekusi SETELAH Tahap 1 dinyatakan sukses (build hijau). Brief ini harus dipecah: jalankan Tahap 1 dulu, verifikasi, baru setup cron Tahap 2.

---

## D. Gate & Keselamatan (kenapa approval-nya step ini)

- YouTube publish **permanent & publik** → tidak boleh full-auto tanpa review.
- `rights_status`, `QC passed`, `boundary refined` sudah dijamin oleh `publish/route.ts` sebelum upload — approval operator adalah layer terakhir di atas itu.
- `TRENDING_AUTO_APPROVAL=false` (default) menjaga alur selalu lewat review Tito.
- Quota YouTube aman: trending discovery ~1–3 unit/day; discovery normal tetap capped oleh `MAX_EPISODES_PER_RUN` & `MAX_EPISODES_ANALYSED_PER_RUN`.