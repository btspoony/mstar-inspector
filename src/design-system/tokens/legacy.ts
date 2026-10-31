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
 * it. The badge and table channels, `input-bg`, `spacing-base` and
 * `rounded-lg` have zero consumers and are simply gone.
 */

const v = (name: string): string => `var(--${name})`;

const RADIUS = "202-203 (views.ts, pages.module.css, admin.html)";
const CONTROL = "203 (SSR views.ts)";
const NOTICES = "203 (pages.module.css, SSR views.ts)";
const SIDEBAR = "203 (SSR views.ts)";
const BADGE = "202 (StatusBadge)";

export interface LegacyToken {
  readonly name: string;
  readonly value: string;
  /** The plan that closes the name — printed above its declaration. */
  readonly owner: string;
}

export const legacyTokens: readonly LegacyToken[] = [
  // Radius: the names the two-tier rule (AD-574) replaced, aliased onto the
  // tiers rather than repeating their numbers. The SSR STYLE still declares the
  // raw values, so `tests/spa/tokens.test.ts` resolves these references when it
  // compares the two faces.
  { name: "rounded-sm", value: v("radius-control"), owner: RADIUS },
  { name: "rounded-md", value: v("radius-container"), owner: RADIUS },
  { name: "rounded-full", value: v("radius-pill"), owner: BADGE },

  // The status pill (`StatusBadge.tsx` consumes these through Tailwind's
  // `(--x)` shorthand; plan 202 replaces the pill with tone × strength).
  { name: "badge-bg", value: v("surface-inset"), owner: BADGE },
  { name: "badge-fg", value: v("text-secondary"), owner: BADGE },
  { name: "badge-radius", value: v("radius-pill"), owner: BADGE },
  { name: "badge-height", value: "20px", owner: BADGE },
  { name: "badge-success-bg", value: v("tone-success-bg"), owner: BADGE },
  { name: "badge-success-fg", value: v("tone-success-fg"), owner: BADGE },
  { name: "badge-warn-bg", value: v("tone-warn-bg"), owner: BADGE },
  { name: "badge-warn-fg", value: v("tone-warn-fg"), owner: BADGE },
  { name: "badge-error-bg", value: v("tone-danger-bg"), owner: BADGE },
  { name: "badge-error-fg", value: v("tone-danger-fg"), owner: BADGE },

  // Control sizing on the SSR face, until plan 203 composes the component layer.
  { name: "button-primary-height", value: v("control-h-md"), owner: CONTROL },
  { name: "button-primary-padding", value: "0 12px", owner: CONTROL },
  { name: "button-primary-radius", value: v("radius-control"), owner: CONTROL },
  { name: "button-small-height", value: v("control-h-sm"), owner: CONTROL },
  { name: "button-small-padding", value: "0 8px", owner: CONTROL },
  { name: "button-small-radius", value: v("radius-control"), owner: CONTROL },

  // The notice channel: an alias of the tone system it duplicated, so a notice
  // can no longer pick a step the tone ladder does not own.
  { name: "notice-success-bg", value: v("tone-success-bg"), owner: NOTICES },
  { name: "notice-success-fg", value: v("tone-success-fg"), owner: NOTICES },
  { name: "notice-success-border", value: v("tone-success-border"), owner: NOTICES },
  { name: "notice-warn-bg", value: v("tone-warn-bg"), owner: NOTICES },
  { name: "notice-warn-fg", value: v("tone-warn-fg"), owner: NOTICES },
  { name: "notice-warn-border", value: v("tone-warn-border"), owner: NOTICES },
  { name: "notice-error-bg", value: v("tone-danger-bg"), owner: NOTICES },
  { name: "notice-error-fg", value: v("tone-danger-fg"), owner: NOTICES },
  { name: "notice-error-border", value: v("tone-danger-border"), owner: NOTICES },

  // The SSR sidebar's active row, until the dashboard composes the pattern.
  { name: "sidebar-active-bg", value: v("surface-overlay"), owner: SIDEBAR },
];
