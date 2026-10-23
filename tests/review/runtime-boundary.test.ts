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
import { dirname, join, relative, resolve } from "node:path";

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
 * The sandbox image ships packages/runner/src plus the zero-runtime-dependency wire
 * contracts both runtime faces share: `COPY packages/shared/src`. Nothing else
 * enters the image (no src/pipeline, no src/store), so an import escaping
 * the runner tree is admissible ONLY when it resolves to a file this Dockerfile
 * actually copies.
 *
 * The admitted set is DERIVED FROM THE DOCKERFILE rather than restated from a
 * directory name (qc2 F-011 / qc3 QC3-007): admitting another tree, or retiring
 * a COPY line the imports still need, fails here instead of joining the image
 * graph silently — and every admitted file must stay free of runtime imports.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const OMP_DOCKERFILE = join(REPO_ROOT, "sandbox-image", "Dockerfile");
const IN_IMAGE_FACE = join(REPO_ROOT, "packages", "runner", "src");
const SHARED_SRC = join(REPO_ROOT, "packages", "shared", "src");

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

/** Files under packages/shared/src the image admits, resolved from those COPY lines. */
function admittedSharedFiles(sources: string[]): string[] {
  const admitted: string[] = [];
  for (const spec of sources) {
    if (!spec.startsWith("packages/shared/src")) continue;
    const abs = join(REPO_ROOT, spec);
    // A directory COPY is deliberate here (one coherent package), so the
    // admitted set is enumerated and every member is asserted individually.
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
 * Drop `//` and block comments — the package documents its own type-only
 * imports in prose, and a `from "…"` inside that prose is not an import.
 * Scans (not regexes) so a `//` inside a specifier is never a comment.
 */
function stripComments(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    const next = text.charAt(i + 1);
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = text.indexOf(ch, i + 1);
      const stop = end === -1 ? text.length : end + 1;
      out += text.slice(i, stop);
      i = stop - 1;
    } else if (ch === "/" && next === "/") {
      const end = text.indexOf("\n", i);
      i = (end === -1 ? text.length : end) - 1;
    } else if (ch === "/" && next === "*") {
      const end = text.indexOf("*/", i + 2);
      i = (end === -1 ? text.length : end + 1);
    } else {
      out += ch;
    }
  }
  return out;
}

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

describe("in-image module graph — the image ships packages/runner/src plus the shared package only", () => {
  const admittedShared = admittedSharedFiles(dockerfileCopySources(OMP_DOCKERFILE));

  test("the Dockerfile admits exactly the shared package modules", () => {
    expect(admittedShared.map((file) => file.slice(REPO_ROOT.length + 1))).toEqual([
      "packages/shared/src/credential-key.ts",
      "packages/shared/src/credential-payload.ts",
      "packages/shared/src/recheck-wire.ts",
      "packages/shared/src/runtime.ts",
    ]);
  });

  test("no packages/runner/src module imports outside that tree and the admitted files", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(IN_IMAGE_FACE)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
        const specifier = match[1]!;
        const target = resolveModuleTarget(specifier, file);
        const admissible =
          target.startsWith(`${IN_IMAGE_FACE}/`) || admittedShared.includes(target);
        if (!admissible) offenders.push(`${file.slice(REPO_ROOT.length + 1)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every admitted shared file stays runtime-dependency-free", () => {
    // Admission condition: a shared module rides the image ONLY because it is
    // dependency-free at runtime (spec §7.3). `import type` is erased, and a
    // relative import may stay as long as it resolves inside the package; a
    // runtime bare specifier or an escaping path invalidates the admission —
    // narrow the boundary instead of widening this rule.
    expect(admittedShared.length).toBeGreaterThan(0);
    const offenders: string[] = [];
    const check = (file: string, specifier: string): void => {
      const escaped =
        specifier.startsWith(".") &&
        relative(SHARED_SRC, resolve(dirname(file), specifier)).startsWith("..");
      if (!specifier.startsWith(".") || escaped) {
        offenders.push(`${file.slice(REPO_ROOT.length + 1)} -> ${specifier}`);
      }
    };
    for (const file of admittedShared) {
      const source = stripComments(readFileSync(file, "utf8"));
      for (const [, modifier, clause = "", specifier = ""] of source.matchAll(
        /\bimport\s+(type\s+)?([^;'"]*?)from\s*["']([^"']+)["']/g,
      )) {
        const named = clause.match(/\{([\s\S]*)\}/)?.[1];
        const specifiers = named?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
        const typeOnly =
          modifier !== undefined ||
          (specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s)));
        if (!typeOnly) check(file, specifier);
      }
      for (const [, specifier = ""] of source.matchAll(
        /\b(?:import|require)\s*\(?\s*["']([^"']+)["']/g,
      )) {
        check(file, specifier);
      }
    }
    expect(offenders).toEqual([]);
  });
});
