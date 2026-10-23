/**
 * `packages/shared` dependency boundary (plan 103, compass D11).
 *
 * The package is the dependency-free owner of the dual-surface wire
 * contracts: a runtime engine/omp import, any `zod` import, or a relative
 * path escaping `packages/shared/src` would drag the Worker or runner
 * dependency graph back into the shared surface. `import type` is allowed —
 * type-only specifiers are erased.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const SHARED_SRC = join(import.meta.dir, "..", "..", "packages", "shared", "src");

/** Every `.ts` file under the package source root, recursively. */
function sharedFiles(dir: string = SHARED_SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sharedFiles(full);
    return entry.endsWith(".ts") ? [full] : [];
  });
}

type ImportRef = { file: string; specifier: string; typeOnly: boolean };

/** `{ type A, type B }` — every named specifier carries the inline modifier. */
function allSpecifiersTyped(clause: string): boolean {
  const named = clause.match(/\{([\s\S]*)\}/)?.[1];
  const specifiers = named?.split(",").map((specifier) => specifier.trim()).filter(Boolean) ?? [];
  return specifiers.length > 0 && specifiers.every((specifier) => /^type\s/.test(specifier));
}

/**
 * Drop `//` and block comments — the package documents its own type-only
 * imports in prose, and a `from "…"` inside that prose is not an import.
 * Scans (not regexes) so a `//` inside a specifier is never mistaken for a
 * comment.
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
 * Import/export specifiers in every spelling the package may use (static
 * import, re-export, side-effect import, dynamic import, require). Statement
 * clauses stop before a quote or `;`, so the lazy clause never spans a
 * neighbouring statement.
 */
function importsOf(file: string): ImportRef[] {
  const source = stripComments(readFileSync(file, "utf8"));
  const refs: ImportRef[] = [];
  for (const [, typeModifier = "", clause = "", specifier = ""] of source.matchAll(
    /\b(?:import|export)\s+(type\s+)?([^"';]*?)\bfrom\s*["']([^"']+)["']/g,
  )) {
    refs.push({ file, specifier, typeOnly: Boolean(typeModifier) || allSpecifiersTyped(clause) });
  }
  for (const [, specifier = ""] of source.matchAll(/\bimport\s*["']([^"']+)["']/g)) {
    refs.push({ file, specifier, typeOnly: false });
  }
  for (const [, specifier = ""] of source.matchAll(
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g,
  )) {
    refs.push({ file, specifier, typeOnly: false });
  }
  return refs;
}

const files = sharedFiles();
const imports = files.flatMap(importsOf);

function offenders(matches: (ref: ImportRef) => boolean): string[] {
  return imports
    .filter(matches)
    .map((ref) => `${relative(SHARED_SRC, ref.file)} -> ${ref.specifier}`)
    .sort();
}

/** A resolved relative target that leaves `packages/shared/src`. */
function escapesPackage(ref: ImportRef): boolean {
  if (!ref.specifier.startsWith(".")) return false;
  const rel = relative(SHARED_SRC, resolve(dirname(ref.file), ref.specifier));
  return rel.startsWith("..") || isAbsolute(rel);
}

describe("packages/shared boundary", () => {
  test("the scan actually sees the package source", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(imports.length).toBeGreaterThan(0);
  });

  test("no runtime import of @mstar-harness/engine or @oh-my-pi/*", () => {
    expect(
      offenders(
        (ref) =>
          !ref.typeOnly &&
          (ref.specifier === "@mstar-harness/engine" || ref.specifier.startsWith("@oh-my-pi/")),
      ),
    ).toEqual([]);
  });

  test("no zod import", () => {
    expect(offenders((ref) => ref.specifier === "zod" || ref.specifier.startsWith("zod/"))).toEqual(
      [],
    );
  });

  test("no relative import escaping packages/shared/src", () => {
    expect(offenders(escapesPackage)).toEqual([]);
  });
});
