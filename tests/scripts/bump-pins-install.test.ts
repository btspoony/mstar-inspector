import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedInstalls, planEdits, proveLoads, runBump, runtimeSpecifiers } from "../../scripts/provider-catalog/bump-pins";

const REPO_ROOT = join(import.meta.dir, "../..");
const OMP = "@oh-my-pi/pi-coding-agent";
const REPO_HARNESS_REF = /harnessRef: "([0-9a-f]{40})"/.exec(
  readFileSync(join(REPO_ROOT, "src/contracts/sandbox-images.ts"), "utf8"),
)![1]!;
const SCRIPT = join(REPO_ROOT, "scripts/provider-catalog/bump-pins.ts");
const REF = /harnessRef: "([0-9a-f]{40})"/.exec(
  readFileSync(join(REPO_ROOT, "src/contracts/sandbox-images.ts"), "utf8"),
)![1]!;

function packedStub(dir: string, version: string, loads = true): string {
  const build = join(dir, "build", "package");
  rmSync(build, { recursive: true, force: true });
  mkdirSync(build, { recursive: true });
  writeFileSync(
    join(build, "package.json"),
    JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version, type: "module", main: "index.js" }),
  );
  writeFileSync(
    join(build, "index.js"),
    loads ? "export const ok = true;\n" : 'export { ok } from "../../../outside-the-tarball/messages.js";\n',
  );
  const tarball = join(dir, `sdk-${version}${loads ? "" : "-unloadable"}.tgz`);
  const tar = Bun.spawnSync(["tar", "czf", tarball, "-C", join(dir, "build"), "package"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  if (tar.exitCode !== 0) throw new Error(`tar failed: ${tar.stderr.toString()}`);
  return tarball;
}

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
        overrides: { "@oh-my-pi/pi-coding-agent": `file:${tarball}` },
      },
      null,
      2,
    ) + "\n";
  write("package.json", manifest(sdkVersion));
  write("packages/runner/package.json", manifest(sdkVersion));
  write(
    "packages/runner/src/runner.ts",
    'import type { Missing } from "@oh-my-pi/pi-coding-agent/types-only";\nimport { ok } from "@oh-my-pi/pi-coding-agent";\nexport const loaded: boolean = ok;\n',
  );
  write(
    "src/contracts/sandbox-images.ts",
    `export const HARNESS_VERSION = "4.7.3";\nexport const OMP_SANDBOX_IMAGE_PINS = Object.freeze({\n  harnessRef: "${REF}",\n});\n`,
  );
  write("sandbox-image/cli-global/package.json", `${JSON.stringify({ dependencies: { "@mstar-harness/cli": "4.7.3" } }, null, 2)}\n`);
  write(
    "sandbox-image/Dockerfile",
    `# mstar-harness plugin, pinned ref ${REF} (tag v4.7.3, bumped 2026-11-18).\nRUN git -C /opt/mstar-harness fetch --depth 1 origin ${REF}\n`,
  );
  mkdirSync(join(root, "scripts/provider-catalog"), { recursive: true });
  writeFileSync(
    join(root, "scripts/provider-catalog/bump-pins.ts"),
    readFileSync(SCRIPT, "utf8"),
  );
  return root;
}

