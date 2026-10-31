/**
 * Semantic layer — names the job, not the value. Component tokens and page
 * code may reference only this layer.
 *
 * The colour vocabulary is the r3 prototype's, verbatim. Two things the
 * prototype leaves silent are decided here instead of guessed:
 *
 * - `focus-ring` — links and keyboard focus resolve to `blue-700` in both
 *   themes. The standing repo contract keeps brand cyan off every focus face
 *   (`shadcn-theme.css` re-points `--ring` here). The two-layer focus halo is
 *   composed from `focus-ring` + `surface-page`, so no shadow token is needed.
 * - the chart split — `chart-{n}` is the fill face and `chart-{n}-mark` the
 *   legend-swatch/stroke face. A full stacked bar in the mark's 700 step reads
 *   as a warning light, so fills sit one step quieter.
 *
 * Composition rule: a colour semantic references a primitive step when its
 * value equals that step in that theme; otherwise it carries the literal (a
 * literal is the approved r3 value with no surviving step — never a nearby
 * step re-snapped to fit).
 */

import type { ThemeName } from "./primitives";

/** `var(--x)` — the only way this layer may reach a primitive. */
const v = (name: string): string => `var(--${name})`;

/**
 * Semantic values that do not vary by theme: heights, radii, spacing,
 * typography, motion.
 */
const commonSemantics = {
  "control-h-xs": "24px",
  "control-h-sm": "32px",
  "control-h-md": "40px",
  "row-h-compact": "38px",
  "row-h-comfort": "48px",

  "radius-control": "8px",
  "radius-container": "12px",
  "radius-pill": "9999px",

  "spacing-1": "4px",
  "spacing-2": "8px",
  "spacing-3": "12px",
  "spacing-4": "16px",
  "spacing-6": "24px",
  "spacing-8": "32px",
  "spacing-10": "40px",
  "spacing-16": "64px",
  "spacing-24": "96px",

  "typo-heading-32-family": v("font-sans"),
  "typo-heading-32-size": "32px",
  "typo-heading-32-weight": "600",
  "typo-heading-32-line": "1.2",
  "typo-heading-32-tracking": "-0.02em",
  "typo-heading-24-family": v("font-sans"),
  "typo-heading-24-size": "24px",
  "typo-heading-24-weight": "600",
  "typo-heading-24-line": "1.25",
  "typo-heading-24-tracking": "-0.01em",
  "typo-heading-20-family": v("font-sans"),
  "typo-heading-20-size": "20px",
  "typo-heading-20-weight": "600",
  "typo-heading-20-line": "1.3",
  "typo-heading-20-tracking": "-0.01em",
  "typo-heading-16-family": v("font-sans"),
  "typo-heading-16-size": "16px",
  "typo-heading-16-weight": "600",
  "typo-heading-16-line": "1.4",
  "typo-heading-16-tracking": "0",
  "typo-label-14-family": v("font-sans"),
  "typo-label-14-size": "14px",
  "typo-label-14-weight": "500",
  "typo-label-14-line": "1.4",
  "typo-label-14-tracking": "0",
  "typo-label-12-family": v("font-sans"),
  "typo-label-12-size": "12px",
  "typo-label-12-weight": "500",
  "typo-label-12-line": "1.4",
  "typo-label-12-tracking": "0.01em",
  "typo-copy-16-family": v("font-sans"),
  "typo-copy-16-size": "16px",
  "typo-copy-16-weight": "400",
  "typo-copy-16-line": "1.6",
  "typo-copy-16-tracking": "0",
  "typo-copy-14-family": v("font-sans"),
  "typo-copy-14-size": "14px",
  "typo-copy-14-weight": "400",
  "typo-copy-14-line": "1.55",
  "typo-copy-14-tracking": "0",
  "typo-button-14-family": v("font-sans"),
  "typo-button-14-size": "14px",
  "typo-button-14-weight": "500",
  "typo-button-14-line": "1.4",
  "typo-button-14-tracking": "0",
  "typo-button-12-family": v("font-sans"),
  "typo-button-12-size": "12px",
  "typo-button-12-weight": "500",
  "typo-button-12-line": "1.4",
  "typo-button-12-tracking": "0",
  "typo-mono-13-family": v("font-mono"),
  "typo-mono-13-size": "13px",
  "typo-mono-13-weight": "400",
  "typo-mono-13-line": "1.5",
  "typo-mono-13-tracking": "0",

  "duration-fast": "120ms",
  "duration-base": "160ms",
  "duration-slow": "240ms",
  "ease-out": "cubic-bezier(0.22, 1, 0.36, 1)",
  "ease-in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
} as const;

/** The `@media (prefers-reduced-motion: reduce)` fold: end state, never a delay. */
export const reducedMotionDurations: Readonly<Record<string, string>> = {
  "duration-fast": "1ms",
  "duration-base": "1ms",
  "duration-slow": "1ms",
};

/** Theme-varying semantics. `SemanticName` is derived from these keys, so the
 * light map cannot lose or gain a key without a typecheck failure. */
