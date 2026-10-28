/**
 * Minimal browser stub for static renders of the SPA pages.
 *
 * Bun's test runtime provides no `document`/`window`, yet the pages read
 * `location.pathname` (their API base), `location.search` (URL state) and
 * `location.origin` (the one absolute URL a page prints — the App's webhook
 * delivery URL) during render. This installs exactly those reads for the
 * duration of a render and removes them again, so one test can render the SAME
 * page under two pathnames without leaking state into its neighbours.
 */
export function withLocation<T>(pathname: string, run: () => T, origin = "http://localhost"): T {
  const scope = globalThis as {
    location?: { pathname: string; search: string; origin: string };
    window?: { location: { pathname: string; search: string; origin: string } };
  };
  const location = { pathname, search: "", origin };
  scope.location = location;
  scope.window = { location };
  try {
    return run();
  } finally {
    delete scope.location;
    delete scope.window;
  }
}
