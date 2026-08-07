# V10 Completion Report

## Baseline

- miner SHA before: `2c969ef863463469af0f23621597ded60ddc53cc`
- renderer SHA before: `a8f1045a1eb17f4d8ec069a0025a3b3dc43a275c`
- miner SHA after: `bb9582f` (+ C12 da75d61)
- renderer SHA after: `519b101` (+ C10 954c782, C12 27c4bcc)

## Verified findings

| ID | Verdict | Evidence |
|----|---------|----------|
| V10-M01 | VERIFIED | two-pass.ts semantic path lacked finalValidation (fixed C2) |
| V10-R01 | VERIFIED | 0/N mapped to partial_failure (fixed C4) |
| V10-R02/R03 | VERIFIED | attempt allocation outside transaction (fixed C6) |
| V10-R04 | VERIFIED | memory-first identity (fixed C7) |
| V10-R05 | VERIFIED | generic Exception -> legacy fallback (fixed C7) |
| V10-M02 | VERIFIED | partial-timed utterance drops words (fixed C9) |
| V10-V01 | VERIFIED | timeline captured from globals (fixed C10) |
| V10-E01 | VERIFIED | per-label descending not global optimum (fixed C11) |
| V10-C01 | VERIFIED | RenderResponse.status lacked failed (fixed C4) |
| V10-R06 | VERIFIED | cancel reads memory first (fixed C7) |
| V10-R07 | VERIFIED | stale legacy state vocab (fixed C12) |
| V10-M03 | VERIFIED | finalValidation optional (fixed C2) |
| V10-R08 | PARTIAL | worker_attached boolean retained as diagnostic only |

## Changes by commit

| Commit | Repo | Files | Behavior | Tests |
|--------|------|-------|----------|-------|
| C1 | miner | final-validation-v10.test.ts | RED tests MT01..05 | 2 fail pre-fix |
| C2 | miner | finalize-candidate.ts, two-pass.ts | finalValidation REQUIRED + semantic path | 229 pass |
| C3 | renderer | test_terminal_v10.py | RED tests RT10..12 | 5 fail pre-fix |
| C4 | renderer | render_service.py, render_contract.py | terminal_status_from_artifacts; failed in Literal | 170 pass |
| C5 | renderer | test_retry_v10.py | RED tests RT01..05 | 6 fail pre-fix |
| C6 | renderer | render_service.py | reserve_attempt BEGIN IMMEDIATE + unique index | 176 pass |
| C7 | renderer | render_service.py | durable-first identity; narrow fallback; cancel durable-first | 176 pass |
| C8 | miner | partial-timing-v10.test.ts | RED tests MT10..14 | 1 fail pre-fix |
| C9 | miner | utterances.ts | classifyTimingCompleteness; preserve full text | 234 pass |
| C10 | renderer | clipper.py, test_timeline_ownership_v10.py | ReframeContext per render | 178 pass |
| C11 | miner | metrics.ts, lexicographic-v10.test.ts | min-cost max-flow lexicographic | 237 pass |
| C12 | both | render_contract.py, fixtures | canonical vocab; failed/partial fixtures | pass |
| C13 | renderer | test_fault_battery_v10.py | fault battery FB01..07 | 185 pass |
| C14 | — | this report | completion + readiness decision | — |

## Database migration

- schema before: request_id, parent_job_id, attempt columns existed
- schema after: + idx_render_jobs_parent_job_id, + unique (request_id, attempt) partial index
- duplicate preflight result: no duplicates found in test DBs (stop-condition guard in place)
- rollback: additive indexes only; drop indexes to roll back (no data change)

## Automated tests

- miner: `npx vitest run` → 237 passed; `npx tsc --noEmit` clean
- renderer: `.venv/Scripts/python.exe -m pytest -q` → 185 passed, 44 subtests
- skipped: none for required gates

## Real episode evaluation (V10-E2E01)

**BLOCKED — STOP condition §15 applies.** Real podcast URLs cannot be legally/
technically fetched from this environment (no YouTube/network access). Per the
stop condition, synthetic clips were NOT substituted and this gate is NOT
claimed as passed.

## Real render evidence (V10-E2E02)

- 3 local-fixture renders exist from v8 (`evidence_out/*_final.mp4`, H.264
  1080x1920) — local synthetic fixtures, NOT real podcast episodes.
- This gate requires 3 real final renders from real episodes; BLOCKED without
  the real-media input from V10-E2E01.

## Fault battery (V10-E2E03) — PASSED

- concurrent retry: RT01..04 pass (single child, monotonic attempts)
- concurrent force: RT03 pass (no duplicate attempts)
- DB failure: RT05, FB02 pass (fail closed, no phantom)
- restart/orphan: FB07 pass (startup reconciliation)
- queue full: FB01 pass (explicit admission error, queued->failed)
- all fail / partial / all success: RT10..12 + FB03..05 pass
- cancel race: FB06 pass (exactly one CAS wins)

## Remaining risks

1. Real-media acceptance (10 episodes + 3 renders) pending network access.
2. `worker_attached` remains boolean diagnostic; a richer ownership signal is
   future work (not blocking).
3. Unique (request_id, attempt) index requires pre-flight duplicate check on
   real production DB before first migration.

## Rollback instructions

- Miner: `git revert bb9582f` (and C2/C9/C11 as needed).
- Renderer: `git revert 519b101` (and C4/C6/C7/C10 as needed).
- DB: drop `uq_render_jobs_request_attempt` + `idx_render_jobs_parent_job_id`
  (no data loss).

## Final decision

**READY WITH LIMITS** — all automated correctness gates pass (Section 16 #1-10),
fault battery passes (#13), but real-media gates #11-12 are BLOCKED by lack of
network access. Per the FEATURE-READY RULE, status must remain READY WITH LIMITS
until the 10 real podcast episodes and 3 real final renders are produced and
reviewed.
