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

const REPO = new URL("../../", import.meta.url).pathname;
const SCAN_ROOT = join(REPO, "src");
const MODULE_DIR = join(SCAN_ROOT, "design-system");
const ENTRY = "@design-system";

/** `from "x"`, `import "x"`, `require("x")`, `import("x")` — capture group 1 is the specifier. */
const SPECIFIER = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;

/** True when `path` is the module root or lies anywhere beneath it. */
function inModule(path: string): boolean {
  return path === MODULE_DIR || path.startsWith(MODULE_DIR + sep);
}

/** Violation rule label for one specifier, or `null` when it is legal. */
function violationFor(specifier: string, importer: string): string | null {
  if (specifier === ENTRY) return null;
  if (specifier.startsWith(`${ENTRY}/`)) return "deep-import";
  const target = specifier.startsWith(".")
    ? resolve(dirname(join(REPO, importer)), specifier)
    : specifier.replace(/^\/+/, "");
  return inModule(target) || target.startsWith("src/design-system") ? "path-into-module" : null;
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

/** Repo-relative `.ts`/`.tsx` files under `src/`, minus the module itself. */
function consumerFiles(dir: string = SCAN_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (!inModule(full)) out.push(...consumerFiles(full));
    } else if (/\.tsx?$/.test(entry)) {
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
    expect(matched(`import { Card } from "@/components/ui/card";\nimport React from "react";`)).toEqual([]);
    expect(matched(`export * from "./tokens";`, "src/contracts/index.ts")).toEqual([]);
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
