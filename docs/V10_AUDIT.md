# V10 Audit — Findings Verification

**Audit date:** 2026-08-07
**Baseline SHAs (before edit):**
- miner: `2c969ef863463469af0f23621597ded60ddc53cc`
- renderer: `a8f1045a1eb17f4d8ec069a0025a3b3dc43a275c`

## Findings

| ID | Priority | Verdict | Evidence (file:symbol:line) |
|----|----------|---------|------------------------------|
| V10-M01 | P0 | **VERIFIED** | `src/lib/moments/two-pass.ts:522` semantic path calls `finalizeCandidate(..., finalStart, finalEnd)` with NO `finalValidation`; repaired path at `:444` passes `finalRangeValidationFor(...)`. |
| V10-R01 | P0 | **VERIFIED** | `render_service.py:2780` `final_status = "completed" if ok_count == len(artifacts) else "partial_failure"` — 0/N maps to partial_failure. `_build_render_response:2838` same pattern. |
| V10-R02 | P0 | **VERIFIED** | `render_service.py:718` `_reserve_job` computes next attempt outside a `BEGIN IMMEDIATE` transaction; retry path allocates without durable CAS on attempt number. |
| V10-R03 | P0 | **VERIFIED** | `render_service.py:761` force branch does lookup/insert in separate transactions; concurrent force can race on parent/attempt selection. |
| V10-R04 | P0 | **VERIFIED** | `render_service.py:3151` `get_existing_request_result` iterates `_async_jobs` FIRST to select job identity; durable SQLite only consulted as fallback. |
| V10-R05 | P0 | **VERIFIED** | `render_service.py:663` `_find_job_by_request` catches generic `Exception` and falls back to legacy JSON scan; DB corruption/IO errors misread as "not found". |
| V10-M02 | P0 | **VERIFIED** | `src/lib/moments/utterances.ts:340` treats utterance as timed when `words.length > 0`; partially word-timed utterances can drop untimed words. |
| V10-V01 | P1 | **VERIFIED** | `shorts_generator/local/clipper.py:298-303` `RenderTimeline` built from module globals `_LAST_FACE_TRACKS`/`_RENDER_STATS`/`_FRAME_TIMELINE`. |
| V10-E01 | P1 | **VERIFIED** | `src/lib/golden/metrics.ts:161` augmenting-path matcher orders per-label candidates by descending IoU but does NOT guarantee global max total IoU among same-cardinality matchings. |
| V10-C01 | P1 | **VERIFIED** | `render_contract.py:487` `status: Literal["completed", "partial_failure"]` — failed excluded from typed response. |
| V10-R06 | P1 | **VERIFIED** | `render_service.py:3489` `render_job_cancel` reads memory snapshot for conflict response before durable state. |
| V10-R07 | P1 | **VERIFIED** | `render_contract.py:383` status comment retains legacy vocabulary `analysing_source|rendering_preview|rendering_final`; `render_service.py:196-198` maps legacy names. |
| V10-M03 | P1 | **VERIFIED** | `src/lib/moments/finalize-candidate.ts:91` `finalValidation?: FinalRangeValidation` optional — omission possible by API design. |
| V10-R08 | P1 | **VERIFIED** | `render_contract.py` `worker_attached: bool` added in v9; memory presence not proof of queue membership. |

## Baseline tests

- miner: 226 passed (from v9)
- renderer: 156 passed (from v9)

## Commit order (brief §14)

1. test(miner): expose semantic final-validation omission (V10-MT01..05)
2. fix(miner): require final-range validation on every finalize path
3. test(renderer): expose terminal total-failure semantics (V10-RT10..12)
4. fix(renderer): canonical completed/partial_failure/failed response
5. test(renderer): expose retry and force concurrency races (V10-RT01..05)
6. fix(renderer): atomic attempt reservation (migration + BEGIN IMMEDIATE allocator)
7. fix(renderer): durable-first identity and DB error handling
8. test(miner): expose partial word-timing text loss (V10-MT10..14)
9. fix(miner): canonical partial-timing slicing
10. refactor(renderer): per-render timeline ownership
11. fix(eval): lexicographic maximum-cardinality + maximum-IoU assignment (V10-ET01..04)
12. refactor(contract): canonical state vocabulary and legacy adapters
13. test(e2e): real-media evidence and fault battery harness
14. docs: V10 completion report and feature-readiness decision
