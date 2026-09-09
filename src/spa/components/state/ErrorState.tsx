/**
 * Page-level error state (plan 57 T4 / AD-582): inline composed error —
 * alert icon, message line (defaulting to `common.loadFailed`), optional
 * retry button (`common.retry`) bound to the page's own reload. `role="
 * alert"` announces assertively (WCAG 4.1.3), matching the PageNotice
 * error semantics — which remain the channel for op-outcome notices and
 * background-reload failures (plan 38/44).
 */
import { CircleAlert } from "lucide-react";
import { t, type Locale } from "../../../i18n";
import { Button } from "@/components/ui/button";

export function ErrorState({
  locale,
  message,
  onRetry,
}: {
  locale: Locale;
  message?: string;
  onRetry?: () => void;
}) {
  return (
    <div data-slot="error-state" role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <CircleAlert aria-hidden="true" className="size-4 shrink-0 text-destructive" />
      {/* Falsy guard (QC round 1 F-008): an empty-string message must fall
          back too — `message ?? …` would render an empty <p> in the alert. */}
      <p className="text-sm text-foreground">{!message ? t(locale, "common.loadFailed") : message}</p>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t(locale, "common.retry")}
        </Button>
      ) : null}
    </div>
  );
}
