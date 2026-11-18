/**
 * Where the catalog's data lives, and which snapshot is current.
 *
 * A directory says who owns the file: `inputs/` is the only place a human or an
 * external service writes, `generated/` is rebuilt by a step. This module names
 * both and provides the ONE rule for choosing among dated snapshots.
 *
 * The snapshot's date is part of its NAME, not a constant in code: a refresh
 * lands as `inputs/models.dev-<YYYY-MM-DD>.json`, and ISO dates sort
 * lexicographically, so the last name is the newest. `fetch-models-dev.ts` keeps
 * exactly one such file, so newest-or-only are the same file and a stale
 * snapshot can never win the pick.
 *
 * Pure: the file list is an argument, never a directory this module opens. The
 * steps read the directory and pass the names in, so `lib/` stays functions.
 */
import path from "node:path";

/** The directory a human or an external service writes — the only one. */
export const INPUTS_DIR = path.resolve("scripts/provider-catalog/inputs");

/** Where the extractor writes what it derived from the installed package. */
export const GENERATED_DIR = path.resolve("scripts/provider-catalog/generated");

/** A dated snapshot name; capture 1 is its date. */
export const SNAPSHOT_NAME = /^models\.dev-(\d{4}-\d{2}-\d{2})\.json$/;

/** The newest snapshot among `names`, and its date. Throws when none matches —
 *  an absent snapshot is a broken checkout, never a silently empty catalog. */
export function pickNewestSnapshot(names: readonly string[]): { file: string; date: string } {
  const file = names
    .filter((name) => SNAPSHOT_NAME.test(name))
    .sort()
    .at(-1);
  if (file === undefined) {
    throw new Error(
      `no models.dev snapshot in ${INPUTS_DIR} — run \`bun run scripts/provider-catalog/fetch-models-dev.ts\``,
    );
  }
  return { file, date: SNAPSHOT_NAME.exec(file)![1]! };
}
