/**
 * `bump-pins.ts` end to end, against a scratch repository — no registry, no
 * network, so it can run in CI beside the rest of the suite.
 *
 * What must be proven is not that the manifests were rewritten (round 1's tests
 * did that and still shipped the bug): the bump must leave a tree whose
 * INSTALLED `node_modules` carries the pinned version, because the extractor
 * reads the installed SDK and the typechecker/tests run against it. A
 * lockfile-only regeneration passes every file-content assertion while leaving
 * the old package on disk, so these tests assert the installed package's own
 * `package.json` — the same bytes `import "@oh-my-pi/pi-coding-agent"` resolves.
 *
 * The scratch repo pins a local stub through `overrides`, which is how a real
 * bun project can name an exact version without a registry.
 */
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planEdits, expectedInstalls } from "../../scripts/provider-catalog/bump-pins";

const REPO_ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(REPO_ROOT, "scripts/provider-catalog/bump-pins.ts");
/** The committed harness ref — the anchor comment carries it verbatim. */
const REF = /harnessRef: "([0-9a-f]{40})"/.exec(
  readFileSync(join(REPO_ROOT, "src/contracts/sandbox-images.ts"), "utf8"),
)![1]!;

/** A packed stub standing in for one registry release of the SDK. A TARBALL,
 *  not a directory: a directory dependency is symlinked into `node_modules`, so
 *  reading the installed manifest would follow the link to the stub and report
 *  whatever version the test last wrote — which would pass with no install at
 *  all. A tarball is unpacked into a real directory, so the version on disk is
 *  evidence that an install actually ran. */
function packedStub(dir: string, version: string): string {
  const build = join(dir, "build", "package");
  mkdirSync(build, { recursive: true });
  writeFileSync(join(build, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }));
  const tarball = join(dir, `sdk-${version}.tgz`);
  const tar = Bun.spawnSync(["tar", "czf", tarball, "-C", join(dir, "build"), "package"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  return tarball;
}

/** A scratch repo `bump-pins` accepts: both manifests, the image registry's
 *  literals, the Dockerfile's pinned anchor, and a packed stub standing in for
 *  the SDK release the pin names. */
function scratchRepo(sdkVersion: string): string {
  const root = mkdtempSync(join(tmpdir(), "bump-pins-"));
  const write = (rel: string, content: string): void => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  };
  const tarball = packedStub(root, sdkVersion);
  const manifest = (pin: string): string =>
    JSON.stringify(
      {
        name: "bump-pins-fixture",
        private: true,
        dependencies: {
          "@oh-my-pi/pi-coding-agent": pin,
          "@mstar-harness/engine": "4.7.3",
        },
        // Resolution goes to the packed stub, so the asserted on-disk version is
        // the one an install produces.
        // The override names the PACKED release, so the install resolves the
        // version the pin asks for — and `publish()` below re-points it when a
        // newer release exists, exactly as the registry would serve one.
        overrides: { "@oh-my-pi/pi-coding-agent": `file:${tarball}` },
      },
      null,
      2,
    ) + "\n";
  write("package.json", manifest(sdkVersion));
  write("packages/runner/package.json", manifest(sdkVersion));
  write(
    "src/contracts/sandbox-images.ts",
    `export const HARNESS_VERSION = "4.7.3";\nexport const OMP_SANDBOX_IMAGE_PINS = Object.freeze({\n  harnessRef: "${REF}",\n});\n`,
  );
  write(
    "sandbox-image/Dockerfile",
    `# mstar-harness plugin, pinned ref ${REF} (tag v4.7.3, bumped 2026-11-18).\nRUN git -C /opt/mstar-harness fetch --depth 1 origin ${REF}\n`,
  );
  mkdirSync(join(root, "scripts/provider-catalog"), { recursive: true });
  // The script under test, byte-for-byte.
  writeFileSync(
    join(root, "scripts/provider-catalog/bump-pins.ts"),
    readFileSync(SCRIPT, "utf8"),
  );
  return root;
}

/** Publish `version` as the release the override resolves — the registry's
 *  side of a bump. Bun keys a `file:` dependency by PATH, so a new release must
 *  arrive at a new path or the install is a no-op that still passes a
 *  content-only assertion. */
