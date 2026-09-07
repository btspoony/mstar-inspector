/**
 * `scripts/release-surfaces.ts` contract pins (plan 50 T2.1 / D3).
 *
 * The module is the SSOT shared by prepare (bump writer) and validate
 * (gate): VERSION_SURFACES list + RELEASE_VERSION_RE + compareSemver /
 * bumpVersion. These tests pin:
 *
 * - the surface list shape (exactly `package.json`, json kind — plan 51
 *   extends it with `src/version.ts` and updates this pin);
 * - semver acceptance / rejection (semver 2.0.0 §9 prerelease identifiers);
 * - semver 2.0.0 §11 precedence chain used by the `version > current` guard;
 * - AD-2 auto-bump semantics (patch default, --minor, prerelease
 *   graduation — derived from package.json#version, never from tags);
 * - per-kind surface read/write round-trip preserving file formatting.
 */
import { describe, expect, test } from "bun:test";
import {
  CHANGELOGS,
  RELEASE_VERSION_RE,
  VERSION_SURFACES,
  bumpVersion,
  changelogPathFor,
  compareSemver,
  readSurfaceVersion,
  writeSurfaceVersion,
} from "../../scripts/release-surfaces";
import { disposeTempRoot, makeTempRoot, writeAt } from "./helpers";

describe("VERSION_SURFACES SSOT", () => {
  test("exactly package.json with json kind (plan 51 extends the list)", () => {
    expect(VERSION_SURFACES).toHaveLength(1);
    expect(VERSION_SURFACES[0]).toEqual({ label: "package.json", path: "package.json", kind: "json" });
  });

  test("changelog targets: EN + CN pair", () => {
    expect(CHANGELOGS).toEqual([
      { path: "CHANGELOG.md", lang: "en" },
      { path: "CHANGELOG_CN.md", lang: "cn" },
    ]);
    expect(changelogPathFor("en")).toBe("CHANGELOG.md");
    expect(changelogPathFor("cn")).toBe("CHANGELOG_CN.md");
  });
});

describe("RELEASE_VERSION_RE", () => {
  test.each([
    "0.1.0",
    "1.0.0",
    "10.20.30",
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-0.3.7",
    "1.0.0-x.7.z.92",
    "1.0.0-x-", // trailing hyphen inside identifier is legal semver
    "1.0.0-rc.1",
  ])("accepts %s", (v) => {
    expect(RELEASE_VERSION_RE.test(v)).toBe(true);
  });

  test.each([
    "v1.0.0", // v prefix belongs to tags, not bare versions
    "1.0",
    "1.0.0.0",
    "1.0.0+build", // build metadata unsupported by design
    "1.0.0-alpha..1", // empty identifier
    "1.0.0-alpha.01", // leading-zero numeric identifier
    "1.0.0-", // empty prerelease
    "1.0.0-.alpha", // identifier starting with a dot
    "1.0.0-alpha_1", // underscore not allowed
    "",
  ])("rejects %s", (v) => {
    expect(RELEASE_VERSION_RE.test(v)).toBe(false);
  });
});

describe("compareSemver (§11 precedence, guards `version > current`)", () => {
  const chain = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11", // numeric compare, not lexicographic
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.1.0",
    "2.0.0",
  ];

  test("each link sorts below the next", () => {
    for (let i = 0; i < chain.length - 1; i++) {
      const a = chain[i] ?? "";
      const b = chain[i + 1] ?? "";
      expect(compareSemver(a, b)).toBeLessThan(0);
      expect(compareSemver(b, a)).toBeGreaterThan(0);
    }
  });

  test("equal versions compare 0; stable outranks its own prerelease", () => {
    expect(compareSemver("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemver("1.0.0", "1.0.0-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("0.9.9", "1.0.0")).toBeLessThan(0);
  });
});

describe("bumpVersion (AD-2: derived from package.json#version, never tags)", () => {
  test("stable patch bump is the default", () => {
    expect(bumpVersion("0.1.0", "patch")).toBe("0.1.1");
    expect(bumpVersion("1.9.9", "patch")).toBe("1.9.10"); // no component carry
  });

  test("stable minor bump is explicit", () => {
    expect(bumpVersion("0.1.0", "minor")).toBe("0.2.0");
    expect(bumpVersion("3.6.9", "minor")).toBe("3.7.0");
  });

  test("prerelease current graduates: patch -> same-core stable, minor -> next minor", () => {
    expect(bumpVersion("3.6.0-alpha.1", "patch")).toBe("3.6.0");
    expect(bumpVersion("3.6.0-alpha.1", "minor")).toBe("3.7.0");
    expect(bumpVersion("1.0.0-rc.2", "patch")).toBe("1.0.0");
  });
});

describe("json surface read/write", () => {
  test("round-trips the version while preserving formatting and neighbors", async () => {
    const root = makeTempRoot();
    try {
      const original = `{
  "name": "test-repo",
  "version": "0.1.0",
  "private": true
}
`;
      writeAt(root, "package.json", original);
      const surface = VERSION_SURFACES[0]!;

      expect(await readSurfaceVersion(surface, root)).toBe("0.1.0");

      await writeSurfaceVersion(surface, root, "0.1.0", "1.0.0");

      const text = await Bun.file(`${root}/package.json`).text();
      const json = JSON.parse(text);
      expect(json.version).toBe("1.0.0");
      expect(json.name).toBe("test-repo");
      expect(json.private).toBe(true);
      // formatting preserved: text-level replace, not a re-serialization
      expect(text).toContain('"private": true');
      expect(text.endsWith("}\n")).toBe(true);
      expect(await readSurfaceVersion(surface, root)).toBe("1.0.0");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("throws when the expected current version is absent (never silently skips)", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "package.json", `{\n  "version": "1.2.3"\n}\n`);
      const surface = VERSION_SURFACES[0]!;
      await expect(writeSurfaceVersion(surface, root, "0.1.0", "1.0.0")).rejects.toThrow(
        'package.json: could not find version field "0.1.0"',
      );
    } finally {
      disposeTempRoot(root);
    }
  });
});
