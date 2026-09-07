/**
 * `scripts/prepare-release.ts` unit tests (plan 50 T2.1 / D3 / D11).
 *
 * Pins the release-prepare contract against throwaway repo layouts:
 *
 * - fragment parsing (frontmatter `category`, `<!-- CN -->` split, defaults,
 *   inline ` # comment` stripping — QC A3);
 * - CLI arg forms (bare `X.Y.Z`, `--minor`, `--allow-empty`; `v`-prefixed
 *   rejected);
 * - bilingual section assembly: EN bullets -> CHANGELOG.md, CN bullets ->
 *   CHANGELOG_CN.md, missing CN block -> EN bullets reused (protocol
 *   fallback); categories grouped, fragment order preserved;
 * - `## [X.Y.Z] - <date>` section inserted under `## [Unreleased]`;
 *   fail-closed rerun idempotency (duplicate section throws) and
 *   no-trailing-newline robustness (QC A2);
 * - AD-2 auto-bump (patch default, --minor, prerelease graduation from
 *   package.json#version — never from tags);
 * - guards: explicit version must be > current (compareSemver), semver RE,
 *   empty unreleased/ requires --allow-empty;
 * - end state: changelogs updated, package.json bumped, fragments archived
 *   to `.changes/archive/<X.Y.Z>/`.
 */
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import {
  buildSectionBody,
  insertSection,
  parseArgs,
  parseFragment,
  prepareRelease,
} from "../../scripts/prepare-release";
import { disposeTempRoot, makeTempRoot, setupReleaseRepo, writeAt } from "./helpers";

const argv = (...args: string[]) => ["bun", "script", ...args];

describe("parseFragment", () => {
  test("splits frontmatter category and CN block", () => {
    const frag = parseFragment(
      "a.md",
      `---\ncategory: Added\n---\n\n- EN one.\n- EN two.\n\n<!-- CN -->\n- CN 一。\n- CN 二。\n`,
    );
    expect(frag.category).toBe("Added");
    expect(frag.en).toBe("- EN one.\n- EN two.");
    expect(frag.cn).toBe("- CN 一。\n- CN 二。");
  });

  test("no frontmatter -> category undefined; no CN block -> cn empty", () => {
    const frag = parseFragment("b.md", `- Only EN bullet.\n`);
    expect(frag.category).toBeUndefined();
    expect(frag.en).toBe("- Only EN bullet.");
    expect(frag.cn).toBe("");
  });

  test("blank category falls back to undefined (-> Changed at assembly)", () => {
    const frag = parseFragment("c.md", `---\ncategory:   \n---\n\n- EN.\n`);
    expect(frag.category).toBeUndefined();
  });

  test("trailing inline ` # comment` in frontmatter values is stripped (QC A3)", () => {
    const frag = parseFragment(
      "d.md",
      `---\ncategory: Added        # optional; drives the ### header\n---\n\n- EN.\n`,
    );
    expect(frag.category).toBe("Added");
  });

  test("`#` glued to the value without whitespace is kept", () => {
    const frag = parseFragment("e.md", `---\ncategory: A#B\n---\n\n- EN.\n`);
    expect(frag.category).toBe("A#B");
  });
});

describe("parseArgs", () => {
  test("no args -> auto patch, no allowEmpty", () => {
    expect(parseArgs(argv())).toEqual({ version: undefined, bump: "patch", allowEmpty: false, help: false });
  });

  test("bare version accepted; -- separator filtered", () => {
    expect(parseArgs(argv("--", "1.0.0")).version).toBe("1.0.0");
    expect(parseArgs(argv("1.0.0-alpha.1")).version).toBe("1.0.0-alpha.1");
  });

  test("v-prefixed version is rejected (prepare takes the bare form)", () => {
    expect(() => parseArgs(argv("v1.0.0"))).toThrow("Unknown argument: v1.0.0");
  });

  test("--minor / --patch / --allow-empty / --help flags", () => {
    expect(parseArgs(argv("--minor")).bump).toBe("minor");
    expect(parseArgs(argv("--minor", "--patch")).bump).toBe("patch");
    expect(parseArgs(argv("--allow-empty")).allowEmpty).toBe(true);
    expect(parseArgs(argv("--help")).help).toBe(true);
  });

  test("unknown argument throws", () => {
    expect(() => parseArgs(argv("--bogus"))).toThrow("Unknown argument: --bogus");
  });
});

