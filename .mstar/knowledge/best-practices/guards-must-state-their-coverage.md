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

## Why this matters more than it looks

The four instances above were found by *review*, not by CI, and three of them
had already been approved once. A guard's value is not that it exists; it is
that its failure mode is louder than the defect. Where that is not true, the
guard has converted a visible bug into an invisible one.

## Detection

Ask of any new check:

1. What is the exact set this examines? Can I print its size?
2. Name one realistic input it would let through.
3. If that input arrived, would anything else catch it?

A check whose answers are "the things I listed", "one I cannot think of", and
"no" is a comment with a test wrapper.
