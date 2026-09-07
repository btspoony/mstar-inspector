/**
 * `scripts/extract-changelog-section.ts` unit tests (plan 50 T2.3 / D5 / D11).
 *
 * Pins the release-notes feed contract:
 *
 * - `--lang en|cn` selects CHANGELOG.md / CHANGELOG_CN.md via the shared
 *   changelog map in release-surfaces.ts;
 * - the extracted body is the section BETWEEN `## [X.Y.Z] - <date>` and the
 *   next `## [` — header line excluded (the release title carries the
 *   version), and the `- <date>` suffix must NOT leak into the body as a
 *   bullet (a quirk the sibling port fixes: the full header line is consumed);
 * - absent or empty sections fail loudly (exit-1 paths for the workflow).
 */
import { describe, expect, test } from "bun:test";
import {
  extractFromFile,
  extractSection,
  parseArgs,
} from "../../scripts/extract-changelog-section";
import { changelogPathFor } from "../../scripts/release-surfaces";
import { disposeTempRoot, makeTempRoot, writeAt } from "./helpers";

const changelog = [
  "# Changelog",
  "",
  "## [Unreleased]",
  "",
  "## [1.1.0] - 2026-09-01",
  "",
  "### Added",
  "",
  "- Added feature X.",
  "",
  "## [1.0.0] - 2026-08-01",
  "",
  "### Baseline",
  "",
  "- Baseline bullet one.",
  "- Baseline bullet two.",
  "",
  "## [0.9.0] - 2026-07-01",
  "",
  "- Oldest.",
].join("\n");

describe("extractSection (pure)", () => {
  test("middle section: header excluded, date not leaked, body to next section", () => {
    const body = extractSection(changelog, "1.0.0");
    expect(body).toBe("### Baseline\n\n- Baseline bullet one.\n- Baseline bullet two.");
    expect(body).not.toContain("2026-08-01");
    expect(body).not.toContain("## [");
  });

  test("last section: body runs to end of file", () => {
    expect(extractSection(changelog, "0.9.0")).toBe("- Oldest.");
  });

  test("first section below Unreleased: stops at the next header", () => {
    expect(extractSection(changelog, "1.1.0")).toBe("### Added\n\n- Added feature X.");
  });

  test("header without a date suffix still matches", () => {
    expect(extractSection("## [Unreleased]\n\n## [2.0.0]\n\n- Body.\n", "2.0.0")).toBe("- Body.");
  });

  test("missing version throws; empty section throws", () => {
    expect(() => extractSection(changelog, "2.0.0")).toThrow("No CHANGELOG section found for ## [2.0.0]");
    expect(() => extractSection("## [1.0.0] - 2026-08-01\n\n## [0.9.0]\n", "1.0.0")).toThrow(
      "CHANGELOG section for 1.0.0 is empty",
    );
  });
});

describe("extractFromFile (lang routing)", () => {
  test("en reads CHANGELOG.md, cn reads CHANGELOG_CN.md", async () => {
    const root = makeTempRoot();
    try {
      writeAt(root, changelogPathFor("en"), changelog);
      writeAt(
        root,
        changelogPathFor("cn"),
        "# 更新日志\n\n## [Unreleased]\n\n## [1.0.0] - 2026-08-01\n\n### Baseline\n\n- 中文基线要点。\n",
      );

      expect(await extractFromFile({ version: "1.0.0", lang: "en", root })).toContain(
        "- Baseline bullet one.",
      );
      expect(await extractFromFile({ version: "1.0.0", lang: "cn", root })).toBe(
        "### Baseline\n\n- 中文基线要点。",
      );
    } finally {
      disposeTempRoot(root);
    }
  });
});

describe("parseArgs", () => {
  const argv = (...args: string[]) => ["bun", "script", ...args];

  test("defaults to en; bare version accepted; -- forms", () => {
    expect(parseArgs(argv("1.0.0"))).toEqual({ version: "1.0.0", lang: "en", help: false });
    expect(parseArgs(argv("--", "1.0.0", "--lang", "cn"))).toEqual({
      version: "1.0.0",
      lang: "cn",
      help: false,
    });
    expect(parseArgs(argv("1.0.0", "--lang=cn")).lang).toBe("cn");
  });

  test("v-prefixed version rejected (extract takes the bare form, like prepare)", () => {
    expect(() => parseArgs(argv("v1.0.0"))).toThrow("Unknown argument: v1.0.0");
  });

  test("bad --lang value and unknown args throw", () => {
    expect(() => parseArgs(argv("1.0.0", "--lang", "fr"))).toThrow("Unknown --lang value: fr");
    expect(() => parseArgs(argv("--lang"))).toThrow("Unknown --lang value: <none>");
    expect(() => parseArgs(argv("--bogus"))).toThrow("Unknown argument: --bogus");
  });
});
