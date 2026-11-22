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
  steps?: readonly string[];
  currentStep?: number;
  footer: ReactNode;
  children: ReactNode;
}) {
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
