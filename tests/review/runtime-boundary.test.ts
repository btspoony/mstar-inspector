
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const WORKERD_FACES = ["src/worker", "src/pipeline", "src/store"] as const;

const OMP_SDK_RE = /@oh-my-pi\/pi-coding-agent/;

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

/**
 * why: The sandbox image ships exactly two package source trees: `packages/runner/src`
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

const ADMITTED_FACE = ["packages/runner/src", "packages/shared/src"] as const;

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
    const paths = args.filter((arg) => !arg.startsWith("--"));
    if (paths.length < 2) throw new Error(`unparseable COPY instruction: ${instruction}`);
    sources.push(...paths.slice(0, -1));
  }
  if (pending !== "") throw new Error(`unterminated COPY continuation: ${pending}`);
  return sources;
}

function admittedFaces(sources: string[]): string[] {
  const faces = sources.filter(
    (spec) =>
      !spec.startsWith("/") &&
      !statSync(join(REPO_ROOT, spec), { throwIfNoEntry: false })?.isFile(),
  );
  return [...new Set(faces)].sort();
}

/** note: Files under packages/shared/src the image admits, resolved from those COPY lines. */
function admittedSharedFiles(sources: string[]): string[] {
  const admitted: string[] = [];
  for (const spec of sources) {
    if (spec !== "packages/shared/src" && !spec.startsWith("packages/shared/src/")) continue;
    const abs = join(REPO_ROOT, spec);
    if (statSync(abs).isDirectory()) admitted.push(...collectFiles(abs));
    else admitted.push(abs);
  }
  return admitted.sort();
}

const RELATIVE_IMPORT_RE = /(?:from\s+|import\s*|require\s*\()\s*['"](\.\.?\/[^'"]+)['"]/g;

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

function resolveModuleTarget(specifier: string, fromFile: string): string {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate)) ?? base;
}

function runtimeSpecifiers(source: string): string[] {
  const specs: string[] = [];
  for (const [, modifier, clause = "", specifier = ""] of source.matchAll(
    /\b(?:import|export)\s+(type\s+)?((?:[^;'"]|"[^"]*"|'[^']*')*?)from\s*["']([^"']+)["']/g,
  )) {
    const named = clause.match(/\{([\s\S]*)\}/)?.[1];
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
  const isAdmittedModule = (target: string): boolean =>
    target.startsWith(`${RUNNER_SRC}/`) || admittedShared.includes(target);

  test("the Dockerfile admits exactly the two package source trees", () => {
    expect(admittedFaces(copySources)).toEqual([...ADMITTED_FACE]);
  });

  test("the image's observable module surface is exactly the shared package tree", () => {
    // why: Behaviour, not manifest parity: the image can only execute modules it
    // ships, so `packages/shared/src` in the build context IS the image's
    // shared surface. A second COPY line carrying a shared module — or one
    // carrying a module from outside the package — widens that surface
    // through a route the directory COPY does not describe, so the COPY set
    // must stay the single directory line and must cover every module.
    const sharedCopySources = copySources.filter(
      (spec) => spec === "packages/shared/src" || spec.startsWith("packages/shared/src/"),
    );
    expect(sharedCopySources).toEqual(["packages/shared/src"]);
    expect(admittedShared).toEqual(collectFiles(SHARED_SRC).sort());
  });

  test("no COPY line ships the repository root src/ tree", () => {
    expect(rootSrcCopies).toEqual([]);
  });

  test("every COPY source is recorded, including relative-destination lines", () => {
    expect(copySources).toContain("packages/runner/package.json");
    expect(copySources).toContain("packages/runner/bun.lock");
  });

  test("negative controls — every root src/ COPY form fails the guard", () => {
    const rootSrc = (text: string): string[] =>
      dockerfileCopySources(text).filter((spec) => spec === "src" || spec.startsWith("src/"));
    expect(rootSrc("COPY src ./")).toEqual(["src"]);
    expect(rootSrc("COPY src/a src/b ./")).toEqual(["src/a", "src/b"]);
    const mixed = dockerfileCopySources("COPY packages/runner/package.json packages/extra/src ./");
    expect(mixed).toEqual(["packages/runner/package.json", "packages/extra/src"]);
    expect(admittedFaces(mixed)).not.toEqual([...ADMITTED_FACE]);
  });

  test("negative controls — an unparseable COPY form fails loudly", () => {
    expect(() => dockerfileCopySources("COPY --chown=0:0 src")).toThrow(/unparseable COPY/);
    expect(() => dockerfileCopySources('COPY ["src", ')).toThrow();
    expect(() => dockerfileCopySources("COPY src ./ \\")).toThrow(/unterminated COPY/);
  });

  test("every shared module the runner imports is admitted, and the boundary refuses a widened COPY set", () => {
    const importedShared = new Set<string>();
    for (const file of collectFiles(RUNNER_SRC)) {
      for (const match of readFileSync(file, "utf8").matchAll(RELATIVE_IMPORT_RE)) {
        const target = resolveModuleTarget(match[1]!, file);
        if (!target.startsWith(`${RUNNER_SRC}/`)) importedShared.add(target);
      }
    }
    expect(importedShared.size).toBeGreaterThan(0);
    for (const target of importedShared) {
      expect(existsSync(target), `${target} is not in the image build context`).toBe(true);
      expect(isAdmittedModule(target), `${target} is imported but no COPY line ships it`).toBe(true);
    }
    const widened = dockerfileCopySources(`${readFileSync(OMP_DOCKERFILE, "utf8")}\nCOPY src /opt/runner/src\n`);
    expect(admittedFaces(widened)).toContain("src");
    expect(admittedFaces(widened)).not.toEqual([...ADMITTED_FACE]);
  });

  test("no packages/runner/src module imports outside that tree and the admitted files", () => {
    const offenders: string[] = [];
    for (const file of collectFiles(RUNNER_SRC)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(RELATIVE_IMPORT_RE)) {
        const specifier = match[1]!;
        const target = resolveModuleTarget(specifier, file);
        if (!isAdmittedModule(target)) offenders.push(`${file.slice(REPO_ROOT.length + 1)}: ${specifier}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("every admitted shared file stays runtime-dependency-free", () => {
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
    expect(runtimeSpecifiers('import { a } from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers('export { a } from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers('export * from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers('export { "Hono" as Hono } from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers("export { 'Hono' as Hono } from 'hono';")).toEqual(["hono"]);
    expect(runtimeSpecifiers('import { "default" as Hono } from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers('export type { T } from "hono";')).toEqual([]);
    expect(runtimeSpecifiers('import type { T } from "hono";')).toEqual([]);
    expect(runtimeSpecifiers('export { type T } from "hono";')).toEqual([]);
    expect(runtimeSpecifiers('export { "type" as T } from "hono";')).toEqual(["hono"]);
    expect(runtimeSpecifiers('export { a } from "./credential-key";')).toEqual(["./credential-key"]);
    expect(runtimeSpecifiers("export { x } from './local';")).toEqual(["./local"]);
    expect(runtimeSpecifiers('export { "Hono" as Hono } from "../../../src/worker/index";')).toEqual([
      "../../../src/worker/index",
    ]);
  });
});
