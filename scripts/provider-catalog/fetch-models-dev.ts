#!/usr/bin/env bun
/**
 * fetch-models-dev.ts — refresh the committed models.dev snapshot.
 *
 *   bun run scripts/provider-catalog/fetch-models-dev.ts
 *
 * Upstream (`https://models.dev/api.json`) keys `models` by model id and puts
 * each model's sizes in `limit: { context, output }`. The snapshot the
 * generator reads is a trimmed map in the shape `{ [providerId]: { id, name,
 * env, api, doc, model_ids, limits } }` — this script is the ONLY converter, so
 * the format has one producer and one consumer (`generate-provider-catalog.ts`).
 *
 * Rule for dated files: exactly ONE snapshot is kept in git, under `inputs/`
 * (the only directory a human or an external service writes). The payload is
 * rendered first and compared byte-for-byte with the newest committed
 * snapshot, so unchanged upstream data writes nothing and keeps the existing
 * file (whose date is the date the data last changed — the generator reports
 * it as the snapshot's provenance). A changed payload lands as
 * `models.dev-<today>.json` and every older dated file is deleted, so a stale
 * second snapshot can never linger and win a lexicographic "newest" pick.
 *
 * The payload carries only fields the generator consumes. Keys are sorted and
 * nothing time-varying goes inside it, so the same upstream input renders
 * byte-identical.
 *
 * Failure is loud and writes nothing: a non-200 response, a body that is not a
 * provider map, a provider whose `models` is not an id-keyed object, an empty
 * provider map, or a provider without a name aborts before the first write.
 */
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { INPUTS_DIR, SNAPSHOT_NAME } from "./lib/snapshot";

const UPSTREAM_URL = "https://models.dev/api.json";
const FETCH_TIMEOUT_MS = 120_000;

/** A model keeps its sizes only when BOTH are usable token counts — the same
 *  rule the generator applies (`modelLimitOf`), so the snapshot never carries a
 *  half row the size table would have to drop again. */
const Limit = z.object({ context: z.number().int().positive(), output: z.number().int().positive() });

const Model = z.object({
  // Loose: an unusable `limit` (upstream ships 0-output audio and embedding
  // models) costs that model its sizes, not the whole fetch.
  limit: z.object({ context: z.number().optional(), output: z.number().optional() }).optional(),
});

const Provider = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  env: z.array(z.string()).optional(),
  api: z.string().nullish(),
  doc: z.string().nullish(),
  // The shape this script exists for: `models` is an object keyed by model id.
  // An array here means upstream went back to a list, which would make the
  // conversion a copy instead of a mapping — the parse rejects it.
  models: z.record(z.string(), Model),
});

const Upstream = z.record(z.string(), Provider);

/** The size fields the generator consumes from each model's `limit` row. */
export type SnapshotLimit = z.infer<typeof Limit>;

/** One provider in the committed snapshot format. */
export type SnapshotProvider = {
  id: string;
  name: string;
  env: string[];
  api: string | null;
  doc: string | null;
  model_ids: string[];
  limits: Record<string, SnapshotLimit>;
};

/** Convert an upstream `api.json` body into the committed snapshot shape. */
export function convertModelsDev(raw: unknown): Record<string, SnapshotProvider> {
  const parsed = Upstream.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0]!;
    const where = issue.path.length === 0 ? "body" : issue.path.join(".");
    throw new Error(`upstream body is malformed at ${where}: ${issue.message}`);
  }
  const providerIds = Object.keys(parsed.data).sort();
  if (providerIds.length === 0) throw new Error("upstream provider map is empty");

  const snapshot: Record<string, SnapshotProvider> = {};
  for (const providerId of providerIds) {
    const provider = parsed.data[providerId]!;
    const modelIds = Object.keys(provider.models).sort();
    if (modelIds.length === 0) throw new Error(`provider ${JSON.stringify(providerId)} lists no models`);

    const limits: Record<string, SnapshotLimit> = {};
    for (const modelId of modelIds) {
      const limit = Limit.safeParse(provider.models[modelId]!.limit);
      if (limit.success) limits[modelId] = limit.data;
    }

    snapshot[providerId] = {
      id: provider.id ?? providerId,
      name: provider.name,
      env: provider.env ?? [],
      api: provider.api ?? null,
      doc: provider.doc ?? null,
      model_ids: modelIds,
      limits,
    };
  }
  return snapshot;
}

/** The snapshot file's bytes: minified, provider keys in sorted order, one
 *  trailing newline (the format the committed snapshot already uses). */
export function renderSnapshot(snapshot: Record<string, SnapshotProvider>): string {
  const ordered: Record<string, SnapshotProvider> = {};
  for (const providerId of Object.keys(snapshot).sort()) ordered[providerId] = snapshot[providerId]!;
  return `${JSON.stringify(ordered)}\n`;
}

/** Write the payload as `models.dev-<date>.json`, or keep the committed file
 *  when the payload is byte-identical to it. Exactly one dated snapshot survives.
 *
 *  The fetch date is the only place time enters, and it only moves when the
 *  payload moves: an unchanged run keeps the existing file AND its date, so the
 *  generator's provenance line does not churn and the refresh workflow's
 *  `git diff --quiet` stays clean. (Otherwise every daily run would land a
 *  rename-only diff — and, because the old file's date is gone, an empty PR.) */
export async function storeSnapshot(
  dir: string,
  payload: string,
  date = new Date().toISOString().slice(0, 10),
): Promise<{ changed: boolean; file: string; bytes: number; pruned: number }> {
  const existing = (await readdir(dir)).filter((name) => SNAPSHOT_NAME.test(name)).sort();
  // Any committed snapshot with these exact bytes IS this payload; keeping the
  // oldest such name makes the choice independent of how many files survived.
  for (const name of existing) {
    if ((await readFile(path.join(dir, name), "utf8")) === payload) {
      return { changed: false, file: path.join(dir, name), bytes: payload.length, pruned: 0 };
    }
  }
  const target = `models.dev-${date}.json`;
  await writeFile(path.join(dir, target), payload, "utf8");
  const stale = existing.filter((name) => name !== target);
  for (const name of stale) await rm(path.join(dir, name));
  return { changed: true, file: path.join(dir, target), bytes: payload.length, pruned: stale.length };
}

/** Convert, then store. Conversion runs FIRST, so a malformed body throws
 *  before the store is ever reached — a failed refresh leaves the committed
 *  directory exactly as it was. */
export async function refresh(
  dir: string,
  body: unknown,
  date = new Date().toISOString().slice(0, 10),
): Promise<{ changed: boolean; file: string; bytes: number; pruned: number }> {
  return storeSnapshot(dir, renderSnapshot(convertModelsDev(body)), date);
}

async function main(): Promise<void> {
  const response = await fetch(UPSTREAM_URL, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { "user-agent": "mstar-inspector provider-catalog refresh" },
  });
  if (!response.ok) throw new Error(`${UPSTREAM_URL} responded ${response.status} ${response.statusText}`);
  const text = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error(`${UPSTREAM_URL} did not return JSON (${text.length} bytes)`);
  }
  const written = await refresh(INPUTS_DIR, body);
  console.log(
    written.changed
      ? `wrote ${written.file} (${written.bytes} bytes), pruned ${written.pruned} older snapshot(s)`
      : `models.dev snapshot unchanged — kept ${written.file}`,
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(`fetch-models-dev: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
