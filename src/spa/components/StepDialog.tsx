/**
 * Step dialog (DESIGN.md v0.4 ### step-dialog): the multi-step entry shell.
 * The panel surface is `ui/dialog`'s `DialogContent` unchanged — container
 * radius through the bridge, `shadow-pop`, `sm:max-w-lg` and `p-6` are not
 * restated. Title on heading-16, description on label-12 in gray-700; the step
 * indicator is label-12, current step on brand-700 and the rest on gray-700,
 * rendered only when there is more than one step.
 *
 * Purely presentational: the footer belongs to the caller (cancel / submit
 * group) and this shell owns only its right alignment and the spacing-2 gap.
 * It holds no busy state — a disabled submit and the in-progress copy are the
 * caller's slot contract — and it never closes itself: `open` is the caller's.
 */
import type { ReactNode } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

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
  /** 0-based index of the current step. */
  currentStep?: number;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="text-(length:--typo-heading-16-size) leading-(--typo-heading-16-line) tracking-(--typo-heading-16-tracking)">
            {title}
          </DialogTitle>
          {description ? (
            <DialogDescription className="text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight) text-(--gray-700)">
              {description}
            </DialogDescription>
          ) : null}
        </DialogHeader>
        {steps && steps.length > 1 ? (
          <ol
            data-slot="step-dialog-steps"
            className="flex flex-wrap items-center gap-2 text-(length:--typo-label-12-size) leading-(--typo-label-12-line) tracking-(--typo-label-12-tracking) font-(weight:--typo-label-12-weight)"
          >
            {steps.map((step, index) => (
              <li
                key={step}
                data-slot="step-dialog-step"
                aria-current={index === currentStep ? "step" : undefined}
                className={cn(index === currentStep ? "text-(--brand-700)" : "text-(--gray-700)")}
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
