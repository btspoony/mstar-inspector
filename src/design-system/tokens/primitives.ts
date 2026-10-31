/**
 * Primitive layer — raw values only. Nothing here carries meaning; the
 * semantic layer names the jobs.
 *
 * The colour palette is compass D14: the 96 steps `tokens.css` declared are
 * reduced to the 26 the semantic bands consume, plus two transitional steps
 * kept only for `admin.html` until plan 204 re-tokens that console. Bands, not
 * a hand-picked list, decide membership — surfaces from the neutral solids
 * ladder, text from `gray-600/700/900/1000`, hairlines from
 * `gray-alpha-400/500`, tone-backgrounds from each family's 100 step,
 * tone-borders from the 300-400 band, tone-foregrounds from family 700 (800
 * where 700 fails 4.5:1 against the tone background, `green-800`), tone-solids
 * from family 700 (light may take 600), chart marks from family 700.
 * `tests/design-system/tokens.test.ts` pins the surviving set.
 */

export type ThemeName = "dark" | "light";

/**
 * One step ladder's declaration. Light must declare exactly these steps:
 * `PrimitiveColors` is derived from the dark keys, so a step added on one side
 * and not the other fails typecheck instead of shipping a half-mapped theme.
 */
const dark = {
  "background-100": "#0a0c10",
  "background-200": "#15181f",
  "background-300": "#212630",

  "gray-200": "#1b1f27",
  "gray-600": "#6b7482",
  "gray-700": "#8b95a3",
  // transitional — `admin.html` only, removed by plan 204
  "gray-800": "#ccd5e1",
  "gray-900": "#a9b4c2",
  "gray-1000": "#eef2f7",

  // transitional — `admin.html` only, removed by plan 204
  "gray-alpha-200": "#ffffff17",
  "gray-alpha-400": "#ffffff2e",
  "gray-alpha-500": "#ffffff3d",

  "brand-600": "#06b6d4",
  "brand-700": "#22d3ee",

  "blue-700": "#4ea1ff",

  "red-100": "#2a1215",
  "red-400": "#7f1d1d",
  "red-700": "#f87171",

  "amber-100": "#27190a",
  "amber-400": "#78350f",
  "amber-600": "#d97706",
  "amber-700": "#fbbf24",

  "green-100": "#052e16",
  "green-300": "#14532d",
  "green-400": "#166534",
  "green-700": "#4ade80",
  "green-800": "#86efac",

  "purple-700": "#c084fc",
} as const;

export type PrimitiveColorStep = keyof typeof dark;
export type PrimitiveColors = Readonly<Record<PrimitiveColorStep, string>>;

const light: PrimitiveColors = {
  "background-100": "#ffffff",
  "background-200": "#f3f5f8",
  "background-300": "#e4e9f0",

  "gray-200": "#f3f5f8",
  "gray-600": "#6d7889",
  "gray-700": "#4e5969",
  "gray-800": "#3a4350",
  "gray-900": "#2f3742",
  "gray-1000": "#0f141a",

  "gray-alpha-200": "#10192814",
  "gray-alpha-400": "#10192824",
  "gray-alpha-500": "#10192836",

  "brand-600": "#0891b2",
  "brand-700": "#0e7490",

  "blue-700": "#0066cc",

  "red-100": "#fef2f2",
  "red-400": "#fca5a5",
  "red-700": "#b91c1c",

  "amber-100": "#fffbeb",
  "amber-400": "#fcd34d",
  "amber-600": "#d97706",
  "amber-700": "#b45309",

  "green-100": "#f0fdf4",
  "green-300": "#bbf7d0",
  "green-400": "#86efac",
  "green-700": "#16a34a",
  "green-800": "#15803d",

  "purple-700": "#9333ea",
};

/** Raw values with no theme dimension. */
const invariant = {
  "font-sans": '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  "font-mono": "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  "breakpoint-sm": "640px",
  "breakpoint-md": "768px",
  "breakpoint-lg": "900px",
  "breakpoint-xl": "1280px",
} as const;

export type PrimitiveName = PrimitiveColorStep | keyof typeof invariant;
export type PrimitiveTokens = Readonly<Record<PrimitiveName, string>>;

export const primitives: Readonly<Record<ThemeName, PrimitiveTokens>> = {
  dark: { ...invariant, ...dark },
  light: { ...invariant, ...light },
};
