/**
 * Primitive layer — raw values only. Nothing here carries meaning; the
 * semantic layer names the jobs.
 *
 * The colour palette is compass D14/D14a: the 96 steps `tokens.css` declared
 * are reduced to the 26 the semantic bands consume, plus 14 **transitional**
 * steps that still have live consumers owned by later plans. Bands, not a
 * hand-picked list, decide the survivors — surfaces from the neutral solids
 * ladder, text from `gray-600/700/900/1000`, hairlines from
 * `gray-alpha-400/500`, tone-backgrounds from each family's 100 step,
 * tone-borders from the 300-400 band, tone-foregrounds from family 700 (800
 * where 700 fails 4.5:1 against the tone background, `green-800`), tone-solids
 * from family 700 (light may take 600), chart marks from family 700.
 *
 * `tests/design-system/tokens.test.ts` pins both sets.
 */

export type ThemeName = "dark" | "light";

/**
 * The survivor ladders. Light must declare exactly these steps:
 * `PrimitiveColors` is derived from the dark keys, so a step added on one side
 * and not the other fails typecheck instead of shipping a half-mapped theme.
 */
const survivorDark = {
  "background-100": "#0a0c10",
  "background-200": "#15181f",
  "background-300": "#212630",

  "gray-200": "#1b1f27",
  "gray-600": "#6b7482",
  "gray-700": "#8b95a3",
  "gray-900": "#a9b4c2",
  "gray-1000": "#eef2f7",

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

export type SurvivorStep = keyof typeof survivorDark;
type SurvivorColors = Readonly<Record<SurvivorStep, string>>;

const survivorLight: SurvivorColors = {
  "background-100": "#ffffff",
  "background-200": "#f3f5f8",
  "background-300": "#e4e9f0",

  "gray-200": "#f3f5f8",
  "gray-600": "#6d7889",
  "gray-700": "#4e5969",
  "gray-900": "#2f3742",
  "gray-1000": "#0f141a",

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

/**
 * D14a transitional steps: dropped by the band rule, kept only because a plan
 * that has not run yet still consumes them. `owner` names the plan that closes
 * the step — task 3's generator emits each declaration with this comment, so
 * the deadline travels with the value instead of living in a second list.
 */
const transitionalValues = {
  // admin.html's inline styles; plan 204 re-tokens that console.
  "gray-800": { dark: "#ccd5e1", light: "#3a4350", owner: "204 (admin.html)" },
  "gray-alpha-200": { dark: "#ffffff17", light: "#10192814", owner: "204 (admin.html)" },
  // The shadcn bridge and the SSR dashboard face, re-pointed onto semantics.
  "brand-800": { dark: "#67e8f9", light: "#155e75", owner: "201 task 3 (shadcn bridge)" },
  "red-800": { dark: "#fca5a5", light: "#991b1b", owner: "201 task 3 (shadcn bridge)" },
  "gray-100": { dark: "#15181f", light: "#fafbfd", owner: "201 task 3 (shadcn bridge)" },
  "gray-400": { dark: "#39404d", light: "#ccd4df", owner: "201 task 3 / 203 (SSR views.ts)" },
  "green-900": { dark: "#bbf7d0", light: "#166534", owner: "201 task 3 (tokens.css component block)" },
  // Primitives and patterns rebuilt on the semantic layer.
  "gray-500": { dark: "#4d5563", light: "#9aa5b4", owner: "202 (ui primitives)" },
  "gray-alpha-300": { dark: "#ffffff21", light: "#1019281a", owner: "202 (ListRow)" },
  // Charts onto the closed slots, and the SSR face's notices.
  "amber-800": { dark: "#fcd34d", light: "#92400e", owner: "203 (SSR views.ts)" },
  "amber-900": { dark: "#fde68a", light: "#78350f", owner: "203 (SSR views.ts)" },
  "red-900": { dark: "#fecaca", light: "#7f1d1d", owner: "203 (SSR views.ts) / 201 task 8" },
  "teal-700": { dark: "#2dd4bf", light: "#0d9488", owner: "203 (charts.css)" },
  "pink-700": { dark: "#f472b6", light: "#db2777", owner: "203 (charts.css)" },
} as const;

export type TransitionalStep = keyof typeof transitionalValues;
export type TransitionalSteps = readonly {
  readonly name: TransitionalStep;
  readonly owner: string;
}[];

/**
 * The transitional set as data. Task 3 emits these declarations (and their
 * owner comments) from here; nothing may keep a parallel hand-maintained copy.
 */
export const transitionalSteps: TransitionalSteps = (
  Object.keys(transitionalValues) as TransitionalStep[]
).map((name) => ({ name, owner: transitionalValues[name].owner }));

/**
 * The survivor set as data, for the same reason: task 3 emits survivors plus
 * the transitional set, so both halves come from the source rather than from a
 * list the generator maintains.
 */
export const survivorSteps: readonly SurvivorStep[] = Object.keys(survivorDark) as SurvivorStep[];

/** Raw values with no theme dimension. */
const invariant = {
  "font-sans": '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
  "font-mono": "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
  "breakpoint-sm": "640px",
  "breakpoint-md": "768px",
  "breakpoint-lg": "900px",
  "breakpoint-xl": "1280px",
} as const;

/** Every palette step the source declares: survivors plus the transitional set. */
export type PrimitiveColorStep = SurvivorStep | TransitionalStep;
export type PrimitiveName = PrimitiveColorStep | keyof typeof invariant;
export type PrimitiveTokens = Readonly<Record<PrimitiveName, string>>;

const transitionalFor = (theme: ThemeName): Readonly<Record<TransitionalStep, string>> =>
  Object.fromEntries(
    (Object.keys(transitionalValues) as TransitionalStep[]).map((name) => [
      name,
      transitionalValues[name][theme],
    ]),
  ) as Readonly<Record<TransitionalStep, string>>;

export const primitives: Readonly<Record<ThemeName, PrimitiveTokens>> = {
  dark: { ...invariant, ...survivorDark, ...transitionalFor("dark") },
  light: { ...invariant, ...survivorLight, ...transitionalFor("light") },
};
