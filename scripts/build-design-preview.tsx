/**
 * Generator for the design-system preview page.
 *
 * One static HTML file showing the whole system — every token in all three
 * layers, every tone × strength, every control height, the type roles, the
 * operator-surface remap, and a rendered specimen of every exported primitive
 * in both themes — built from `src/design-system/` alone. There is no template
 * beside this file: the generator holds the layout, and the content is derived,
 * so the page cannot describe a system the source has moved past.
 *
 * Derivation alone cannot fail, so `--check` reads the page back and asserts
 * four separate things: one entry per declared token in each theme; the value
 * that entry prints is what the theme resolves to; every token has a specimen
 * family the page can actually draw; and every exported primitive is accounted
 * for — either its own `data-slot` appears in the markup (a specimen painted
 * it) or it is declared unpaintable with a reason (`UNPAINTED`: a Radix portal,
 * or a context root that renders no host node). The token-family rule catches
 * a *new* token; the primitive rule catches a *new* export.
 *
 * The page carries no compiled Tailwind — the classes in the markup are inert
 * here — so the primitive section is a structural proof (every export renders
 * and is accounted for in both themes), not a pixel reference.
 *
 * The output is build material, not shipped code: `dist/` is untracked and
 * only `dist/spa/` is served.
 *
 * Usage:
 *   bun run build:spa                              # the build — runs this generator, then vite
 *   bun scripts/build-design-preview.tsx            # write dist/design-preview.html
 *   bun scripts/build-design-preview.tsx --check    # exit 1 when an entry is missing
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import * as primitives from "../src/design-system/primitives/index";

import {
  OPS_SURFACE_ATTR,
  THEMES,
  legacyTokens,
  opsSurface,
  reducedMotionDurations,
  resolveTheme,
  tokenNames,
  type ThemeName,
} from "../src/design-system/tokens";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT_PATH = path.join(ROOT, "dist/design-preview.html");

const LAYERS = ["primitive", "semantic", "component"] as const;
type Layer = (typeof LAYERS)[number];

const LAYER_TITLE: Readonly<Record<Layer, string>> = {
  primitive: "Primitive — raw values, no meaning",
  semantic: "Semantic — the named jobs",
  component: "Component — composed from the semantic layer",
};

/** The three strengths a tone is used at: quiet withholds the tint, soft is the
 * tint, solid is the fill. */
const STRENGTHS = ["quiet", "soft", "solid"] as const;
type Strength = (typeof STRENGTHS)[number];

const TONE_NAME = /^tone-(.+)-(?:bg|border|fg|solid)$/;
const TYPO_NAME = /^typo-(.+)-(?:family|size|weight|line|tracking)$/;
const COLOR_VALUE = /^(?:#[0-9a-f]{3,8}|oklch\()/i;

const TYPO_PROPERTY: Readonly<Record<string, string>> = {
  family: "font-family",
  size: "font-size",
  weight: "font-weight",
  line: "line-height",
  tracking: "letter-spacing",
};

const ENTITIES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
};

