import type { ReactNode } from "react";
import type { Locale } from "../../i18n";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import type { Loaded } from "./api";
import type { AdminPageId } from "./pages";

export function Screen<T>({
  state,
  failed,
  onRetry,
  locale,
  children,
}: {
  state: Loaded<T>;
  failed: string;
  onRetry: () => void;
  locale: Locale;
  children: (data: T) => ReactNode;
}) {
  if (state.status === "loading") return <PageSkeleton locale={locale} kind="table" />;
  if (state.status === "error") return <ErrorState locale={locale} message={failed} onRetry={onRetry} />;
  return <>{children(state.data)}</>;
}

/** The console path beside a page title — the design's wayfinding detail. */
export function ConsolePath({ page }: { page: AdminPageId }) {
  return <code className="text-xs text-muted-foreground">/_internal_admin/{page}</code>;
}
