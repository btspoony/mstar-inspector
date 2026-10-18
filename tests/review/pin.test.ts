/**
 * Pin assertions for the sandbox image build inputs, engine dep, and the
 * preinstalled @mstar-harness/cli.
 *
 * Expected values come from `OMP_SANDBOX_IMAGE_PINS`
 * (`src/contracts/sandbox-images.ts` — the single declaration of the image's
 * versioned build inputs) and from `package.json` (the dependency authority),
 * never from literals restated here. The Dockerfile cannot read that module
 * (no build args, no env), so it is the one unavoidable second copy: the
 * anchors below lock it to the declaration.
 *
 * POLICY CHANGE (user instruction 2026-09-06): the repo manifest
 * `@mstar-harness/engine` range is the only range allowed in package.json.
 * The sandbox image side stays exact: the Dockerfile fetches a pinned deref
 * commit, the image CLI install is exact, and reproducibility is frozen by
 * bun.lock (packages row resolves to the exact version) +
 * `bun install --frozen-lockfile` in the image build.
 *
 * These tests fail if any Dockerfile pin drifts off the declared value, if the
 * manifest range or the lockfile resolution drifts, if the image CLI install
 * drifts off the exact pin, loses its PATH exposure, or desyncs from the
 * `REVIEW_SKILL_VERSION` prefix — or if the fixture plugin root stops
 * mirroring the pinned layout (`commands/amazing-pr-review.md` +
 * `skills/mstar-audit`).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLUGIN_ROOT_FIXTURE } from "./plugin-root-fixture";
import { OMP_SANDBOX_IMAGE_PINS } from "../../src/contracts/sandbox-images";
import { REVIEW_SKILL_VERSION } from "../../src/store/artifact-store";

const REPO_ROOT = join(import.meta.dir, "..", "..");
/** The runtime-specific Dockerfile location (sandbox-image/omp/). */
const OMP_DOCKERFILE = join(REPO_ROOT, "sandbox-image", "omp", "Dockerfile");
const DOCKERFILE = readFileSync(OMP_DOCKERFILE, "utf8");

describe("sandbox image harness pin", () => {
  test("Dockerfile fetches the declared harness commit", () => {
    expect(DOCKERFILE).toContain(`fetch --depth 1 origin ${OMP_SANDBOX_IMAGE_PINS.harnessRef}`);
  });

  test("Dockerfile comment records the declared tag", () => {
    expect(DOCKERFILE).toContain(`tag v${OMP_SANDBOX_IMAGE_PINS.harnessVersion}`);
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
  test("Dockerfile preinstalls @mstar-harness/cli at the declared exact pin (bun global)", () => {
    // bun global install of the exact pin — image pinning discipline; the
    // repo manifest range exception does NOT extend to the image.
    expect(DOCKERFILE).toContain(
      `bun add --global @mstar-harness/cli@${OMP_SANDBOX_IMAGE_PINS.harnessCliVersion}`,
    );
  });

  test("Dockerfile puts the bun global bin on PATH for sandbox exec", () => {
    expect(DOCKERFILE).toContain('ENV PATH="/root/.bun/bin:${PATH}"');
  });

  test("Dockerfile has no unversioned / @latest CLI install", () => {
    expect(DOCKERFILE).not.toContain("@mstar-harness/cli@latest");
    // Every `@mstar-harness/cli` occurrence in the file (comment included)
    // must be version-pinned — a bare, unversioned install reference fails.
    expect(DOCKERFILE.match(/@mstar-harness\/cli(?!@)/)).toBeNull();
  });
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

describe("review skill version pin", () => {
  test("REVIEW_SKILL_VERSION + suffix binds to the Dockerfile fetch sha prefix", () => {
    const fetchSha = DOCKERFILE.match(/fetch --depth 1 origin ([0-9a-f]{40})/)?.[1];
    expect(fetchSha).toBeDefined();
    // The constant's "+" suffix is the short form of the Dockerfile fetch sha;
    // drift between the two anchors (image ref vs D1 attribution) fails here.
    expect(REVIEW_SKILL_VERSION.endsWith(`+${fetchSha!.slice(0, 8)}`)).toBe(true);
  });

  test("REVIEW_SKILL_VERSION version prefix binds to the Dockerfile CLI pin", () => {
    const versionPrefix = REVIEW_SKILL_VERSION.split("+")[0];
    expect(versionPrefix).toBeDefined();
    // The CLI exact pin and the D1 attribution anchor share the version
    // component: a future bump that updates one but not the other (e.g. a
    // fetch-sha + REVIEW_SKILL_VERSION bump leaving the image CLI at the old
    // version) fails here — same drift net as the fetch-sha binding above.
    expect(DOCKERFILE).toContain(`@mstar-harness/cli@${versionPrefix!}`);
  });
});

describe("fixture plugin root layout", () => {
  test("fixture contains commands/amazing-pr-review.md and skills/mstar-audit", () => {
    expect(existsSync(join(PLUGIN_ROOT_FIXTURE, "commands", "amazing-pr-review.md"))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT_FIXTURE, "skills", "mstar-audit", "SKILL.md"))).toBe(true);
  });
});
