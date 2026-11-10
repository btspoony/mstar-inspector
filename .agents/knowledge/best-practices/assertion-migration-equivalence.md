---
title: Assertion migration equivalence
type: best-practice
status: active
last_updated: 2026-10-26
tags: [testing, refactor, review]
---

# Assertion migration equivalence

Replacing a source-string pin with a rendered assertion is a refactor of the test suite, and
the usual refactor rule applies: the replacement must be **at least as strong** as what it
replaced. "The test still passes" is not evidence — it passes on the broken version too.

## The two guards see different things

- A **source scan** is branch-complete: it covers conditional faces that never render in the
  test (creation-disabled notices, confirmation dialogs, loading and error states) and can
  forbid a duplicated spelling anywhere in the module.
- A **render assertion** is composition-aware: it sees what a composed primitive actually
  emits, including styles that live in a different file from the page under test.

A migration that keeps only one of them silently loses the other's coverage. When a pin guarded
a property on both axes, keep both and state the division in a test comment: source scan = all
branches of these modules; render = the emitted face including composed primitives.

## Equivalence checklist

- Run the replacement against a deliberately broken component; it must fail for the intended
  reason, not for a missing element.
- Mutation-test each direction separately: change the page (render guard) and change a
  primitive (source scan). A single mutation that both catch does not prove both are present.
- Check the test count and the assertion count: a migration that lowers either is a deletion
  until proven otherwise.
- Record retained source pins with the structural rule they guard — a pin with no stated
  reason reads as leftover and gets deleted by the next cleanup.
