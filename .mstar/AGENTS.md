# AGENTS.md — `.mstar/` (harness layer)

Morning Star harness subtree rules. Root `AGENTS.md` keeps repo-level long-term constraints only; this file is the harness SSOT.

## Paths

Directory layout is declared in root `.mstarc` (`[config]`) — single source of truth; do not duplicate it here. Git split (process local / results shared): tracked = `AGENTS.md`, `knowledge/**`, `specs/**`; everything else under `.mstar/` is gitignored. `workflows/` and `projects/` are created by engine writers on demand — never pre-create.

## Content Boundaries

- `docs/` — human docs (install, contributing). Never process artifacts.
- `{SPECS_DIR}` — frozen specs / ADRs.
- `{PLAN_DIR}` — main plans + durable gate summaries only. QC/QA raw reports go to `{SDD_DIR}/review/`, not here.
- `{KNOWLEDGE_DIR}` — implementation SSOT, reusable designs.
- `{ITERATION_DIR}` — iteration packages (compass + guides).

## State & Gates

- State machine: `Todo → InProgress → InReview → Done | Blocked`.
- **`Done` may be set only by PM or QA.** Implement roles stop at `InReview`.
- Residual SSOT: `{PROJECT_DIR}/<id>/residuals.json`. Plan files hold no residual state.
- Never `git add` process artifacts (`plans/`, `status.json`, `iterations/`, `sdd/`, `workflows/`, `projects/`).

## Escalation

Conflicts between this file and skills resolve to `mstar-harness-core`; user instruction overrides all.
