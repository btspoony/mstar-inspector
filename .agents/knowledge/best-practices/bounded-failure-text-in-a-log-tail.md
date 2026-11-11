---
module: review-runner / queue consumer failure reporting
date: 2026-11-11
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - "A failure message is persisted inside a truncated log window (a tail slice, a byte cap, a last-N-lines column)"
  - "An attribution explains which configured candidate or component did not serve, and why"
  - "A diagnostic error message can itself be arbitrarily long"
tags: [failure-reporting, bounded-output, observability, attribution, log-tail]
related_components: ["packages/runner/src/seat-failover-probe.ts", "packages/runner/src/runner.ts", "src/pipeline/consumer.ts"]
---

# Bounded failure text inside a truncated log tail

## Context

A sandboxed runner prints a failure explanation to stderr; the Worker keeps only the last few hundred
characters of that stream and persists them as the durable failure row. Two independent defects grow
from that arrangement, and each one alone makes the row useless in a different way.

The first is **inference disguised as observation**. The failure line named the first configured
model as the one that "served the failed request". Nothing had observed that: the same catch covers a
throw before any prompt was sent, and a per-seat override can have used a different provider entirely.
An operator reading the durable row is told which provider failed when the process never learned it.

The second is **an unbounded explanation inside a bounded window**. The attribution joined one line
per chain entry and printed last, so a long chain pushed the original provider error out of the tail.
The row then contained a meticulous list of what was *not* tried, and no statement of what failed.

## Guidance

**Report only what the process observed.** A failure block may name a component's state
(eligible, dropped at a named gate with its reason, not evaluated) because the process computed it. It
may say "served" only when a runtime observation identifies that exact component; otherwise the header
says "(configured)" and every entry stands on its own verdict. A configured list is an intention, not
an outcome - writing it as an outcome converts the operator's diagnosis into a guess.

**Own the budget where the text is built, not where it is cut.** The producer that knows the window's
size composes one block under an explicit character budget:

| Rule | Why |
|---|---|
| The primary cause is emitted first and never evicted | the tail slice preserves the end; anything after the cause can be cut, the cause cannot |
| Each entry is capped before the block budget is applied | one oversized entry must be truncated, never folded away - a folded diagnostic stops saying that a diagnostic failed |
| Overflow becomes one counted line (+N more entries omitted) | silence about the remainder reads as completeness |
| Every printing path shares the formatter | one unguarded path (an exception handler, a missing-input branch) reintroduces the defect for exactly the case that produces the longest message |

Leave headroom between the block budget and the window: the consumer adds its own prefix after
slicing, and redaction only shrinks, so the budget must cover the block alone with room to spare.

## Why This Matters

Both defects pass their tests. A test that asserts "the failure text contains the provider" passes
for an inferred provider; a test that asserts "the attribution lists every chain entry" passes while
the cause is silently evicted. They fail only in the situations the row exists for: a pre-prompt
crash, an overridden seat, a long chain, a diagnostic that throws with a stack trace. In those cases
the operator reads a confident, wrong, and partial explanation and acts on it.

The cheap check is arithmetic and order, not a new test harness: compose the block, count its
characters against the window minus the consumer's prefix, and confirm the cause is the first line
and that a several-thousand-character entry still leaves it present.

## When to Apply

- A durable failure row is derived from a truncated stream (stderr tail, last-N lines, byte cap).
- An explanation names which of several candidates was used, skipped, or dropped.
- A diagnostic path can itself throw, or its message length is outside your control.
- A status or attribution column is written from configuration rather than from a runtime observation.

## Examples

In this repository the bounded compiler lives beside the probe that produces the per-selector
verdicts, and the consumer's persisted row is the last 600 characters of stderr. The three constants
that make the guarantee checkable are the block budget, the per-entry cap and the cause cap; the
regression that keeps it honest is a several-thousand-character diagnostic asserted to leave the
provider cause intact.
