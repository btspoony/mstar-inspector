/**
 * Tailwind's own colour palette — the vocabulary a surface must never name.
 *
 * One list in one place, because a guard's coverage is the list it carries. Two
 * copies of this alternation already drifted: the both-theme pass carried all 22
 * families while the StatusBadge face banned 13, so a seeded `bg-teal-500`
 * passed a check whose name claimed "no literal colour anywhere".
 *
 * These are Tailwind's families, not this project's palette — the app's steps
 * (`src/design-system/tokens/primitives.ts`) happen to reuse some names, which
 * is exactly why a consumer writing `gray-800` reads as a palette step.
 */

/** The 22 colour families Tailwind ships, each with numeric steps. */
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

/** The utilities whose value is a colour — `bg-`, `text-`, `border-`, … */
const COLOUR_UTILITIES = [
  "bg",
  "text",
  "border",
  "ring",
  "fill",
  "stroke",
  "from",
  "via",
  "to",
  "outline",
  "divide",
  "placeholder",
  "decoration",
] as const;

/**
 * A palette colour utility in a class list: `text-neutral-400`, `bg-black`.
 * Anchored on both sides so a token reference is not matched by its own inner
 * name — `border-(--tone-neutral-border)` names no palette family here.
 *
 * Exported as source, not as a compiled `RegExp`: the two callers need
 * different flags, and a shared `/g` instance carries `lastIndex` between them.
 */
export const PALETTE_UTILITY_SOURCE =
  `(?<![\\w-])(?:${COLOUR_UTILITIES.join("|")})-(?:${FAMILIES.join("|")})-\\d{2,3}(?![\\w-])` +
  `|(?<![\\w-])(?:bg|text|border|ring|fill|stroke|from|via|to)-(?:black|white)(?![\\w-])`;
