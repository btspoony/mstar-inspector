import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "bun:test";

import { survivorSteps } from "../../src/design-system/tokens";

const REPO = new URL("../../", import.meta.url).pathname;
const SCAN_ROOT = join(REPO, "src");
const MODULE_DIR = join(SCAN_ROOT, "design-system");
const ENTRY = "@design-system";

const SPECIFIER = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

const MODULE_FILE = /\.m?[jt]sx?$/;

function inModule(path: string): boolean {
  return path === MODULE_DIR || path.startsWith(MODULE_DIR + sep);
}

function sourceFiles(
  { match, skip }: { match: RegExp; skip?: (dir: string) => boolean },
  dir: string = SCAN_ROOT,
): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (skip?.(full) !== true) out.push(...sourceFiles({ match, skip }, full));
    } else if (match.test(entry)) {
      out.push(relative(REPO, full));
    }
  }
  return out;
}

function violationFor(specifier: string, importer: string): string | null {
  if (specifier === ENTRY) return null;
  if (specifier.startsWith(`${ENTRY}/`)) return "deep-import";
  const target = specifier.startsWith(".")
    ? resolve(dirname(join(REPO, importer)), specifier)
    : resolve(REPO, specifier.replace(/^\/+/, ""));
  return inModule(target) ? "path-into-module" : null;
}

type Violation = { file: string; line: number; rule: string; specifier: string };

function scanContent(content: string, file: string): Violation[] {
  const violations: Violation[] = [];
  SPECIFIER.lastIndex = 0;
  for (let m = SPECIFIER.exec(content); m !== null; m = SPECIFIER.exec(content)) {
    const specifier = m[1] ?? "";
    const rule = violationFor(specifier, file);
    if (rule === null) continue;
    violations.push({
      file,
      line: content.slice(0, m.index).split("\n").length,
      rule,
      specifier,
    });
  }
  return violations;
}

describe("design-system module boundary", () => {
  test("matcher pairs: illegal paths match, the entry alias and unrelated imports do not", () => {
    const matched = (content: string, file = "src/spa/pages/example.tsx") =>
      scanContent(content, file).map((v) => `${v.rule} ${v.specifier}`);

    expect(matched(`import { tokens } from "@design-system/tokens";`)).toEqual([
      "deep-import @design-system/tokens",
    ]);
    expect(matched(`import ref from "@design-system/baseline/reference.html";`)).toEqual([
      "deep-import @design-system/baseline/reference.html",
    ]);
    expect(matched(`import { tokens } from "../design-system/tokens";`, "src/dashboard/x.ts")).toEqual([
      "path-into-module ../design-system/tokens",
    ]);
    expect(matched(`import { entry } from "../../design-system";`, "src/spa/lib/x.ts")).toEqual([
      "path-into-module ../../design-system",
    ]);
    expect(matched(`const m = require("../design-system/index.ts");`, "src/worker/x.ts")).toEqual([
      "path-into-module ../design-system/index.ts",
    ]);
    expect(matched(`import x from "src/design-system/tokens";`)).toEqual([
      "path-into-module src/design-system/tokens",
    ]);

    expect(matched(`import { Button } from "@design-system";`)).toEqual([]);
    expect(matched(`import x from "./design-system";`)).toEqual([]);
    expect(matched(`import { AppAvatar } from "@/components/AppAvatar";\nimport React from "react";`)).toEqual([]);
    expect(matched(`export * from "./tokens";`, "src/contracts/index.ts")).toEqual([]);

    expect(matched(`import x from "src/design-system-utils";`)).toEqual([]);
    expect(matched(`import x from "../design-system-utils/index.ts";`, "src/spa/lib/x.ts")).toEqual([]);
    expect(matched(`import x from "src/design-system/../design-system/tokens";`)).toEqual([
      "path-into-module src/design-system/../design-system/tokens",
    ]);
  });

  test("no consumer imports the module internals or bypasses the entry alias", () => {
    const files = sourceFiles({ match: MODULE_FILE, skip: inModule });
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => inModule(join(REPO, file)))).toEqual([]);

    const violations = files.flatMap((file) => scanContent(readFileSync(join(REPO, file), "utf8"), file));
    const message = violations
      .map((v) => `${v.file}:${v.line}: [${v.rule}] ${v.specifier}`)
      .join("\n");
    expect(violations, `design-system boundary violations:\n${message}`).toEqual([]);
  });
});