describe("buildSectionBody (bilingual assembly)", () => {
  const frags = [
    parseFragment("a.md", `---\ncategory: Baseline\n---\n\n- EN A1.\n\n<!-- CN -->\n- CN A1。\n`),
    parseFragment("b.md", `---\ncategory: Baseline\n---\n\n- EN B1.\n\n<!-- CN -->\n- CN B1。\n`),
    parseFragment("c.md", `- EN C1 (no category, no CN).\n`),
  ];

  test("groups by category in first-seen order, default Changed", () => {
    const body = buildSectionBody("en", frags);
    expect(body).toBe(
      "### Baseline\n\n- EN A1.\n- EN B1.\n\n### Changed\n\n- EN C1 (no category, no CN).",
    );
  });

  test("cn takes CN bullets, reusing EN when the CN block is missing", () => {
    const body = buildSectionBody("cn", frags);
    expect(body).toContain("- CN A1。");
    expect(body).toContain("- CN B1。");
    expect(body).toContain("- EN C1 (no category, no CN)."); // fallback
    expect(body).not.toContain("<!-- CN -->");
  });
});

describe("insertSection", () => {
  const changelog = "# Changelog\n\nIntro.\n\n## [Unreleased]\n\n## [0.0.9] - 2025-01-01\n\n- Old.\n";

  test("lands directly under ## [Unreleased], above older sections", () => {
    const next = insertSection(changelog, "1.0.0", "2026-09-07", "- New.");
    const iUn = next.indexOf("## [Unreleased]");
    const iNew = next.indexOf("## [1.0.0] - 2026-09-07");
    const iOld = next.indexOf("## [0.0.9] - 2025-01-01");
    expect(iUn).toBeGreaterThanOrEqual(0);
    expect(iUn).toBeLessThan(iNew);
    expect(iNew).toBeLessThan(iOld);
    expect(next).toContain("\n## [Unreleased]\n\n## [1.0.0] - 2026-09-07\n\n- New.\n\n## [0.0.9]");
  });

  test("empty body -> header-only section (--allow-empty shape)", () => {
    const next = insertSection(changelog, "1.0.0", "2026-09-07", "");
    expect(next).toContain("\n## [Unreleased]\n\n## [1.0.0] - 2026-09-07\n\n## [0.0.9]");
  });

  test("duplicate version section throws (fail-closed rerun idempotency, QC A2)", () => {
    expect(() => insertSection(changelog, "0.0.9", "2026-09-07", "- Again.")).toThrow(
      "Changelog already has a section for [0.0.9] — refusing to duplicate.",
    );
    // exact bracket match: 1.0.0 must NOT trip on a 1.0.0-alpha.1 section
    const withPre = insertSection(changelog, "1.0.0-alpha.1", "2026-09-07", "- Pre.");
    expect(() => insertSection(withPre, "1.0.0-alpha.1", "2026-09-07", "- Pre.")).toThrow(
      "already has a section for [1.0.0-alpha.1]",
    );
    expect(insertSection(withPre, "1.0.0", "2026-09-07", "- Stable.")).toContain(
      "## [1.0.0] - 2026-09-07",
    );
  });

  test("`## [Unreleased]` as final line without trailing newline appends below it (QC A2)", () => {
    const bare = "# Changelog\n\nIntro.\n\n## [Unreleased]";
    const next = insertSection(bare, "1.0.0", "2026-09-07", "- New.");
    expect(next.startsWith("# Changelog")).toBe(true); // title not displaced
    const iUn = next.indexOf("## [Unreleased]");
    const iNew = next.indexOf("## [1.0.0] - 2026-09-07");
    expect(iUn).toBeGreaterThan(-1);
    expect(iNew).toBeGreaterThan(iUn);
    expect(next).toContain("## [Unreleased]\n\n## [1.0.0] - 2026-09-07\n\n- New.\n\n");
  });

  test("without an Unreleased header, inserts after the header block", () => {
    const noUn = "# Changelog\n\nIntro.\n\n## [0.0.9] - 2025-01-01\n\n- Old.\n";
    const next = insertSection(noUn, "1.0.0", "2026-09-07", "- New.");
    const iIntro = next.indexOf("Intro.");
    const iNew = next.indexOf("## [1.0.0]");
    const iOld = next.indexOf("## [0.0.9]");
    expect(iIntro).toBeGreaterThan(-1);
    expect(iIntro).toBeLessThan(iNew);
    expect(iNew).toBeLessThan(iOld);
  });
});

