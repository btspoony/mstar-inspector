/**
 * Component layer — assembled from the semantic layer, never from a primitive
 * and never from a literal. A component token here is an expression, so it
 * follows the active theme without a second declaration per theme; only the
 * ops surface variant overrides it (see `surface-variants.ts`).
 *
 * Scope is deliberately the component faces that own tokens: the primary /
 * secondary / ghost / danger / disabled button, the text field, and the card.
 * Status surfaces are the tone system's job — `tone-{meaning}-{bg,border,fg}`
 * is the pill, its solid strength is `tone-{meaning}-solid`, and D15 forbids a
 * second component set beside it.
 */

const v = (name: string): string => `var(--${name})`;

export const components = {
  // Primary action. `on-brand` is the label face because the fill is brand and
  // the label must flip with the theme; `border` duplicates `bg` so a surface
  // variant can change the edge alone (that is what the ops re-map does).
  // Hover is `brand-600`, not `tone-accent-fg`: the accent fg equals the accent
  // solid, so hovering through it would be invisible.
  "button-primary-bg": v("tone-accent-solid"),
  "button-primary-fg": v("on-brand"),
  "button-primary-border": v("tone-accent-solid"),
  "button-primary-hover-bg": v("brand-600"),

  "button-secondary-bg": v("surface-card"),
  "button-secondary-fg": v("text-primary"),
  "button-secondary-border": v("border-strong"),

  "button-ghost-fg": v("text-muted"),

  "button-danger-bg": v("tone-danger-bg"),
  "button-danger-fg": v("tone-danger-fg"),
  "button-danger-border": v("tone-danger-border"),

  "button-disabled-bg": v("surface-inset"),
  "button-disabled-fg": v("text-faint"),
  "button-disabled-border": v("border-default"),

  // Sizes: three named control heights, padding and label step per size.
  "button-height-xs": v("control-h-xs"),
  "button-height-sm": v("control-h-sm"),
  "button-height-md": v("control-h-md"),
  "button-padding-xs": "0 8px",
  "button-padding-sm": "0 12px",
  "button-padding-md": "0 14px",
  "button-radius": v("radius-control"),

  "field-bg": v("surface-page"),
  "field-fg": v("text-primary"),
  "field-border": v("border-default"),
  "field-placeholder": v("text-faint"),
  "field-height": v("control-h-md"),
  "field-padding": "0 12px",
  "field-radius": v("radius-control"),

  "card-bg": v("surface-card"),
  "card-fg": v("text-primary"),
  "card-border": v("border-default"),
  "card-radius": v("radius-container"),
  "card-padding": v("spacing-6"),
} as const;

export type ComponentName = keyof typeof components;
export type ComponentTokens = Readonly<Record<ComponentName, string>>;
