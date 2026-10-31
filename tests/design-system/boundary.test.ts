/**
 * Module boundary guard for `src/design-system/` (plan 201, task 1).
 *
 * Product source reaches the design system one way only: the `@design-system`
 * alias, which every program maps onto `src/design-system/index.ts`. A second
 * door — `@design-system/tokens/...`, a relative path into the module, or a
 * bare `src/design-system/...` specifier — re-blurs the layer the iteration
 * exists to establish, so this guard rejects them.
 *
 * Scope: every TypeScript file under `src/` outside `src/design-system/`.
 * Deliberately out of scope:
 * - `src/design-system/**` itself — internals import each other freely;
 * - `scripts/**` — the generation chain (tasks 3-7) reads the DOM-free token
 *   source directly, which is the only reason the root program can compile it
 *   without DOM lib;
 * - `tests/**` — gates and suites, not shipped consumers.
 *
 * Matcher contract: import specifiers are string literals, so a lexical scan
 * sees them whole (the `tests/spa/visual-discipline.test.ts` house pattern).
 * Relative specifiers are resolved against the importing file's directory
 * before judging, so `src/spa/pages.tsx` importing `./design-system` is a
 * different module and never matches.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { describe, expect, test } from "bun:test";

import { survivorSteps } from "../../src/design-system/tokens";

const REPO = new URL("../../", import.meta.url).pathname;
const SCAN_ROOT = join(REPO, "src");
const MODULE_DIR = join(SCAN_ROOT, "design-system");
const ENTRY = "@design-system";

/** `from "x"`, `import "x"`, `require("x")`, `import("x")` — capture group 1 is the specifier. */
const SPECIFIER = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

/**
 * Module files whose imports count as consumers: `.ts`, `.tsx`, `.mts`, `.mjs`,
 * `.js`, `.jsx`, `.cjs`. A `.js`/`.mjs` consumer can still reach the module by
 * path (a script, a config, a worker entry), so a scan that only saw
 * `.ts`/`.tsx` would pass while such a file bypassed the single door.
 */
const MODULE_FILE = /\.m?[jt]sx?$/;

/** True when `path` is the module root or lies anywhere beneath it. */
function inModule(path: string): boolean {
  return path === MODULE_DIR || path.startsWith(MODULE_DIR + sep);
}

/**
 * Violation rule label for one specifier, or `null` when it is legal.
 *
 * Both branches resolve to an absolute path and are judged by `inModule`, so a
 * bare specifier is compared as a path rather than by string prefix: a sibling
 * like `src/design-system-utils` is a different module, while
 * `src/design-system/../design-system/tokens` still lands inside this one.
 */
function violationFor(specifier: string, importer: string): string | null {
  if (specifier === ENTRY) return null;
  if (specifier.startsWith(`${ENTRY}/`)) return "deep-import";
  const target = specifier.startsWith(".")
    ? resolve(dirname(join(REPO, importer)), specifier)
    : resolve(REPO, specifier.replace(/^\/+/, ""));
  return inModule(target) ? "path-into-module" : null;
}

type Violation = { file: string; line: number; rule: string; specifier: string };

/** Scans `content` as if it were the repo-relative file `file`. */
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

/** Repo-relative TS/JS module files under `src/`, minus the module itself. */
function consumerFiles(dir: string = SCAN_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!inModule(full)) out.push(...consumerFiles(full));
    } else if (MODULE_FILE.test(entry)) {
      out.push(relative(REPO, full));
    }
  }
  return out;
}

