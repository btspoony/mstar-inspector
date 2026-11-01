---
module: src/spa styles + design-system tokens (theme mechanism)
date: 2026-11-01
last_updated: 2026-11-01
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - authoring or reviewing anything that paints a theme-dependent face
  - adopting a shadcn/ui component into the SPA
  - changing the theme bootstrap or the token cascade
tags:
  - tailwind
  - dark-variant
  - data-theme
  - shadcn
  - token-cascade
  - theme-contract
---

# Tailwind's `dark:` answers the OS until it is bound to the attribute

## Problem

The dashboard's theme is an explicit contract: `data-theme="light"` on the root,
written before first paint from a stored choice, **absent meaning dark**. It
never consults `prefers-color-scheme`, which is deliberate — the OS preference
must not change what a user sees when they have chosen a face.

Tailwind v4's `dark:` variant knows nothing about that. Unbound, it is
`@media (prefers-color-scheme: dark)`, so a `dark:` utility answers a question
the app never asked:

- it **never fires** when the user picked dark on an OS set to light;
- it **fires** when the user picked light on an OS set to dark, recolouring a
  control that should follow the token layer.

Twenty-one utilities across six primitives had drifted into that state. None was
load-bearing in either direction; each was a face that could paint against the
user's explicit choice.

## Rule

**Do not author a `dark:` utility — and the variant is bound anyway.** The two
halves are not alternatives; they answer different questions.

- **The ban: the cascade is the one sanctioned mechanism.** Every semantic
  token already resolves per theme, so a control that names semantic tokens
  needs no variant at all. An authored `dark:` is a second theme mechanism
  hidden inside a class string, and two mechanisms will disagree.
  `tests/design-system/boundary.test.ts` enforces the ban repo-wide.
- **The binding: only the spellings a text scan cannot see.**
  `src/spa/styles/shadcn-theme.css` declares

  ```css
  @custom-variant dark (&:where(:root:not([data-theme="light"]), :root:not([data-theme="light"]) *));
  ```

  — the token cascade's own root condition. A class name composed at runtime
  (`` `dark:${suffix}` ``) and a component copied in from upstream that arrives
  with shadcn's spellings already in it never appear as text in the guard's scan
  set, so the ban cannot reach them. Unbound, those utilities answer the OS;
  bound, they answer the stored choice. The binding removes the disagreement
  about *which theme is active*; the ban still removes the second mechanism.

## Dark is the attribute's absence — the shadcn recipe is inverted

The published recipes are `@custom-variant dark (&:where(.dark, .dark *));` and
`(&:where([data-theme="dark"], [data-theme="dark"] *));`. Both key on a marker
the app must write, and this app writes none for a visitor who has never
toggled: the pre-paint bootstrap in `src/spa/index.html` sets
`document.documentElement.dataset.theme` only when
`localStorage["mstar.dashboard.theme"]` already holds `light` or `dark`.

So a `[data-theme="dark"]` binding here is not partially right — it is exactly
backwards. It covers the visitor who made a choice and misses the default case,
which is every first visit, and it does so silently: the stylesheet compiles,
the build stays green, and only a human comparing two renders sees the missing
dark face.

`:root:not([data-theme="light"])` states the real contract in one condition, for
the root and its descendants alike. `tests/design-system/dark-variant.test.ts`
pins both the shipped line and the compiled selector, and evaluates the rule
against each root state: unset and `"dark"` fire, `"light"` never does.

## How it hid

Every symptom looked like a design choice. While the variant was unbound, a
destructive button's `dark:bg-destructive/60` never applied on an OS-light
machine, so the button filled with the full re-pointed solid and its `text-white`
label landed at ≈2.6:1. The existing contrast test asserted `on-brand` — a face
the component did not paint — so the test passed while the DOM failed.

That is the second lesson, and it outlives the first: when a test proves
contrast, it must read the class the component actually renders, resolve it
through the bridge and the token file, and measure *that*. Asserting a token the
component never names is a test of your intentions.

## Detection

- `grep -rn 'dark:' src/` — a hit in authored source is the ban broken. Legal
  hits are TypeScript object keys, this stylesheet's own comment, and the theme
  records; no authored utility may appear.
- `@custom-variant dark` must exist in `src/spa/styles/shadcn-theme.css` and key
  on `:root:not([data-theme="light"])`. A `.dark` or `[data-theme="dark"]`
  spelling compiles, reviews clean, and leaves every never-toggled visitor
  without a dark face.
- Any test that pins a colour: does it read the component's own class string, or
  a token name you chose?
