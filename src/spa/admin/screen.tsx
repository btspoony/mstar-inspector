/**
 * The console's screen idioms.
 *
 * `Screen` is the ONE spelling of the three non-populated states every screen
 * has: the table skeleton while reading, the inline error with its retry when
 * the read fails, and — through `DataTable`'s own `empty` prop — the page's
 * `EmptyState` when the read succeeds with nothing in it.
 *
 * The console is English-only by decision: it is an operator surface, its copy
 * is literal, and the two shared state primitives are handed the `en` locale so
 * `common.loading` / `common.loadFailed` / `common.retry` still resolve from
 * the single string table — no operator keys are added to the workspace
 * dictionaries, and no key exists in only one locale.
 */
import type { ReactNode } from "react";
import { ErrorState } from "../components/state/ErrorState";
import { PageSkeleton } from "../components/state/PageSkeleton";
import type { Loaded } from "./api";
import type { AdminPageId } from "./pages";

export function Screen<T>({
  state,
  failed,
  onRetry,
  children,
}: {
  state: Loaded<T>;
  /** What this screen's failed read means, e.g. "Could not load the user list." */
  failed: string;
  onRetry: () => void;
  children: (data: T) => ReactNode;
}) {
  if (state.status === "loading") return <PageSkeleton locale="en" kind="table" />;
  if (state.status === "error") return <ErrorState locale="en" message={failed} onRetry={onRetry} />;
  return <>{children(state.data)}</>;
}

/** The console path beside a page title — the design's wayfinding detail. */
export function ConsolePath({ page }: { page: AdminPageId }) {
  return <code className="text-xs text-muted-foreground">/_internal_admin/{page}</code>;
}
