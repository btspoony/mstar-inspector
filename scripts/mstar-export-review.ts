#!/usr/bin/env bun
/**
 * mstar-export-review.ts — carry one review envelope through the harness persist surface.
 *
 * Carry assessment:
 * - Carries: the validated `mstar.review/v1` envelope, unchanged, as a `review` artifact.
 * - Does not carry: the D1 finding store (reviews/findings) — the harness has no analogue.
 * - Does not carry: publication journal, leases, threads, checks, recurrence, or dashboard rows.
 * - Key: `<installation>-<owner>-<repo>-<pr>-<sha>` from `--idem`; destination `sdd/_reviews/<key>.json`.
 * - Store: FsStore under `--harness` (default: harness root resolved from cwd); `--store` overrides.
 *
 * Usage:
 *   bun run scripts/mstar-export-review.ts --file review.json --idem <i>/<o>/<r>/<pr>/<sha>
 *   bun run scripts/mstar-export-review.ts --idem <i>:<o>:<r>:<pr>:<sha> < review.json
 *   bun run scripts/mstar-export-review.ts --help
 */
import { readFileSync } from "node:fs";
import {
  createFsStore,
  loadStoreModule,
  resolveArtifactPath,
  resolveHarnessDir,
  validateMstarReviewV1,
  type ArtifactStore,
} from "@mstar-harness/engine";

/** Persist keys are a single safe path component (engine `assertSafePathComponent`). */
const KEY_RE = /^[A-Za-z0-9._-]+$/;

/** `<installation>/<owner>/<repo>/<pr>/<sha>` — either `/` or `:` separators. */
export function deriveReviewKey(idem: string): string {
  const parts = idem.split(/[/:]/);
  if (parts.length !== 5 || parts.some((part) => part === "")) {
    throw new Error(
      `--idem must be <installation>/<owner>/<repo>/<pr>/<sha> (5 non-empty parts, "/" or ":" separators) — got ${JSON.stringify(idem)}`,
    );
  }
  const key = parts.join("-");
  if (!KEY_RE.test(key)) {
    throw new Error(`derived persist key ${JSON.stringify(key)} must match ${KEY_RE}`);
  }
  return key;
}

/** Validate the envelope first; nothing is written on a failed gate. */
export function parseEnvelope(raw: string): unknown {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch (error) {
    throw new Error(`review envelope is not valid JSON: ${(error as Error).message}`);
  }
  const gate = validateMstarReviewV1(doc);
  if (!gate.ok) {
    throw new Error(gate.violations.map((v) => `${v.code}: ${v.message}`).join("\n"));
  }
  return doc;
}

export type ExportOptions = {
  raw: string;
  idem: string;
  harnessRoot: string;
  storeModule?: string;
};

/** Write the envelope through the persist surface; returns the destination (default store only). */
export async function exportReview(opts: ExportOptions): Promise<{ key: string; path?: string }> {
  const key = deriveReviewKey(opts.idem);
  const payload = parseEnvelope(opts.raw);
  const store: ArtifactStore = opts.storeModule
    ? await loadStoreModule(opts.storeModule)
    : createFsStore(opts.harnessRoot);
  await store.put({ kind: "review", key, payload });
  return {
    key,
    path: opts.storeModule ? undefined : resolveArtifactPath(opts.harnessRoot, { kind: "review", key }),
  };
}

function printUsage(): void {
  console.log(`Usage: bun run scripts/mstar-export-review.ts --idem <installation>/<owner>/<repo>/<pr>/<sha> [options]

Reads a review envelope from --file <path> (default: stdin), validates it as
mstar.review/v1 with the engine, and writes it to the harness persist surface
as a "review" artifact. Nothing is written when validation fails.

Options:
  --file <path>     Envelope JSON file (default: stdin)
  --idem <tuple>    installation/owner/repo/pr/sha, "/" or ":" separated; key is
                    <installation>-<owner>-<repo>-<pr>-<sha>
  --harness <dir>   Harness root (default: resolved from cwd); not needed with --store
  --store <module>  Custom store module (createArtifactStore / default factory or
                    {put,get} object), same contract the harness CLI accepts;
                    MSTAR_STORE_MODULE is read when the flag is absent
  --help            This text

Carry limits:
  Carries the envelope only — no D1 finding store, publication journal, leases,
  threads, checks, recurrence, or dashboard data.
  Default destination: <harness>/sdd/_reviews/<key>.json
  (a plan-shaped key <yyyymmdd>-<slug> lands at <harness>/sdd/<key>/review/report.json).`);
}

function argValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

async function main(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    printUsage();
    return 0;
  }
  const idem = argValue(args, "--idem");
  if (idem === undefined) {
    console.error("missing --idem; see --help");
    return 2;
  }
  const file = argValue(args, "--file");
  const raw = file === undefined ? readFileSync(0, "utf8") : readFileSync(file, "utf8");
  const storeModule = argValue(args, "--store") ?? process.env["MSTAR_STORE_MODULE"];
  const harnessRoot = argValue(args, "--harness") ?? resolveHarnessDir(process.cwd()) ?? "";
  if (harnessRoot === "" && storeModule === undefined) {
    console.error("no harness root: pass --harness <dir> or run inside a harness");
    return 2;
  }
  try {
    const result = await exportReview({ raw, idem, harnessRoot, storeModule });
    console.log(result.path ?? `review ${result.key} written through custom store`);
    return 0;
  } catch (error) {
    console.error((error as Error).message);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}