const PALETTE_DECLARATION_SITE = "src/spa/styles/tokens.css";
const PALETTE_FAMILIES = [...new Set(survivorSteps.map((step) => step.replace(/-\d+$/, "")))];
const RETIRED_FAMILIES = ["teal", "pink"];
const PALETTE_STEP = new RegExp(
  `--(?:${[...PALETTE_FAMILIES, ...RETIRED_FAMILIES].join("|")})-\\d{3,4}\\b`,
  "g",
);
const TOKEN_CONSUMER_FILE = /\.(?:css|html|m?[jt]sx?)$/;

describe("token layer boundary", () => {
  test("no consumer names a primitive palette step", () => {
    const files = sourceFiles({ match: TOKEN_CONSUMER_FILE, skip: inModule }).filter(
      (file) => file !== PALETTE_DECLARATION_SITE,
    );
    expect(files.length).toBeGreaterThan(0);

    const hits = files.flatMap((file) =>
      readFileSync(join(REPO, file), "utf8")
        .split("\n")
        .flatMap((line, index) =>
          [...line.matchAll(PALETTE_STEP)].map(
            (match) => `${file}:${index + 1}: [palette-step] ${match[0]}`,
          ),
        ),
    );
    expect(hits, `consumers name primitive palette steps:\n${hits.join("\n")}`).toEqual([]);
  });

  test("the matcher is precise: semantic names and bridge keys are legal", () => {
    const matches = (text: string) => [...text.matchAll(PALETTE_STEP)].map((match) => match[0]);
    expect([..."var(--surface-card) var(--border) var(--background)".matchAll(PALETTE_STEP)]).toEqual(
      [],
    );
    expect(matches("var(--spacing-6) var(--typo-heading-24-size) var(--chart-1)")).toEqual([]);
    expect(matches("var(--gray-200)")).toEqual(["--gray-200"]);
    expect(matches("var(--gray-alpha-400)")).toEqual(["--gray-alpha-400"]);
    expect(matches("bg-(--brand-700)")).toEqual(["--brand-700"]);
    expect(matches("var(--gray-1000)")).toEqual(["--gray-1000"]);
    expect(matches("var(--teal-700)")).toEqual(["--teal-700"]);
  });
});

const DARK_VARIANT = /(?<![\w-])dark:[a-z[(]/g;

describe("theme mechanism boundary", () => {
  test("no source file writes a dark: variant", () => {
    const files = sourceFiles({ match: TOKEN_CONSUMER_FILE });
    expect(files.length).toBeGreaterThan(0);

    const hits = files.flatMap((file) =>
      readFileSync(join(REPO, file), "utf8")
        .split("\n")
        .flatMap((line, index) =>
          [...line.matchAll(DARK_VARIANT)].map(
            (match) => `${file}:${index + 1}: [dark-variant] ${line.trim()}`,
          ),
        ),
    );
    expect(hits, `sources split on the OS scheme instead of data-theme:\n${hits.join("\n")}`).toEqual([]);
  });

  test("the dark: matcher is precise: the theme attribute and a JS ternary are legal", () => {
    const matches = (text: string) => [...text.matchAll(DARK_VARIANT)].length;
    expect(matches('className="dark:text-white dark:bg-black"')).toBe(2);
    expect(matches('["dark:[color:var(--x)]"]')).toBe(1);
    expect(matches("isDark ? 'bg-black' : 'bg-white'")).toBe(0);
    expect(matches('document.documentElement.dataset.theme = "dark"')).toBe(0);
    expect(matches("// was dark:text-white before the migration")).toBe(1);
  });
});
