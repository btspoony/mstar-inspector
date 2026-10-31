/**
 * The ops surface variant (compass D15). `data-surface="ops"` on the admin
 * document root re-maps one closed set of semantic and primary-action tokens
 * to neutral emphasis: the operator console withholds the accent tone whole
 * rather than inventing a second component set.
 *
 * Every value is a reference to a token that already exists — a literal here
 * would be a new colour, which D15 forbids. `tokens.test.ts` asserts that.
 *
 * Scope is the document root, not a page wrapper, so Radix portals (the
 * flag-confirm dialog, dropdowns, tooltips) inherit the variant.
 */

export const OPS_SURFACE_ATTR = 'data-surface="ops"';

export const opsSurface = {
  "tone-accent-bg": "var(--tone-neutral-bg)",
  "tone-accent-border": "var(--tone-neutral-border)",
  "tone-accent-fg": "var(--tone-neutral-fg)",
  "tone-accent-solid": "var(--tone-neutral-solid)",
  "button-primary-bg": "var(--tone-neutral-bg)",
  "button-primary-fg": "var(--text-primary)",
  "button-primary-border": "var(--border-strong)",
  // The base hover brightens the brand step; withholding the accent means the
  // ops action hovers one plane up the neutral ladder instead. Without this
  // line the ops primary would hover toward the accent, leaking back the tone
  // D15 withholds.
  "button-primary-hover-bg": "var(--surface-overlay)",
} as const;

export type OpsSurfaceToken = keyof typeof opsSurface;
