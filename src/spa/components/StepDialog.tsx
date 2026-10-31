/**
 * Step dialog (DESIGN.md v0.5 ### step-dialog): the multi-step entry shell.
 * The panel surface, the title face and the description face are `ui/dialog`'s
 * `DialogContent` / `DialogTitle` / `DialogDescription` unchanged — container
 * radius through the bridge, `shadow-pop`, `sm:max-w-lg`, the spacing-6
 * padding, the heading-16 title and the label-12 muted description are not
 * restated. This shell adds only the step indicator: label-12, current step on
 * `tone-accent-fg` and the rest on `text-muted`, rendered only when there is
 * more than one step, an out-of-range `currentStep` clamped in so exactly one
 * step is always current.
 *
 * Purely presentational: the footer belongs to the caller (cancel / submit
 * group) and this shell owns only its right alignment, on the primitive's
 * spacing-2 gap. It holds no busy state — a disabled submit and the
 * in-progress copy are the caller's slot contract — and it never closes
 * itself: `open` is the caller's.
 */
import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  cn,
} from "@design-system";

export function StepDialog({
  open,
  onOpenChange,
  title,
  description,
  steps,
  currentStep = 0,
  footer,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  /** Step labels; the indicator appears only when there are two or more. */
  steps?: readonly string[];
  /** 0-based index of the current step; values outside the range clamp in. */
  currentStep?: number;
  footer: ReactNode;
  children: ReactNode;
}) {
  // The contract has no "no current step" state, so an out-of-range index
  // clamps into the label range: exactly one step is always current.
  const stepCount = steps?.length ?? 0;
  const active = stepCount > 0 ? Math.min(Math.max(currentStep, 0), stepCount - 1) : -1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        {steps && steps.length > 1 ? (
          <ol
            data-slot="step-dialog-steps"
            className="flex flex-wrap items-center gap-2 text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight)"
          >
            {steps.map((step, index) => (
              <li
                // Labels are user copy and may repeat; only the position is stable.
                key={index}
                data-slot="step-dialog-step"
                aria-current={index === active ? "step" : undefined}
                className={cn(
                  index === active ? "text-(--tone-accent-fg)" : "text-(--text-muted)",
                )}
              >
                {step}
              </li>
            ))}
          </ol>
        ) : null}
        {children}
        <DialogFooter className="justify-end">{footer}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
