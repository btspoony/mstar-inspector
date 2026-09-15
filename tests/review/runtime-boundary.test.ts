/**
 * Module import matrix guard (+ spec § 模块 import 矩阵):
 * the workerd faces — src/worker, src/pipeline, src/store — must NEVER import
 * the omp SDK (container-only). This is the executable form of the plan
 * verification `grep -n 'from "@oh-my-pi/pi-coding-agent"' src/worker
 * src/pipeline src/store` → no matches; it additionally covers dynamic
 * imports and require() spellings.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
// --- in-image module graph (custom-providers regression; recheck amendment;
// narrowed per P67-QC-015 in QC wave B) ------------------------------------

/**
 * The sandbox image ships src/review plus — since the recheck amendment (PM
 * 2026-09-13) — the ONE zero-runtime-dependency wire contract the recheck seat
 * runtime-imports: `COPY src/contracts/recheck.ts`. Nothing else enters the
 * image (no src/pipeline, no src/store), so an import escaping src/review is
 * admissible ONLY when it resolves to a file this Dockerfile actually copies.
 *
 * The admitted set is DERIVED FROM THE DOCKERFILE rather than restated from a
 * directory name (qc2 F-011 / qc3 QC3-007): widening the COPY back to a
 * directory, or admitting another contract file, fails here instead of joining
 * the image graph silently — and every admitted file, not just one, must stay
 * free of runtime imports.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const OMP_DOCKERFILE = join(REPO_ROOT, "sandbox-image", "omp", "Dockerfile");
const IN_IMAGE_FACE = join(REPO_ROOT, "src", "review");

/** Every build-context source a `COPY <src…> <abs dest>` line ships. */
function dockerfileCopySources(dockerfile: string): string[] {
  const sources: string[] = [];
  for (const line of readFileSync(dockerfile, "utf8").split("\n")) {
    const match = /^COPY\s+(?:--\S+\s+)*(\S+)(?:\s+\S+)*\s+\/\S+\s*$/.exec(line.trim());
    if (match === null) continue;
    for (const spec of match[1]!.split(",")) if (spec !== "") sources.push(spec);
  }
  return sources;
}

/** Files under src/contracts the image admits, resolved from those COPY lines. */
function admittedContractFiles(sources: string[]): string[] {
  const admitted: string[] = [];
  for (const spec of sources) {
    if (!spec.startsWith("src/contracts")) continue;
    const abs = join(REPO_ROOT, spec);
    // A directory COPY is the rejected shape — it would silently admit any
    // future file. Enumerate what is actually admitted so each one is asserted.
    if (statSync(abs).isDirectory()) admitted.push(...collectFiles(abs));
    else admitted.push(abs);
  }
  return admitted.sort();
}

/**
 * Relative import specifiers (`./…` / `../…`) in any import/require spelling
 * (static import, side-effect import, dynamic import, require, re-export).
 */
const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*|require\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g;

/**
 * The real file a relative specifier resolves to (Bun/TS extensionless
 * imports), or the unresolved base when nothing exists there — which then
 * fails the admission test rather than passing on a phantom path.
 */
function resolveModuleTarget(specifier: string, fromFile: string): string {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? base;
}

describe("in-image module graph — the image ships src/review plus named contract files only", () => {
  const admittedContract = admittedContractFiles(dockerfileCopySources(OMP_DOCKERFILE));

  test("the Dockerfile admits exactly the one dependency-free wire module", () => {
    expect(admittedContract.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual(["src/contracts/recheck.ts"]);
  });

  test("no src/review module imports outside src/review and the admitted files", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(IN_IMAGE_FACE)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
        const specifier = match[1]!;
        const target = resolveModuleTarget(specifier, file);
        const admissible =
          target.startsWith(`${IN_IMAGE_FACE}/`) || admittedContract.includes(target);
        if (!admissible) offenders.push(`${file.slice(REPO_ROOT.length + 1)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every admitted contract file stays runtime-dependency-free", () => {
    // PM amendment condition: the file rides the image ONLY
    // because it is a zero-runtime-dependency module (spec §7.3). Any import
    // statement appearing in an admitted file invalidates the admission — stop
    // and re-narrow the boundary instead of widening this rule. Fresh
    // non-global regexes: global ones are stateful under .test().
    expect(admittedContract.length).toBeGreaterThan(0);
    const relativeImport = /(?:from\s+|import\s*|require\s*\()\s*['"]\.\.?\/[^'"]*['"]/;
    const moduleImport = /(?:from\s+|import\s+|require\s*\()\s*['"][^.'"][^'"]*['"]/;
    const offenders: string[] = [];
    for (const file of admittedContract) {
      const source = readFileSync(file, "utf8");
      if (relativeImport.test(source) || moduleImport.test(source)) {
        offenders.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
