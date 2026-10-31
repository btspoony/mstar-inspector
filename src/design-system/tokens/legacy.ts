/**
 * Transitional names the live stylesheet still owes to surfaces that plans
 * 202-203 own.
 *
 * They are **not** a second token layer and not a compatibility gesture: each
 * entry is either a straight reference into the semantic/component layer or the
 * one value (a radius, a control height) the surface declares today. The name
 * leaves this set in the commit that migrates its last consumer, which is why
 * every entry carries the plan that closes it. `tokens.test.ts` pins the set in
 * both directions and the generated file prints the owner above each line.
 *
 * Membership is measured, not guessed: a name is here only because a file
 * outside `src/design-system/` references it and the new layers do not declare
 * it. Two groups left with plan 203 task 7, when the SSR face moved onto the
 * component layer: the button-sizing aliases (`button-primary-*`,
 * `button-small-*`) and its sidebar tint (`sidebar-active-bg`); the notice
 * channel left in the same commit, once `pages.module.css` read the tone tokens
 * directly instead of through an alias of them.
 */

const v = (name: string): string => `var(--${name})`;

const RADIUS = "204 (admin.html, pages.module.css)";

export interface LegacyToken {
  readonly name: string;
  readonly value: string;
  /** The plan that closes the name — printed above its declaration. */
  readonly owner: string;
}

export const legacyTokens: readonly LegacyToken[] = [
  // Radius: the names the two-tier rule (AD-574) replaced, aliased onto the
  // tiers rather than repeating their numbers. Two files still spell the old
  // names — `src/spa/admin.html` (plan 204 re-tokens that console) and the
  // notice face in `src/spa/pages.module.css` — and the aliases leave in the
  // commit that migrates the last of them.
  { name: "rounded-sm", value: v("radius-control"), owner: RADIUS },
  { name: "rounded-md", value: v("radius-container"), owner: RADIUS },
];
