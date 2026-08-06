# Brief v6 — Verification Audit (before coding)

- Baseline: miner `64c251b`, renderer `fd97342` (pulled & verified via git log).
- Method: every finding verified against actual checked-out code (file:line).

## Verification table

| ID | Area | Verdict | Evidence |
|---|---|---|---|
| V6-R01 | Renderer | **CONFIRMED** | `render_service.py:2072` `downloading→analysing` dan `:2107` `analysing→rendering` return value diabaikan — render lanjut walau CAS gagal. |
| V6-R02 | Renderer | **CONFIRMED** | `render_service.py:2973-2974` worker exception memaksa `_async_jobs[job_id]={"state":"failed"}` TANPA cek apakah transition sukses / terminal lain menang — cancel yang menang bisa ditimpa. |
| V6-R03 | Renderer | **CONFIRMED** | `render_service.py:3190-3196` sync `_persist_terminal_via_transition` return Boolean diabaikan; `:3204` memory completed walau tidak committed. |
| V6-R04 | Renderer | PARTIALLY FIXED | `render_service.py:2527` job-level `rendering→quality_check` transition SEKALI setelah semua clip — tapi QC per-artifact berjalan di dalam `_render`; observasi stage per multi-clip belum diuji (R-QC-01 belum ada). |
| V6-R05 | Renderer | **CONFIRMED** | `_enqueue_job` (2874-2880) cek `not _render_queue_worker_started` saja; worker loop (`:2954`) tidak reset flag saat crash → dead worker tak pernah restart. |
| V6-R06 | Renderer | **CONFIRMED** | `render_service.py:2192-2194` bare path → `timeline=None`; `:2203-2204` fallback ke `get_render_stats()` (module global). |
| V6-R07 | Renderer | **CONFIRMED** | `test_visual_behavior.py` konstruksi `RenderTimeline()` + `frames.append` langsung — tidak exercise planner decision (V-PLN-01..08 belum). |
| V6-M01 | Miner | **CONFIRMED** | `finalize-candidate.ts` komentar klaim "caller re-checks via validateBoundary" — hanya revalidasi start; tidak ada revalidate duration/end/topic/contamination setelah repair. |
| V6-M02 | Miner | **CONFIRMED** | Tidak ada `coverage`/`hybrid` di `utterances.ts` — satu utterance ber-timing membuat seluruh slice word-level → untimed overlapping content hilang. |
| V6-M03 | Miner | **CONFIRMED** | `utterances.ts:337` fallback slicing utterance-level dilabel `'cue'` — harus `'utterance'`. |
| V6-C01 | Contract | PARTIALLY FIXED | Zod `.strict()` 10× + Pydantic `extra="forbid"` v5; namun JSON Schema belum sempurna + belum ada fixture conformance matrix C-PAR-01/02 yang memaksa ketiganya accept/reject identik. |
| V6-C02 | Contract | **CONFIRMED** | `render_contract.py:199-202` `getattr(clip, "hook_end_sec")` membaca CLIP attribute (None) — narrative finite check tidak berfungsi; belum ada narrative in-clip + hook<=payoff. Language default `"en"` bukan `"auto"`. |
| V6-C03 | Contract | **CONFIRMED** | `RenderResponse` (`:342`) `rendered: List[Dict]`, `artifacts: Optional[List[Dict]]` — tidak typed `RenderArtifactResult`. |
| V6-E01 | Evaluator | ALREADY FIXED | `computeAssignmentResult` (v5 commit 12) — positive & hard-negative independent. |
| V6-E02 | Evaluator | ALREADY FIXED | `topKRankAwareRecall` iterate label expected rank (v5 commit 12). |
| V6-E03 | Evaluator | **CONFIRMED** | `boundaryError`, `contaminationError`, `binaryAccuracy`, `evaluateGoldenLegacy` masih public clipId-based — perlu deprecate/private + redirect. |

## Summary
- **CONFIRMED**: 12 (R01,R02,R03,R05,R06,R07,M01,M02,M03,C02,C03,E03) — ALL FIXED in commits 1-13.
- **PARTIALLY FIXED**: 2 (R04 → Option A closed; C01 → parity closed)
- **ALREADY FIXED**: 2 (E01, E02)
- **NOT REPRODUCIBLE**: 0
- Stop condition (>3 NOT REPRODUCIBLE): NOT triggered.

## Final status (v6 commits 1-14)
| ID | Status | Commit |
|---|---|---|
| R01 | FIXED | 2 (8ac9883) |
| R02 | FIXED | 2/3 |
| R03 | FIXED | 2 (8ac9883) |
| R04 | FIXED (Option A) | 4 (ad74ed2) |
| R05 | FIXED | 4 (ad74ed2) |
| R06 | FIXED | 2/5 (d35e012) |
| R07 | FIXED | 11 (121cf90) |
| M01 | FIXED | 7 (22584ce) |
| M02 | FIXED | 8 (150e78e) |
| M03 | FIXED | 8 (150e78e) |
| C01 | FIXED | 9/10 (f168e7f/e4f2b06/4149df1) |
| C02 | FIXED | 10 (4149df1/e4f2b06) |
| C03 | FIXED | 10 (4149df1) |
| E01 | ALREADY FIXED (v5) | — |
| E02 | ALREADY FIXED (v5) | — |
| E03 | FIXED | 12 (cd96695) |

Full report: docs/audits/brief-v6-completion-report.md
