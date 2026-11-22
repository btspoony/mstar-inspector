#!/usr/bin/env bun
/**
 * note: catalog-changes.ts — list the model vocabulary a catalog regeneration REMOVES.
 *
 *   bun run scripts/provider-catalog/catalog-changes.ts <old generated module> <new generated module>
 *
 * The refresh workflow extracts the committed module from the base branch and
 * diffs it against the regenerated one. A removed model id is the failure that
 * bites: an App chain that still names it fails at request time, and nothing in
 * the regeneration itself says so. Removed providers are reported for the same
 * reason. Additions are not listed — they cannot break a stored chain.
 *
 * Prints Markdown; an unchanged vocabulary prints a single "no removals" line.
 * A module that does not expose `PROVIDER_CATALOG` is a malformed input and
 * stops the run instead of reporting an empty (falsely clean) diff.
 */
import path from "node:path";

/** One catalog entry's vocabulary: the row's own models plus every protocol's. */
export type CatalogEntry = { models: readonly string[]; protocols?: readonly { models: readonly string[] }[] };

export type CatalogRemovals = {
  providersDropped: string[];
  modelsRemoved: Record<string, string[]>;
};

function vocabulary(entry: CatalogEntry): Set<string> {
  return new Set([...entry.models, ...(entry.protocols ?? []).flatMap((option) => option.models)]);
}

/** Compare two catalogs provider by provider. */
export function catalogRemovals(
  before: Record<string, CatalogEntry>,
  after: Record<string, CatalogEntry>,
): CatalogRemovals {
  const providersDropped = Object.keys(before)
    .filter((id) => !Object.hasOwn(after, id))
    .sort();
  const modelsRemoved: Record<string, string[]> = {};
  for (const [id, entry] of Object.entries(before)) {
    const next = after[id];
    if (next === undefined) continue;
    const kept = vocabulary(next);
    const removed = [...vocabulary(entry)].filter((modelId) => !kept.has(modelId)).sort();
    if (removed.length > 0) modelsRemoved[id] = removed;
  }
  return { providersDropped, modelsRemoved };
}

/** Render the removals as the pull request body's catalog section. */
export function renderRemovals({ providersDropped, modelsRemoved }: CatalogRemovals): string {
  const providers = Object.entries(modelsRemoved);
  if (providersDropped.length === 0 && providers.length === 0) {
    return "No provider and no model id was removed — every chain that resolved before still resolves.";
  }
  const lines: string[] = [];
  if (providersDropped.length > 0) {
    lines.push(
      `**Providers that disappeared** (${providersDropped.length}) — an App chain naming one fails at request time:`,
      "",
      ...providersDropped.map((id) => `- \`${id}\``),
      "",
    );
  }
  if (providers.length > 0) {
    const total = providers.reduce((sum, [, ids]) => sum + ids.length, 0);
    lines.push(
      `**Model ids removed** (${total} across ${providers.length} providers) — check every App chain that names one:`,
      "",
      ...providers.map(([id, ids]) => `- \`${id}\`: ${ids.map((modelId) => `\`${modelId}\``).join(", ")}`),
      "",
    );
  }
  return lines.join("\n").trimEnd();
}

async function loadCatalog(file: string): Promise<Record<string, CatalogEntry>> {
  const module = (await import(path.resolve(file))) as { PROVIDER_CATALOG?: unknown };
  const catalog = module.PROVIDER_CATALOG;
  if (typeof catalog !== "object" || catalog === null) {
    throw new Error(`${file} does not export PROVIDER_CATALOG`);
  }
  return catalog as Record<string, CatalogEntry>;
}

if (import.meta.main) {
  const [beforePath, afterPath] = process.argv.slice(2);
  if (beforePath === undefined || afterPath === undefined) {
    console.error("usage: bun run scripts/provider-catalog/catalog-changes.ts <old module> <new module>");
    process.exit(2);
  }
  const removals = catalogRemovals(await loadCatalog(beforePath), await loadCatalog(afterPath));
  console.log(renderRemovals(removals));
}
