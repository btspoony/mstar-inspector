# Card borders need an explicit colour

**Category**: best-practices · **Tags**: design-system, tailwind, preflight, cards

## The trap

`ui/card.tsx` (the shadcn copy-in) ships `border` as a class with **width only**:

```
.border { border-style: var(--tw-border-style); border-width: 1px }
```

Tailwind's preflight sets `border: 0 solid`, so `border-color` stays at its initial `currentColor`. A card that only applies `border` therefore paints its outline in the **text colour** (`gray-1000`, near-white in the dark theme) at full opacity — a heavy rule where the design intends an 18 %-alpha hairline.

Nothing in a component test that only asserts `bg-card` or a class substring catches this. The rendered markup looks correct; only the resolved border colour is wrong.

## The rule

A component that owns a card-like surface must set the hairline colour itself:

```tsx
<Card className="border-(--gray-alpha-400)">      {/* card / table / panel hairline */}
<Card className="border-(--gray-alpha-500)">      {/* primary tier (AD-591, tinted) */}
```

- `SectionCard` documents this per tier and is the reference implementation.
- `GroupCard` sets `border-(--gray-alpha-400)` on its root for the same reason.
- `DataTable` needs it twice: on the shell **and** on rows — `border-(--gray-alpha-400)` plus `[&_tr]:border-(--gray-alpha-400)`.
- A nav/fill tint (`background: var(--gray-alpha-200)` on `[aria-current]`) is *not* a hairline; do not "fix" it to 400.

## Evidence

Two independent QC rounds caught the same class of defect in one iteration:

- Plan 102 QC seat 1 — `GroupCard` rendered no hairline colour; the test asserted `bg-card` only, so the regression was invisible.
- Plan 104 QC seat 1 — `DataTable`'s shell and rows used bare `border` / `border-b`, resolving to `currentColor` at full strength.

Both were fixed by adding the token colour at the consumer, never by editing `ui/*` (those copy-ins are deliberately untouched in this repo).

## Check before shipping a new surface component

1. Does the element render a visible border? If yes, is a `border-*` **colour** token (or an explicit colour) in the same class list?
2. Does a test assert that colour class, so removing it fails?
3. Is the colour the *tier* colour the spec names (400 hairline vs 500 primary), not just any token?
