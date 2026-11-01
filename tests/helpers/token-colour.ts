/**
 * What a rendered element actually paints its text in.
 *
 * A tone assertion has to survive a class-string change, so the treatment is
 * identified by the COLOUR the browser computes: this reads the one
 * `text-(--token)` utility the element names and follows the token to the
 * value the token layer declares. An element that names no colour token is
 * inheriting from its container — reported as `null`, never as a pass.
 *
 * The theme is an argument, never a module-level constant: the same class list
 * resolves to a different colour per theme, so a pair that coincides today and
 * splits later would be judged against the wrong face.
 *
 * `text-(length:--x)` is a type step, not a colour, so it never matches.
 */
import { resolveTheme, type ThemeName } from "../../src/design-system/tokens";

/** The colour the alert face resolves to (`--tone-danger-fg`) in `theme`. */
export function dangerFg(theme: ThemeName): string {
  return resolveTheme(theme).semantic["tone-danger-fg"] ?? "";
}

const TEXT_TOKEN = /^text-\((--[\w-]+)\)$/;

/** The resolved colour of the one text colour that element names, in `theme`. */
export function textColourOf(markup: string, theme: ThemeName): string | null {
  const classes = (/class="([^"]*)"/.exec(markup)?.[1] ?? "").split(/\s+/).filter(Boolean);
  const named = classes
    .map((name) => TEXT_TOKEN.exec(name)?.[1]?.replace(/^--/, ""))
    .filter((name): name is string => name !== undefined);
  if (named.length > 1) {
    throw new Error(`one element names ${named.length} text colours: ${named.join(" ")}`);
  }
  const token = named[0];
  if (token === undefined) return null;
  const layers = resolveTheme(theme);
  const value = layers.semantic[token] ?? layers.component[token] ?? layers.primitive[token];
  if (value === undefined) throw new Error(`--${token} is not a declared token`);
  return value;
}

/** The rendered tags that declare `data-slot="slot"`, in document order. */
export function slotTags(markup: string, slot: string): string[] {
  return [...markup.matchAll(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`, "g"))].map((match) => match[0]);
}

/** The rendered spans that paint the alert colour, opening tag through text. */
export function alertSegments(markup: string, theme: ThemeName): string[] {
  const segments: string[] = [];
  const danger = dangerFg(theme);
  // Each opening tag is judged on its OWN class list: an outer muted span that
  // merely contains the coloured one is not the coloured one.
  for (const open of markup.matchAll(/<span\b[^>]*>/g)) {
    if (textColourOf(open[0], theme) !== danger) continue;
    const rest = markup.slice((open.index ?? 0) + open[0].length);
    const close = rest.indexOf("</span>");
    segments.push(open[0] + (close < 0 ? "" : rest.slice(0, close + "</span>".length)));
  }
  return segments;
}
