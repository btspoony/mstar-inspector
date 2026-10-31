# Tailwind v4 `dark:` reads the OS, your theme reads `data-theme`

## Problem

The dashboard's theme is an explicit contract: `data-theme="light"` on the root,
set by a manual toggle, absent meaning dark. It never consults
`prefers-color-scheme`, which is deliberate — the OS preference must not change
what a user sees when they have chosen a face.

Tailwind v4's `dark:` variant is `@media (prefers-color-scheme: dark)` unless a
project rebinds it with `@custom-variant dark`. This repository never rebound it.
Consequence, in both directions:

- A `dark:` utility **never fires** when the user picks dark on an OS set to
  light.
- A `dark:` utility **does fire** when the user picks light on an OS set to dark,
  recolouring a control that should follow the token layer.

Twenty-one utilities across six primitives were in this state. None was
load-bearing in either direction; each was a face that could paint against the
user's explicit choice.

## Rule

**Either rebind the variant or do not use it.**

- Rebind: `@custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));`
  in the theme entry, so `dark:` follows the app's mechanism.
- Or drop `dark:` entirely and let the token layer carry both themes: every
  semantic token already resolves per theme, so a control that names semantic
  tokens needs no variant at all.

Deleting is usually right for a token-driven system. A `dark:` utility is a
second theme mechanism hidden inside a class string, and two mechanisms will
disagree.

## How it hid

Every symptom looked like a design choice. A destructive button had
`dark:bg-destructive/60`; on an OS-light machine the `/60` never applied, so the
button filled with the full re-pointed solid and its `text-white` label landed at
≈2.6:1. The existing contrast test asserted `on-brand` — a face the component did
not paint — so the test passed while the DOM failed.

That is the second lesson: when a test proves contrast, it must read the class
the component actually renders, resolve it through the bridge and the token file,
and measure *that*. Asserting a token the component never names is a test of your
intentions.

## Detection

- `grep -rn 'dark:' src/` and check whether `@custom-variant dark` exists.
- Any test that pins a colour: does it read the component's own class string, or
  a token name you chose?
