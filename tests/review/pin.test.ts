/**
 * Pin assertions for the sandbox image build inputs, engine dep, and the
 * preinstalled @mstar-harness/cli.
 *
 * Expected values come from `OMP_SANDBOX_IMAGE_PINS`
 * (`src/contracts/sandbox-images.ts` — the single declaration of the image's
 * versioned build inputs) and from `package.json` (the dependency authority),
 * never from literals restated here. The Dockerfile and the committed
 * global-install manifest (`sandbox-image/cli-global/`) cannot read that module
 * (no build args, no env), so they are the unavoidable second copies: the
 * anchors below lock them to the declaration.
 *
 * POLICY CHANGE (user instruction 2026-09-06): the repo manifest
 * `@mstar-harness/engine` range is the only range allowed in package.json.
 * The sandbox image side stays exact: the Dockerfile fetches a pinned deref
 * commit, and the CLI is installed from the committed global-install manifest
 * (`@mstar-harness/cli` exact) plus its committed `bun.lock`, replayed with
 * `bun install --frozen-lockfile`. No CLI version literal lives in the
 * Dockerfile — the manifest owns it.
 *
 * These tests fail if any Dockerfile pin drifts off the declared value, if the
 * manifest range or the lockfile resolution drifts, if the two surfaces'
 * shared dependencies (engine, omp SDK) resolve to different versions, if the
 * image CLI install drifts off the exact pin, loses its PATH exposure, or
 * desyncs from the `REVIEW_SKILL_VERSION` prefix, if a build-assertion script
 * loses its COPY/RUN wiring — or if the fixture plugin
 * root stops mirroring the pinned layout (`commands/amazing-pr-review.md` +
 * `skills/mstar-audit`). Transitive drift between the two lockfiles is a
 * separate, allowlisted check: tests/review/lock-drift.test.ts.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLUGIN_ROOT_FIXTURE } from "./plugin-root-fixture";
import { HARNESS_VERSION, OMP_SANDBOX_IMAGE_PINS } from "../../src/contracts/sandbox-images";
import { REVIEW_SKILL_VERSION } from "../../src/store/artifact-store";

const REPO_ROOT = join(import.meta.dir, "..", "..");
/** The runtime-specific Dockerfile location (sandbox-image/). */
const OMP_DOCKERFILE = join(REPO_ROOT, "sandbox-image", "Dockerfile");
const DOCKERFILE = readFileSync(OMP_DOCKERFILE, "utf8");
/** Comment lines dropped: a commented-out instruction is not a live one. */
const INSTRUCTIONS = DOCKERFILE.split("\n")
  .filter((line) => !/^\s*#/.test(line))
  .join("\n");

describe("sandbox image harness pin", () => {
  test("both declared harness versions are the single HARNESS_VERSION constant", () => {
    // The constant is the only place a bump edits; the pin fields and every
    // downstream anchor (committed CLI manifest, engine manifest, lock rows)
    // read it, so one of them left behind fails a comparison below.
    expect(OMP_SANDBOX_IMAGE_PINS.harnessVersion).toBe(HARNESS_VERSION);
    expect(OMP_SANDBOX_IMAGE_PINS.harnessCliVersion).toBe(HARNESS_VERSION);
  });

  test("Dockerfile fetches the declared harness commit", () => {
    expect(DOCKERFILE).toContain(`fetch --depth 1 origin ${OMP_SANDBOX_IMAGE_PINS.harnessRef}`);
  });

  test("Dockerfile comment pairs the declared ref with the declared tag", () => {
    // One line carries both: a bump that moves the commit or the version
    // alone leaves the other half stale and fails here.
    const pinned = DOCKERFILE.match(/^#\s*mstar-harness plugin, pinned ref (\w+) \(tag v(\S+),/m);
    expect(pinned).not.toBeNull();
    expect(pinned!.slice(1)).toEqual([OMP_SANDBOX_IMAGE_PINS.harnessRef, HARNESS_VERSION]);
  });
});

describe("sandbox image base / tool pins", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    engines: Record<string, string>;
  };

  test("Dockerfile FROM pins the declared base image digest", () => {
    expect(DOCKERFILE).toContain(`@${OMP_SANDBOX_IMAGE_PINS.baseImageDigest}`);
  });

  test("Dockerfile COPYs the shim from the declared sandbox tag", () => {
    expect(DOCKERFILE).toContain(
      `COPY --from=docker.io/cloudflare/sandbox:${OMP_SANDBOX_IMAGE_PINS.sandboxShimTag} `,
    );
  });

  test("Dockerfile downloads the declared Bun release", () => {
    expect(DOCKERFILE).toContain(`bun-v${OMP_SANDBOX_IMAGE_PINS.bunVersion}`);
  });

  test("package.json engines.bun floor matches the declared Bun pin", () => {
    // The floor must equal `>=` + the image's pinned Bun: that image is the
    // only environment the CLI actually runs in, so a lower floor stops
    // locking the Bun the image installs while a higher one declares a
    // runtime nothing provides.
    expect(pkg.engines.bun).toBe(`>=${OMP_SANDBOX_IMAGE_PINS.bunVersion}`);
  });

  test("Dockerfile downloads the declared gh release", () => {
    expect(DOCKERFILE).toContain(`gh_${OMP_SANDBOX_IMAGE_PINS.ghVersion}_linux_amd64`);
  });
});

