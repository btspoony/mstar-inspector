---
module: review runner / omp settings (per-role models)
date: 2026-08-30
problem_type: best_practice
category: best-practices
severity: high
plan_id: 17-dashboard-perrole-models
tags: [omp, settings, model-roles, agent-overrides, sdk, dead-surfaces, per-role]
related_components: [runtime-omp, runner, consumer, deep-seats]
---

# omp runner per-role models: live surfaces vs dead surfaces (pinned SDK 18.0.4)

## Context

v0.6 B6 needed per-seat models for the review runner (quick/default seat `mstar-review-seat`; deep seats `code-reviewer`/`fullstack-dev`/`frontend-dev` dispatched by the parent session's `task` tool). Research falsified the "write a config file" assumption and pinned the one live mechanism.

## Guidance

**Dead surfaces (do not use):**
- `Settings.isolated({...})` builds **in-memory** settings — it never reads `<cwd>/.omp/config.yml`, `$PI_CODING_AGENT_DIR/config.yml`, or any disk file (`settings.ts`: `inMemory ? null : join(agentDir,"config.yml")`; `reloadFromDisk()` early-returns on `!this.#persist`). Dropping a config file in the container is dead config.
- `PI_SMOL_MODEL` / `PI_SLOW_MODEL` / `PI_PLAN_MODEL` are **CLI-entry-only** (`overrideModelRoles` at CLI startup). The runner calls `createAgentSession` from the SDK directly, so exporting them in exec env has no effect. There is no `PI_MODEL`.

**Live surfaces:**
1. **`OMP_REVIEW_MODEL` exec env → `modelSelectors`**: selector[0] is simultaneously the parent primary AND every quick/default seat primary (seats get the identical chain, `model: seatModels`); the tail is the retry fallback chain (`retry.fallbackChains.default`). Per-App chain override already rides this.
2. **Settings overrides passed programmatically** into `Settings.isolated`: `task.agentModelOverrides` (agent name → selector chain) resolves per spawned agent name; `modelRoles` (role → selector) for built-in roles. SDK resolution order per request: **explicit `model` param → settings override → agent frontmatter → parent active/fallback** (`model-resolver.ts:1148-1181`). Consequence: a settings override CANNOT change a seat whose model is passed explicitly — quick/default overrides must be applied at the `seatModels` synthesis point, while deep seats (no explicit model) resolve via the settings override.
3. **SDK entry normalization**: `normalizeModelPatternList` comma-splits AND trims string and array forms (`model-resolver.ts:970-976`) — `[chainString]` ≡ comma-split form; `:thinking` suffixes pass verbatim.
4. **Model catalog** (`$PI_CODING_AGENT_DIR/models.yml`) IS read (independent of Settings) — but it is baked into the image; per-tenant providers need catalog changes (deferred).

**Byte-compat discipline**: extend the runner input with an OPTIONAL field (`modelOverrides`), guard shape-only in `parseRunnerInput` (runner stays zod-free), thread via conditional spread; assert byte-equality of serialized session options for the absent/empty-map case on every path (deep + quick/default). One settings write covers the deep parent AND its spawned seats (`structured-subagent.ts:433` — child inherits `session.settings`; `reloadFromDisk` no-op).

## Why This Matters

The natural-looking mechanisms (config file drop, env vars) silently no-op with the SDK-direct runner pattern. The explicit-vs-settings priority inversion (explicit wins) also inverts where the override must be applied per dispatch style.

## When to Apply

Any `createAgentSession`-based runner needing per-agent/per-role models; any "why didn't my config.yml/PI_* env take effect" debugging on omp SDK integrations; re-verify on every SDK pin bump (recorded in v0.6 compass Risk Register).

## Examples

- `src/review/runtime-omp.ts` (`seatModels` synthesis + `deepSessionOptions` overrides), `src/review/runner.ts` (`parseRunnerInput` guard), `src/pipeline/consumer.ts` (input threading), `tests/review/**` (settings-capture + byte-compat).
