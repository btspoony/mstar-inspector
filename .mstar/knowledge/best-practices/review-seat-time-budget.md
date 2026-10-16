# Review-seat time budgets: one shared clock, evidence-based cap classification

**Scope:** any review orchestrator that fans out read-only seats (plus, for a deep tier, one parent session that dispatches its own seats) and wants them to converge inside a wall-clock budget — without ever failing the review because a limit fired.

## 1. One clock per review, not one budget per seat

Anchor a single absolute instant when the review starts (the runner's review start; the harness's `worktree-setup` is the same instant) and derive the remaining minutes from it for every seat. What a seat receives is a **snapshot of that shared clock**, never a fresh per-seat allowance — a later wave legitimately gets less than an earlier one.

- Keep the soft cap (a tier's convergence target, e.g. 5/10/15 min) and the outer exec guard (the process-level timeout) as **two separate tables**. Reaching the soft cap must abort nothing anywhere.
- Keep the derivation pure: `cap − (now − anchor)/60_000`, strictly decreasing, and **negative past the cap** rather than clamped. Whole-minute rounding belongs at the render site, never inside the value other logic consumes.
- A wall-clock figure that is clamped or rounded at the source silently hides an overrun for the rest of the tick.

## 2. Nudges: per seat, on a cadence, stopping at that seat's own settlement

Tell each still-running seat how much of the clock is left, faster once the cap is passed, and require convergence (stop expanding, summarize what exists, declare what was not scanned). Two implementation rules that are easy to get wrong:

- **A fan-out awaits all seats, so "stop" is per-seat state.** Wrap each seat's promise, run the supervisor against a settlement log, and stop nudging a seat the moment *its own* promise settles. Do not treat "the group finished" as a per-seat condition.
- **Tie teardown to an all-settled barrier.** A fail-fast `Promise.all` rejection ends supervision for siblings that are still running and can reach disposal/cleanup before they settle. Use `Promise.allSettled` (or an equivalent barrier), defer teardown behind it, and still rethrow the first failure afterwards.

## 3. A limit stop must be non-fatal — and its classification needs positive evidence

The contract: when a limit fires, the review keeps its collected work and the reader sees **the cause and the unscanned scope** in the body. Non-negotiable consequences:

- **Never widen the classifier.** A generic "was aborted" flag is shared by provider aborts, caller cancellation and watchdog timeouts alike; treating it as a budget stop turns ordinary failures into silent partial coverage. Gate the non-fatal branch on **positive evidence of this cap firing** — the watchdog's own runtime-limit reason for the configured budget — and let everything else (missing reason, SDK error, invalid output) fall through to the fatal path. A textual predicate is acceptable when it is the only discriminator, but it fails closed and must be re-checked on a dependency bump.
- **Do not use the abort flag to attribute a cause** you cannot evidence; a note that blames the configured cap when the reason is unknown is worse than no note.
- **Keep the invalid-output path reachable.** "Returned nothing valid" is a failure, not partial coverage.
- Carry the declared gap in an existing content slot (a summary/notes field that renders into the published body) rather than inventing a schema field.

## 4. Why a deep-tier stop is *not* expressible on the current engine

For the deep tier the only accepted output is a schema-validated `yield`. The SDK's session deadline can stop the turn cleanly and its exit carries the gathered messages — but a stopped parent has not yielded, so the run throws, and a stop with no accepted findings is synthesized to the top verdict (`ship it`) with no neutral/incomplete value in the verdict vocabulary. Publishing available content would therefore assert a pass the run did not earn.

**Therefore: do not wire a hard session bound until the result vocabulary has a neutral/incomplete outcome (plus its tally semantics).** Keep the soft-cap nudges as the deep tier's only lever and record the gap honestly; "soft nudges + the outer guard" is not equivalent to the non-fatal contract.

## 5. Operational note: standalone workflow branch anchors

A standalone development workflow registers its delivery source: `--branch-source feat/<plan-id>`, `--branch-target main`. Registering the base branch as the source (e.g. `main`/`main`) makes `plan complete` refuse with `coordination.scope-mismatch` — the guard requires the plan's recorded working branch to equal the registered source.

There is **no supported correction verb** for that anchor today: workflow registration is create-only, and no plan/workflow verb accepts branch anchors afterwards. Recovering requires an operator-side correction of the workflow row (take a SQLite `.backup` snapshot first), and the gap is worth reporting upstream.
