/**
 * `scripts/release-surfaces.ts` contract pins (plan 50 T2.1 / D3; plan 51 T2
 * extends the surface list).
 *
 * The module is the SSOT shared by prepare (bump writer) and validate
 * (gate): VERSION_SURFACES list + RELEASE_VERSION_RE + compareSemver /
 * bumpVersion. These tests pin:
 *
 * - the surface list shape (package.json json + src/version.ts ts-const —
 *   plan 51 D4);
 * - semver acceptance / rejection (semver 2.0.0 §9 prerelease identifiers);
 * - semver 2.0.0 §11 precedence chain used by the `version > current` guard;
 * - AD-2 auto-bump semantics (patch default, --minor, prerelease
 *   graduation — derived from package.json#version, never from tags);
 * - per-kind surface read/write round-trip preserving file formatting
 *   (ts-const regenerates from the canonical template);
 * - the checked-in `src/version.ts` is byte-identical to what prepare would
 *   regenerate at the repo's current version (single-writer discipline);
 * - unknown surface kinds throw (exhaustive switch guards).
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  CHANGELOGS,
  RELEASE_VERSION_RE,
  VERSION_SURFACES,
  bumpVersion,
  changelogPathFor,
  compareSemver,
  readSurfaceVersion,
  renderVersionTs,
  writeSurfaceVersion,
} from "../../scripts/release-surfaces";
import type { VersionSurface } from "../../scripts/release-surfaces";
import { disposeTempRoot, makeTempRoot, writeAt } from "./helpers";

describe("VERSION_SURFACES SSOT", () => {
  test("exactly package.json (json) + src/version.ts (ts-const) — plan 51 D4", () => {
    expect(VERSION_SURFACES).toHaveLength(2);
    expect(VERSION_SURFACES[0]).toEqual({ label: "package.json", path: "package.json", kind: "json" });
    expect(VERSION_SURFACES[1]).toEqual({
      label: "src/version.ts",
      path: "src/version.ts",
      kind: "ts-const",
    });
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

describe("ts-const surface (src/version.ts, plan 51 D4)", () => {
  const surface = VERSION_SURFACES[1]!;

  test("round-trips the version, regenerating from the canonical template", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "src/version.ts", renderVersionTs("0.1.0"));

      expect(await readSurfaceVersion(surface, root)).toBe("0.1.0");

      await writeSurfaceVersion(surface, root, "0.1.0", "1.0.0");

      const text = await Bun.file(`${root}/src/version.ts`).text();
      // header preserved verbatim + constant bumped: byte-exact template output
      expect(text).toBe(renderVersionTs("1.0.0"));
      expect(text).toContain("Generated by `release:prepare` — do not edit");
      expect(text.endsWith('export const APP_VERSION = "1.0.0";\n')).toBe(true);
      expect(await readSurfaceVersion(surface, root)).toBe("1.0.0");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("read returns undefined when the APP_VERSION export is absent", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "src/version.ts", "// no constant here\nexport const OTHER = 1;\n");
      expect(await readSurfaceVersion(surface, root)).toBeUndefined();
    } finally {
      disposeTempRoot(root);
    }
  });

  test("commented-out or mid-line APP_VERSION text is not read (QC F-001 line anchor)", async () => {
    const root = makeTempRoot();
    try {
      // a commented-out decoy above the real line: the real one still reads
      writeAt(
        root,
        "src/version.ts",
        `// export const APP_VERSION = "9.9.9";\n${renderVersionTs("1.0.0")}`,
      );
      expect(await readSurfaceVersion(surface, root)).toBe("1.0.0");

      // decoy only -> no readable export
      writeAt(root, "src/version.ts", '// export const APP_VERSION = "9.9.9";\n');
      expect(await readSurfaceVersion(surface, root)).toBeUndefined();

      // mid-line occurrence -> not the generated line shape
      writeAt(root, "src/version.ts", 'const x = 1; export const APP_VERSION = "9.9.9";\n');
      expect(await readSurfaceVersion(surface, root)).toBeUndefined();
    } finally {
      disposeTempRoot(root);
    }
  });

  test("write throws on drift instead of silently overwriting a hand edit", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "src/version.ts", renderVersionTs("9.9.9"));
      await expect(writeSurfaceVersion(surface, root, "0.1.0", "1.0.0")).rejects.toThrow(
        'src/version.ts: could not find APP_VERSION "0.1.0" (found "9.9.9")',
      );
    } finally {
      disposeTempRoot(root);
    }
  });

  test("write throws when the file has no APP_VERSION export", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "src/version.ts", "export const OTHER = 1;\n");
      await expect(writeSurfaceVersion(surface, root, "0.1.0", "1.0.0")).rejects.toThrow(
        'src/version.ts: could not find APP_VERSION "0.1.0" (no APP_VERSION export found)',
      );
    } finally {
      disposeTempRoot(root);
    }
  });

  test("checked-in src/version.ts is byte-identical to the template at the repo version", async () => {
    // Single-writer discipline: the committed file must be exactly what
    // prepare would regenerate — any hand edit shows up here (and in
    // release:validate as MISMATCH after a bump).
    const repoRoot = join(import.meta.dir, "..", "..");
    const pkg = (await Bun.file(join(repoRoot, "package.json")).json()) as { version: string };
    const checkedIn = await Bun.file(join(repoRoot, "src", "version.ts")).text();
    expect(checkedIn).toBe(renderVersionTs(pkg.version));
  });
});

describe("unknown surface kind (exhaustive switch guards)", () => {
  // Runtime-invalid entry (as if a future kind hit an older switch): the
  // `never`-typed default arms fail the BUILD for new union members; this
  // cast exercises the run-time throw for entries that dodge the types.
  const bogus = {
    label: "bogus",
    path: "bogus.yaml",
    kind: "yaml",
  } as unknown as VersionSurface;

  test("readSurfaceVersion throws — never silently reads <missing>", async () => {
    const root = makeTempRoot();
    try {
      await expect(readSurfaceVersion(bogus, root)).rejects.toThrow("Unknown surface kind");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("writeSurfaceVersion throws — never silently skips a bump", async () => {
    const root = makeTempRoot();
    try {
      await expect(writeSurfaceVersion(bogus, root, "0.1.0", "1.0.0")).rejects.toThrow(
        "Unknown surface kind",
      );
    } finally {
      disposeTempRoot(root);
    }
  });
});
