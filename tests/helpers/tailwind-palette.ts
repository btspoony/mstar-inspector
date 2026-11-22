
const FAMILIES = [
  "slate",
  "gray",
  "zinc",
  "neutral",
  "stone",
  "red",
  "orange",
  "amber",
  "yellow",
  "lime",
  "green",
  "emerald",
  "teal",
  "cyan",
  "sky",
  "blue",
  "indigo",
  "violet",
  "purple",
  "fuchsia",
  "pink",
  "rose",
] as const;

const COLOUR_UTILITIES = [
  "bg",
  "text",
  "border",
  "ring",
  "ring-offset",
  "inset-ring",
  "divide",
  "fill",
  "stroke",
  "outline",
  "decoration",
  "caret",
  "accent",
  "placeholder",
  "shadow",
  "inset-shadow",
  "text-shadow",
  "drop-shadow",
  "scrollbar-thumb",
  "scrollbar-track",
  "from",
  "via",
  "to",
] as const;

const COLOUR_AXIS = `(?:border-[trblsexy]|divide-[xy])`;

/**
 * A palette colour utility in a class list: `text-neutral-400`, `bg-black`,
 * `border-t-red-500`, `divide-x-red-500`. Anchored on both sides so a token
 * reference is not matched by its own inner name — `border-(--tone-neutral-border)`
 * names no palette family here.
 *
 * Exported as source, not as a compiled `RegExp`: the callers need
 * different flags, and a shared `/g` instance carries `lastIndex` between them.
 */
export const PALETTE_UTILITY_SOURCE =
  `(?<![\\w-])(?:${COLOUR_UTILITIES.join("|")})-(?:${FAMILIES.join("|")})-\\d{2,3}(?![\\w-])` +
  `|(?<![\\w-])${COLOUR_AXIS}-(?:${FAMILIES.join("|")})-\\d{2,3}(?![\\w-])` +
  `|(?<![\\w-])(?:${COLOUR_UTILITIES.join("|")}|${COLOUR_AXIS})-(?:black|white)(?![\\w-])`;
