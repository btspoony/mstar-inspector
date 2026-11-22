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
