# Brief v11 — Completion Report

**Tanggal:** 2026-08-08 | **Model agent LLM:** ds/deepseek-v4-flash (9router 127.0.0.1:20128)

## Verdict

**FEATURE-READY** — semua commit penutup selesai, unit/e2e suite hijau di kedua repo,
dan gate real-media (G1–G3) dieksekusi dengan media YouTube nyata (7 transcript,
3 final MP4 dengan karaoke caption). Bug produksi yang ditemukan oleh gate
diperbaiki dan diregresi.

## Commit matrix

| Commit | Repo | Isi |
|--------|------|-----|
| 0490711 | renderer | C1 RED: endpoint concurrency tests (retry/force/resubmit) |
| eb88a61 | renderer | C2+C3: reserve_attempt single allocator + wiring (retry/force/resubmit) |
| 470f398 | renderer | C4: durable reads fail-closed + sync mirroring |
| 9a35ff4 | renderer | C5: endpoint persistence-winner invariants |
| d521fa2 | miner | C6: repaired lookahead pakai time horizon |
| 5a44473 | miner | C8: hybrid transcript provenance (timingCoverage, excludedOrUncertainText) |
| 7e20e8e | miner | C9+C10: canonical assignment objective cases |
| 7063774 | renderer | C11: live production fault battery |
| d21c6e0 | miner | C12: LLM boundary JSON valid (contextUtterances + maxOutputTokens + schema defaults) |
| abacb2c | renderer | C12: RenderArtifact publishable crash fix |
| f71602b | renderer | C12: canonical QC status mapping |
| fdfe58f | renderer | C12: legacy force compat + test alignment + captioned script |
| 1a04a5e | renderer | C12: real-media evidence doc |

(C2 dan C3 digabung dalam satu commit karena keduanya mengubah file yang sama —
transparan, bukan mengklaim pemisahan yang tidak ada.)

## Temuan brief & verifikasi

| Temuan | Status | Bukti |
|--------|--------|-------|
| F11-01 /retry manual attempt | FIXED | endpoint `/retry` kini via reserve_attempt |
| F11-02 force via _reserve_job | FIXED | force async/sync via reserve_attempt(reason=force) |
| F11-03 resubmit collision | FIXED | allocator satu active attempt per request_id |
| F11-04 speculative winner ID | FIXED | reserve_attempt tidak mengembalikan ID non-persisted |
| F11-05 _load_job swallow | FIXED | fail-closed PersistenceError |
| F11-06 repaired fixed-count lookahead | FIXED | followingWithinLookaheadSec di repaired path |
| F11-07 hybrid partial leakage | FIXED | timingCoverage + excludedOrUncertainText |
| F11-08 sync minimal dict | FIXED | mirror_durable_after_failure dipakai sync path |
| F11-09 matcher objective | VERIFIED | min-cost max-flow lexicographic (v10) + tests v11 |

## Suite final

- Renderer: 205 passed (184 baseline + v11 test baru) — angka final setelah
  commit terakhir diverifikasi pada langkah push.
- Miner: 246 passed + tsc clean.

## Real-media gate (C12)

- G1: 7 dari 10 episode podcast asli ditranskripsikan (en + id; 3 gagal karena
  anti-bot YouTube / tanpa caption — dicatat jujur, bukan digantikan synthetic).
- G2: pipeline produksi (analyzeEpisode) dijalankan; episode Iqbal menghasilkan
  clip dengan LLM boundary (engine=llm), sisanya rejected oleh boundary repair
  pada ASR cue-level (perilaku sah, tanpa injeksi timestamp).
- G3: 3 final 1080x1920 H.264 dengan karaoke caption burned-in dari whisper.

## Keterbatasan (honest)

1. 3 episode gagal transcription: YouTube anti-bot (Sign in to confirm) dan
   no caption track — tidak di-substitusi.
2. Model `deepseek` (combo lama) sering empty completion pada prompt besar
   → role `moment_detection.maxOutputTokens` dinaikkan ke 4000 + context cap
   240 utterances; `.env` DEEPSEEK_MODEL diarahkan ke `ds/deepseek-v4-flash`.
3. Pengubah .env: DEEPSEEK_BASE_URL lawas `host.docker.internal` tidak
   reachable dari host; eval memakai override 127.0.0.1 — ini konfigurasi lokal,
   bukan perubahan kode.
4. Flaky test `test_hardening_sprint.py::TestRetrySourceValidation` (404
   YouTube saat batch) bukan regresi kode — pass standalone.