const darkSemantics = {
  "surface-page": v("background-100"),
  // Not a palette step: the shell band sits between page and raised.
  "surface-shell": "#0d1015",
  "surface-raised": "#12151b",
  "surface-card": v("background-200"),
  "surface-inset": v("gray-200"),
  "surface-overlay": v("background-300"),

  // The hairline under the palette's own alpha ladder.
  "border-subtle": "#ffffff1a",
  "border-default": v("gray-alpha-400"),
  "border-strong": v("gray-alpha-500"),

  "text-primary": v("gray-1000"),
  "text-secondary": v("gray-900"),
  "text-muted": v("gray-700"),
  "text-faint": v("gray-600"),

  "tone-neutral-bg": v("gray-200"),
  "tone-neutral-border": v("gray-alpha-400"),
  "tone-neutral-fg": v("gray-900"),
  "tone-neutral-solid": v("gray-700"),
  // Cyan's 100/300 steps are not in the D14 survivors: the approved values
  // have no step, so the tone carries them.
  "tone-accent-bg": "#042f2e",
  "tone-accent-border": "#155e75",
  "tone-accent-fg": v("brand-700"),
  "tone-accent-solid": v("brand-700"),
  "tone-success-bg": v("green-100"),
  "tone-success-border": v("green-400"),
  "tone-success-fg": v("green-700"),
  "tone-success-solid": v("green-700"),
  "tone-warn-bg": v("amber-100"),
  "tone-warn-border": v("amber-400"),
  "tone-warn-fg": v("amber-700"),
  "tone-warn-solid": v("amber-700"),
  "tone-danger-bg": v("red-100"),
  "tone-danger-border": v("red-400"),
  "tone-danger-fg": v("red-700"),
  "tone-danger-solid": v("red-700"),

  // Fill faces are theme-fixed: the quiet 600 step the approved charts use.
  // Only chart-1 follows the theme, through brand-600.
  "chart-1": v("brand-600"),
  "chart-2": "#16a34a",
  "chart-3": v("amber-600"),
  "chart-4": "#dc2626",
  "chart-5": "#2563a8",
  "chart-6": "#9333ea",
  "chart-1-mark": v("brand-700"),
  "chart-2-mark": v("green-700"),
  "chart-3-mark": v("amber-700"),
  "chart-4-mark": v("red-700"),
  "chart-5-mark": v("blue-700"),
  "chart-6-mark": v("purple-700"),

  // Dark wears the bright cyan face, so the primary label is ink.
  "on-brand": "#06222a",
  "focus-ring": v("blue-700"),

  "shadow-card": "0 1px 2px #02061766, 0 2px 8px #02061733",
  "shadow-pop": "0 8px 24px #02061799, 0 2px 6px #02061766",
} as const;

export type SemanticColorName = keyof typeof darkSemantics;
export type SemanticName = SemanticColorName | keyof typeof commonSemantics;

const lightSemantics: Readonly<Record<SemanticColorName, string>> = {
  "surface-page": v("background-100"),
  "surface-shell": "#f7f9fb",
  "surface-raised": v("background-200"),
  "surface-card": v("background-100"),
  "surface-inset": v("background-200"),
  "surface-overlay": v("background-300"),

  "border-subtle": "#1019280f",
  "border-default": v("gray-alpha-400"),
  "border-strong": v("gray-alpha-500"),

  "text-primary": v("gray-1000"),
  "text-secondary": v("gray-900"),
  "text-muted": v("gray-700"),
  "text-faint": v("gray-600"),

  "tone-neutral-bg": v("gray-200"),
  "tone-neutral-border": v("gray-alpha-400"),
  "tone-neutral-fg": v("gray-700"),
  "tone-neutral-solid": v("gray-600"),
  "tone-accent-bg": "#ecfeff",
  "tone-accent-border": "#a5f3fc",
  "tone-accent-fg": v("brand-700"),
  "tone-accent-solid": v("brand-700"),
  "tone-success-bg": v("green-100"),
  "tone-success-border": v("green-300"),
  // green-700 fails 4.5:1 on the success tint; green-800 is the one step D14
  // keeps for exactly this pair.
  "tone-success-fg": v("green-800"),
  "tone-success-solid": v("green-700"),
  "tone-warn-bg": v("amber-100"),
  // amber-300 is not a D14 survivor; the approved value has no step.
  "tone-warn-border": "#fde68a",
  "tone-warn-fg": v("amber-700"),
  "tone-warn-solid": v("amber-600"),
  "tone-danger-bg": v("red-100"),
  // red-300 is not a D14 survivor; the approved value has no step.
  "tone-danger-border": "#fecaca",
  "tone-danger-fg": v("red-700"),
  // Light danger solid may not take red-600 (D14 names amber-600 only).
  "tone-danger-solid": "#dc2626",

  "chart-1": v("brand-600"),
  "chart-2": "#16a34a",
  "chart-3": v("amber-600"),
  "chart-4": "#dc2626",
  "chart-5": "#2563a8",
  "chart-6": "#9333ea",
  "chart-1-mark": v("brand-700"),
  "chart-2-mark": v("green-700"),
  "chart-3-mark": v("amber-700"),
  "chart-4-mark": v("red-700"),
  "chart-5-mark": v("blue-700"),
  "chart-6-mark": v("purple-700"),

  "on-brand": "#ffffff",
  "focus-ring": v("blue-700"),

  "shadow-card": "0 1px 2px #10192814, 0 2px 8px #1019280f",
  "shadow-pop": "0 8px 24px #1019281f, 0 2px 6px #10192814",
};

/** One theme's complete semantic layer: the shared half plus its own colours. */
export function semanticTokens(theme: ThemeName): Readonly<Record<SemanticName, string>> {
  const colours = theme === "dark" ? darkSemantics : lightSemantics;
  return { ...commonSemantics, ...colours };
}

export type SemanticTokens = Readonly<Record<SemanticName, string>>;
