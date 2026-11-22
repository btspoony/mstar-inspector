import type { ComponentProps } from "react";

import { cn } from "../cn";

export type StatusTone = "neutral" | "accent" | "success" | "warn" | "danger";
export type StatusStrength = "quiet" | "soft" | "solid";

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
      data-slot="status-badge"
      data-tone={tone}
      data-strength={strength}
    />
  );
}
