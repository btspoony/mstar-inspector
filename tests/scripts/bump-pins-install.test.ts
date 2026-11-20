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
import { expectedInstalls, planEdits, runBump } from "../../scripts/provider-catalog/bump-pins";

const REPO_ROOT = join(import.meta.dir, "../..");
const OMP = "@oh-my-pi/pi-coding-agent";
/** The committed harness ref, read from the registry (the anchor carries it). */
const REPO_HARNESS_REF = /harnessRef: "([0-9a-f]{40})"/.exec(
  readFileSync(join(REPO_ROOT, "src/contracts/sandbox-images.ts"), "utf8"),
)![1]!;
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
  // The CLI pin's manifest + lock: the workflow's restore set names them, so the
  // fixture must carry them or `git checkout -- <paths>` could not restore them.
  write("sandbox-image/cli-global/package.json", `${JSON.stringify({ dependencies: { "@mstar-harness/cli": "4.7.3" } }, null, 2)}\n`);
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

function runBumpCli(root: string, args: string[]): { code: number; out: string } {
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
      const result = runBumpCli(root, ["--omp", "18.22.2"]);
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
      const result = runBumpCli(root, ["--omp", "18.22.2"]);
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
    // The anchor comment's OWN tag and date, read from the committed file — a
    // version-only bump must match the literal the file carries, not an assumed
    // one (round 4's wedge).
    anchorTag: /# mstar-harness plugin, pinned ref [0-9a-f]{40} \(tag v([^,]+),/.exec(
      readFileSync(join(REPO_ROOT, "sandbox-image/Dockerfile"), "utf8"),
    )![1]!,
    bumped: /bumped (\d{4}-\d{2}-\d{2})/.exec(
      readFileSync(join(REPO_ROOT, "sandbox-image/Dockerfile"), "utf8"),
    )![1]!,
  };

  test("a version-only engine move is refused: the ref and anchor move with it", () => {
    // Round 4's wedge: `--engine` alone moved HARNESS_VERSION and the CLI pin
    // while the ref and the Dockerfile tag stayed on the previous release, so the
    // next `--harness-ref` bump threw. The two move together or not at all.
    expect(() => planEdits(from, { engine: "4.8.0" }, "2026-12-01")).toThrow(
      /pass --harness-ref for the tag's commit/,
    );
    // And a ref with no version is refused too: one anchor records one release.
    expect(() =>
      planEdits(from, { harnessRef: "c".repeat(40) }, "2026-12-01"),
    ).toThrow(/pass --engine for the release it belongs to/);
    // The pair together produces a fully consistent plan.
    const edits = planEdits(from, { engine: "4.8.0", harnessRef: "c".repeat(40) }, "2026-12-01");
    const anchor = edits.find((edit) => edit.to.startsWith("# mstar-harness plugin"));
    expect(anchor?.to).toContain(`(tag v4.8.0, bumped 2026-12-01)`);
    expect(anchor?.to).toContain(`pinned ref ${"c".repeat(40)}`);
    expect(edits.find((edit) => edit.to.includes("harnessRef:"))?.to).toContain("c".repeat(40));
    expect(edits.find((edit) => edit.to.includes("HARNESS_VERSION"))?.to).toContain('"4.8.0"');
  });

  test("a later full bump still succeeds from a tree an earlier release left alone", async () => {
    // The sequence the wedge broke: the workflow holds the pins when a tag is
    // missing (it passes no flags — nothing moves), then a later run has both the
    // version and the ref. The second bump must find the anchors it expects.
    const root = scratchRepo("18.22.1");
    try {
      expect(Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
      // The "tag missing" run: no flag reaches the script, so the tree is
      // untouched — the workflow's own decision, reproduced.
      const held = runBumpCli(root, []);
      expect(held.code).toBe(0);
      expect(held.out).toContain("nothing to do");

      // The later run has a ref: version + ref move together and the anchor is
      // rewritten from the literal the file actually carries.
      publish(root, "18.22.2");
      const later = runBumpCli(root, ["--omp", "18.22.2", "--engine", "4.7.3", "--harness-ref", REF]);
      // 4.7.3 is already the engine version here, so only the omp pin moves — the
      // point is that the call is ACCEPTED rather than throwing "does not carry".
      expect(later.code, later.out).toBe(0);
      expect(later.out).not.toContain("does not carry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the expected installs come from each manifest's own range shape", () => {
    const edits = planEdits(from, { engine: "4.8.0", harnessRef: "c".repeat(40) }, "2026-12-01");
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
    // The plan must be built from the pins the committed files actually carry.
    // A hardcoded previous release turns a routine pin bump red for no defect
    // (AGENTS.md: no dependency pins in tests).
    const images = readFileSync(join(REPO_ROOT, "src/contracts/sandbox-images.ts"), "utf8");
    const dockerfile = readFileSync(join(REPO_ROOT, "sandbox-image/Dockerfile"), "utf8");
    const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
      dependencies: Record<string, string>;
    };
    const committed = {
      omp: root.dependencies["@oh-my-pi/pi-coding-agent"]!,
      engine: root.dependencies["@mstar-harness/engine"]!,
      harness: /export const HARNESS_VERSION = "([^"]+)"/.exec(images)![1]!,
      harnessRef: REF,
      anchorTag: /# mstar-harness plugin, pinned ref [0-9a-f]{40} \(tag v([^,]+),/.exec(dockerfile)![1]!,
      bumped: /bumped (\d{4}-\d{2}-\d{2})/.exec(dockerfile)![1]!,
    };
    const nextPatch = (version: string): string => version.replace(/(\d+)$/, (n) => String(Number(n) + 1));
    for (const edit of planEdits(committed, {
      omp: nextPatch(committed.omp),
      engine: nextPatch(committed.harness),
      harnessRef: "b".repeat(40),
    })) {
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


describe("an aborted bump leaves the tree consistent with the HELD pins", () => {
  /** Read the version actually installed in `root`. */
  function installed(root: string, name: string): string | null {
    try {
      return (JSON.parse(readFileSync(join(root, "node_modules", ...name.split("/"), "package.json"), "utf8")) as {
        version: string;
      }).version;
    } catch {
      return null;
    }
  }

  /** The workflow's restore branch, read from the workflow itself: every path it
   *  restores and the exact reinstall command. Extracted rather than restated, so
   *  a test cannot pass against a restore the workflow no longer performs. */
  function workflowRestore(): { paths: string[]; reinstall: string } {
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/refresh-catalog.yml"), "utf8");
    const listed = /PINS=\(([\s\S]*?)\)/.exec(workflow)?.[1];
    expect(listed, "the workflow has no PINS list").toBeDefined();
    // The PINS list is written with two paths per line (`package.json bun.lock`),
    // so split on whitespace, not lines.
    const paths = listed!
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .flatMap((line) => line.split(/\s+/));
    const reinstall = /git checkout -- "\$\{PINS\[@\]\}"\n\s*(bun install --frozen-lockfile)/.exec(workflow)?.[1];
    expect(reinstall, "the restore branch must reinstall after restoring the files").toBeDefined();
    return { paths, reinstall: reinstall! };
  }

  test("the workflow's own restore pair returns the installed tree to the held pin", async () => {
    const root = scratchRepo("18.22.1");
    try {
      // A real git checkout, so `git checkout -- <paths>` is the actual command
      // the workflow runs — not an emulation of it.
      const git = (...args: string[]): void => {
        const proc = Bun.spawnSync(["git", ...args], {
          cwd: root,
          stdout: "pipe",
          stderr: "pipe",
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@example.com",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@example.com",
          },
        });
        expect(proc.exitCode, `${args.join(" ")}: ${proc.stderr.toString()}`).toBe(0);
      };
      // Seed the locks the workflow restores: the fixture ships manifests only,
      // and `git checkout -- bun.lock` needs the file to exist in the commit.
      const seeded = Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(seeded.exitCode, seeded.stderr.toString()).toBe(0);
      for (const dir of ["packages/runner", "sandbox-image/cli-global"]) {
        const seededLock = Bun.spawnSync(["bun", "install", "--lockfile-only"], {
          cwd: join(root, dir),
          stdout: "pipe",
          stderr: "pipe",
        });
        expect(seededLock.exitCode, `${dir}: ${seededLock.stderr.toString()}`).toBe(0);
      }
      const { paths, reinstall } = workflowRestore();
      git("init", "-q", ".");
      git("add", "-A");
      git("commit", "-q", "-m", "held pins");
      expect(installed(root, OMP)).toBe("18.22.1");

      // The bump reaches the ROOT install (the release is published) and then
      // aborts on a later surface — exactly where the workflow's else is reachable.
      publish(root, "18.22.2");
      await expect(
        runBump(root, { omp: "18.22.2" }, {
          afterRootInstall: () => {
            throw new Error("the runner copy could not resolve the release");
          },
        }),
      ).rejects.toThrow(/runner copy/);

      // Mid-failure: manifests AND the installed tree carry the attempted version.
      expect(installed(root, OMP)).toBe("18.22.2");
      expect(
        (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> })
          .dependencies[OMP],
      ).toBe("18.22.2");

      // The workflow's restore branch, verbatim: restore those paths, then the
      // frozen install it names. Without the reinstall the extractor would read
      // 18.22.2 under an 18.22.1 manifest — the divergence the install prevents.
      git("checkout", "--", ...paths);
      const reinstalled = Bun.spawnSync(["bash", "-c", reinstall], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(reinstalled.exitCode, reinstalled.stderr.toString()).toBe(0);
      expect(installed(root, OMP)).toBe("18.22.1");
      // And every RESTORED path is byte-identical to the held commit again (the
      // fixture's own stub tarballs are untracked noise, not restored surfaces).
      const dirty = Bun.spawnSync(["git", "status", "--porcelain", "--", ...paths], {
        cwd: root,
        stdout: "pipe",
      }).stdout.toString().trim();
      expect(dirty).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the restore covers every surface a bump can move", () => {
    // The list is read from the workflow; this asserts it is complete, which is
    // what makes the test above meaningful (a missing path would stay moved).
    const { paths } = workflowRestore();
    for (const path of [
      "package.json",
      "bun.lock",
      "packages/runner/package.json",
      "packages/runner/bun.lock",
      "src/contracts/sandbox-images.ts",
      "sandbox-image/cli-global/package.json",
      "sandbox-image/cli-global/bun.lock",
      "sandbox-image/Dockerfile",
    ]) {
      expect(paths, path).toContain(path);
    }
    // Every file `planEdits` can write is in the list — the coupling that keeps
    // them equal as surfaces are added.
    const from = {
      omp: "18.22.2",
      engine: "^4.7.3",
      harness: "4.7.3",
      harnessRef: REPO_HARNESS_REF,
      anchorTag: "4.7.3",
      bumped: "2026-11-18",
    };
    for (const edit of planEdits(from, { omp: "18.23.0", engine: "4.8.0", harnessRef: "b".repeat(40) })) {
      expect(paths, edit.file).toContain(edit.file);
    }
  });
});
