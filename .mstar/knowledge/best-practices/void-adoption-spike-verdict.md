---
module: void-adoption / bare-wrangler CF Worker spike verdict
date: 2026-09-02
last_updated: 2026-09-02
problem_type: best_practice
category: best-practices
severity: medium
topic: void foundation spike
tags: [void, vite, migration-assessment, cloudflare-workers, spike]
related_components: [wrangler.jsonc, queues, sandbox-image]
applies_when:
  - evaluating Void (voidzero) adoption for an existing bare-wrangler Worker
  - deciding build-chain adoption without platform migration
---

# Void adoption spike verdict (v0.10.13, Private Beta) — bare-wrangler Worker

## Context

The T0 spike (2026-09-02) empirically tested Void adoption for mstar-inspector (production PR-review Worker: Hono + D1 + KV + Queues+DLQ + Sandbox DO + cron). Verdict: **Void framework layer rejected; pure Vite SPA adopted** (compass AC1 fallback gate).

## Guidance (durable findings)

1. **Queues (blocker)**: Void's `queues/*.ts` convention generates its OWN consumer registration in `dist/**/wrangler.json` with NO `max_concurrency` / `dead_letter_queue` fields; the wrangler.jsonc passthrough entry is ADDED BESIDE it (two consumers for one queue, unsuppressible). Any Worker relying on DLQ / concurrency caps cannot adopt Void queues as-is. (Also seen: `triggers.crons` duplicated `["*/15","*/15"]`, producers duplicated.)
2. **Routing**: with both `routes/[...slug]` catch-all and `pages/`, the catch-all wins (pages never reached for unmatched GETs) — "pages-first" assumptions from the docs do not hold in the generated worker; enumerated route tables are the reliable pattern.
3. **keep_vars / containers / DO migrations**: wrangler.jsonc passthrough preserved them in build output (points survived), BUT the Sandbox DO class export is owned by `void/sandbox` (generated entry) — coexisting with a hand-written `entry.ts` export was the unresolved conflict.
4. **Safe adoption path used instead**: `wrangler.jsonc [assets] { directory, binding = "ASSETS", run_worker_first = true }` + Vite build → SPA shell served by the EXISTING Hono worker with enumerated-page dispatch. Zero platform risk; deploy chain untouched.
5. **Meta lesson**: Private Beta frameworks — gate adoption behind a T0 spike with explicit per-point fail criteria + a pre-written fallback roadmap (compass AC gate), never "explore then decide".

## Why This Matters

Re-evaluating Void post-beta: re-run the same six-point spike; check whether queues consumers now merge (single entry honoring wrangler fields) before re-attempting framework adoption.

## Examples

- Evidence was iteration-local (compass AC1 record, T0 spike task report, `void-spike/` scratch checkout) and is not part of the tracked repo.
