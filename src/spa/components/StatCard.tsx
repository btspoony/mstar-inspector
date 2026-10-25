/**
 * Stat idiom: a muted uppercase label (DESIGN.md label-12 step) over a
 * one-step-larger tabular figure, with an optional hint line and an optional
 * 0–1 progress bar. `StatCard` renders one definition-list group, so it is
 * written for the `StatGrid` wrapper — the semantic `<dl>` — and not for
 * standalone use. Both are props-only: pages pass resolved strings.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The fill width is a static class ladder because Tailwind only compiles
 * classes it can find in source. shortcut: the bar quantises to 10% steps,
 * upgrade to a CSS-var width if sub-step precision is ever needed.
 */
const FILL_WIDTHS = [
  "w-0",
  "w-[10%]",
  "w-[20%]",
  "w-[30%]",
  "w-[40%]",
  "w-[50%]",
  "w-[60%]",
  "w-[70%]",
  "w-[80%]",
  "w-[90%]",
  "w-full",
] as const;

export function StatCard({
  label,
  value,
  hint,
  progress,
}: {
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  /** 0–1 filled ratio; values outside the range clamp. */
  progress?: number;
}) {
  const step =
    progress === undefined ? -1 : Math.round(Math.min(1, Math.max(0, progress)) * 10);

  return (
    <div className="flex flex-col gap-1">
      <dt className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) uppercase text-muted-foreground">
        {label}
      </dt>
      <dd className="text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking) font-medium tabular-nums">
        {value}
      </dd>
      {hint ? <dd className="text-xs text-muted-foreground">{hint}</dd> : null}
      {step < 0 ? null : (
        <div
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={step * 10}
          className="mt-1 h-1 overflow-hidden rounded-(--rounded-full) bg-(--background-300)"
        >
          <div
            className={cn("h-full rounded-(--rounded-full) bg-(--primary)", FILL_WIDTHS[step])}
          />
        </div>
      )}
    </div>
  );
}

/** Plain responsive columns; three across once the viewport has room. */
export function StatGrid({ children }: { children: ReactNode }) {
  return <dl className="grid gap-4 sm:grid-cols-3">{children}</dl>;
}
