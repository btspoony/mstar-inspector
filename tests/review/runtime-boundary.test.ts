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
 * The sandbox image ships exactly two package source trees: `packages/runner/src`
 * plus the zero-runtime-dependency wire contracts both runtime faces share,
 * `packages/shared/src`. Nothing from the repository root `src/` tree may enter
 * again, and an import escaping the runner tree is admissible ONLY when it
 * resolves to a file this Dockerfile actually copies.
 *
 * The admitted face is DERIVED FROM THE DOCKERFILE rather than restated from a
 * directory name (qc2 F-011 / qc3 QC3-007): admitting another source tree — or
 * re-adding a `COPY src/...` line — fails here instead of joining the image
 * graph silently, and every admitted shared file must stay free of runtime
 * imports.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const OMP_DOCKERFILE = join(REPO_ROOT, "sandbox-image", "Dockerfile");
const RUNNER_SRC = join(REPO_ROOT, "packages", "runner", "src");
const SHARED_SRC = join(REPO_ROOT, "packages", "shared", "src");

/** The only build-context source trees the image may admit. */
const ADMITTED_FACE = ["packages/runner/src", "packages/shared/src"] as const;

/** Split one instruction body on whitespace, honouring quoted arguments. */
function splitArgs(body: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const char of body) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (/\s/.test(char)) {
      if (current !== "") args.push(current);
      current = "";
    } else current += char;
  }
  if (quote !== null) throw new Error(`unterminated quote in COPY: ${body}`);
  if (current !== "") args.push(current);
  return args;
}

/**
 * Every build-context source a `COPY [flags] <src…> <dest>` instruction ships.
 * The destination is the last argument whether absolute or relative, and every
 * source is recorded — not just the first. A form this guard cannot classify
 * throws instead of being skipped: a silent skip leaves the face guard blind.
 */
function dockerfileCopySources(text: string): string[] {
  const sources: string[] = [];
  let pending = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const continued = line.endsWith("\\");
    const instruction = `${pending}${continued ? line.slice(0, -1) : line}`.trim();
    if (continued) {
      pending = `${instruction} `;
      continue;
    }
    pending = "";
    const match = /^COPY\s+(.*)$/i.exec(instruction);
    if (match === null) continue;
    const body = match[1]!.trim();
    let args: string[];
    if (body.startsWith("[")) {
      const parsed: unknown = JSON.parse(body);
      if (!Array.isArray(parsed) || !parsed.every((arg) => typeof arg === "string")) {
        throw new Error(`unparseable COPY JSON form: ${instruction}`);
      }
      args = parsed as string[];
    } else args = splitArgs(body);
    // Flags (`--from=…`, `--chown=…`, `--chmod=…`, `--link`) precede the paths.
    const paths = args.filter((arg) => !arg.startsWith("--"));
    if (paths.length < 2) throw new Error(`unparseable COPY instruction: ${instruction}`);
    sources.push(...paths.slice(0, -1));
  }
  if (pending !== "") throw new Error(`unterminated COPY continuation: ${pending}`);
  return sources;
}

/**
 * The source trees a `COPY` line ships, repo-relative. A single-file source
 * (manifest, lockfile, script) is not a face, so anything else — including a
 * tree that does not exist in the build context — counts as one and must be
 * one of the two admitted packages.
 */
function admittedFaces(sources: string[]): string[] {
  const faces = sources.filter(
    // An absolute source belongs to another image (`COPY --from=…`), not the
    // build context.
    (spec) =>
      !spec.startsWith("/") &&
      !statSync(join(REPO_ROOT, spec), { throwIfNoEntry: false })?.isFile(),
  );
  return [...new Set(faces)].sort();
}