describe("sandbox image CLI pin", () => {
  // The CLI pin's single declaration is the committed global-install manifest
  // the build COPYs and replays. Its exact version must equal the harness
  // constant (image pinning discipline — the repo manifest `^` range exception
  // does NOT extend to the image), and the lock beside it must resolve that
  // same version, otherwise `bun install --frozen-lockfile` installs a CLI the
  // pin never named.
  const CLI_MANIFEST_PATH = join(REPO_ROOT, "sandbox-image", "cli-global", "package.json");
  const CLI_LOCK_PATH = join(REPO_ROOT, "sandbox-image", "cli-global", "bun.lock");
  const cliManifest = JSON.parse(readFileSync(CLI_MANIFEST_PATH, "utf8")) as {
    dependencies: Record<string, string>;
  };
  const cliLock = readFileSync(CLI_LOCK_PATH, "utf8");

  test("the committed global-install manifest pins the CLI to HARNESS_VERSION exactly", () => {
    expect(cliManifest.dependencies["@mstar-harness/cli"]).toBe(
      OMP_SANDBOX_IMAGE_PINS.harnessCliVersion,
    );
  });

  test("the committed lock resolves that exact CLI pin", () => {
    // Both rows: the workspaces declaration mirrors the manifest, the packages
    // row is what the frozen install actually resolves.
    expect(cliLock).toContain(
      `"@mstar-harness/cli": "${OMP_SANDBOX_IMAGE_PINS.harnessCliVersion}"`,
    );
    expect(cliLock).toContain(
      `"@mstar-harness/cli": ["@mstar-harness/cli@${OMP_SANDBOX_IMAGE_PINS.harnessCliVersion}"`,
    );
  });

  test("Dockerfile installs the CLI by replaying the committed manifest + lock", () => {
    // COPY before the RUN that consumes it, and the install is the frozen
    // form: a live `bun add --global` re-resolved the CLI's caret ranges on
    // every build (I-000009), which is exactly what this layer must not do.
    const copy = "COPY sandbox-image/cli-global/package.json sandbox-image/cli-global/bun.lock";
    const install = "bun install --frozen-lockfile --production";
    expect(DOCKERFILE).toContain(copy);
    expect(DOCKERFILE).toContain(install);
    expect(DOCKERFILE.indexOf(copy)).toBeLessThan(DOCKERFILE.indexOf(install));
    expect(DOCKERFILE).not.toContain("bun add --global");
  });

  test("Dockerfile links the installed bins onto PATH", () => {
    expect(DOCKERFILE).toContain("ln -sf ../install/global/node_modules/.bin/mstar ");
    expect(DOCKERFILE).toContain("ln -sf ../install/global/node_modules/.bin/mstar-harness ");
    // The no-node rewrite still targets the linked shim.
    expect(DOCKERFILE).toContain(
      "sed -i --follow-symlinks '1s|.*|#!/usr/bin/env bun|' /root/.bun/bin/mstar",
    );
  });

  test("Dockerfile carries no CLI version literal and no CLI install line", () => {
    // The manifest owns the version now; a version restated on an instruction
    // line is the drift this guards. Comments excluded: the harness-tag
    // comment legitimately names the plugin tag v<version>.
    const version = OMP_SANDBOX_IMAGE_PINS.harnessCliVersion.replace(/\./g, "\\.");
    expect(INSTRUCTIONS.match(new RegExp(`(?<![\\d.])${version}(?![\\d.])`, "g"))).toBeNull();
    expect(INSTRUCTIONS).not.toContain("@latest");
    expect(INSTRUCTIONS).not.toContain("@mstar-harness/cli");
  });

  test("Dockerfile puts the bun global bin on PATH for sandbox exec", () => {
    expect(DOCKERFILE).toContain('ENV PATH="/root/.bun/bin:${PATH}"');
  });
});

