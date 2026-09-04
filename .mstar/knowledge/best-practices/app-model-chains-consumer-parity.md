---
module: dashboard / per-App model chains (default + named) and consumer resolution
date: 2026-09-04
problem_type: best_practice
category: best-practices
severity: high
plan_id: 35-apps-detail-ops-providers
tags: [d1, migration, backfill, model-chains, consumer, parity, omp, models-yml]
related_components: [migrations/0017_app_model_chains.sql, src/dashboard/app-config-store.ts, src/pipeline/consumer.ts, src/review/runtime-omp.ts]
---

# Named model chains with byte-identical runner parity

## Context

Each review App had one implicit model chain + per-seat single-model overrides. iter011 plan 35 upgraded to **1 default + N named chains** where audit seats reference a chain by name — without changing anything the sandbox runner consumes (omp `models.yml` synthesis, selector grammar `provider/model[:variant]`).

## Guidance

- **Two-table shape** (migration 0017, first backfill-DML precedent — 0001–0016 are DDL-only): `app_model_chains(app_id, name, PK(app_id,name))` with `is_default` (uniqueness enforced by store in a **single `db.batch()`** clear-then-set, no CHECK/partial index — app-family convention) + `app_model_chain_seats(app_id, role, chain_name, PK(app_id,role))`. Both FK `github_apps`, no ON DELETE (soft-delete app family).
- **Backfill is INSERT…SELECT in the same transaction**: non-NULL `app_model_config.model_chain` → `('default', chain, is_default=1)`; each `app_model_roles` row → named chain `seat-<role>` (deterministic name carries the seat identity) + a seat reference row. NULL/absent config → **no default row** = existing fail-closed semantics, byte-preserved. Absent seat row = default chain (0009 absent-row precedent).
- **Consumer resolution must be output-identical**: `resolveModelOverrides` maps seat → chain → models; default-referenced and absent seats are **omitted from the map**; empty map → `undefined`. The runner sees exactly what it saw before migration (locked by `tests/worker/app-config.test.ts` mirror + migration-equivalence tests via `tests/store/helpers.ts ALL_MIGRATIONS` real-SQL runner).
- **Canonicalize at the write boundary, both faces**: the bulk seat-save path must `trim()` chain names before the known-chain check **and** the bind (route-trimmed + store-untrimmed = dangling reference → next review fails closed for the whole App). Save-roles is **full-map semantics**: all seat keys required, missing key → 400 (partial updates silently keep stale references).
- **Fail loud on tamper**: consumer read of a missing referenced chain throws (fails closed) — the DB-level guards make this unreachable in practice, it is a tamper backstop, not the primary defense.

## Why This Matters

Chain upgrades fail silently when the runner-visible contract drifts. The two-table + output-parity pattern adds product flexibility (named chains for roles) with a migration the runner cannot notice — and the backfill-DML precedent (with real-SQL migration-equivalence tests) is now established for future schema evolution.

## When to Apply

Any change to chain/seat storage, any new backfill migration, any consumer-side resolution change. Verify with the parity test pair before merge.

## Examples

- `tests/worker/app-config.test.ts` — mirror lock (`app-config-store` ↔ `runtime-omp.ts`).
- `tests/dashboard/insights-store.test.ts` style: `ALL_MIGRATIONS` replay for migration equivalence.
