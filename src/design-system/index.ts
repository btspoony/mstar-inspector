/**
 * Public entry point of the design system.
 *
 * Everything outside `src/design-system/` reaches this module one way only:
 * the `@design-system` alias, which every program maps onto this file.
 * `tokens/`, `baseline/`, `primitives/` and `patterns/` are module internals —
 * importing them directly, by alias subpath or by relative path, breaks the
 * boundary that `tests/design-system/boundary.test.ts` enforces.
 *
 * The token source (task 2) is the only thing exported so far; the generated
 * CSS, fixture and preview are tasks 3-7, and the primitives and patterns
 * arrive with plan 202.
 */
export {
  OPS_SURFACE_ATTR,
  THEMES,
  UnresolvedTokenError,
  legacyTokens,
  opsSurface,
  reducedMotionDurations,
  resolveTheme,
  survivorSteps,
  themeVaryingSemantics,
  tokenLayers,
  tokenNames,
  transitionalSteps,
} from "./tokens";
export type {
  ComponentName,
  ComponentTokens,
  OpsSurfaceToken,
  PrimitiveName,
  PrimitiveTokens,
  SemanticName,
  SemanticTokens,
  SurvivorStep,
  ThemeName,
  TokenLayers,
  TransitionalStep,
  TransitionalSteps,
} from "./tokens";
