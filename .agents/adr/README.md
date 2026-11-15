# Architecture decision records

One record states one decision the project made among real alternatives, and why each alternative lost. `docs/specs/` states what the system does now; a record states why it does it that way and what would falsify the choice. A record never restates a spec: it links the spec section it explains.

## Buckets

The bucket is the decision's fate; the class is its domain. `{bucket}/{class}/<YYYY-MM-DD>-<slug>.md`.

| Bucket | Holds | Movement |
|---|---|---|
| `proposed/` | A decision not yet shipped. | → `implemented/` or `rejected/`, never archived. |
| `implemented/` | The standing decision, in the present tense. | → `archived/` only when its mechanism is gone and it no longer guides future work; a record with a successor stays here, on a supersession line. |
| `rejected/` | A proposal that lost, body frozen. | No move. |
| `archived/` | A decision that is no longer authority; kept only for history. | No move. |

A move is one change: bucket directory, body and header together. The filename never changes across a move. Archiving requires all three of: its mechanism is gone or has no live consumer, it no longer guides future work, and it retains historical value — a record that fails the third is deleted, not archived. A successor is not an archive reason by itself: a record that still guides work stays in its live bucket and carries the supersession.

`superseded` is not a bucket and not a state: a superseded record stays in its live bucket and says so on its header line.

## Classes

`architecture/` and `feature/` are the classes in use. A new class is a new directory plus one line in this section, in the same change.

There is no `refactor` class. An observable behaviour change is `feature`; a change with no observable behaviour change is a simplification noted in the record body.

## Filename

`<YYYY-MM-DD>-<kebab-slug>.md`, lowercase, hyphen-separated. The date is the day the decision took effect — for a retrospective record, the day the shipped change landed, not the day the record was filed. It is the only copy of that date: there is no `Date:` field, so nothing can drift from the filename.

## Header

In this order, each a bare line:

```markdown
# ADR: <title>
Status: <state> — <why>
Archived: <YYYY-MM-DD> — <reason>        (only in archived/)
Spec: <path> § <section heading>
Supersedes: <path> | Superseded-by: <path>   (only where a supersession exists)
```

**`Date:` is deliberately absent.** The filename prefix is the decision's effect date and its only copy.

**`Status` vocabulary is exactly three states: `proposed`, `implemented`, `rejected`.** The state equals the containing bucket for those three directories. An `archived/` record keeps `Status: implemented` and gains `Archived: <YYYY-MM-DD> — <reason>` directly below it. `accepted`, `accepted-retrospective` and `superseded` are not states: a decision taken before its record was filed is `implemented`, and the `— <why>` clause carries the retrospection (`— retrospective: <what shipped>; filed after the fact`).

**`Supersedes` / `Superseded-by` are mandatory exactly when a supersession exists, in both directions, in one change**: the successor names the predecessor, the predecessor names the successor, on relative paths. Absent otherwise — an empty or placeholder line is a defect, not a marker. A superseded record's body freezes at the supersession, link rot only, because it stays a true statement about what it decided.

**`Spec:`** names the spec and the section heading inside it that the decision explains — any `##` to `####` heading — in the form `Spec: docs/specs/<class>/<file>.md § <section heading>`. The record links that section and never restates it. The obligation binds records filed from 2026-11-16 on: a record filed before this README carries no `Spec:` line, and is not edited to add one — this tree adds records, it does not rewrite old ones.

## Sections

`implemented/` — all four required, in this order:

```markdown
## Problem
## Decision
## Alternatives considered
## Consequences
```

`proposed/` — `## Problem`, `## Proposal`, `## Alternatives considered`, `## Acceptance criteria`, `## Risks`.

`rejected/` — the proposed body, frozen; only `## Problem`, `## Proposal` and `## Alternatives considered` are required.

Sections neither required nor banned stay. `## Proposal`, `## Plan`, `## Migration plan` and `## Acceptance criteria` must not appear in an `implemented/` or `archived/` record: they are proposal-era scaffolding a promotion left behind.

## No index

The buckets are the index: path, class and date are enough to find a record, and a second registry would drift. There is no `INDEX.md`, no decision list and no counts page here. `docs/specs/README.md` stays the only index of specs; this tree gets none.

## Records in this tree

A record states what the code shows. Records filed from 2026-11-16 carry a path or a symbol for every claim, existing at the commit the reader has; older records are read as filed.
