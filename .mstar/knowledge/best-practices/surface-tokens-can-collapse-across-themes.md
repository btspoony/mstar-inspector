---
module: design system · SPA surface tokens
date: 2026-11-01
last_updated: 2026-11-01
problem_type: best_practice
category: best-practices
severity: medium
applies_when:
  - stacking one surface on another (a well, an inset, a band inside a card)
  - choosing a fill token to signal that a region is recessed or raised
  - changing a surface token in one theme block
tags:
  - design-system
  - tokens
  - theming
  - contrast
---

# Two surface tokens can resolve to the same colour in one theme

## The trap

`src/spa/styles/tokens.css` declares surfaces in a **shared** block, then a **light** block that
redeclares only the tokens whose value differs. A token absent from the light block keeps the shared
block's *reference*, which resolves through whatever the active theme defines further down the chain.

That is correct by design — and it means two tokens with different names, different dark values, and
different intended roles can collapse onto one colour in light:

```css
/* shared */
--surface-page: var(--background-100);   /* dark: #0a0c10 */
--surface-card: var(--background-200);   /* dark: #15181f */

/* light — only the names whose declaration differs */
--surface-card: var(--background-100);   /* light: #ffffff */
/* --surface-page is NOT redeclared, so it still reads var(--background-100) */
```

In light, `--surface-page` and `--surface-card` are both `--background-100` = `#ffffff`. A well
painted `bg-(--surface-page)` inside a `surface-card` container has a **1.00:1** difference from the
surface it is supposed to sit inside: no fill at all, only whatever border it carries.

Nothing in a class-string test catches this. The markup is exactly what was written; only the
resolved pair is wrong, and only in one theme.

## The rule

**Before stacking a surface on another, resolve both tokens in both theme blocks.** A token's name
states its role, not its value. Read the shared block and the light block, follow each `var()` to a
primitive, and confirm the two differ *in the theme you are about to ship*.

If they are equal by construction, the fill cannot carry the separation, and the options are:

1. **A stroke carries it.** Pick the token the system already uses for a box's edge
   (`--border-default` — form fields, buttons, dialogs, list frames) and say in the component's
   comment that the light theme is border-carried, so the next reader does not try to "fix" the fill.
2. **A surface below the card is added.** This is a token decision, not a class change: add a light
   value under `--surface-card` and move the region onto it. It needs its own contrast note and a
   `DESIGN.md` line.
3. **The polarity is inverted deliberately.** Say so. `--surface-inset` resolves *lighter* than the
   card in dark and *darker* in light, so a region using it reads as raised in one theme and recessed
   in the other. That is only correct if the design means "this region is different", not "this region
   is recessed".

## How it was found

A provider card's model list was given a recessed well so it would stop reading as attached to the key
rows above it. In dark it worked (well `#0a0c10` on card `#15181f`, 1.10:1). In light the well was
`#ffffff` on `#ffffff` — 1.00:1 — and simultaneously the *brightest* surface in the card, because the
key rows around it use `--surface-inset` at `#f3f5f8`. The polarity inverted and the separation rested
on a 6 %-alpha hairline.

A review seat caught it by resolving both theme blocks and doing the arithmetic; neither the
component test, the typecheck, nor the design-system check script can see this class of defect.

## Check

```bash
# every surface token, both blocks
grep -nE "^\s+--surface-" src/spa/styles/tokens.css

# the primitives those references land on
grep -nE "^\s+--background-(100|200|300):|^\s+--gray-200:" src/spa/styles/tokens.css
```

Then compute the pair you intend to stack. If the ratio is 1.00:1 in either theme, the fill is doing
nothing there and the separation has to come from something else.