describe("sandbox image build assertions", () => {
  // Each capability the image claims is proven by a script the build COPYs and
  // runs. CI never builds the image, so a dropped COPY or RUN would otherwise
  // revert the claim to a comment without failing anything. Instructing on
  // INSTRUCTIONS (not the raw file) keeps a commented-out line from counting.
  for (const script of [
    "verify-seat-supervision.sh",
    "verify-cli-lock.sh",
    "verify-cli-shim.sh",
  ]) {
    test(`Dockerfile runs ${script}`, () => {
      const copy = `COPY sandbox-image/${script} /opt/${script}`;
      const run = `RUN sh /opt/${script}`;
      expect(INSTRUCTIONS).toContain(copy);
      expect(INSTRUCTIONS).toContain(run);
      expect(INSTRUCTIONS.indexOf(copy)).toBeLessThan(INSTRUCTIONS.indexOf(run));
    });
  }
});

describe("engine dependency pin", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const lockfile = readFileSync(join(REPO_ROOT, "bun.lock"), "utf8");
  const engineRange = pkg.dependencies["@mstar-harness/engine"]!;
  const engineVersion = engineRange.replace(/^[\^~]/, "");

  test("@mstar-harness/engine manifest declares the range matching the declared CLI pin", () => {
    // The manifest range tracks the image's CLI pin (policy change
    // 2026-09-06): the range prefix is the manifest exception, the version
    // itself is the declared pin — not a literal restated here.
    expect(engineRange).toBe(`^${OMP_SANDBOX_IMAGE_PINS.harnessCliVersion}`);
  });

  test("@mstar-harness/engine bun.lock packages row resolves to the exact declared version", () => {
    // The packages row names the RESOLVED version verbatim (exact, no range
    // prefix) — this is what `bun install --frozen-lockfile` in the image
    // build installs. A bad resolution (e.g. an older version, or the range
    // leaking into the resolved name) fails this anchor.
    expect(lockfile).toContain(`"@mstar-harness/engine": ["@mstar-harness/engine@${engineVersion}"`);
  });

  test("@mstar-harness/engine bun.lock workspaces row mirrors the manifest range", () => {
    // The workspaces dependencies row mirrors the package.json range
    // declaration; drift here would desync the workspace root from the
    // manifest.
    expect(lockfile).toContain(`"@mstar-harness/engine": "${engineRange}"`);
  });
});

