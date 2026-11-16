/**
 * One decision path for plan verdicts (`m9-entitlement-single-entry`).
 *
 * Every "may this workspace do X under its plan" answer must be minted by
 * `checkEntitlement` in `src/dashboard/entitlement.ts`. `resolveWorkspacePlan`
 * legitimately has display and audit readers (the switcher label, the members
 * page card, the usage card, the operator audit `before` detail) — none of them
 * can refuse — so the invariant this file pins is **one decision site, not one
 * caller**: the three private decision predicates may not be spelled anywhere
 * else in `src/`.
 *
 * The second half is the kind list: `EntitlementKind` and the `switch` in
 * `checkEntitlement` must name the same members, one branch each. A kind added
 * to the union without a branch (or a branch without the union member) fails
 * here instead of at a runtime default.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SRC = join(import.meta.dir, "..", "..", "src");
const ENTITLEMENT = join(SRC, "dashboard", "entitlement.ts");

/** The predicates that may only exist as internals of `checkEntitlement`. */
const DECISION_PREDICATES = ["memberSlotAvailable", "freeSlotAvailable", "assertSharedBotAllowed"];

/** Every `.ts` file under `src/`, recursively. */
function sourceFiles(dir: string = SRC): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return entry.endsWith(".ts") ? [full] : [];
  });
}

/**
 * Drop `//` and block comments so a name mentioned in prose is not a use.
 * Scans (not regexes), so a `//` inside a string literal is never mistaken for
 * a comment — the same reason `tests/contracts/shared-boundary.test.ts` scans.
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

describe("the decision path has one entry", () => {
  for (const predicate of DECISION_PREDICATES) {
    test(`${predicate} is spelled in src/dashboard/entitlement.ts only`, () => {
      const hits = sourceFiles()
        .filter((file) => stripComments(readFileSync(file, "utf8")).includes(predicate))
        // `src/`-relative, so a failure names a file a reader can open.
        .map((file) => file.slice(SRC.length + 1))
        .sort();
      expect(hits).toEqual([join("dashboard", "entitlement.ts")]);
    });
  }

  test("the predicates are not exported — a caller cannot bypass the entry", () => {
    const source = stripComments(readFileSync(ENTITLEMENT, "utf8"));
    for (const predicate of DECISION_PREDICATES) {
      expect(source).not.toContain(`export function ${predicate}(`);
    }
    // Non-vacuity: the entry itself IS exported, so the assertion above is not
    // passing merely because the file declares nothing at all.
    expect(source).toContain("export async function checkEntitlement(");
  });
});

/** `EntitlementKind`'s members, read off the exported union. */
function declaredKinds(): string[] {
  const source = stripComments(readFileSync(ENTITLEMENT, "utf8"));
  const union = source.match(/export type EntitlementKind\s*=([\s\S]*?);/)?.[1];
  if (union === undefined) throw new Error("EntitlementKind union not found");
  return [...union.matchAll(/"([^"]+)"/g)].map((match) => match[1]!).sort();
}

/** The `case "…":` labels of `checkEntitlement`'s switch, in source order. */
function branchKinds(): string[] {
  const source = stripComments(readFileSync(ENTITLEMENT, "utf8"));
  const body = source.slice(source.indexOf("export async function checkEntitlement("));
  const end = body.indexOf("\n}\n");
  const fn = end === -1 ? body : body.slice(0, end);
  return [...fn.matchAll(/case "([^"]+)":/g)].map((match) => match[1]!).sort();
}

describe("every kind has exactly one branch", () => {
  test("the switch names the kind union and nothing else", () => {
    const declared = declaredKinds();
    // Non-vacuity: the inventory the plan measures.
    expect(declared).toEqual(["app-count", "free-workspace-slot", "member-slot", "review-quota", "shared-bot"]);
    expect(branchKinds()).toEqual(declared);
  });

  test("the switch has no default branch — a new kind must be handled, not swallowed", () => {
    const source = stripComments(readFileSync(ENTITLEMENT, "utf8"));
    const fn = source.slice(source.indexOf("export async function checkEntitlement("));
    expect(fn.slice(0, fn.indexOf("\n}\n"))).not.toContain("default:");
  });
});
