# Brief V11 Boundary Recovery — Pre-change Audit

**Audit timestamp:** 2026-08-08 15:57 SEAST  
**Scope:** correctness recovery first; acceptance evidence only after temporal invariants pass.

## Repository baselines

| Repository | Audited ref | Full SHA | Working-tree note |
|---|---|---|---|
| `titostream27/youtube-content-miner` | `origin/main` / recovery branch base | `35de09822132b8f0f4a0fb58633426fd0d202a97` | Clean tracked baseline in an isolated worktree. Untracked `.gitattributes`, `AGENTS.md`, and `graphify-out/` in the pre-existing local checkout were not modified. |
| `titostream27/AI-Youtube-Shorts-Generator` | local verified renderer recovery HEAD | `a93e7813146bf2016812d0c91083681d66b5e589` | Isolated worktree created from local HEAD. The pre-existing checkout had untracked `scripts/phase_h_e2e.py`; it was preserved and not copied into the clean worktree. |
| renderer fork `main` | pushed GitHub ref | `1a04a5e155a643ac415336dfce4be1d544e0570d` | Local recovery commits `da8dd156d1f24d4994978c29c3191869731d4a69` and `a93e7813146bf2016812d0c91083681d66b5e589` are not present on the pushed fork ref at audit time. |
| renderer upstream `main` | upstream ref | `c30376e94326f8674793c960b482eb532ffbf1f6` | Recorded only to disambiguate upstream from Tito's fork. |

The miner recovery branch is based exactly on reviewed commit `35de098`; therefore it contains the reviewed baseline rather than merely descending from it.

## GitHub Actions state at audit time

| Repository | Run | Commit | Conclusion | URL |
|---|---:|---|---|---|
| miner | `31248230891` | `35de09822132b8f0f4a0fb58633426fd0d202a97` | `success` | https://github.com/titostream27/youtube-content-miner/actions/runs/31248230891 |
| renderer fork | `31205757569` | `1a04a5e155a643ac415336dfce4be1d544e0570d` | `failure` | https://github.com/titostream27/AI-Youtube-Shorts-Generator/actions/runs/31205757569 |

A local green claim for the renderer is not equivalent to pushed CI. Renderer CI remains **BLOCKED** until the exact final pushed SHA has a green run.

## Exact pre-fix production defect reproduction

Committed `g2_eval.out` contains impossible repaired durations flowing through the production two-pass path. Examples:

- line 88: `too short (-12.7s < 14s)`
- line 94: `too short (-32.6s < 14s)`
- line 144: `too short (-80.2s < 14s)`
- line 147: `too short (-21.6s < 14s)`
- line 153: `too short (-12.8s < 14s)`

This is a production range-construction correctness defect. ASR fragmentation may affect semantic ending classification, but it cannot make `finalEndSec < finalStartSec` valid.

## Confirmed code-level causes before edit

1. `src/lib/moments/boundary-repair.ts`: the ending scan has no lower bound tied to `roughStartSec`, so a complete utterance wholly before the candidate may be selected.
2. The same function sets `finalStartSec` from the selected ending utterance (`Math.max(roughStartSec, endU.startSec)`), allowing ending repair to collapse the candidate start.
3. Its loop index belongs to the filtered `inside` array but is used to index the full `utterances` array for `nextU` and `following`.
4. Invalid/non-finite rough ranges are not rejected before selection, and repaired/refined outputs have no fail-closed finite/ordering guard.
5. Controlled extension can cross a supplied `preferEndBeforeSec` next-topic ceiling and also mutates the start.

## Expected change surface

- `src/lib/moments/__tests__/boundary-repair-closure.test.ts`: BR-01..BR-12 plus deterministic generated invariant coverage and a compact ASR-fragment failure signature.
- `src/lib/moments/boundary-repair.ts`: minimal window-local, indexed, start-safe, fail-closed end repair.
- `src/lib/moments/two-pass.ts`: only if diagnostics or caller range assumptions need correction after focused tests.
- `scripts/real-media-prod-eval.ts`: acceptance instrumentation/schema only after correctness tests pass.
- Brief V11 evidence/docs: repair contradictory G1/G2/G3 and CI claims without rewriting historical failed evidence.
- Renderer files: change only if independent verification proves a real CI/test defect.

## Explicit first-line decision

Alternate ASR providers, manually authored timestamps, lower minimum duration, weaker scoring/contamination thresholds, and skipped required tests are **not** first-line fixes. The temporal boundary invariant will be fixed and proven first. Any later ending-classification adaptation requires separate real-media evidence under the brief's threshold.

## Gate status entering implementation

| Gate | Status | Reason |
|---|---|---|
| Boundary correctness | **FAIL** | Negative durations and invalid selection semantics reproduced. |
| Miner local CI | **PENDING RE-RUN** | Must run `npm ci`, TypeScript, Vitest, and ESLint after the fix. |
| Miner GitHub Actions | **PENDING FINAL SHA** | Baseline run is green; recovery SHA does not yet exist remotely. |
| G1 | **BLOCKED** | Existing notes conflict; committed evidence does not yet prove one canonical 10-row usable-unique manifest. |
| G2 | **BLOCKED** | Existing run has negative durations, incomplete per-episode schema, and no complete 20-annotation comparison set. |
| Renderer CI | **BLOCKED** | Latest pushed fork run is red; local recovery commits are unpushed. |
| G3 | **BLOCKED** | Existing renders are not yet proven as three miner-selected clips with one single-focus and two genuine switch cases plus full playback checklists. |
