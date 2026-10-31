/**
 * The console's plain variant (compass D15; plan 204 task 1).
 *
 * "Plainer" is one re-map, never a second component set: `data-surface="ops"`
 * on `src/spa/admin.html`'s `<html>` puts every Radix portal — the
 * flag-confirm dialog, dropdowns, tooltips — under the same variant, because
 * they mount on `<body>` and inherit the root's custom properties. The
 * generated block then withholds the accent tone whole.
 *
 * Four assertions, because the rule breaks four ways: the attribute leaves
 * the document root, the generated block stops re-mapping a token, the bridge
 * stops resolving through those tokens (so the re-map never reaches the
 * painted control), or admin code names the tone (or a brand step) the variant
 * withholds and its own colours win over the re-map.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { opsSurface } from "../../src/design-system/tokens";

const REPO = new URL("../../", import.meta.url).pathname;
const ADMIN_HTML_PATH = join(REPO, "src/spa/admin.html");
const ADMIN_DIR = join(REPO, "src/spa/admin");
const CSS_PATH = join(REPO, "src/spa/styles/tokens.css");
const BRIDGE_PATH = join(REPO, "src/spa/styles/shadcn-theme.css");
const BUTTON_PATH = join(REPO, "src/design-system/primitives/button.tsx");

const ADMIN_HTML = readFileSync(ADMIN_HTML_PATH, "utf8");
const CSS = readFileSync(CSS_PATH, "utf8");

/** The declarations of the first block whose selector is `selector`. */
function block(css: string, selector: string): Record<string, string> {
  const at = css.indexOf(selector);
  if (at === -1) throw new Error(`stylesheet has no ${selector}`);
  const open = css.indexOf("{", at);
  const end = css.indexOf("\n}", open);
  const out: Record<string, string> = {};
  for (const match of css.slice(open + 1, end).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[match[1]!] = match[2]!.trim();
  }
  return out;
}

/** The declarations of the generated ops block, parsed out of the stylesheet. */
function opsBlock(): Record<string, string> {
  return block(CSS, ':root[data-surface="ops"] {');
}

/** One `var(--x)` chain resolved inside a merged declaration map. */
function resolve(vars: Record<string, string>, name: string): string {
  let value = vars[name];
  for (let hop = 0; hop < 8 && value?.startsWith("var("); hop += 1) {
    value = vars[/^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1] ?? ""];
  }
  if (value === undefined) throw new Error(`--${name} is not declared`);
  return value;
}

/**
 * The declarations the console's document resolves against. `data-theme` and
 * `data-surface` selectors both score 0-2-0, so the merge order is the
 * stylesheet's source order: bridge, root, the stored-light branch, then ops.
 */
function consoleVars(theme: "dark" | "light"): Record<string, string> {
  const bridge = block(readFileSync(BRIDGE_PATH, "utf8"), ":root {");
  const base = { ...bridge, ...block(CSS, ":root {") };
  const light = theme === "light" ? block(CSS, ':root[data-theme="light"] {') : {};
  return { ...base, ...light, ...opsBlock() };
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

  test("the console's primary action paints the quiet pair", () => {
    // The classes the default variant actually wears — `bg-primary` and
    // `text-primary-foreground` — are read from the component, so a renamed
    // utility fails here instead of passing on an assumption. `<Button>` with
    // no `variant` prop (every console submit and the flag confirm) is this
    // face.
    const variant = /default:\s*"([^"]+)"/.exec(readFileSync(BUTTON_PATH, "utf8"))?.[1];
    const fillKey = /(?:^|\s)bg-([a-z][a-z0-9-]*)(?=\s|$)/.exec(variant ?? "")?.[1];
    const labelKey = /(?:^|\s)text-([a-z][a-z0-9-]*)(?=\s|$)/.exec(variant ?? "")?.[1];
    expect(fillKey, "the default variant paints a token fill").toBeDefined();
    expect(labelKey, "the default variant paints a token label").toBeDefined();

    // Painted, not declared: resolve the pair through the same cascade the
    // document uses. The declared ops block reaching `button-primary-*` is not
    // enough — before this bridge hop it left the fill on `tone-neutral-solid`.
    for (const theme of ["dark", "light"] as const) {
      const vars = consoleVars(theme);
      expect(resolve(vars, fillKey!), `${theme} ops fill`).toBe(resolve(vars, "tone-neutral-bg"));
      expect(resolve(vars, labelKey!), `${theme} ops label`).toBe(resolve(vars, "text-primary"));
    }
  });

  test("no admin file names the withheld tone or a brand step", () => {
    const files = adminFiles();
    // A scan that found nothing to scan is not a pass.
    expect(files.length).toBeGreaterThan(1);

    // A `tone="accent"` prop is a semantic request for the emphasis face, not
    // the token name this guard forbids — the surface re-map withholds the
    // paint, and the painted pair is asserted above.
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

describe("the console document's own styles", () => {
  test("admin.html spells no colour, radius or hairline of its own", () => {
    // The shell's frame is the document's only hand-written CSS. Every value
    // in it has to be a token reference: a hex (or a palette step) re-introduces
    // a second colour vocabulary, a `--rounded-*` alias re-spells the radius
    // tiers, and a px width on a border is the hairline someone hand-corrected.
    const rules = [
      { rule: "colour literal", re: /#[0-9a-fA-F]{3,8}\b/ },
      { rule: "palette step", re: /var\(--(?:gray|gray-alpha|brand|blue|red|amber|green|purple)-/ },
      { rule: "legacy radius", re: /--rounded-[a-z]+/ },
      { rule: "radius not a token", re: /border-radius:\s*(?!\s*var\()/ },
      { rule: "hairline width", re: /(?:border|outline|box-shadow)[^;]*\b\d+(?:\.\d+)?px\b/ },
    ];
    const hits = ADMIN_HTML.split("\n").flatMap((line, index) =>
      rules
        .filter(({ re }) => re.test(line))
        .map(({ rule }) => `src/spa/admin.html:${index + 1}: [${rule}] ${line.trim()}`),
    );
    expect(hits, `admin.html keeps no literal of its own:\n${hits.join("\n")}`).toEqual([]);
  });
});
