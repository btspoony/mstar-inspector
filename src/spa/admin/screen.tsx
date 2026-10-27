/**
 * The console's screen idioms.
 *
 * `Screen` is the ONE spelling of the three non-populated states every screen
 * has: the table skeleton while reading, the inline error with its retry when
 * the read fails, and — through `DataTable`'s own `empty` prop — the page's
 * `EmptyState` when the read succeeds with nothing in it.
 *
 * The console is bilingual like the workspace shell: `main.tsx` reads
 * `boot.locale` (falling back to `en` when the boot is absent) and hands it to
 * every screen, which forwards it to the shared state primitives so
 * `common.loading` / `common.loadFailed` / `common.retry` resolve in the
 * operator's language. Page copy comes from the `admin.*` dictionary keys.
 */
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
  /** What this screen's failed read means, e.g. "Could not load the user list." */
  failed: string;
  onRetry: () => void;
  /** The boot locale the admin entry read from `boot.locale`. */
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
