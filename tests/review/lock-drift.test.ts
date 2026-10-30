/**
 * Cross-lockfile drift guard.
 *
 * The root workspace (Worker + tests) and `packages/runner` resolve their own
 * dependency graphs from separate lockfiles; the image installs only the
 * runner's. Every package present in BOTH lockfiles at a different version is
 * therefore a real divergence between what the repo's tests run and what the
 * image runs — `package.json`'s pins do not constrain the transitive graph.
 *
 * The divergence that exists today is deliberate (see
 * `packages/runner/lock-drift.allowlist.json`): the runner lock was resolved
 * fresh, so the pruned-in-image transformers/sharp subtree, the omp SDK's
 * transitive graph, and the optional per-platform sherpa binaries all drifted.
 * This test converts "deliberate" into "checked" — but only over package NAMES
 * plus a reason class. Version numbers are deliberately NOT pinned anywhere:
 * they move on every dependency bump, so pinning them would fail CI on routine
 * upgrades without saying anything about intent. A NEW drifting package name
 * must be added to the allowlist with its reason; a name that stops drifting
 * must be deleted from it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const ROOT_LOCK = join(REPO_ROOT, "bun.lock");
const RUNNER_LOCK = join(REPO_ROOT, "packages", "runner", "bun.lock");
const ALLOWLIST = join(REPO_ROOT, "packages", "runner", "lock-drift.allowlist.json");

/** Why a package is allowed to differ between the two lockfiles. */
const REASONS = ["pruned-in-image", "omp-transitive", "optional-platform"];

type Lockfile = { packages: Record<string, [string, ...unknown[]]> };

/**
 * Resolved version of every `packages` row. A row's name is either a plain
 * package (`@babel/parser`) or bun's nested-disambiguation form
 * (`@opentelemetry/resources/@opentelemetry/core`); the resolved version is
 * the tail of entry[0] (`name@version`).
 */
function resolutions(path: string): Map<string, string> {
  const lock = Bun.JSONC.parse(readFileSync(path, "utf8")) as Lockfile;
  return new Map(
    Object.entries(lock.packages).map(([name, entry]) => {
      const resolved = entry[0];
      return [name, resolved.slice(resolved.lastIndexOf("@") + 1)];
    }),
  );
}

/** Sorted names of every common package whose two resolutions disagree. */
function drift(): string[] {
  const root = resolutions(ROOT_LOCK);
  const runner = resolutions(RUNNER_LOCK);
  const found: string[] = [];
  for (const [name, rootVersion] of root) {
    const runnerVersion = runner.get(name);
    if (runnerVersion !== undefined && runnerVersion !== rootVersion) found.push(name);
  }
  return found.sort();
}

/** Package name → reason class. */
const ALLOWED = Bun.JSONC.parse(readFileSync(ALLOWLIST, "utf8")) as Record<string, string>;

describe("runner ⇄ root lockfile drift", () => {
  test("the observed drift names equal the committed allowlist keys", () => {
    expect(drift()).toEqual(Object.keys(ALLOWED).sort());
  });

  test("every observed drift carries a declared reason class", () => {
    for (const name of drift()) {
      const reason = ALLOWED[name] ?? "<missing>";
      expect({ name, known: REASONS.includes(reason) }).toEqual({ name, known: true });
    }
  });

  test("a parse failure cannot masquerade as a clean graph", () => {
    // Guards the set comparison above: a lockfile whose row shape changed
    // would yield an empty `drift()`, and an empty allowlist would then "match"
    // for the wrong reason. The root graph is strictly larger than the
    // runner's, and the known divergence is non-empty.
    expect(resolutions(ROOT_LOCK).size).toBeGreaterThan(resolutions(RUNNER_LOCK).size);
    expect(drift().length).toBeGreaterThan(0);
  });
});