/** Files under packages/shared/src the image admits, resolved from those COPY lines. */
function admittedSharedFiles(sources: string[]): string[] {
  const admitted: string[] = [];
  for (const spec of sources) {
    if (spec !== "packages/shared/src" && !spec.startsWith("packages/shared/src/")) continue;
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

/**
 * Runtime (non-erased) module specifiers in one source text, in every
 * import/require/re-export spelling. `import type` and an all-`type` named
 * clause are erased, so they are not runtime edges.
 *
 * The clause is matched as `[^;'"]` OR a complete double-quoted string: a
 * named clause may be quoted (`export { "Hono" as Hono } from "hono"`, the
 * ES2022 arbitrary-module-namespace spelling), and a quote-blind class ended
 * the clause there and dropped the edge silently.
 */
function runtimeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const [, modifier, clause = "", specifier = ""] of source.matchAll(
    /\b(?:import|export)\s+(type\s+)?((?:[^;'"]|"[^"]*")*?)from\s*["']([^"']+)["']/g,
  )) {
    const named = clause.match(/\{([\s\S]*)\}/)?.[1];
    // Only the `type ` keyword erases a specifier, and it can never sit inside
    // a quoted name — so a comma-split of a quoted name still yields a
    // non-`type` item and the edge is recorded rather than dropped.
    const specifiers = named?.split(",").map((s) => s.trim()).filter(Boolean) ?? [];
    const typeOnly =
      modifier !== undefined ||
      (specifiers.length > 0 && specifiers.every((s) => /^type\s/.test(s)));
    if (!typeOnly) specs.push(specifier);
  }
  for (const [, specifier = ""] of source.matchAll(
    /\b(?:import|require)\s*\(?\s*["']([^"']+)["']/g,
  )) {
    specs.push(specifier);
  }
  return specs;
}

describe("in-image module graph — the image ships packages/runner/src plus the shared package only", () => {
  const copySources = dockerfileCopySources(readFileSync(OMP_DOCKERFILE, "utf8"));
  const admittedShared = admittedSharedFiles(copySources);
  const rootSrcCopies = copySources.filter(
    (spec) => spec === "src" || spec.startsWith("src/"),
  );

  test("the Dockerfile admits exactly the two package source trees", () => {
    // Derived, not restated: the assertion pins the derivation against the
    // Dockerfile, so a third admitted tree (or a retired package) fails here.
    expect(admittedFaces(copySources)).toEqual([...ADMITTED_FACE]);
  });

  test("no COPY line ships the repository root src/ tree", () => {
    // The split's regression: the image once shipped src/review + src/contracts.
    expect(rootSrcCopies).toEqual([]);
  });

  test("every COPY source is recorded, including relative-destination lines", () => {
    // `COPY <src…> ./` (the image's own runner manifest line) must contribute
    // both sources, not just the first, and must not be skipped as relative.
    expect(copySources).toContain("packages/runner/package.json");
    expect(copySources).toContain("packages/runner/bun.lock");
  });

  test("negative controls — every root src/ COPY form fails the guard", () => {
    const rootSrc = (text: string): string[] =>
      dockerfileCopySources(text).filter((spec) => spec === "src" || spec.startsWith("src/"));
    expect(rootSrc("COPY src ./")).toEqual(["src"]);
    expect(rootSrc("COPY src/a src/b ./")).toEqual(["src/a", "src/b"]);
    // A non-admitted tree after a legal first source is still a face.
    const mixed = dockerfileCopySources("COPY packages/runner/package.json packages/extra/src ./");
    expect(mixed).toEqual(["packages/runner/package.json", "packages/extra/src"]);
    expect(admittedFaces(mixed)).not.toEqual([...ADMITTED_FACE]);
  });

  test("negative controls — an unparseable COPY form fails loudly", () => {
    // Fail loud, never skip: a skipped line leaves the face guard blind.
    expect(() => dockerfileCopySources("COPY --chown=0:0 src")).toThrow(/unparseable COPY/);
    expect(() => dockerfileCopySources('COPY ["src", ')).toThrow();
    expect(() => dockerfileCopySources("COPY src ./ \\")).toThrow(/unterminated COPY/);
  });

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
    for (const file of collectFiles(RUNNER_SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
        const specifier = match[1]!;
        const target = resolveModuleTarget(specifier, file);
        const admissible = target.startsWith(`${RUNNER_SRC}/`) || admittedShared.includes(target);
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
      for (const specifier of runtimeSpecifiers(stripComments(readFileSync(file, "utf8")))) {
        check(file, specifier);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("negative control — the scan flags a re-exported bare specifier", () => {
    // The pre-fix scan matched `import … from` only, so `export … from` — the
    // exact spelling that adds a runtime edge — passed unseen.
    expect(runtimeSpecifiers('import { a } from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers('export { a } from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers('export * from "hono";')).toEqual(["hono"]);
    // A quoted export name is the same runtime edge: the quote-blind clause
    // class ended at the `"` and dropped it silently.
    expect(runtimeSpecifiers('export { "Hono" as Hono } from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers('import { "default" as Hono } from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers('export type { T } from "hono";')).toEqual([]);
    expect(runtimeSpecifiers('import type { T } from "hono";')).toEqual([]);
    // A quoted name is never a `type` marker, so it stays a runtime edge.
    expect(runtimeSpecifiers('export { type T } from "hono";')).toEqual([]);
    expect(runtimeSpecifiers('export { "type" as T } from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers('export { a } from "./credential-key";')).toEqual(["./credential-key"]);
  });
});
