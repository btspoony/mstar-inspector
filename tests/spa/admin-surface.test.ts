/**
 * The console's plain variant (compass D15; plan 204 task 1).
 *
 * "Plainer" is one re-map, never a second component set: `data-surface="ops"`
 * on `src/spa/admin.html`'s `<html>` puts every Radix portal — the
 * flag-confirm dialog, dropdowns, tooltips — under the same variant, because
 * they mount on `<body>` and inherit the root's custom properties. The
 * generated block then withholds the accent tone whole.
 *
 * Three assertions, because the rule breaks three ways: the attribute leaves
 * the document root, the generated block stops re-mapping a token, or admin
 * code names the tone (or a brand step) the variant withholds and its own
 * colours win over the re-map.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { opsSurface } from "../../src/design-system/tokens";

const REPO = new URL("../../", import.meta.url).pathname;
const ADMIN_HTML_PATH = join(REPO, "src/spa/admin.html");
const ADMIN_DIR = join(REPO, "src/spa/admin");
const CSS_PATH = join(REPO, "src/spa/styles/tokens.css");

const ADMIN_HTML = readFileSync(ADMIN_HTML_PATH, "utf8");
const CSS = readFileSync(CSS_PATH, "utf8");

/** The declarations of the generated ops block, parsed out of the stylesheet. */
function opsBlock(): Record<string, string> {
  const at = CSS.indexOf(':root[data-surface="ops"] {');
  if (at === -1) throw new Error("generated stylesheet has no ops block");
  const open = CSS.indexOf("{", at);
  const end = CSS.indexOf("\n}", open);
  const out: Record<string, string> = {};
  for (const match of CSS.slice(open + 1, end).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[match[1]!] = match[2]!.trim();
  }
  return out;
}

/** `src/spa/admin/**` plus the document — the console's whole surface. */
function adminFiles(): string[] {
  const sources = readdirSync(ADMIN_DIR, { recursive: true })
    .map(String)
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => join(ADMIN_DIR, file));
  return [ADMIN_HTML_PATH, ...sources];
}

describe("the console's plain variant", () => {
  test("the admin document root carries data-surface=ops", () => {
    const rootTag = ADMIN_HTML.match(/<html\b[^>]*>/)?.[0];
    expect(rootTag, "admin.html has no <html> tag").toBeDefined();
    // On the ROOT: `:root[data-surface="ops"]` is what the stylesheet keys the
    // re-map on, and a page wrapper would leave every portal un-re-mapped.
    expect(rootTag).toContain('data-surface="ops"');
  });

  test("the generated ops block withholds the accent tone and the brand action", () => {
    const ops = opsBlock();
    // The file is a pure function of the source, so a hand edit or a dropped
    // declaration is a difference here rather than a silently plainer console.
    expect(ops).toEqual({ ...opsSurface });
    for (const face of ["bg", "border", "fg", "solid"]) {
      expect(ops[`tone-accent-${face}`], `--tone-accent-${face}`).toBe(
        `var(--tone-neutral-${face})`,
      );
    }
    expect(ops["button-primary-bg"]).toBe("var(--tone-neutral-bg)");
    // One plane up the neutral ladder: the base hover brightens the brand
    // step, which would put the withheld accent straight back on the action.
    expect(ops["button-primary-hover-bg"]).toBe("var(--surface-overlay)");
  });

  test("no admin file names the withheld tone or a brand step", () => {
    const files = adminFiles();
    // A scan that found nothing to scan is not a pass.
    expect(files.length).toBeGreaterThan(1);

    const forbidden = [
      { rule: "tone-accent-*", re: /tone-accent-/ },
      { rule: "brand step", re: /\bbrand-\d{2,3}\b/ },
    ];
    const hits = files.flatMap((file) =>
      readFileSync(file, "utf8")
        .split("\n")
        .flatMap((line, index) =>
          forbidden
            .filter(({ re }) => re.test(line))
            .map(({ rule }) => `${file.slice(REPO.length)}:${index + 1}: [${rule}] ${line.trim()}`),
        ),
    );
    expect(hits, `admin code may not name the tone the variant withholds:\n${hits.join("\n")}`).toEqual(
      [],
    );
  });
});
