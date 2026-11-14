---
module: review-pipeline
date: 2026-11-14
last_updated: 2026-11-14
problem_type: logic_error
category: best-practices
severity: high
plan_id: recheck-adaptive-fit
symptoms:
  - "review_failures records stage=recheck with 'skipped: budget (config): ... need at least 66k-75k bytes, the budget is 65536' on every round of a long-lived PR"
  - "Addresses findings from earlier rounds never resolve their GitHub conversations; D1 review_threads stays resolution_state='pending' with verified_json NULL"
  - "The same concerns are re-published as new findings each round because no assessment ever runs"
root_cause: "The recheck ask was all-or-nothing: fitRecheckInput refused the whole round when targets + discussion exceeded review.recheck.assignment_max_bytes, and rotation only advanced rows that were selected, so an omitted row could never make progress"
resolution_type: code_fix
related_components:
  - consumer
  - runner
  - finding-lifecycle
  - recheck-wire
tags:
  - recheck
  - assignment-budget
  - rotation
  - starvation
  - publication-journal
---

# Recheck fits its ask instead of skipping the round

## Problem

A pull request that stays open for many rounds accumulates findings. Each round offers the still-recheckable rows to the recheck seat as one document (targets + discussion + evidence). That document only grows: a 20-target round with the original finding bodies and a bounded discussion is ~66-75 KiB. The operator budget `review.recheck.assignment_max_bytes` defaults to 65,536, so from the round the ask crossed it, `fitRecheckInput` refused the whole round. No seat ran, no assessment was produced, `reconciled.resolutions` stayed empty, and every addressed finding's review thread stayed pending forever — while the same code kept publishing new findings, because nothing was ever re-checked.

## What made it a deadlock rather than a slow lane

- The ask was all-or-nothing by design: "every target and the discussion always ride (no prior finding may vanish from the ask)". Only evidence slices were droppable.
- Rotation advances `last_scheduled_ms` only for rows that were **selected**, and the selector scopes are a fixed cap — so an omitted row was never distinguishable from a scheduled one. It came back at the front next round and was refused again.
- Raising the budget moves the cliff; it does not remove it. Long-lived PRs grow without bound.

## Resolution

- Move the fit predicate to `packages/shared/src/recheck-wire.ts` so the worker runs the same rule as the runner; the runner keeps its skip path for a direct call.
- The consumer now fits during input construction: candidates ride in rotation order up to `min(512 KiB wire cap, assignment budget − prose)`. Rows that do not fit are `budget` / never-sent and join `budgetExcluded`; `selectedRowIds` is built from the rows actually sent, so their rotation clock — and only theirs — advances.
- The rotation head is rescued whenever it does not fit whole: its ORIGINAL body is bounded by a byte-accurate binary search (rowId, title, path and line anchors unchanged, body marked truncated), first beside the fitting rows with its own catalog, then without it, then alone when the budget cannot be shared. A displaced row keeps its clock and comes first next round.
- Discussion is narrowed to the sent associations before serializing; issue items, coverage and digest stay. Resolution eligibility still requires the same snapshot/coverage/digest fences.

## Invariants worth keeping

- Never-sent means never-advanced: only rows that rode the wire may move `last_scheduled_ms`.
- `assessed + invalid-output + omitted = selected` still holds; an omitted row is `budget`, not `assessed`.
- The budget is a fitting budget, not a gate; the only all-or-nothing case left is a budget too small to carry prose plus one minimal target.

## Evidence

Staging (2026-11-14): five consecutive rounds recorded `stage=recheck` skips at 66,265 / 71,259 / 73,716 / 72,065 / 75,132 bytes against a 65,536 budget; the PR's 30 threads were all pending and nine addressed findings unresolved. With the fit in place, a synthetic staging-shaped ask sends 15 of 20 targets inside 64,099 bytes (document + prose) and two rounds over synthetic rows send disjoint prefixes.