describe("design-system module boundary", () => {
  test("matcher pairs: illegal paths match, the entry alias and unrelated imports do not", () => {
    const matched = (content: string, file = "src/spa/pages/example.tsx") =>
      scanContent(content, file).map((v) => `${v.rule} ${v.specifier}`);

    // must match: alias subpaths
    expect(matched(`import { tokens } from "@design-system/tokens";`)).toEqual([
      "deep-import @design-system/tokens",
    ]);
    expect(matched(`import ref from "@design-system/baseline/reference.html";`)).toEqual([
      "deep-import @design-system/baseline/reference.html",
    ]);
    // must match: relative paths that land inside the module
    expect(matched(`import { tokens } from "../design-system/tokens";`, "src/dashboard/x.ts")).toEqual([
      "path-into-module ../design-system/tokens",
    ]);
    expect(matched(`import { entry } from "../../design-system";`, "src/spa/lib/x.ts")).toEqual([
      "path-into-module ../../design-system",
    ]);
    expect(matched(`const m = require("../design-system/index.ts");`, "src/worker/x.ts")).toEqual([
      "path-into-module ../design-system/index.ts",
    ]);
    // must match: bare root-relative specifier
    expect(matched(`import x from "src/design-system/tokens";`)).toEqual([
      "path-into-module src/design-system/tokens",
    ]);

    // must NOT match: the one legal entry
    expect(matched(`import { Button } from "@design-system";`)).toEqual([]);
    // must NOT match: a same-named sibling directory of the importer
    expect(matched(`import x from "./design-system";`)).toEqual([]);
    // must NOT match: unrelated specifiers the repo actually uses
    expect(matched(`import { AppAvatar } from "@/components/AppAvatar";\nimport React from "react";`)).toEqual([]);
    expect(matched(`export * from "./tokens";`, "src/contracts/index.ts")).toEqual([]);

    // must NOT match: a sibling module whose name merely starts the same way —
    // the prefix test this replaced reported it as a violation.
    expect(matched(`import x from "src/design-system-utils";`)).toEqual([]);
    expect(matched(`import x from "../design-system-utils/index.ts";`, "src/spa/lib/x.ts")).toEqual([]);
    // must still match: a bare specifier that escapes and comes back in
    expect(matched(`import x from "src/design-system/../design-system/tokens";`)).toEqual([
      "path-into-module src/design-system/../design-system/tokens",
    ]);
  });

  test("no consumer imports the module internals or bypasses the entry alias", () => {
    const files = consumerFiles();
    // Guard against a scan that silently found nothing (wrong root, moved tree).
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => inModule(join(REPO, file)))).toEqual([]);

    const violations = files.flatMap((file) => scanContent(readFileSync(join(REPO, file), "utf8"), file));
    const message = violations
      .map((v) => `${v.file}:${v.line}: [${v.rule}] ${v.specifier}`)
      .join("\n");
    expect(violations, `design-system boundary violations:\n${message}`).toEqual([]);
  });
});

/**
 * The second half of the same boundary: a consumer names the semantic and
 * component layers (and the shadcn bridge keys), never a primitive palette
 * step. This is the guard DESIGN.md promised for the commit that migrates the
 * last primitive reader — plan 204's `pages.module.css` sweep was that commit.
 *
 * It reads source text in every syntax a reference is written in:
 * `var(--gray-200)` in a stylesheet, `bg-(--gray-200)` in markup, and a
 * `--gray-200:` declaration in an inline `style` attribute. The generated
 * stylesheet is the palette's one declaration site; `src/design-system/` is
 * where the layers are composed, so both are exempt.
 *
 * The family names are derived from `survivorSteps`, so the matcher follows the
 * palette instead of a second hand-maintained list. The two families the D14
 * band rule retired whole (`teal`, `pink`) are named here because no survivor
 * can derive them, and a consumer naming one is exactly the return this guard
 * exists to catch. The step grammar is the real one: three digits, plus the
 * four-digit `gray-1000` top step.
 *
 * Blind spots, by construction: a text scan cannot see a computed name — a key
 * access (`tokenLayers("dark").primitive["gray-800"]`) or a string composed
 * from parts — and `tests/design-system/tokens.test.ts`'s exact-survivor pin is
 * the backstop for exactly those shapes.
 */
const PALETTE_DECLARATION_SITE = "src/spa/styles/tokens.css";
/** Family names the palette declares today, read off the surviving steps. */
const PALETTE_FAMILIES = [...new Set(survivorSteps.map((step) => step.replace(/-\d+$/, "")))];
/** D14 dropped these families whole; their names must never come back. */
const RETIRED_FAMILIES = ["teal", "pink"];
const PALETTE_STEP = new RegExp(
  `--(?:${[...PALETTE_FAMILIES, ...RETIRED_FAMILIES].join("|")})-\\d{3,4}\\b`,
  "g",
);
/** Every syntax a consumer can write a token reference in. */
const TOKEN_CONSUMER_FILE = /\.(?:css|html|m?[jt]sx?)$/;

/** Repo-relative consumer sources under `src/`, minus the module and the declaration site. */
function tokenConsumerFiles(dir: string = SCAN_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!inModule(full)) out.push(...tokenConsumerFiles(full));
    } else if (TOKEN_CONSUMER_FILE.test(entry)) {
      const file = relative(REPO, full);
      if (file !== PALETTE_DECLARATION_SITE) out.push(file);
    }
  }
  return out;
}

describe("token layer boundary", () => {
  test("no consumer names a primitive palette step", () => {
    const files = tokenConsumerFiles();
    // Guard against a scan that silently found nothing (wrong root, moved tree).
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
    // Numeric semantic names are not palette steps: the family list, not the
    // digit count, is what tells them apart.
    expect(matches("var(--spacing-6) var(--typo-heading-24-size) var(--chart-1)")).toEqual([]);
    expect(matches("var(--gray-200)")).toEqual(["--gray-200"]);
    expect(matches("var(--gray-alpha-400)")).toEqual(["--gray-alpha-400"]);
    expect(matches("bg-(--brand-700)")).toEqual(["--brand-700"]);
    // The two forms the first matcher could not see: the four-digit top step
    // and a family the D14 reduction retired whole.
    expect(matches("var(--gray-1000)")).toEqual(["--gray-1000"]);
    expect(matches("var(--teal-700)")).toEqual(["--teal-700"]);
  });
});