/** Token values reach the page as text and as attribute values. */
const escapeHtml = (value: string): string =>
  value.replace(/[&<>"]/g, (character) => ENTITIES[character] as string);

/** The exact inverse of `escapeHtml`, one pass, so `&amp;quot;` survives. */
const decodeHtml = (value: string): string =>
  value.replace(/&(?:lt|gt|quot|amp);/g, (entity) =>
    ({ "&lt;": "<", "&gt;": ">", "&quot;": '"', "&amp;": "&" })[entity] as string,
  );

const tokensOf = (resolved: Readonly<Record<string, string>>, name: string, where: string): string => {
  const value = resolved[name];
  if (value === undefined) throw new Error(`the preview needs --${name} (${where}) and the source does not declare it`);
  return value;
};

/**
 * How one token is demonstrated. A token is only previewed if the page has a
 * specimen for its family — a paint needs a swatch, a shadow a cast surface, a
 * spacing step a run at its own length. A token whose family is not here has no
 * specimen, and `--check` fails rather than printing it as plain text and
 * calling that a preview: a new kind of token has to teach this generator how
 * to show it before it can pass.
 */
type Specimen =
  | "paint"
  | "shadow"
  | "radius"
  | "spacing"
  | "padding"
  | "height"
  | "motion"
  | "family"
  | "type"
  | "width";

/** Ordered: the first matching rule wins, so the specific families precede the
 * generic name-prefix ones. `button-height-xs` and `card-radius` carry the slot
 * in the middle, so those rules match the word anywhere, not just at the end. */
const FAMILIES: readonly { readonly kind: Specimen; readonly test: (name: string, value: string) => boolean }[] = [
  { kind: "paint", test: (_name, value) => COLOR_VALUE.test(value) },
  { kind: "shadow", test: (name) => name.startsWith("shadow-") },
  { kind: "radius", test: (name) => /(?:^|-)radius(?:-|$)/.test(name) },
  { kind: "spacing", test: (name) => name.startsWith("spacing-") },
  { kind: "padding", test: (name) => /(?:^|-)padding(?:-|$)/.test(name) },
  { kind: "height", test: (name) => /^control-h-|^row-h-|(?:^|-)height(?:-|$)/.test(name) },
  { kind: "motion", test: (name) => name.startsWith("duration-") || name.startsWith("ease-") },
  { kind: "family", test: (name) => name.startsWith("font-") },
  { kind: "type", test: (name) => name.startsWith("typo-") },
  { kind: "width", test: (name) => name.startsWith("breakpoint-") },
];

export function specimenOf(name: string, value: string): { kind: Specimen; html: string } | undefined {
  const kind = FAMILIES.find((rule) => rule.test(name, value))?.kind;
  const swatch = (cls: string, css: string, text = ""): { kind: Specimen; html: string } => ({
    kind: kind as Specimen,
    html: `<span class="${cls}" style="${css}">${text}</span>`,
  });

  switch (kind) {
    case "paint":
      return swatch("specimen-chip", `--chip: var(--${name})`);
    case "shadow":
      return swatch("specimen-shadow", `box-shadow: var(--${name})`);
    case "radius":
      return swatch("specimen-radius", `border-radius: var(--${name})`);
    case "spacing":
      return swatch("specimen-length", `width: var(--${name})`);
    case "padding":
      return swatch("specimen-length", `padding-left: var(--${name})`, "▏");
    case "height":
      return swatch("specimen-height", `height: var(--${name})`);
    case "motion":
      return swatch("specimen-motion", `transition-duration: var(--${name})`);
    case "family":
      return swatch("specimen-family", `font-family: var(--${name})`, "Aa");
    case "type": {
      // The slot is the trailing segment; a role's five slots are shown against
      // the same sample text, which is how they compose. An unknown slot has no
      // property to set, so it reports no specimen rather than a blank one.
      const property = TYPO_PROPERTY[name.slice(name.lastIndexOf("-") + 1)];
      if (property === undefined) return undefined;
      return swatch("specimen-family", `${property}: var(--${name})`, "Aa 0123");
    }
    case "width":
      return swatch("specimen-length", `width: var(--${name})`);
    default:
      return undefined;
  }
}

/** One token entry: name, the specimen for its family, and the resolved value. */
function tokenRow(layer: Layer, name: string, value: string): string {
  const specimen = specimenOf(name, value);
  return (
    `<tr data-layer="${layer}" data-token="${name}" data-value="${escapeHtml(value)}" ` +
    `data-specimen="${specimen?.kind ?? "none"}">` +
    `<th scope="row"><code>--${name}</code></th>` +
    `<td class="specimen">${specimen?.html ?? ""}</td>` +
    `<td><code>${escapeHtml(value)}</code></td></tr>`
  );
}

function tokenTable(layer: Layer, tokens: Readonly<Record<string, string>>): string[] {
  return [
    `<h2>${LAYER_TITLE[layer]}</h2>`,
    '<table><thead><tr><th scope="col">Token</th><th scope="col"></th><th scope="col">Resolved value</th></tr></thead>',
    "<tbody>",
    ...Object.entries(tokens).map(([name, value]) => tokenRow(layer, name, value)),
    "</tbody></table>",
  ];
}

/** The tone meanings the semantic layer declares, in source order. */
function toneMeanings(names: readonly string[]): string[] {
  const meanings: string[] = [];
  for (const name of names) {
    const meaning = TONE_NAME.exec(name)?.[1];
    if (meaning !== undefined && !meanings.includes(meaning)) meanings.push(meaning);
  }
  return meanings;
}

function pillStyle(meaning: string, strength: Strength): string {
  const slot = `--tone-${meaning}`;
  switch (strength) {
    case "quiet":
      // The tint is withheld; the edge and the label still carry the meaning.
      return `background:transparent;border-color:var(${slot}-border);color:var(${slot}-fg)`;
    case "soft":
      return `background:var(${slot}-bg);border-color:var(${slot}-border);color:var(${slot}-fg)`;
    case "solid":
      // The label is the page ink: a tone fg is chosen to sit on the tint, not
      // on its own solid step.
      return `background:var(${slot}-solid);border-color:transparent;color:var(--surface-page)`;
  }
}

function toneGrid(semantic: Readonly<Record<string, string>>): string[] {
  const meanings = toneMeanings(Object.keys(semantic));
  // A meaning declared without one of its four faces would render a pill with
  // an undefined var — visible as "no style", not as a missing token.
  const absent = meanings.flatMap((meaning) =>
    ["bg", "border", "fg", "solid"]
      .filter((slot) => !(`tone-${meaning}-${slot}` in semantic))
      .map((slot) => `--tone-${meaning}-${slot}`),
  );
  if (absent.length > 0) {
    throw new Error(`the tone grid needs ${absent.join(", ")}, and the source does not declare it`);
  }

  return [
    "<h2>Tone × strength</h2>",
    '<table><thead><tr><th scope="col">Tone</th>',
    ...STRENGTHS.map((strength) => `<th scope="col">${strength}</th>`),
    "</tr></thead><tbody>",
    ...meanings.map(
      (meaning) =>
        `<tr><th scope="row"><code>${meaning}</code></th>` +
        STRENGTHS.map(
          (strength) =>
            `<td><span class="pill" data-tone="${meaning}" data-strength="${strength}" ` +
            `style="${pillStyle(meaning, strength)}">${meaning}</span></td>`,
        ).join("") +
        "</tr>",
    ),
    "</tbody></table>",
  ];
}

function controlHeights(semantic: Readonly<Record<string, string>>): string[] {
  return [
    "<h2>Control heights</h2>",
    ...Object.entries(semantic)
      .filter(([name]) => name.startsWith("control-h-"))
      .map(
        ([name, value]) =>
          `<div class="height-row"><span class="height-sample" data-control-height="${name}" ` +
          `style="height: var(--${name})"><code>--${name}</code></span>` +
          `<code>${escapeHtml(value)}</code></div>`,
      ),
  ];
}

/** One specimen per typography role, set from that role's own five tokens. */
function typeSpecimens(semantic: Readonly<Record<string, string>>): string[] {
  const roles: string[] = [];
  for (const name of Object.keys(semantic)) {
    const role = TYPO_NAME.exec(name)?.[1];
    if (role !== undefined && !roles.includes(role)) roles.push(role);
  }

  return [
    "<h2>Type</h2>",
    ...roles.map((role) => {
      const declarations = Object.entries(TYPO_PROPERTY).map(([slot, property]) => {
        // A role missing one slot would set an undefined property and
        // inherit the page's — a specimen that lies about the role.
        tokensOf(semantic, `typo-${role}-${slot}`, `the ${role} type role`);
        return `${property}: var(--typo-${role}-${slot});`;
      });
      return `<p class="type-sample" data-typo="${role}" style="${declarations.join("")}">Aa 0123 — ${role}</p>`;
    }),
  ];
}

/** The operator-surface remap: the same names, resolved onto neutral emphasis. */
function operatorSurface(): string[] {
  return [
    `<h2>Operator surface variant — <code>${escapeHtml(OPS_SURFACE_ATTR)}</code></h2>`,
    `<div ${OPS_SURFACE_ATTR}>`,
    '<table><thead><tr><th scope="col">Token</th><th scope="col"></th><th scope="col">Remapped to</th></tr></thead><tbody>',
    ...Object.entries(opsSurface).map(
      ([name, value]) =>
        `<tr data-remap="${name}" data-value="${escapeHtml(value)}">` +
        `<th scope="row"><code>--${name}</code></th>` +
        `<td class="specimen"><span class="specimen-chip" style="--chip: var(--${name})"></span></td>` +
        `<td><code>${escapeHtml(value)}</code></td></tr>`,
    ),
    "</tbody></table>",
    "</div>",
  ];
}

/**
 * The transitional names, once for the page: each is a declaration that
 * resolves through the token it names and leaves with the plan that closes it,
 * so printing it per theme would imply a second value that does not exist.
 */
function transitionalNames(): string[] {
  return [
    "<h2>Transitional names — each leaves with the plan that closes it</h2>",
    '<table><thead><tr><th scope="col">Name</th><th scope="col">Declared as</th><th scope="col">Closed by</th></tr></thead><tbody>',
    ...legacyTokens.map(
      (token) =>
        `<tr data-legacy="${token.name}" data-value="${escapeHtml(token.value)}" ` +
        `data-owner="${escapeHtml(token.owner)}">` +
        `<th scope="row"><code>--${token.name}</code></th>` +
        `<td><code>${escapeHtml(token.value)}</code></td>` +
        `<td><code>${escapeHtml(token.owner)}</code></td></tr>`,
    ),
    "</tbody></table>",
  ];
}

/**
 * Primitive coverage: one rendered specimen per primitive, and the exported
 * faces the server renderer cannot paint.
 *
 * A specimen is a composition, not a singleton: a Radix face only mounts
 * inside the part that owns it (a `SelectItem` lives in a `SelectContent`), and
 * the page is only evidence if the face really rendered. One composition per
 * primitive therefore covers every export that primitive offers.
 *
 * `renderToStaticMarkup` inherits one limit from Radix: a portal mounts its
 * container in a layout effect, so nothing paints during server rendering.
 * Those faces — and every context root, which renders no host node at all —
 * are named in `UNPAINTED` with their reason. The check requires that set to be
 * *exactly* the exports the markup did not paint, so a new export cannot pass
 * unexplained and a reason cannot outlive the export it names.
 */
type UnpaintedReason = "Radix portal — the server renderer mounts no container" | "context root — renders no host node";

const UNPAINTED: Readonly<Record<string, UnpaintedReason>> = {
  // Dialogs: the trigger paints; everything behind the overlay is portalled.
  Dialog: "context root — renders no host node",
  DialogPortal: "Radix portal — the server renderer mounts no container",
  DialogOverlay: "Radix portal — the server renderer mounts no container",
  DialogContent: "Radix portal — the server renderer mounts no container",
  DialogHeader: "Radix portal — the server renderer mounts no container",
  DialogTitle: "Radix portal — the server renderer mounts no container",
  DialogDescription: "Radix portal — the server renderer mounts no container",
  DialogFooter: "Radix portal — the server renderer mounts no container",
  DialogClose: "Radix portal — the server renderer mounts no container",
  // Sheets reuse the dialog root and portal.
  Sheet: "context root — renders no host node",
  SheetContent: "Radix portal — the server renderer mounts no container",
  SheetHeader: "Radix portal — the server renderer mounts no container",
  SheetTitle: "Radix portal — the server renderer mounts no container",
  SheetDescription: "Radix portal — the server renderer mounts no container",
  SheetFooter: "Radix portal — the server renderer mounts no container",
  SheetClose: "Radix portal — the server renderer mounts no container",
  // Menus: the trigger paints; the menu body is portalled.
  DropdownMenu: "context root — renders no host node",
  DropdownMenuPortal: "Radix portal — the server renderer mounts no container",
  DropdownMenuContent: "Radix portal — the server renderer mounts no container",
  DropdownMenuGroup: "Radix portal — the server renderer mounts no container",
  DropdownMenuLabel: "Radix portal — the server renderer mounts no container",
  DropdownMenuItem: "Radix portal — the server renderer mounts no container",
  DropdownMenuCheckboxItem: "Radix portal — the server renderer mounts no container",
  DropdownMenuRadioGroup: "Radix portal — the server renderer mounts no container",
  DropdownMenuRadioItem: "Radix portal — the server renderer mounts no container",
  DropdownMenuSeparator: "Radix portal — the server renderer mounts no container",
  DropdownMenuShortcut: "Radix portal — the server renderer mounts no container",
  DropdownMenuSub: "context root — renders no host node",
  DropdownMenuSubTrigger: "Radix portal — the server renderer mounts no container",
  DropdownMenuSubContent: "Radix portal — the server renderer mounts no container",
  // Selects: the trigger and its value paint; the item list is portalled.
  Select: "context root — renders no host node",
  SelectContent: "Radix portal — the server renderer mounts no container",
  SelectGroup: "Radix portal — the server renderer mounts no container",
  SelectLabel: "Radix portal — the server renderer mounts no container",
  SelectItem: "Radix portal — the server renderer mounts no container",
  SelectSeparator: "Radix portal — the server renderer mounts no container",
  SelectScrollUpButton: "Radix portal — the server renderer mounts no container",
  SelectScrollDownButton: "Radix portal — the server renderer mounts no container",
  // Tooltips: the trigger paints; the root, its provider and the bubble do not.
  Tooltip: "context root — renders no host node",
  TooltipProvider: "context root — renders no host node",
  TooltipContent: "Radix portal — the server renderer mounts no container",
};

/** Readable alias so the compositions below read as markup, not as a lookup. */
const P = primitives;

const SPECIMENS: Readonly<Record<string, ReactElement>> = {
  Button: <P.Button>Button</P.Button>,
  Card: (
    <P.Card>
      <P.CardHeader>
        <P.CardTitle>Card</P.CardTitle>
        <P.CardDescription>Card description</P.CardDescription>
        <P.CardAction>action</P.CardAction>
      </P.CardHeader>
      <P.CardContent>Card content</P.CardContent>
      <P.CardFooter>Card footer</P.CardFooter>
    </P.Card>
  ),
  Dialog: (
    <P.Dialog open>
      <P.DialogTrigger>Open dialog</P.DialogTrigger>
      <P.DialogPortal>
        <P.DialogOverlay />
        <P.DialogContent>
          <P.DialogHeader>
            <P.DialogTitle>Dialog</P.DialogTitle>
            <P.DialogDescription>Dialog description</P.DialogDescription>
          </P.DialogHeader>
          <P.DialogFooter>
            <P.DialogClose>Close</P.DialogClose>
          </P.DialogFooter>
        </P.DialogContent>
      </P.DialogPortal>
    </P.Dialog>
  ),
  DropdownMenu: (
    <P.DropdownMenu open>
      <P.DropdownMenuTrigger>Open menu</P.DropdownMenuTrigger>
      <P.DropdownMenuPortal>
        <P.DropdownMenuContent>
          <P.DropdownMenuLabel>Menu</P.DropdownMenuLabel>
          <P.DropdownMenuGroup>
            <P.DropdownMenuItem>Item</P.DropdownMenuItem>
            <P.DropdownMenuCheckboxItem checked>Checkbox</P.DropdownMenuCheckboxItem>
            <P.DropdownMenuRadioGroup value="one">
              <P.DropdownMenuRadioItem value="one">Radio</P.DropdownMenuRadioItem>
            </P.DropdownMenuRadioGroup>
            <P.DropdownMenuSub>
              <P.DropdownMenuSubTrigger>Submenu</P.DropdownMenuSubTrigger>
              <P.DropdownMenuSubContent>
                <P.DropdownMenuItem>Nested</P.DropdownMenuItem>
              </P.DropdownMenuSubContent>
            </P.DropdownMenuSub>
            <P.DropdownMenuSeparator />
            <P.DropdownMenuShortcut>⌘K</P.DropdownMenuShortcut>
          </P.DropdownMenuGroup>
        </P.DropdownMenuContent>
      </P.DropdownMenuPortal>
    </P.DropdownMenu>
  ),
  Input: <P.Input placeholder="Input" />,
  Select: (
    <P.Select open>
      <P.SelectTrigger>
        <P.SelectValue placeholder="Select" />
      </P.SelectTrigger>
      <P.SelectContent>
        <P.SelectScrollUpButton />
        <P.SelectGroup>
          <P.SelectLabel>Group</P.SelectLabel>
          <P.SelectItem value="one">Item</P.SelectItem>
          <P.SelectSeparator />
        </P.SelectGroup>
        <P.SelectScrollDownButton />
      </P.SelectContent>
    </P.Select>
  ),
  Separator: <P.Separator />,
  Sheet: (
    <P.Sheet open>
      <P.SheetTrigger>Open sheet</P.SheetTrigger>
      <P.SheetContent>
        <P.SheetHeader>
          <P.SheetTitle>Sheet</P.SheetTitle>
          <P.SheetDescription>Sheet description</P.SheetDescription>
        </P.SheetHeader>
        <P.SheetFooter>
          <P.SheetClose>Close</P.SheetClose>
        </P.SheetFooter>
      </P.SheetContent>
    </P.Sheet>
  ),
  Sidebar: (
    <P.SidebarProvider>
      <P.Sidebar>
        <P.SidebarHeader>
          <P.SidebarInput placeholder="Search" />
          <P.SidebarTrigger />
        </P.SidebarHeader>
        <P.SidebarContent>
          <P.SidebarGroup>
            <P.SidebarGroupLabel>Group</P.SidebarGroupLabel>
            <P.SidebarGroupAction aria-label="Group action">+</P.SidebarGroupAction>
            <P.SidebarGroupContent>
              <P.SidebarMenu>
                <P.SidebarMenuItem>
                  <P.SidebarMenuButton>Menu button</P.SidebarMenuButton>
                  <P.SidebarMenuAction aria-label="Menu action">…</P.SidebarMenuAction>
                  <P.SidebarMenuBadge>3</P.SidebarMenuBadge>
                </P.SidebarMenuItem>
                <P.SidebarMenuItem>
                  <P.SidebarMenuSkeleton showIcon />
                </P.SidebarMenuItem>
                <P.SidebarMenuItem>
                  <P.SidebarMenuSub>
                    <P.SidebarMenuSubItem>
                      <P.SidebarMenuSubButton>Sub item</P.SidebarMenuSubButton>
                    </P.SidebarMenuSubItem>
                  </P.SidebarMenuSub>
                </P.SidebarMenuItem>
              </P.SidebarMenu>
            </P.SidebarGroupContent>
          </P.SidebarGroup>
          <P.SidebarSeparator />
        </P.SidebarContent>
        <P.SidebarFooter>Footer</P.SidebarFooter>
        <P.SidebarRail />
      </P.Sidebar>
      <P.SidebarInset>Inset</P.SidebarInset>
    </P.SidebarProvider>
  ),
  Skeleton: <P.Skeleton />,
  Table: (
    <P.Table>
      <P.TableCaption>Caption</P.TableCaption>
      <P.TableHeader>
        <P.TableRow>
          <P.TableHead>Head</P.TableHead>
        </P.TableRow>
      </P.TableHeader>
      <P.TableBody>
        <P.TableRow>
          <P.TableCell>Cell</P.TableCell>
        </P.TableRow>
      </P.TableBody>
      <P.TableFooter>
        <P.TableRow>
          <P.TableCell>Footer</P.TableCell>
        </P.TableRow>
      </P.TableFooter>
    </P.Table>
  ),
  Tabs: (
    <P.Tabs defaultValue="one">
      <P.TabsList>
        <P.TabsTrigger value="one">One</P.TabsTrigger>
      </P.TabsList>
      <P.TabsContent value="one">Tabs content</P.TabsContent>
    </P.Tabs>
  ),
  Toggle: <P.Toggle>Toggle</P.Toggle>,
  ToggleGroup: (
    <P.ToggleGroup type="single" defaultValue="one">
      <P.ToggleGroupItem value="one">One</P.ToggleGroupItem>
      <P.ToggleGroupItem value="two">Two</P.ToggleGroupItem>
    </P.ToggleGroup>
  ),
  Tooltip: (
    <P.TooltipProvider>
      <P.Tooltip open>
        <P.TooltipTrigger>Hover</P.TooltipTrigger>
        <P.TooltipContent>Tooltip</P.TooltipContent>
      </P.Tooltip>
    </P.TooltipProvider>
  ),
};

/** kebab name → `data-slot`, with the one component whose slot is not its name. */
const SLOT_ALIAS: Readonly<Record<string, string>> = { SidebarProvider: "sidebar-wrapper" };

const slotOf = (name: string): string =>
  SLOT_ALIAS[name] ?? name.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

/** The components the barrel exports: functions whose name is capitalised. */
const exportedPrimitives = (): string[] =>
  Object.entries(primitives)
    .filter(([name, value]) => /^[A-Z]/.test(name) && typeof value === "function")
    .map(([name]) => name);

const SPECIMEN_HTML: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(SPECIMENS).map(([name, element]) => [name, renderToStaticMarkup(element)]),
);

/**
 * The exports a markup string paints, by their own `data-slot`. Run against the
 * specimens to produce the section's counts, and against a theme section by the
 * check to prove the page carries them.
 */
const paintedPrimitives = (markup: string): string[] =>
  exportedPrimitives().filter((name) => markup.includes(`data-slot="${slotOf(name)}"`));

function primitiveSection(): string[] {
  const exported = exportedPrimitives();
  const markup = Object.values(SPECIMEN_HTML).join("");
  const painted = paintedPrimitives(markup);
  const unpainted = exported.filter((name) => !painted.includes(name));

  return [
    "<h2>Primitives</h2>",
    `<p data-primitives="${exported.length}" data-painted="${painted.length}" data-unpainted="${unpainted.length}">` +
      `${exported.length} exports across ${Object.keys(SPECIMENS).length} specimens: ` +
      `${painted.length} paint their own slot; ${unpainted.length} are portal- or context-bound ` +
      "and are listed once, below the themes. Class names stay inert here — this page carries no compiled Tailwind.</p>",
    '<div class="primitives">',
    ...Object.entries(SPECIMEN_HTML).map(
      ([name, html]) =>
        `<figure class="primitive" data-primitive="${name}">${html}<figcaption>${name}</figcaption></figure>`,
    ),
    "</div>",
  ];
}

/** Faces the server renderer cannot paint, printed once with their reason. */
function unpaintedSection(): string[] {
  return [
    "<h2>Unpainted primitive faces</h2>",
    "<p>Rendered by the client only: a Radix portal mounts its container after hydration, and a context root has no host node. Their specimens above still mount them, so a broken primitive fails the build.</p>",
    '<table><thead><tr><th scope="col">Export</th><th scope="col">Reason</th></tr></thead><tbody>',
    ...Object.entries(UNPAINTED).map(
      ([name, reason]) =>
        `<tr data-unpainted-face="${name}" data-reason="${escapeHtml(reason)}">` +
        `<th scope="row"><code>${name}</code></th><td>${escapeHtml(reason)}</td></tr>`,
    ),
    "</tbody></table>",
  ];
}

const PAGE_CSS = `*, *::before, *::after { box-sizing: border-box; }
html { color-scheme: dark light; }
body { margin: 0; }
.theme {
  padding: 32px 40px 48px;
  background: var(--surface-page);
  color: var(--text-primary);
  font-family: var(--typo-copy-14-family);
  font-size: var(--typo-copy-14-size);
  font-weight: var(--typo-copy-14-weight);
  line-height: var(--typo-copy-14-line);
}
.theme h1 {
  margin: 0 0 24px;
  font-family: var(--typo-heading-24-family);
  font-size: var(--typo-heading-24-size);
  font-weight: var(--typo-heading-24-weight);
  line-height: var(--typo-heading-24-line);
  letter-spacing: var(--typo-heading-24-tracking);
  text-transform: capitalize;
}
.theme h2 {
  margin: 32px 0 8px;
  color: var(--text-muted);
  font-family: var(--typo-label-12-family);
  font-size: var(--typo-label-12-size);
  font-weight: var(--typo-label-12-weight);
  letter-spacing: var(--typo-label-12-tracking);
  text-transform: uppercase;
}
table { width: 100%; border-collapse: collapse; }
th, td {
  padding: 5px 8px;
  border-bottom: 1px solid var(--border-subtle);
  font-weight: inherit;
  text-align: left;
  vertical-align: middle;
}
thead th {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
tbody th { font-weight: 500; }
code { color: var(--text-secondary); font-family: var(--font-mono); font-size: 12px; }
.specimen { width: 96px; }
.specimen-chip {
  display: block;
  width: 56px;
  height: 16px;
  border: 1px solid var(--border-default);
  border-radius: 4px;
  background: var(--chip);
}
.specimen-shadow {
  display: block;
  width: 56px;
  height: 24px;
  border-radius: 4px;
  background: var(--surface-card);
}
.specimen-radius {
  display: block;
  width: 24px;
  height: 24px;
  border: 1px solid var(--border-strong);
  background: var(--surface-inset);
}
.specimen-length {
  display: block;
  height: 8px;
  max-width: 100%;
  background: var(--tone-accent-solid);
}
.specimen-height {
  display: block;
  width: 48px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--surface-inset);
}
.specimen-motion {
  display: block;
  width: 48px;
  height: 2px;
  background: var(--border-strong);
  transition-property: width;
  transition-timing-function: linear;
}
.specimen-family { font-size: 14px; }

.pill {
  display: inline-flex;
  align-items: center;
  height: 20px;
  padding: 0 8px;
  border: 1px solid;
  border-radius: var(--radius-pill);
  font-family: var(--typo-label-12-family);
  font-size: 11px;
  font-weight: 600;
}
.height-row { display: flex; align-items: center; gap: 12px; margin-bottom: 6px; }
.height-sample {
  display: inline-flex;
  align-items: center;
  padding: 0 12px;
  border: 1px solid var(--border-default);
  border-radius: var(--radius-control);
  background: var(--surface-inset);
}
.type-sample { margin: 0 0 10px; }
.primitives { display: flex; flex-wrap: wrap; gap: 12px; }
.primitive {
  flex: 0 1 auto;
  min-width: 120px;
  padding: 8px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-control);
}
.primitive figcaption {
  margin-top: 8px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-size: 11px;
}`;

/** One theme's resolved declarations, so each section renders itself. */
function themeStyle(theme: ThemeName): string {
  const resolved = resolveTheme(theme);
  const declarations = LAYERS.flatMap((layer) => Object.entries(resolved[layer])).map(
    ([name, value]) => `--${name}: ${value};`,
  );
  return `[data-theme="${theme}"] { ${declarations.join(" ")} }`;
}

/** The remap is theme-invariant: every value names another token. */
function operatorStyle(): string {
  const declarations = Object.entries(opsSurface).map(([name, value]) => `--${name}: ${value};`);
  return `[${OPS_SURFACE_ATTR}] { ${declarations.join(" ")} }`;
}

function themeSection(theme: ThemeName): string[] {
  const resolved = resolveTheme(theme);
  return [
    `<!-- theme:${theme} -->`,
    `<section class="theme" data-theme="${theme}">`,
    `<h1>${theme}</h1>`,
    ...toneGrid(resolved.semantic),
    ...controlHeights(resolved.semantic),
    ...primitiveSection(),
    ...typeSpecimens(resolved.semantic),
    ...LAYERS.flatMap((layer) => tokenTable(layer, resolved[layer])),
    ...operatorSurface(),
    "</section>",
    `<!-- /theme:${theme} -->`,
  ];
}

/**
 * Rendered once, in dark ink: each entry is an alias declaration, so it prints
 * the expression and its owner rather than a value that would differ by theme.
 */
function transitionalSection(): string[] {
  return [
    "<!-- theme:shared -->",
    '<section class="theme" data-theme="dark">',
    "<h1>Transitional names</h1>",
    "<p>Alias declarations, theme-independent: each resolves through the token it names and leaves with the plan that closes it.</p>",
    ...transitionalNames(),
    ...unpaintedSection(),
    "<h2>Reduced-motion fold — <code>prefers-reduced-motion: reduce</code></h2>",
    '<table><thead><tr><th scope="col">Token</th><th scope="col">Reduced</th></tr></thead><tbody>',
    ...Object.entries(reducedMotionDurations).map(
      ([name, value]) =>
        `<tr data-reduced-motion="${name}" data-value="${escapeHtml(value)}">` +
        `<th scope="row"><code>--${name}</code></th><td><code>${escapeHtml(value)}</code></td></tr>`,
    ),
    "</tbody></table>",
    "</section>",
    "<!-- /theme:shared -->",
  ];
}

/** The page, as a pure function of the token source. */
export function buildPreview(): string {
  return [
    "<!doctype html>",
    "<!--",
    "  GENERATED — do not edit.",
    "  Emitted by `bun scripts/build-design-preview.tsx` from `src/design-system/tokens/`,",
    "  and checked by its `--check` mode. Change the token source and regenerate.",
    "-->",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    "<title>Design system preview</title>",
    `<style>\n${PAGE_CSS}\n${THEMES.map(themeStyle).join("\n")}\n${operatorStyle()}\n</style>`,
    "</head>",
    "<body>",
    ...THEMES.flatMap((theme) => themeSection(theme)),
    ...transitionalSection(),
    "</body>",
    "</html>",
    "",
  ].join("\n");
}

function sectionOf(html: string, theme: ThemeName): string {
  const open = html.indexOf(`<!-- theme:${theme} -->`);
  const close = html.indexOf(`<!-- /theme:${theme} -->`);
  if (open === -1 || close < open) throw new Error(`the page has no ${theme} section; regenerate it`);
  return html.slice(open, close);
}

/** Entries of one theme section, by token name — the shape the page promises. */
function entryValues(section: string): Map<string, { value: string; specimen: string }> {
  const entries = new Map<string, { value: string; specimen: string }>();
  const ENTRY =
    /data-layer="[a-z]+" data-token="([^"]+)" data-value="([^"]*)" data-specimen="([a-z]+)"/g;
  for (let match = ENTRY.exec(section); match !== null; match = ENTRY.exec(section)) {
    entries.set(match[1] as string, {
      value: decodeHtml(match[2] as string),
      specimen: match[3] as string,
    });
  }
  return entries;
}

export interface PreviewCoverage {
  readonly ok: boolean;
  /** Token entries the page carries, and the count it owes. */
  readonly entries: number;
  readonly expectedEntries: number;
  /** Tone × strength specimens, across both themes. */
  readonly tonePairs: number;
  readonly expectedTonePairs: number;
  readonly controlHeights: number;
  readonly expectedControlHeights: number;
  /** Operator-surface remaps, across both themes. */
  readonly remaps: number;
  readonly expectedRemaps: number;
  /** Primitive specimens, across both themes. */
  readonly specimens: number;
  readonly expectedSpecimens: number;
  /** Exported primitives whose own `data-slot` the markup paints. */
  readonly painted: number;
  readonly expectedPainted: number;
  /** Faces that cannot paint on the server, listed once with their reason. */
  readonly unpainted: number;
  readonly expectedUnpainted: number;
  /** Transitional names, printed once as declarations. */
  readonly transitional: number;
  readonly expectedTransitional: number;
  /** The reduced-motion fold, printed once. */
  readonly reducedMotion: number;
  readonly expectedReducedMotion: number;
  /** One line per thing the page fails to carry. */
  readonly missing: readonly string[];
  /** Entries that printed a value the token source does not hold for that theme. */
  readonly wrong: readonly { readonly entry: string; readonly page: string; readonly source: string }[];
}

/** Reads the page back and says what it covers. */
export function previewCoverage(html: string): PreviewCoverage {
  const names = tokenNames();
  const meanings = toneMeanings(names.semantic);
  const heights = names.semantic.filter((name) => name.startsWith("control-h-"));
  const remaps = Object.keys(opsSurface);

  const missing: string[] = [];
  const wrong: { entry: string; page: string; source: string }[] = [];
  const counts = {
    entries: 0,
    tonePairs: 0,
    controlHeights: 0,
    remaps: 0,
    specimens: 0,
    painted: 0,
    unpainted: 0,
    transitional: 0,
    reducedMotion: 0,
  };
  const exported = exportedPrimitives();
  const unpaintedFaces = Object.keys(UNPAINTED);

  // `entryValues` keys by token name alone, so the layers must not share one.
  // They do not (each layer references the one beneath it, never declares its
  // names), and a shared name would make one entry silently cover two tokens.
  const shared = names.primitive.filter(
    (name) => names.semantic.includes(name) || names.component.includes(name),
  );
  for (const name of shared) missing.push(`--${name} is declared by more than one layer; the page cannot tell them apart`);

  const sharedOpen = html.indexOf("<!-- theme:shared -->");
  const sharedClose = html.indexOf("<!-- /theme:shared -->");
  const sharedHtml =
    sharedOpen === -1 || sharedClose < sharedOpen ? "" : html.slice(sharedOpen, sharedClose);
  for (const token of legacyTokens) {
    if (sharedHtml.includes(`data-legacy="${token.name}"`)) counts.transitional += 1;
    else missing.push(`no transitional entry for --${token.name} (closed by ${token.owner})`);
  }
  for (const [name, value] of Object.entries(reducedMotionDurations)) {
    if (sharedHtml.includes(`data-reduced-motion="${name}" data-value="${escapeHtml(value)}"`)) {
      counts.reducedMotion += 1;
    } else missing.push(`no reduced-motion entry for --${name} (${value})`);
  }
  for (const [name, reason] of Object.entries(UNPAINTED)) {
    if (sharedHtml.includes(`data-unpainted-face="${name}" data-reason="${escapeHtml(reason)}"`)) {
      counts.unpainted += 1;
    } else missing.push(`no unpainted-ledger entry for ${name} (${reason})`);
  }

  for (const theme of THEMES) {
    const section = sectionOf(html, theme);
    const entries = entryValues(section);
    const resolved = resolveTheme(theme);

    for (const layer of LAYERS) {
      for (const name of names[layer]) {
        const source = tokensOf(resolved[layer], name, `${theme} ${layer}`);
        const entry = `${theme} ${layer}/${name}`;
        const page = entries.get(name);
        const expected = specimenOf(name, source);
        if (page === undefined) missing.push(`${theme}: no entry for ${layer}/${name}`);
        else if (page.value !== source) wrong.push({ entry, page: page.value, source });
        else if (expected === undefined) {
          // The family is what makes an entry a preview rather than a text row:
          // a new token kind must teach this generator a specimen first.
          missing.push(`${entry} has no specimen family; add one to FAMILIES`);
        } else if (page.specimen !== expected.kind) {
          missing.push(`${entry} is shown as ${page.specimen}, but its family is ${expected.kind}`);
        } else counts.entries += 1;
      }
    }

    for (const meaning of meanings) {
      for (const strength of STRENGTHS) {
        if (section.includes(`data-tone="${meaning}" data-strength="${strength}"`)) counts.tonePairs += 1;
        else missing.push(`${theme}: no specimen for ${meaning} × ${strength}`);
      }
    }

    for (const name of heights) {
      if (section.includes(`data-control-height="${name}"`)) counts.controlHeights += 1;
      else missing.push(`${theme}: no specimen for --${name}`);
    }

    for (const name of remaps) {
      if (section.includes(`data-remap="${name}"`)) counts.remaps += 1;
      else missing.push(`${theme}: no operator-surface entry for --${name}`);
    }

    for (const name of Object.keys(SPECIMENS)) {
      if (section.includes(`data-primitive="${name}"`)) counts.specimens += 1;
      else missing.push(`${theme}: no primitive specimen for ${name}`);
    }

    // Coverage is closed in both directions: an export the markup does not
    // paint must be declared, and a declaration must still be unpaid.
    const painted = paintedPrimitives(section);
    counts.painted += painted.length;
    for (const name of exported) {
      if (!painted.includes(name) && !(name in UNPAINTED)) {
        missing.push(`${theme}: ${name} neither paints its own slot nor is declared in UNPAINTED`);
      }
    }
    for (const name of unpaintedFaces) {
      if (!exported.includes(name)) {
        missing.push(`${theme}: UNPAINTED names ${name}, which the barrel does not export`);
      } else if (painted.includes(name)) {
        missing.push(`${theme}: UNPAINTED names ${name}, but the markup paints it`);
      }
    }
  }

  const expected = {
    entries: (names.primitive.length + names.semantic.length + names.component.length) * THEMES.length,
    tonePairs: meanings.length * STRENGTHS.length * THEMES.length,
    controlHeights: heights.length * THEMES.length,
    remaps: remaps.length * THEMES.length,
    specimens: Object.keys(SPECIMENS).length * THEMES.length,
    painted: (exported.length - unpaintedFaces.length) * THEMES.length,
    unpainted: unpaintedFaces.length,
    transitional: legacyTokens.length,
    reducedMotion: Object.keys(reducedMotionDurations).length,
  };

  return {
    ok:
      missing.length === 0 &&
      wrong.length === 0 &&
      counts.entries === expected.entries &&
      counts.tonePairs === expected.tonePairs &&
      counts.controlHeights === expected.controlHeights &&
      counts.remaps === expected.remaps &&
      counts.specimens === expected.specimens &&
      counts.painted === expected.painted &&
      counts.unpainted === expected.unpainted &&
      counts.transitional === expected.transitional &&
      counts.reducedMotion === expected.reducedMotion,
    entries: counts.entries,
    expectedEntries: expected.entries,
    tonePairs: counts.tonePairs,
    expectedTonePairs: expected.tonePairs,
    controlHeights: counts.controlHeights,
    expectedControlHeights: expected.controlHeights,
    remaps: counts.remaps,
    expectedRemaps: expected.remaps,
    specimens: counts.specimens,
    expectedSpecimens: expected.specimens,
    painted: counts.painted,
    expectedPainted: expected.painted,
    unpainted: counts.unpainted,
    expectedUnpainted: expected.unpainted,
    transitional: counts.transitional,
    expectedTransitional: expected.transitional,
    reducedMotion: counts.reducedMotion,
    expectedReducedMotion: expected.reducedMotion,
    missing,
    wrong,
  };
}

if (import.meta.main) {
  const html = buildPreview();
  const coverage = previewCoverage(html);
  const label = path.relative(ROOT, OUT_PATH);

  if (!coverage.ok) {
    for (const entry of coverage.missing) console.error(`  missing  ${entry}`);
    for (const entry of coverage.wrong) {
      console.error(`  stale    ${entry.entry}`);
      console.error(`           page:   ${JSON.stringify(entry.page)}`);
      console.error(`           source: ${JSON.stringify(entry.source)}`);
    }
    console.error(
      `design-preview: ${coverage.missing.length} missing, ${coverage.wrong.length} stale ` +
        `(${coverage.entries}/${coverage.expectedEntries} token entries, ` +
        `${coverage.tonePairs}/${coverage.expectedTonePairs} tone × strength, ` +
        `${coverage.controlHeights}/${coverage.expectedControlHeights} control heights, ` +
        `${coverage.remaps}/${coverage.expectedRemaps} operator-surface remaps, ` +
        `${coverage.specimens}/${coverage.expectedSpecimens} primitive specimens, ` +
        `${coverage.painted}/${coverage.expectedPainted} painted primitive exports, ` +
        `${coverage.unpainted}/${coverage.expectedUnpainted} declared unpainted, ` +
        `${coverage.transitional}/${coverage.expectedTransitional} transitional names)`,
    );
    console.error("The page is derived from the source: a gap here is a gap in this generator.");
    process.exit(1);
  }

  console.log(
    `design-preview: ${coverage.entries} token entries across ${THEMES.length} themes, ` +
      `${coverage.tonePairs} tone × strength, ${coverage.controlHeights} control heights, ` +
      `${coverage.remaps} operator-surface remaps, ${coverage.transitional} transitional names, ` +
      `${coverage.specimens} primitive specimens ` +
      `(${coverage.painted} painted exports, ${coverage.unpainted} portal/context-bound and listed)`,
  );

  if (!process.argv.includes("--check")) {
    mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    writeFileSync(OUT_PATH, html);
    console.log(`${label} written`);
  }
}
