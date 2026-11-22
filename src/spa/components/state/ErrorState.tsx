import { CircleAlert } from "lucide-react";
import { t, type Locale } from "../../../i18n";
import { Button } from "@design-system";

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
      <p className="text-sm text-foreground">{!message ? t(locale, "common.loadFailed") : message}</p>
      {onRetry ? (
        <Button type="button" variant="outline" size="sm" onClick={onRetry}>
          {t(locale, "common.retry")}
        </Button>
      ) : null}
    </div>
  );
}