describe("cross-side dependency parity", () => {
  // The root workspace (Worker) and the runner package install their own
  // lockfiles; the image ships the runner's resolution. Both dependencies that
  // exist on BOTH surfaces must resolve to the same version — otherwise the
  // in-image runner runs against a different harness/omp SDK than the repo's
  // tests, and a bump that updates one side's manifest + lock passes CI green.
  // The runner manifest pin is the expected value: the image installs from it
  // (`bun install --frozen-lockfile`), and the root side must not drift off it.
  const runnerPkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "runner", "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const LOCKS = [join(REPO_ROOT, "bun.lock"), join(REPO_ROOT, "packages", "runner", "bun.lock")];

  /** Resolve version of a DEPENDENCY (not a nested `parent/dep` packages row). */
  function resolvedDependency(path: string, dep: string): string | undefined {
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return readFileSync(path, "utf8").match(new RegExp(`"${escaped}": \\["${escaped}@([^"]+)"`))?.[1];
  }

  const PARITY_DEPS = ["@mstar-harness/engine", "@oh-my-pi/pi-coding-agent"] as const;

  for (const dep of PARITY_DEPS) {
    test(`${dep} resolves to the runner manifest pin in both lockfiles`, () => {
      const pinned = runnerPkg.dependencies[dep];
      expect(pinned).toBeDefined();
      expect(LOCKS.map((path) => resolvedDependency(path, dep))).toEqual([pinned, pinned]);
    });
  }

  /** The `workspaces` dependency DECLARATION for `dep` — not its packages row. */
  function declaredDependency(path: string, dep: string): string | undefined {
    const escaped = dep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const text = readFileSync(path, "utf8");
    const packages = text.indexOf('\n  "packages": {');
    if (packages < 0) throw new Error(`no packages section in ${path}`);
    return text.slice(0, packages).match(new RegExp(`"${escaped}": "([^"]+)"`))?.[1];
  }

  test("the runner lock's engine declaration is the harness pin", () => {
    // The resolution row above can agree while the declaration it was resolved
    // from still names the old version — a hand-edited or stale lock then
    // installs the old engine on the next `bun install` and the row follows,
    // out of the pin. Both rows are declared surfaces of the same pin.
    const runnerLock = join(REPO_ROOT, "packages", "runner", "bun.lock");
    expect(declaredDependency(runnerLock, "@mstar-harness/engine")).toBe(HARNESS_VERSION);
  });

  test("the harness engine pin also equals the declared image harness pin", () => {
    expect(runnerPkg.dependencies["@mstar-harness/engine"]).toBe(
      OMP_SANDBOX_IMAGE_PINS.harnessVersion,
    );
  });
});

describe("runner package face", () => {
  const runnerPkg = JSON.parse(
    readFileSync(join(REPO_ROOT, "packages", "runner", "package.json"), "utf8"),
  ) as { version: string; dependencies: Record<string, string> };

  test("runner dependencies are exactly the engine and the omp SDK", () => {
    expect(Object.keys(runnerPkg.dependencies).sort()).toEqual([
      "@mstar-harness/engine",
      "@oh-my-pi/pi-coding-agent",
    ]);
  });

  test("Dockerfile runner package version label mirrors packages/runner/package.json", () => {
    // Exact line, not a substring: `…=0.1.0-rc1` must not satisfy a `0.1.0`
    // expectation, and the label must appear exactly once.
    const labels = Array.from(
      DOCKERFILE.matchAll(/^LABEL\s+io\.mstar\.runner-package-version=(\S+)\s*$/gim),
      (match) => match[1],
    );
    expect(labels).toEqual([runnerPkg.version]);
  });
});

describe("review skill version pin", () => {
  test("REVIEW_SKILL_VERSION + suffix binds to the Dockerfile fetch sha prefix", () => {
    const fetchSha = DOCKERFILE.match(/fetch --depth 1 origin ([0-9a-f]{40})/)?.[1];
    expect(fetchSha).toBeDefined();
    // The constant's "+" suffix is the short form of the Dockerfile fetch sha;
    // drift between the two anchors (image ref vs D1 attribution) fails here.
    expect(REVIEW_SKILL_VERSION.endsWith(`+${fetchSha!.slice(0, 8)}`)).toBe(true);
  });

  test("REVIEW_SKILL_VERSION version prefix binds to the committed CLI pin", () => {
    const versionPrefix = REVIEW_SKILL_VERSION.split("+")[0];
    expect(versionPrefix).toBeDefined();
    // The CLI exact pin and the D1 attribution anchor share the version
    // component: a future bump that updates one but not the other (e.g. a
    // fetch-sha + REVIEW_SKILL_VERSION bump leaving the image CLI at the old
    // version) fails here — same drift net as the fetch-sha binding above.
    // The pin's single declaration is the committed global-install manifest
    // the build replays (see the "sandbox image CLI pin" block above).
    const manifest = JSON.parse(
      readFileSync(join(REPO_ROOT, "sandbox-image", "cli-global", "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect(manifest.dependencies["@mstar-harness/cli"]).toBe(versionPrefix!);
  });
});

describe("fixture plugin root layout", () => {
  test("fixture contains commands/amazing-pr-review.md and skills/mstar-audit", () => {
    expect(existsSync(join(PLUGIN_ROOT_FIXTURE, "commands", "amazing-pr-review.md"))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT_FIXTURE, "skills", "mstar-audit", "SKILL.md"))).toBe(true);
  });
});
