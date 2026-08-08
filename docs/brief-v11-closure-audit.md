# Brief v11 Closure — Audit Note

**Tanggal:** 2026-08-08
**Misi:** pulihkan CI kedua repo, tutup G1/G2/G3, cross-repo E2E, dokumentasi jujur.

## 1. Baseline sebelum edit (Phase A)

| Repo | Branch | HEAD | git status | CI saat audit |
|------|--------|------|-----------|---------------|
| youtube-content-miner | main | `86af5ad` | clean | merah (ESLint 31 errors) |
| AI-Youtube-Shorts-Generator | main | `1a04a5e` | clean | merah (pytest collection) |

Repositori TIDAK berubah material dari asumsi review-time brief — HEAD sesuai
commit completion v11 (`1a04a5e` renderer, `86af5ad` miner).

## 2. Reproduksi & root cause

### Renderer (Phase C)
Command: `python -m pytest -q` di venv CI-parity (hanya `pip install -r requirements.txt`).

Reproduksi:
1. `No module named pytest` — requirements.txt tidak memuat pytest; CI runner
   tidak punya built-in. **Ini bukan root cause final** (workflow mungkin dulu
   pakai cache), tapi menunjukkan env CI sparse.
2. Setelah install pytest: `ModuleNotFoundError: No module named 'numpy'` —
   `shorts_generator/local/clipper.py:485` import numpy di module load, tapi
   requirements.txt tidak mencantumkan numpy.
   - Commit `e72d107` (reaction-gated split) menambah `import numpy as np`
     tanpa menambah dependency. **Root cause utama CI renderer.**
3. Setelah numpy: `test_visual_regression.py:21 import cv2` — module-level
   import opencv, hanya tersedia via requirements-local (bukan CI).

### Miner (Phase B)
Command: `npm ci && npx tsc --noEmit && npx vitest run && npx eslint . --max-warnings 0`.

Reproduksi:
- `npx tsc --noEmit` — 0 error.
- `npx vitest run` — 249 passed.
- `npx eslint . --max-warnings 0` — **32 problems (31 errors, 1 warning)**.

Error lint (10 file):
- `two-pass.ts` — import `startBoundaryNeedsReject`/`expandStartBackToComplete`
  redundan (dipakai finalize-candidate, bukan two-pass); 6 param fungsi
  `finalRangeValidationFor` tak terpakai; `startCheck`/`duration` dead vars;
  `finalEnd`/`finalStart` prefer-const.
- `contract.test.ts` — 11× `as any[]` → helper `firstClip()`.
- `utterances.ts` — `timedTotal` dead var.
- `trending-topic-agent.ts` — `phrase` destructure tak terpakai.
- `golden-pipeline.test.ts` — `mkdirSync` unused import.
- `hardening-v6.test.ts` — `proposedStart` dead var.
- `scheduled-process.ts` — `renderBase` dead var.
- `end-to-end-handshake.test.ts` — `exists` function tak terpakai.
- `lookahead-v9.test.ts` — `beforeEach` unused import.
- `metrics.ts` — unused eslint-disable directive.

## 3. Fix yang diterapkan

### Renderer
- `requirements.txt`: + `numpy>=1.26` (produksi dep, clipper module-load).
- `test_visual_regression.py`: skip guard `HAS_CV2` (konsisten pattern
  `test_api_v8.py` HAS_CLIENT; test tetap jalan di env dengan opencv).
- `test_hardening_sprint.py::test_retry_accepts_failed_and_partial_failure`:
  mock `_enqueue_job` agar worker tidak memicu download di CI (test hanya
  menguji allocator/lineage, bukan worker).

### Miner
- `two-pass.ts`: hapus import redundan, 6 param `finalRangeValidationFor`,
  `startCheck`, `duration`; `finalEnd`/`finalStart` → const.
- `contract.test.ts`: helper `firstClip()` menggantikan 11× `as any[]`.
- 8 file lain: hapus dead vars/import/function sesuai semantik (bukan
  suppression).

## 4. Hasil acceptance (lokal, CI-parity)

| Repo | Command | Result |
|------|---------|--------|
| miner | npx tsc --noEmit | 0 error |
| miner | npx vitest run | 249 passed |
| miner | npx eslint . --max-warnings 0 | 0 errors / 0 warnings |
| renderer | python -m pytest -q (CI-parity venv) | 201 passed, 4 skipped, 28 subtests, exit 0 |

## 5. Catatan perbedaan vs asumsi review-time

- Review-time brief menyebut lint errors di `two-pass.ts`, `hardening-v6`,
  `trending-topic-agent`, `golden-pipeline` — diverifikasi ada, PLUS error
  tambahan di 6 file lain (metrics, utterances, scheduled-process,
  contract.test, end-to-end-handshake, lookahead-v9) yang belum tercatat
  di brief. Semua diperbaiki.
- Renderer root cause (numpy) tidak terlihat dari traceback publik CI —
  direproduksi di venv CI-parity.
- `npm ci` di Windows sempat korup (typescript hilang) — diatasi dengan
  `npm ci` ulang bersih; bukan kode defect.