function publish(root: string, version: string, loads = true, manifests = ["package.json", "packages/runner/package.json"]): void {
  const tarball = packedStub(root, version, loads);
  for (const rel of manifests) {
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
      const seeded = Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" });
      expect(seeded.exitCode).toBe(0);
      const before = join(root, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
      expect(JSON.parse(readFileSync(before, "utf8")).version).toBe("18.22.1");

      publish(root, "18.22.2");
      const result = runBumpCli(root, ["--omp", "18.22.2"]);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toContain("verified @oh-my-pi/pi-coding-agent@18.22.2 installed in");

      const after = join(root, "node_modules/@oh-my-pi/pi-coding-agent/package.json");
      expect(JSON.parse(readFileSync(after, "utf8")).version).toBe("18.22.2");
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
    const root = scratchRepo("18.22.1");
    try {
      const result = runBumpCli(root, ["--omp", "18.22.2"]);
      expect(result.code).not.toBe(0);
      expect(result.out).toContain("the bump did not install");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bump-pins proves the bumped SDK loads, not just installs", () => {
  test("a release that installs but imports a file its tarball omits aborts the bump", () => {
    const root = scratchRepo("18.22.1");
    try {
      expect(Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
      publish(root, "18.22.2", false);
      const result = runBumpCli(root, ["--omp", "18.22.2"]);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out).toContain("verified @oh-my-pi/pi-coding-agent@18.22.2 installed in");
      expect(result.out).toContain("installs but does not load");
      expect(result.out).toContain("outside-the-tarball/messages.js");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a runner tree that does not load aborts the bump even when the root tree loads", () => {
    const root = scratchRepo("18.22.1");
    try {
      expect(Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
      publish(root, "18.22.2", true, ["package.json"]);
      publish(root, "18.22.2", false, ["packages/runner/package.json"]);
      const result = runBumpCli(root, ["--omp", "18.22.2"]);
      expect(result.code, result.out).not.toBe(0);
      expect(result.out).toMatch(/verified 1 runtime SDK import\(s\) load in \.\n/);
      expect(result.out).toMatch(/the bumped tree in \S*runner-lock-\S* installs but does not load/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a loadable release passes the load proof", () => {
    const root = scratchRepo("18.22.1");
    try {
      expect(Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
      publish(root, "18.22.2");
      const result = runBumpCli(root, ["--omp", "18.22.2"]);
      expect(result.code, result.out).toBe(0);
      expect(result.out).toMatch(/verified 1 runtime SDK import\(s\) load in \.\n/);
      expect(result.out).toMatch(/verified 1 runtime SDK import\(s\) load in \S*runner-lock-/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("only value imports of the runner's dependencies are proved", () => {
    const root = scratchRepo("18.22.1");
    try {
      expect(runtimeSpecifiers(root, [OMP])).toEqual([OMP]);
      expect(runtimeSpecifiers(root, ["@mstar-harness/engine"])).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the repository's runner yields SDK specifiers to prove", () => {
    const specifiers = runtimeSpecifiers(REPO_ROOT, [OMP]);
    expect(specifiers).toContain(OMP);
    expect(specifiers.every((specifier) => specifier === OMP || specifier.startsWith(`${OMP}/`))).toBe(true);
  });

  test("an empty specifier list is a refusal, never a silent pass", () => {
    expect(() => proveLoads(REPO_ROOT, [])).toThrow(/nothing to prove the bump loads/);
  });
});

describe("bump-pins edit plan", () => {
  const from = {
    omp: "18.22.2",
    engine: "^4.7.3",
    harness: "4.7.3",
    harnessRef: REF,
    anchorTag: /# mstar-harness plugin, pinned ref [0-9a-f]{40} \(tag v([^,]+),/.exec(
      readFileSync(join(REPO_ROOT, "sandbox-image/Dockerfile"), "utf8"),
    )![1]!,
    bumped: /bumped (\d{4}-\d{2}-\d{2})/.exec(
      readFileSync(join(REPO_ROOT, "sandbox-image/Dockerfile"), "utf8"),
    )![1]!,
  };

  test("a version-only engine move is refused: the ref and anchor move with it", () => {
    expect(() => planEdits(from, { engine: "4.8.0" }, "2026-12-01")).toThrow(
      /pass --harness-ref for the tag's commit/,
    );
    expect(() =>
      planEdits(from, { harnessRef: "c".repeat(40) }, "2026-12-01"),
    ).toThrow(/pass --engine for the release it belongs to/);
    const edits = planEdits(from, { engine: "4.8.0", harnessRef: "c".repeat(40) }, "2026-12-01");
    const anchor = edits.find((edit) => edit.to.startsWith("# mstar-harness plugin"));
    expect(anchor?.to).toContain(`(tag v4.8.0, bumped 2026-12-01)`);
    expect(anchor?.to).toContain(`pinned ref ${"c".repeat(40)}`);
    expect(edits.find((edit) => edit.to.includes("harnessRef:"))?.to).toContain("c".repeat(40));
    expect(edits.find((edit) => edit.to.includes("HARNESS_VERSION"))?.to).toContain('"4.8.0"');
  });

  test("a later full bump still succeeds from a tree an earlier release left alone", async () => {
    const root = scratchRepo("18.22.1");
    try {
      expect(Bun.spawnSync(["bun", "install"], { cwd: root, stdout: "pipe", stderr: "pipe" }).exitCode).toBe(0);
      const held = runBumpCli(root, []);
      expect(held.code).toBe(0);
      expect(held.out).toContain("nothing to do");

      publish(root, "18.22.2");
      const later = runBumpCli(root, ["--omp", "18.22.2", "--engine", "4.7.3", "--harness-ref", REF]);
      expect(later.code, later.out).toBe(0);
      expect(later.out).not.toContain("does not carry");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("the expected installs come from each manifest's own range shape", () => {
    const edits = planEdits(from, { engine: "4.8.0", harnessRef: "c".repeat(40) }, "2026-12-01");
    expect(expectedInstalls(edits, "package.json")).toEqual([
      { name: "@mstar-harness/engine", version: "4.8.0", caret: true },
    ]);
    expect(expectedInstalls(edits, "packages/runner/package.json")).toEqual([
      { name: "@mstar-harness/engine", version: "4.8.0", caret: false },
    ]);
    expect(expectedInstalls(edits, "sandbox-image/cli-global/package.json")).toEqual([
      { name: "@mstar-harness/cli", version: "4.8.0", caret: false },
    ]);
    expect(expectedInstalls(edits, "sandbox-image/Dockerfile")).toEqual([]);
  });

  test("an unchanged pin plans no edit at all", () => {
    expect(planEdits(from, { omp: from.omp, engine: "4.7.3" })).toEqual([]);
  });

  test("every planned literal really is in the committed file", () => {
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
    expect(source).toContain('Bun.spawnSync(["bun", "install", ...args]');
    expect(source).toContain("--frozen-lockfile");
  });
});


describe("an aborted bump leaves the tree consistent with the HELD pins", () => {
  function installed(root: string, name: string): string | null {
    try {
      return (JSON.parse(readFileSync(join(root, "node_modules", ...name.split("/"), "package.json"), "utf8")) as {
        version: string;
      }).version;
    } catch {
      return null;
    }
  }

  function workflowRestore(): { paths: string[]; reinstall: string } {
    const workflow = readFileSync(join(REPO_ROOT, ".github/workflows/refresh-catalog.yml"), "utf8");
    const listed = /PINS=\(([\s\S]*?)\)/.exec(workflow)?.[1];
    expect(listed, "the workflow has no PINS list").toBeDefined();
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

      publish(root, "18.22.2");
      await expect(
        runBump(root, { omp: "18.22.2" }, {
          afterRootInstall: () => {
            throw new Error("the runner copy could not resolve the release");
          },
        }),
      ).rejects.toThrow(/runner copy/);

      expect(installed(root, OMP)).toBe("18.22.2");
      expect(
        (JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies: Record<string, string> })
          .dependencies[OMP],
      ).toBe("18.22.2");

      git("checkout", "--", ...paths);
      const reinstalled = Bun.spawnSync(["bash", "-c", reinstall], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(reinstalled.exitCode, reinstalled.stderr.toString()).toBe(0);
      expect(installed(root, OMP)).toBe("18.22.1");
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
