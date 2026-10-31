/**
 * Public entry point of the design system.
 *
 * Everything outside `src/design-system/` reaches this module one way only:
 * the `@design-system` alias, which every program maps onto this file.
 * `tokens/`, `baseline/`, `primitives/` and `patterns/` are module internals —
 * importing them directly, by alias subpath or by relative path, breaks the
 * boundary that `tests/design-system/boundary.test.ts` enforces.
 *
 * Two tiers are exported: the token source (`./tokens`), and the primitives
 * (`./primitives`) that read the semantic layer, plus the composed patterns
 * (`./patterns`) built from them. `cn` is exported beside them because callers
 * that compose their own faces need the same merge rule.
 */
export * from "./primitives";
export * from "./patterns";
export { cn } from "./cn";
export {
  THEMES,
  UnresolvedTokenError,
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