describe("prepareRelease (end to end on a temp repo)", () => {
  test("explicit version: assembles both changelogs, bumps package.json, archives fragments", async () => {
    const root = makeTempRoot();
    try {
      setupReleaseRepo(root);
      const result = await prepareRelease({
        version: "1.0.0",
        bump: "patch",
        allowEmpty: false,
        root,
        date: "2026-09-07",
      });

      expect(result).toEqual({
        current: "0.1.0",
        version: "1.0.0",
        fragments: ["a-baseline.md", "z-fix.md"],
      });

      const en = await Bun.file(join(root, "CHANGELOG.md")).text();
      expect(en).toContain("## [1.0.0] - 2026-09-07");
      expect(en).toContain("### Baseline\n\n- EN baseline bullet.\n- EN baseline second.");
      expect(en).toContain("### Fixed\n\n- EN fix bullet (no CN block).");
      expect(en.indexOf("## [Unreleased]")).toBeLessThan(en.indexOf("## [1.0.0]"));

      const cn = await Bun.file(join(root, "CHANGELOG_CN.md")).text();
      expect(cn).toContain("## [1.0.0] - 2026-09-07");
      expect(cn).toContain("- CN 基线要点。");
      expect(cn).toContain("- EN fix bullet (no CN block)."); // CN-missing fallback
      expect(cn).not.toContain("EN baseline bullet.");

      const pkg = (await Bun.file(join(root, "package.json")).json()) as { version: string };
      expect(pkg.version).toBe("1.0.0");

      expect(readdirSync(join(root, ".changes", "archive", "1.0.0")).sort()).toEqual([
        "a-baseline.md",
        "z-fix.md",
      ]);
      expect(readdirSync(join(root, ".changes", "unreleased")).filter((f) => f.endsWith(".md"))).toEqual([]);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("auto mode: patch+1 from package.json#version (AD-2)", async () => {
    const root = makeTempRoot();
    try {
      setupReleaseRepo(root);
      const result = await prepareRelease({ bump: "patch", allowEmpty: false, root, date: "2026-09-07" });
      expect(result.version).toBe("0.1.1");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("auto mode --minor: minor+1", async () => {
    const root = makeTempRoot();
    try {
      setupReleaseRepo(root);
      const result = await prepareRelease({ bump: "minor", allowEmpty: false, root, date: "2026-09-07" });
      expect(result.version).toBe("0.2.0");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("auto mode from a prerelease current graduates to the same-core stable", async () => {
    const root = makeTempRoot();
    try {
      setupReleaseRepo(root, "1.0.0-alpha.1");
      const result = await prepareRelease({ bump: "patch", allowEmpty: false, root, date: "2026-09-07" });
      expect(result.version).toBe("1.0.0");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("prerelease target versions are first-class (AC1 dry-run shape)", async () => {
    const root = makeTempRoot();
    try {
      setupReleaseRepo(root);
      const result = await prepareRelease({
        version: "1.0.0-alpha.1",
        bump: "patch",
        allowEmpty: false,
        root,
        date: "2026-09-07",
      });
      expect(result.version).toBe("1.0.0-alpha.1");
      const en = await Bun.file(join(root, "CHANGELOG.md")).text();
      expect(en).toContain("## [1.0.0-alpha.1] - 2026-09-07");
      expect(existsSync(join(root, ".changes", "archive", "1.0.0-alpha.1", "a-baseline.md"))).toBe(true);
    } finally {
      disposeTempRoot(root);
    }
  });

  test("guard: version must be strictly greater than current", async () => {
    const root = makeTempRoot();
    try {
      setupReleaseRepo(root);
      await expect(
        prepareRelease({ version: "0.1.0", bump: "patch", allowEmpty: false, root, date: "2026-09-07" }),
      ).rejects.toThrow("Version 0.1.0 must be greater than current 0.1.0.");
      await expect(
        prepareRelease({ version: "0.0.9", bump: "patch", allowEmpty: false, root, date: "2026-09-07" }),
      ).rejects.toThrow("Version 0.0.9 must be greater than current 0.1.0.");
      // first cut 1.0.0 > 0.1.0 passes
      await expect(
        prepareRelease({ version: "1.0.0", bump: "patch", allowEmpty: false, root, date: "2026-09-07" }),
      ).resolves.toMatchObject({ version: "1.0.0" });
    } finally {
      disposeTempRoot(root);
    }
  });

  test("guard: non-semver version rejected", async () => {
    const root = makeTempRoot();
    try {
      setupReleaseRepo(root);
      await expect(
        prepareRelease({ version: "1.0", bump: "patch", allowEmpty: false, root, date: "2026-09-07" }),
      ).rejects.toThrow('Invalid version "1.0"');
    } finally {
      disposeTempRoot(root);
    }
  });

  test("partial-failure rerun aborts before duplicating a section (QC A2)", async () => {
    const root = makeTempRoot();
    try {
      setupReleaseRepo(root);
      await prepareRelease({ version: "1.0.0-alpha.1", bump: "patch", allowEmpty: false, root, date: "2026-09-07" });
      // half-applied shape: the changelog section landed, but the bump was
      // reverted and the fragment never moved — as if the run died between
      // writes. Retrying the same version must fail closed, not duplicate.
      writeAt(
        root,
        "package.json",
        `{\n  "name": "test-repo",\n  "version": "0.1.0",\n  "private": true\n}\n`,
      );
      writeAt(
        root,
        ".changes/unreleased/a-baseline.md",
        `---\ncategory: Baseline\n---\n\n- EN baseline bullet.\n\n<!-- CN -->\n- CN 基线要点。\n`,
      );

      await expect(
        prepareRelease({ version: "1.0.0-alpha.1", bump: "patch", allowEmpty: false, root, date: "2026-09-07" }),
      ).rejects.toThrow("Changelog already has a section for [1.0.0-alpha.1]");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("empty unreleased/ requires --allow-empty; with it, header-only section and no archive", async () => {
    const root = makeTempRoot();
    try {
      setupReleaseRepo(root);
      const { rmSync } = await import("node:fs");
      rmSync(join(root, ".changes", "unreleased", "a-baseline.md"));
      rmSync(join(root, ".changes", "unreleased", "z-fix.md"));

      await expect(
        prepareRelease({ bump: "patch", allowEmpty: false, root, date: "2026-09-07" }),
      ).rejects.toThrow("No fragments found in .changes/unreleased/");

      const result = await prepareRelease({ bump: "patch", allowEmpty: true, root, date: "2026-09-07" });
      expect(result.version).toBe("0.1.1");
      const en = await Bun.file(join(root, "CHANGELOG.md")).text();
      expect(en).toContain("## [0.1.1] - 2026-09-07");
      expect(existsSync(join(root, ".changes", "archive", "0.1.1"))).toBe(false);
    } finally {
      disposeTempRoot(root);
    }
  });
});
