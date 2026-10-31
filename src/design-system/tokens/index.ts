/**
 * Token source — the only hand-editable half of the design system.
 *
 * Three layers, one direction: `primitive` holds raw values, `semantic` names
 * the jobs and references primitives, `component` composes semantics. A layer
 * may reference only the layer beneath it; `var()` is the only link.
 *
 * Both themes carry the same key sets by construction: the light colour maps
 * are typed against the dark keys, so a half-mapped theme fails typecheck
 * rather than rendering a blank token at runtime (the theme contract is
 * `theme.css`, which the generator emits).
 *
 * Nothing here emits CSS — `scripts/build-tokens.ts` does that in task 3, the
 * fixture in task 4. This file answers one question: what does the system
 * declare, per layer and per theme.
 */

import type { ThemeName } from "./primitives";
import { primitives } from "./primitives";
import { semanticTokens } from "./semantic";
import type { SemanticName } from "./semantic";
import { components } from "./components";

export type { ThemeName } from "./primitives";
export type {
  PrimitiveName,
  PrimitiveTokens,
  SurvivorStep,
  TransitionalStep,
  TransitionalSteps,
} from "./primitives";
export { survivorSteps, transitionalSteps } from "./primitives";
export type { SemanticName, SemanticTokens } from "./semantic";
export type { ComponentName, ComponentTokens } from "./components";
export type { OpsSurfaceToken } from "./surface-variants";
export { OPS_SURFACE_ATTR, opsSurface } from "./surface-variants";
export type { LegacyToken } from "./legacy";
export { legacyTokens } from "./legacy";
export { reducedMotionDurations } from "./semantic";


export const THEMES: readonly ThemeName[] = ["dark", "light"];

export type ResolvedLayers = Readonly<Record<string, string>>;

export interface TokenLayers {
  readonly primitive: ResolvedLayers;
  readonly semantic: ResolvedLayers;
  readonly component: ResolvedLayers;
}

/** The layers as declared: `var()` references intact. */
export function tokenLayers(theme: ThemeName): TokenLayers {
  return { primitive: primitives[theme], semantic: semanticTokens(theme), component: components };
}

/** Every declared name, per layer — the fixture and the boundary gate read these. */
export function tokenNames(): {
  readonly primitive: readonly string[];
  readonly semantic: readonly string[];
  readonly component: readonly string[];
} {
  return {
    primitive: Object.keys(primitives.dark),
    semantic: Object.keys(semanticTokens("dark")),
    component: Object.keys(components),
  };
}

export class UnresolvedTokenError extends Error {
  constructor(
    readonly theme: ThemeName,
    readonly token: string,
    readonly reference: string,
  ) {
    super(`${theme}: --${token} references undefined --${reference}`);
  }
}

const VAR = /var\(--([a-z0-9-]+)\)/g;

/**
 * Fully resolved value of every token in one theme. Each `var(--x)` must land
 * in the same theme's declared layers; an unknown reference (or a cycle)
 * throws rather than yielding a value that looks defined and renders nothing.
 */
export function resolveTheme(theme: ThemeName): TokenLayers {
  const layers = tokenLayers(theme);
  const declared: ResolvedLayers = { ...layers.primitive, ...layers.semantic, ...layers.component };

  const expand = (owner: string, value: string, seen: readonly string[]): string =>
    value.replace(VAR, (_match, ref: string) => {
      const inner = declared[ref];
      if (inner === undefined) throw new UnresolvedTokenError(theme, owner, ref);
      if (seen.includes(ref)) throw new UnresolvedTokenError(theme, owner, `cycle ${[...seen, ref].join(" -> ")}`);
      return expand(owner, inner, [...seen, ref]);
    });

  const resolved = Object.fromEntries(
    Object.entries(declared).map(([name, value]) => [name, expand(name, value, [name])]),
  );
  const slice = (layer: ResolvedLayers) =>
    Object.fromEntries(Object.keys(layer).map((name) => [name, resolved[name] as string]));
  return { primitive: slice(layers.primitive), semantic: slice(layers.semantic), component: slice(layers.component) };
}

/** Semantic names whose *resolved* value differs between the themes.
 *
 * Resolved, not declared: `surface-page` is `var(--background-100)` in both
 * themes and still renders a different colour, so a declaration-string
 * comparison would report a theme-invariant token that is not one. */
export function themeVaryingSemantics(): readonly string[] {
  const dark = resolveTheme("dark").semantic;
  const light = resolveTheme("light").semantic;
  return Object.keys(dark).filter((name) => dark[name] !== light[name]);
}
