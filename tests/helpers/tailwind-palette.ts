/**
 * Tailwind's own colour palette — the vocabulary a surface must never name.
 *
 * One list in one place, because a guard's coverage is the list it carries. Two
 * copies of this alternation already drifted: the both-theme pass carried all 22
 * families while the StatusBadge face banned 13, so a seeded `bg-teal-500`
 * passed a check whose name claimed "no literal colour anywhere". A third copy
 * (the visual-discipline guard) was unified with this one when the axis forms
 * were added: its prefix set was the superset, and its family list still
 * missed the border/divide side and span spellings both other consumers missed.
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

/**
 * The utilities whose value is a colour — `bg-`, `text-`, `ring-`, … Every
 * v4 family that takes a colour, not only the ones a surface happens to use:
 * a guard's coverage is its list, and a prefix missing here is a utility that
 * paints a palette step unseen (`I-000247`).
 *
 * `border` and `divide` appear here as well as in the axis alternatives below:
 * the plain spelling (`border-red-500`) matches this list, the side/span
 * spelling (`border-t-red-500`) matches the axis alternative.
 */
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

/**
 * The side/span spellings Tailwind v4 generates between a colour prefix and
 * its value: `border-{t,r,b,l,s,e,x,y}-`, `divide-{x,y}-`. Without them
 * `border-t-red-500` and `divide-x-red-500` matched no guard at all while
 * painting a raw palette colour.
 */
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
  // The side/span spelling the families take too: `border-t-red-500`.
  `|(?<![\\w-])${COLOUR_AXIS}-(?:${FAMILIES.join("|")})-\\d{2,3}(?![\\w-])` +
  // `black`/`white` are colours in the same series, so every prefix above takes
  // them — `shadow-black`, `caret-white`, `scrollbar-thumb-black` included, not
  // the nine-prefix subset this clause used to carry. `border-{side}` joins the
  // same clause: `border-t-black`.
  `|(?<![\\w-])(?:${COLOUR_UTILITIES.join("|")}|border-[trblsexy])-(?:black|white)(?![\\w-])`;
