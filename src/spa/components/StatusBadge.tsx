/**
 * Status pill (DESIGN.md Badge): the ONE pill face — --badge-* component
 * tokens for shape and the semantic 100/800 pairs for tone. Callers pass the
 * label themselves; the page owns what a status means, this owns how it looks.
 *
 * `brand` is the accent moment (primary-action / brand surface), never an
 * alert: warnings stay amber, errors red, success green (DESIGN.md Colors).
 */
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export type StatusTone = "neutral" | "success" | "warning" | "error" | "brand";

/** Tone faces — the only place the pill's colors are spelled out. */
const TONE_FACES: Record<StatusTone, string> = {
  neutral: "bg-(--badge-bg) text-(--badge-fg)",
  success: "bg-(--badge-success-bg) text-(--badge-success-fg)",
  warning: "bg-(--badge-warn-bg) text-(--badge-warn-fg)",
  error: "bg-(--badge-error-bg) text-(--badge-error-fg)",
  brand: "bg-(--brand-700) text-(--background-100)",
};

export function StatusBadge({
  tone,
  className,
  ...props
}: ComponentProps<"span"> & { tone: StatusTone }) {
  return (
    <span
      className={cn(
        "inline-flex h-(--badge-height) items-center rounded-(--badge-radius) px-2 text-xs tracking-(--typo-label-12-tracking) font-medium",
        TONE_FACES[tone],
        className,
      )}
      {...props}
      data-tone={tone}
    />
  );
}
