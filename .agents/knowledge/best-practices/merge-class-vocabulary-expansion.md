---
module: review-vocabulary
date: 2026-11-05
problem_type: best_practice
category: best-practices
severity: medium
tags:
  - merge-class
  - review-envelope
  - engine-upgrade
  - dashboard-vocabulary
  - chart-slots
---

# Adding an engine merge class: five touch points, two without a compiler

## Problem

The engine's merge-class vocabulary (`MERGE_CLASSES`) is also this repository's finding-severity
vocabulary, restated at five layers. An engine that adds a class breaks nothing loudly: three
layers stop compiling because their map or index is closed over the type, but two carry no such
gate — the dashboard's contract list is only ever indexed, so a missing class is an absent filter
chip, a zero-filled insights key and a rejected query value at once, and the recheck wire's own
union refuses the class as a shape it does not admit, without an error until a recheck runs.

## The five touch points

### `src/review/schema.ts` — the rank and the tally mirror

`MERGE_CLASS_RANK` is a closed `Record<MergeClass, number>`, so the compiler refuses a class the
engine emits and this map lacks. The rank is behaviour, not formatting: `capFindings` sorts by it
and keeps the first `FINDINGS_MAX` (50) findings, so the position decides what is published.

The mirror `tallySchema` needs the new per-class count as `z.number().int().min(0).optional()`.
Earlier engines omit it and readers treat absent as 0, so a required member rejects envelopes that
are already stored. The finding's own `mergeClass` needs no edit — it is `z.enum(MERGE_CLASSES)`
against the engine export.

### `src/contracts/finding-severity.ts` — the dashboard's copy

`FINDING_SEVERITIES` is the dashboard's one deliberate restatement of the engine enum, because the
dashboard leaf boundary forbids importing the store, pipeline and review layers. Four consumers
read it: the record route's `severity` filter guard (`isFindingSeverity`), the SPA filter chips
(`SEVERITY_GROUPS`), the insights zero-fill (`by_severity`) and the must-fix tally
(`MUST_FIX_SEVERITY`). Nothing here fails if the list is short — every consumer indexes it — so a
missing class silently loses a chip, a chart key and a query spelling; a class added here that the
engine does not emit makes the route accept a filter no row can match.

### `src/spa/pages/pullRequestDetailModel.ts` — the presentation map

`SEVERITY_PRESENTATION` is a closed literal keyed by that contract and indexed by
`FindingSeverity` in `SEVERITY_GROUPS`, so a missing class is a compile error at the index. Each
entry carries a `labelKey` that must exist in both dictionaries (`src/i18n/en.ts`,
`src/i18n/zh-CN.ts`); `DictionaryKey` makes a missing label a compile error, while a label that is
present and wrong is caught by nothing.

### `src/spa/pages/AppInsightsTab.tsx` — the chart slot

`SEVERITY_SLOTS: Record<FindingSeverity, ChartSlot>` maps each class onto one of six slots
(`CHART_SLOTS` in `src/spa/components/charts/chartSlots.ts`). This is the layer that fails
silently: while the map was untyped, a class with no slot dropped out of the stacked series and the
legend with no error, while the API zero-filled its key and kept counting it. The `Record` binding
turns the omission into a type error; the slot itself must still be free, because the palette is
six and a seventh value is a type error rather than a stylesheet answer.

### `packages/shared/src/recheck-wire.ts` — the third vocabulary

`OriginalFinding.mergeClass` restated the class union, so a new class reached the recheck seat as a
shape the wire did not admit. It binds to the engine's `MergeClass` by `import type`. The module is
a zero-runtime-dependency wire module, and a type-only import is the form its contract permits — a
value import of the enum would break it.

## Order of work

Edit the closed maps first, starting with `src/contracts/finding-severity.ts` (the others key off
it), then `MERGE_CLASS_RANK` and `SEVERITY_PRESENTATION`, then `SEVERITY_SLOTS`. Each edit makes the
compiler enumerate the remaining consumers, so the sweep is a type check rather than a search.
Once that set is empty, take the edits nothing enforces: the optional tally member and the wire's
type binding. The engine bump itself travels the pin path (see Related), not this checklist.

## What bites

- **The rank position is the engine's, not a convenient one.** A class ranked below its engine
  position silently demotes findings out of the 50-finding cap — they are counted as omitted, and
  the review body reports the omission rather than the finding.
- **The tally member is optional by contract.** Making it required fails validation of stored
  envelopes, not just of new documents.
- **The engine's `TypeError` is a backstop, not the gate.** `computePrTally` throws on an off-enum
  class instead of tallying it as `nit`, but this repository does not call it; the zod boundary in
  `src/review/schema.ts` is the gate that actually runs.
- **All five belong to one change.** A class in the contract but not in `MERGE_CLASS_RANK` compiles
  and leaves the repository unable to represent a class the engine already emits.

## When to apply

Any engine bump whose release notes touch `MERGE_CLASSES` or `PR_VERDICTS`. For `PR_VERDICTS` the
five touch points do not apply — verdicts are imported from the engine — but one map is open on
purpose and worth a look: `VERDICT_TONES` in `src/spa/pages/pullRequestDetailModel.ts` falls back
to `"neutral"`, so a new verdict renders quietly instead of failing.

## Related

- `image-assertion-and-pin-discipline.md` — the pin and image side of an engine bump (deref commit,
  single semver source, lock replay); this document stops at the vocabulary.
- `mstar-review-v1-artifact-store.md` — how the envelope persists and how `findings.severity`
  stores the merge class; a new class needs no migration there.
