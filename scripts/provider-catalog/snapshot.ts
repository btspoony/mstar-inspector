/**
 * Locating the committed models.dev snapshot — shared by the authoring scripts
 * (fetch / extract / generate) so "which snapshot" has one answer.
 *
 * The snapshot's date is part of its NAME, not a constant in code: a refresh
 * lands as `models.dev-<YYYY-MM-DD>.json`, and ISO dates sort lexicographically,
 * so the last name is the newest. `fetch-models-dev.ts` keeps exactly one such
 * file, so newest-or-only are the same file and a stale snapshot can never win
 * the pick.
 */
import { readdirSync } from "node:fs";
import path from "node:path";

/** The snapshot directory, resolved against the repo root (scripts run from there). */
export const CATALOG_DIR = path.resolve("scripts/provider-catalog");

/** A dated snapshot name; capture 1 is its date. */
export const SNAPSHOT_NAME = /^models\.dev-(\d{4}-\d{2}-\d{2})\.json$/;

/** The newest committed snapshot and its date. Throws when none matches — an
 *  absent snapshot is a broken checkout, never a silently empty catalog. */
export function newestSnapshot(dir: string = CATALOG_DIR): { file: string; date: string } {
  const file = readdirSync(dir)
    .filter((name) => SNAPSHOT_NAME.test(name))
    .sort()
    .at(-1);
  if (file === undefined) {
    throw new Error(
      `no models.dev snapshot in ${dir} — run \`bun run scripts/provider-catalog/fetch-models-dev.ts\``,
    );
  }
  return { file, date: SNAPSHOT_NAME.exec(file)![1]! };
}
