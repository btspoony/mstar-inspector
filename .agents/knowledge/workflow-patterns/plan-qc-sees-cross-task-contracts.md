---
module: review harness (plan QC, per-task review, CI gates)
date: 2026-11-11
problem_type: best_practice
category: workflow-patterns
severity: medium
tags: [plan-qc, task-review, ci-gate, review-scope, cross-task-contract]
applies_when:
  - "Composing a plan whose tasks each carry their own acceptance checklist"
  - "Deciding whether per-task reviews are enough before a merge"
  - "A diff satisfies every task's acceptance but the repository's own gates still fail"
---

# A per-task review cannot see a contract that spans tasks

## Problem

A plan was split into four tasks, each with its own acceptance sentence, its own
implementer round and its own reviewer. Every task review approved. The plan-level
QC then found the merge blocked: the combined diff touched image inputs
(`packages/runner/src/**`, `sandbox-image/**`) but its Dockerfile edit landed on a
*continuation* line of an existing `# rebuild:` marker, and the CI gate accepts only
a changed line that **starts with** `# rebuild:`. Nothing in any task's acceptance
mentioned the marker, because no single task owned the Dockerfile — one task only
wrote a sentence into a marker block that another task's scope had created.

The same shape hid a second defect class: a changelog fragment claimed a character
count that is false for supplementary code points. It was written by the task that
changed the unit, reviewed by that task's reviewer, and only visible as wrong when
read against the whole plan's claim.

## Why per-task review structurally misses it

- **Acceptance is local.** A task's reviewer checks what the task promised. A
  contract between two tasks belongs to neither acceptance.
- **Diffs are partitioned.** Each reviewer sees one task's diff against its own
  base, so an edit that is correct alone but incomplete in combination reads as
  correct.
- **Repository gates are global.** CI checks (image markers, changelog coverage,
  schema parity) run on the union of the commits, at a scope no task reviewer
  was asked about.

## Guidance

- Treat plan QC as the **second, different** question: not "did each task meet its
  acceptance" but "does the union pass the repository's own gates". Run the gates
  that CI will run, against the plan head, before dispatching QC — and make the QC
  seat re-run them rather than trust the per-task reports.
- Name cross-cutting contracts **in the plan**, not in a task: the marker rule, the
  changelog-per-observable-change rule, the schema/migration parity rule. If a plan
  touches files whose gate is global, that gate belongs in the plan's Global
  Constraints, and its check belongs in PM Acceptance.
- When a task rewrites prose another task's file created, give the QC seat an
  explicit instruction to verify the sentence against source. A plausible sentence
  is the failure mode; reading the diff for fluency reproduces the miss.
- Expect the blocking finding to arrive from a seat that reads the **union**, and
  expect it late. Budget a fix wave after plan QC; do not treat per-task approval
  as merge readiness.

## What did not work

- Asking each task reviewer to "also check nothing else broke": they cannot see
  the other commits, and the request produces confident reassurance rather than
  evidence.
- Relying on CI to catch it after the PR opened: the failure was real and
  reproducible locally for the cost of one command, and catching it at plan QC
  kept the fix inside the branch instead of a review round on the PR.