function publish(root: string, version: string): void {
  const tarball = packedStub(root, version);
  for (const rel of ["package.json", "packages/runner/package.json"]) {
    const file = join(root, rel);
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      overrides: Record<string, string>;
    };
    manifest.overrides["@oh-my-pi/pi-coding-agent"] = `file:${tarball}`;
    writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`);
  }
}

function runBump(root: string, args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync(["bun", "run", "scripts/provider-catalog/bump-pins.ts", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode ?? -1, out: `${proc.stdout.toString()}${proc.stderr.toString()}` };
}

describe("bump-pins installs the bumped SDK (not just relocks)", () => {
  test("after the bump the INSTALLED package matches the pin", () => {
    const root = scratchRepo("18.22.1");
    try {
      // The pre-state: an install exists at the old version, as on a developer
      // machine or a CI checkout that just ran `bun install`.
      const seeded = Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(seeded.exitCode).toBe(0);
      const before = join(root, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
      expect(JSON.parse(readFileSync(before, "utf8")).version).toBe("18.22.1");

      publish(root, "18.22.2");
      const result = runBump(root, ["--omp", "18.22.2"]);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("verified @oh-my-pi/pi-coding-agent@18.22.2 installed in");

      // THE assertion: the bytes the extractor and the compiler will read.
      const after = join(root, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
      expect(JSON.parse(readFileSync(after, "utf8")).version).toBe("18.22.2");
      // And the lock the image installs agrees, with a frozen install accepted.
      const frozen = Bun.spawnSync(["bun", "install", "--frozen-lockfile"], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(frozen.exitCode).toBe(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("an install that cannot produce the pinned version aborts the bump", () => {
    // The stub stays at the OLD version, so the install succeeds but the pin is
    // unsatisfiable — a yanked/registry-lagging release. The script must throw
    // rather than leave manifests claiming a tree that does not exist.
    const root = scratchRepo("18.22.1");
    try {
      // Only the OLD tarball exists, so 18.22.2 cannot install.
      const result = runBump(root, ["--omp", "18.22.2"]);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("the bump did not install");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bump-pins edit plan", () => {
  const from = {
    omp: "18.22.2",
    engine: "^4.7.3",
    harness: "4.7.3",
    harnessRef: REF,
    bumped: /bumped (\d{4}-\d{2}-\d{2})/.exec(
      readFileSync(join(REPO_ROOT, "sandbox-image/Dockerfile"), "utf8"),
    )![1]!,
  };

  test("the expected installs come from each manifest's own range shape", () => {
    const edits = planEdits(from, { engine: "4.8.0" }, "2026-12-01");
    // Root keeps the caret; the runner pins exactly — verified separately.
    expect(expectedInstalls(edits, "package.json")).toEqual([
      { name: "@mstar-harness/engine", version: "4.8.0", caret: true },
    ]);
    expect(expectedInstalls(edits, "packages/runner/package.json")).toEqual([
      { name: "@mstar-harness/engine", version: "4.8.0", caret: false },
    ]);
    // The CLI manifest carries the same release; its lock is the whole artifact
    // (no source imports the CLI), so the script relocks it but installs nothing.
    expect(expectedInstalls(edits, "sandbox-image/cli-global/package.json")).toEqual([
      { name: "@mstar-harness/cli", version: "4.8.0", caret: false },
    ]);
    // The Dockerfile and the registry module are not manifests: nothing to install.
    expect(expectedInstalls(edits, "sandbox-image/Dockerfile")).toEqual([]);
  });

  test("an unchanged pin plans no edit at all", () => {
    expect(planEdits(from, { omp: from.omp, engine: "4.7.3" })).toEqual([]);
  });

  test("every planned literal really is in the committed file", () => {
    for (const edit of planEdits(from, { omp: "18.23.0", engine: "4.8.0", harnessRef: "b".repeat(40) })) {
      expect(readFileSync(join(REPO_ROOT, edit.file), "utf8"), edit.file).toContain(edit.from);
    }
  });

  test("the script's documented surfaces cover every lock beside a bumped manifest", () => {
    const source = readFileSync(SCRIPT, "utf8");
    for (const lock of ["bun.lock", "packages/runner/bun.lock", "sandbox-image/cli-global/bun.lock"]) {
      expect(source, lock).toContain(lock);
    }
    // A lockfile-only path would satisfy every content assertion above while
    // installing nothing — the round-1 defect. The script must call a real
    // install, and `--lockfile-only` may only appear where a lock is generated.
    expect(source).toContain('Bun.spawnSync(["bun", "install", ...args]');
    expect(source).toContain("--frozen-lockfile");
  });
});
