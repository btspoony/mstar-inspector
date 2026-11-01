---
module: design-system + SPA guards (tests and check scripts)
date: 2026-11-01
last_updated: 2026-11-01
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - adding or widening a guard, ban, or check script
  - writing a seeded fixture for a rule that rejects source text
  - claiming a rule closed a blind spot
tags:
  - guards
  - fixtures
  - coverage
  - text-scan
  - regression-teeth
---

# A guard that names a subset is a claim, not a guard

## Problem

Four separate rounds in one iteration produced the same defect shape, each from
a different author, each approved by a different reviewer until a later seat
caught it:

1. A row-height contract: three source comments said the vocabulary was asserted
   in `surface-idioms.test.ts`. The file rendered cards and never imported the
   table or list components. A row-height regression stayed green.
2. A Tailwind `@source` directive: the only thing keeping the scanner pointed at
   the migrated primitives. Delete it and `bun run build:spa` still exits 0 while
   the compiled CSS drops from 73.7 kB to 35.8 kB — a green build and an
   unstyled UI. Nothing tested it.
3. A preview coverage loop: it enumerated `primitives/` and called the set
   closed, while the public barrel also exported `patterns/`. A pattern export
   could ship unexercised and undeclared.
4. A palette-name guard: `\d{2,3}\b` plus a hand-kept family list. It missed
   `--gray-1000` (four digits, still declared) and the whole `teal`/`pink`
   vocabulary, while `DESIGN.md` described it as the fact that no consumer names
   a palette step.

Every one passed review because the guard *looked* complete: it had a test, an
assertion, sometimes a comment explaining why it mattered. The defect is not
weakness in the check — it is the gap between what the check covers and what its
name and its documentation claim.

## Rule

**A check must be able to state what it covered, and that statement must be
narrower than or equal to the set it actually examines.**

Concretely, when writing a guard:

- **Derive the set, do not repeat it.** A family list maintained next to the
  data it describes drifts. `survivorSteps` + a short retired-family list beats a
  regex that spells the families out.
- **Prove it fails.** For every guard, break the thing it guards and watch it go
  red before you call it done. A guard nobody has seen fail is documentation.
  This is necessary and not sufficient — see the next bullet.
- **Prove the *fixture* slips before the rule exists.** A seeded fixture earns
  its place only if it fails under the rule as it was *before* the change and
  passes after it. Load the old revision by path — `git show <rev>:<path>`,
  never retyped from memory — and run it over the same seed. Green-under-old /
  red-under-new is the only pair that demonstrates added coverage. Red under
  both means the seed lands on a defect the old rule already caught, so it
  proves nothing about the fix: reshape it, or discard it and say so.
  A fixture that passes either way is a test of the fix author's intentions.
- **Write down the blind spots at the guard.** Text scans cannot see computed
  keys (`tokenLayers(...).primitive["gray-800"]`), concatenated names, or values
  copied as literals. Say so where the scan lives, and name the backstop.
- **A handoff comment is a promise.** If three files say "this is asserted in
  `X`", then `X` asserts it. A dangling pointer is worse than no pointer,
  because it stops the next reader from looking.
- **Snapshot the load-bearing line.** When one line's absence fails silently —
  a `@source` directive, a selector order that wins by specificity — pin the
  line itself, plus the property that makes it load-bearing (the target must
  resolve outside the scan root; the ops block must be emitted after the light
  block).

## Two replays, and what each caught

Both were run before the replay rule existed, and neither defect was visible in
the fixture's own green run — which is the reason the rule exists.

- **Run the new rule against the old bytes, not only the new fixture.** The
  contrast gate pointed at the pre-change dark `chart-5` value (`#2563a8`, read
  from git rather than remembered) exits 1 with 2.900 and 2.696:1 below the 3:1
  bar; on the shipped `#2d6bb0` it exits 0 printing 3.580 / 3.249 / 3.020:1.
  Same command, same tree, one token — the teeth in a single diff. The colour
  guards replay the other way as well: run over the pre-change tree they report
  `components/ListRow.tsx` (`min-w-[76px]`), a violation the old
  hand-maintained 27-file list could not see because it never read 40 of the 67
  colour files, while the shared matcher catches fourteen named seeds the
  pre-change matcher (`git show 9925086:tests/helpers/tailwind-palette.ts`) let
  through. Neither number is inferable from the new code reading well.
- **A seed whose defect the old rule could not exhibit.** A rule rejecting a
  bare `border` blanks `//` comments before scanning; the fix stopped the
  blanking regex from consuming the character in front of the delimiter. The
  seed written alongside the fix was `cn("border")//note`, and it was discarded:
  the character before `//` there is `)`, so the old regex blanked the
  parenthesis and left the class string intact — old and new both detected the
  border. The seed that isolates the defect is `const cls = "border"//no colour
  named`, where the closing quote abuts the comment, the old regex eats the
  quote, the literal stops parsing, and the bare `border` is missed. One
  character of position was the whole difference between a fixture and a
  decoration.

## Why this matters more than it looks

The four instances in the Problem section were found by *review*, not by CI, and
three of them had already been approved once. A guard's value is not that it
exists; it is that its failure mode is louder than the defect. Where that is not
true, the guard has converted a visible bug into an invisible one — and a
fixture that never slipped completes the illusion by making the fix look proven.

## Detection

Ask of any new check:

1. What is the exact set this examines? Can I print its size?
2. Name one realistic input it would let through.
3. If that input arrived, would anything else catch it?
4. Does my fixture fail under the pre-change rule? If I have not run the old
   revision over it, I do not know that the fix changed anything.

A check whose answers are "the things I listed", "one I cannot think of", "no",
and "I did not try" is a comment with a test wrapper.
