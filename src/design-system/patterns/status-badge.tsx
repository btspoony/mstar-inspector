/**
 * Status pill — the ONE status face (DESIGN.md § Tone × strength). A state is
 * a tone, painted at one of three strengths: `quiet` withholds the tint (edge
 * and label carry the meaning), `soft` is the tinted pill every status today
 * wears, and `solid` is the fill reserved for the one state that must be seen
 * first.
 *
 * The tones are the token families' names. The retired call-site vocabulary
 * maps onto them one way: brand → accent, warning → warn, error → danger.
 *
 * `data-tone` and `data-strength` are written after `{...props}`: they are the
 * semantic identity, so a caller cannot spoof either through a spread.
 */
import type { ComponentProps } from "react";

import { cn } from "../cn";

export type StatusTone = "neutral" | "accent" | "success" | "warn" | "danger";
export type StatusStrength = "quiet" | "soft" | "solid";

/**
 * Strength × tone faces — the only place the pill's colours are spelled out.
 * The class names are literal because Tailwind scans source text; a composed
 * `--tone-${tone}-bg` would never reach the stylesheet.
 */
const FACES: Record<StatusStrength, Record<StatusTone, string>> = {
  quiet: {
    neutral: "border-(--tone-neutral-border) bg-transparent text-(--tone-neutral-fg)",
    accent: "border-(--tone-accent-border) bg-transparent text-(--tone-accent-fg)",
    success: "border-(--tone-success-border) bg-transparent text-(--tone-success-fg)",
    warn: "border-(--tone-warn-border) bg-transparent text-(--tone-warn-fg)",
    danger: "border-(--tone-danger-border) bg-transparent text-(--tone-danger-fg)",
  },
  soft: {
    neutral: "border-(--tone-neutral-border) bg-(--tone-neutral-bg) text-(--tone-neutral-fg)",
    accent: "border-(--tone-accent-border) bg-(--tone-accent-bg) text-(--tone-accent-fg)",
    success: "border-(--tone-success-border) bg-(--tone-success-bg) text-(--tone-success-fg)",
    warn: "border-(--tone-warn-border) bg-(--tone-warn-bg) text-(--tone-warn-fg)",
    danger: "border-(--tone-danger-border) bg-(--tone-danger-bg) text-(--tone-danger-fg)",
  },
  solid: {
    // A tone fg is chosen to sit on its tint, not on its own solid step, so
    // the label on a solid is the page ink — except accent, whose solid is the
    // primary-action fill and whose label there is `on-brand`.
    neutral: "border-transparent bg-(--tone-neutral-solid) text-(--surface-page)",
    accent: "border-transparent bg-(--tone-accent-solid) text-(--on-brand)",
    success: "border-transparent bg-(--tone-success-solid) text-(--surface-page)",
    warn: "border-transparent bg-(--tone-warn-solid) text-(--surface-page)",
    danger: "border-transparent bg-(--tone-danger-solid) text-(--surface-page)",
  },
};

export function StatusBadge({
  tone,
  strength = "soft",
  className,
  ...props
}: ComponentProps<"span"> & {
  tone: StatusTone;
  /** Defaults to `soft`, the tinted pill. */
  strength?: StatusStrength;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-(--radius-pill) border px-2 py-0.5 whitespace-nowrap text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight)",
        FACES[strength][tone],
        className,
      )}
      {...props}
      data-tone={tone}
      data-strength={strength}
    />
  );
}
