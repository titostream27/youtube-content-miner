# Brief V11 Historical Closure Audit — Superseded

This file preserves the fact that the previous closure attempt ended **BLOCKED**, but its detailed classification and corpus counts are superseded by the boundary-recovery audit.

Corrections established on 2026-08-08:

- Negative repaired durations were a production boundary correctness defect, not an acceptable ASR artifact.
- The previous G1 evidence did not consistently prove ten usable unique episodes.
- Claims that miner/renderer GitHub Actions were green were not tied to the final recovery SHAs.
- Manual timestamps and historical renders do not satisfy current primary G2/G3 evidence.

Current evidence:

- `docs/brief-v11-boundary-recovery-audit.md`
- `docs/brief-v11-boundary-recovery-completion-report.md`
- `docs/evidence/brief-v11-g1-corpus.json`
- `docs/evidence/brief-v11-g2-production-summary.jsonl`

**Current verdict: BLOCKED.** Boundary correctness and G1 pass; G2 quality/manual comparison, G3, and final-SHA GitHub Actions remain blocked.
