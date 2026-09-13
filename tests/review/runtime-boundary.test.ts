/**
 * Module import matrix guard (plan 07 Task 2 + spec § 模块 import 矩阵):
 * the workerd faces — src/worker, src/pipeline, src/store — must NEVER import
 * the omp SDK (container-only). This is the executable form of the plan
 * verification `grep -n 'from "@oh-my-pi/pi-coding-agent"' src/worker
 * src/pipeline src/store` → no matches; it additionally covers dynamic
 * imports and require() spellings.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Faces that run on workerd and are barred from the omp SDK. */
const WORKERD_FACES = ["src/worker", "src/pipeline", "src/store"] as const;

const OMP_SDK_RE = /@oh-my-pi\/pi-coding-agent/;

/** Collect every .ts/.js/.tsx file under a directory, recursively. */
function collectFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...collectFiles(full));
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      found.push(full);
    }
  }
  return found;
}

describe("module import matrix — omp SDK is container-only", () => {
  for (const face of WORKERD_FACES) {
    test(`${face} never references @oh-my-pi/pi-coding-agent`, () => {
      const offenders: string[] = [];
      for (const file of collectFiles(face)) {
        const source = readFileSync(file, "utf8");
        if (OMP_SDK_RE.test(source)) {
          offenders.push(file);
        }
      }
      expect(offenders).toEqual([]);
    });
  }
});
// --- in-image module graph (plan 23 T3 regression; plan 67 T3 amendment) -----

/**
 * The sandbox image COPYs src/review plus — since plan 67 Task 3 (PM
 * amendment 2026-09-13) — the zero-runtime-dependency wire contracts
 * directory (COPY src/contracts): the recheck seat runtime-imports
 * src/contracts/recheck.ts. NOTHING else enters the image (no src/pipeline,
 * no src/store), so an import escaping src/review is admissible ONLY when it
 * resolves inside src/contracts. The admitted module itself must stay
 * dependency-free — asserted below.
 */
const IN_IMAGE_FACE = "src/review";
const ADMITTED_FACE = "src/contracts";

/**
 * Relative import specifiers (`./…` / `../…`) in any import/require spelling
 * (static import, side-effect import, dynamic import, require, re-export).
 */
const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*|require\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g;

describe("in-image module graph — src/review is self-contained (Dockerfile COPY src/review)", () => {
  test("no src/review module imports outside src/review and src/contracts (relative specifiers)", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(IN_IMAGE_FACE)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
        const specifier = match[1]!;
        const target = resolve(dirname(file), specifier);
        const inImage =
          target.startsWith(`${resolve(IN_IMAGE_FACE)}/`) || target.startsWith(`${resolve(ADMITTED_FACE)}/`);
        if (!inImage) {
          offenders.push(`${file}: ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  test("the admitted wire module src/contracts/recheck.ts stays runtime-dependency-free", () => {
    // PM amendment condition (plan 67 T3): src/contracts rides the image ONLY
    // because recheck.ts is a zero-runtime-dependency module (spec §7.3). Any
    // import statement appearing there invalidates the admission — stop and
    // re-narrow the boundary instead of widening this rule. Fresh non-global
    // regexes: global ones are stateful under .test().
    const source = readFileSync(join(ADMITTED_FACE, "recheck.ts"), "utf8");
    const relativeImport = /(?:from\s+|import\s*|require\s*\()\s*['"]\.\.?\/[^'"]*['"]/;
    const moduleImport = /(?:from\s+|import\s+|require\s*\()\s*['"][^.'"][^'"]*['"]/;
    expect(relativeImport.test(source)).toBe(false);
    expect(moduleImport.test(source)).toBe(false);
  });
});
