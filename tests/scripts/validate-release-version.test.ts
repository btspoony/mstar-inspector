/**
 * `scripts/validate-release-version.ts` unit tests (plan 50 T2.2 / D4 / D11).
 *
 * Pins the release gate against temp repos (real `git init` where tag state
 * matters):
 *
 * - tag form: `v`-prefixed accepted and stripped, non-semver rejected early;
 * - surface alignment: reads the SAME VERSION_SURFACES list prepare bumps
 *   (json kind -> `version` field), MISSING on absent file, MISMATCH on
 *   stale version;
 * - tag-exists: `git rev-parse refs/tags/v<version>` — existing tag fails
 *   the gate, absent tag passes, non-repo errors propagate;
 * - CLI tag resolution: first positional arg wins over $GITHUB_REF_NAME.
 */
import { describe, expect, test } from "bun:test";
import {
  resolveTag,
  tagExists,
  tagToVersion,
  validateReleaseVersion,
} from "../../scripts/validate-release-version";
import { disposeTempRoot, git, makeTempRoot, writeAt } from "./helpers";

/** Init a git repo with one commit so lightweight tags resolve. */
function initGitRepo(root: string): void {
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "test");
  writeAt(root, ".keep", "");
  git(root, "add", "-A");
  git(root, "commit", "-q", "-m", "init");
}

describe("tag form", () => {
  test("tagToVersion strips the leading v", () => {
    expect(tagToVersion("v1.0.0")).toBe("1.0.0");
    expect(tagToVersion("1.0.0")).toBe("1.0.0");
  });

  test("non-semver tags are rejected before any file/git access", async () => {
    const root = makeTempRoot();
    try {
      for (const bad of ["v1.0", "1.0", "vv1.0.0", "v1.0.0+build", ""]) {
        const result = await validateReleaseVersion(bad, root);
        expect(result.ok).toBe(false);
        expect(result.lines).toHaveLength(1);
        expect(result.lines[0]).toMatch(/^Invalid release tag/);
      }
    } finally {
      disposeTempRoot(root);
    }
  });
});

describe("validateReleaseVersion gate", () => {
  test("aligned surface + free tag passes", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "package.json", `{\n  "version": "1.0.0"\n}\n`);
      initGitRepo(root);

      const result = await validateReleaseVersion("v1.0.0", root);
      expect(result.ok).toBe(true);
      expect(result.lines).toContain("OK package.json: 1.0.0");
      expect(result.lines).toContain("OK tag: v1.0.0 does not exist yet");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("stale surface version fails with MISMATCH", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "package.json", `{\n  "version": "0.1.0"\n}\n`);
      initGitRepo(root);

      const result = await validateReleaseVersion("v1.0.0", root);
      expect(result.ok).toBe(false);
      expect(result.lines).toContain("MISMATCH package.json (package.json): tag v1.0.0, file has 0.1.0");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("absent surface file fails with MISSING", async () => {
    const root = makeTempRoot();
    try {
      initGitRepo(root);
      const result = await validateReleaseVersion("v1.0.0", root);
      expect(result.ok).toBe(false);
      expect(result.lines).toContain("MISSING package.json");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("surface without a version field reads as <missing>", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "package.json", `{\n  "name": "t"\n}\n`);
      initGitRepo(root);
      const result = await validateReleaseVersion("v1.0.0", root);
      expect(result.ok).toBe(false);
      expect(result.lines[0]).toBe("MISMATCH package.json (package.json): tag v1.0.0, file has <missing>");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("existing tag fails the gate (re-release is a bug, not a retry)", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "package.json", `{\n  "version": "1.0.0"\n}\n`);
      initGitRepo(root);
      git(root, "tag", "-a", "v1.0.0", "-m", "release");

      const result = await validateReleaseVersion("v1.0.0", root);
      expect(result.ok).toBe(false);
      expect(result.lines).toContain("TAGEXISTS v1.0.0 already exists — refusing to validate a published version");
    } finally {
      disposeTempRoot(root);
    }
  });

  test("tag on a different version does not trip the gate", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "package.json", `{\n  "version": "1.1.0"\n}\n`);
      initGitRepo(root);
      git(root, "tag", "-a", "v1.0.0", "-m", "release");

      const result = await validateReleaseVersion("v1.1.0", root);
      expect(result.ok).toBe(true);
    } finally {
      disposeTempRoot(root);
    }
  });
});

describe("tagExists (git rev-parse)", () => {
  test("false on a repo without the tag, true after tagging, throws outside a repo", () => {
    const root = makeTempRoot();
    try {
      writeAt(root, "package.json", `{\n  "version": "1.0.0"\n}\n`);
      initGitRepo(root);
      expect(tagExists("1.0.0", root)).toBe(false);
      git(root, "tag", "-a", "v1.0.0", "-m", "release"); // annotated tag shape
      expect(tagExists("1.0.0", root)).toBe(true);
    } finally {
      disposeTempRoot(root);
    }

    const notARepo = makeTempRoot();
    try {
      expect(() => tagExists("1.0.0", notARepo)).toThrow(/git rev-parse failed/);
    } finally {
      disposeTempRoot(notARepo);
    }
  });
});

describe("resolveTag (CLI form)", () => {
  test("first positional arg wins over $GITHUB_REF_NAME", () => {
    expect(resolveTag(["v1.0.0"], { GITHUB_REF_NAME: "v1.0.2" })).toBe("v1.0.0");
    expect(resolveTag([], { GITHUB_REF_NAME: "v1.0.2" })).toBe("v1.0.2");
    expect(resolveTag([], {})).toBeUndefined();
  });
});
