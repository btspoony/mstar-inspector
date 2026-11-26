import type { VerifiedModels } from "./app-config-store";

/**
 * The thinking levels a selector may carry as a trailing `:<level>`. Mirror of
 * packages/runner/src/token-usage.ts `THINKING_LEVELS`, which stays authoritative
 * because dashboard modules must not import review code; tests/worker/
 * settings-provider-first.test.ts locks the two key sets together.
 */
export const THINKING_LEVELS: Record<string, true> = {
  auto: true,
  inherit: true,
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};
/**
 * Levels the SDK accepts abbreviated, provided the prefix matches exactly one
 * of them. Derived from THINKING_LEVELS so the pool cannot drift from the
 * parity-locked table; `auto` is excluded because the SDK matches it exactly.
 */
const ABBREVIABLE_LEVELS = Object.keys(THINKING_LEVELS).filter((level) => level !== "auto");

/**
 * Why: a selector tail is a thinking level when it is the legacy `thinking`
 * alias, an exact level name, or an unambiguous abbreviation (>= 2 chars,
 * exactly one level starts with it — the SDK's `:med` / `:xhi` form). `auto`
 * stays exact-only, as in the SDK.
 *
 * The `thinking` alias keeps chains stored before this narrowing re-savable —
 * docs/deploy.md documents `anthropic/claude-sonnet-4-5:thinking`.
 */
function stripsThinkingTail(tail: string): boolean {
  if (tail === "thinking") return true;
  if (THINKING_LEVELS[tail] === true) return true;
  if (tail.length < 2) return false;
  let matches = 0;
  for (const level of ABBREVIABLE_LEVELS) {
    if (level.startsWith(tail)) matches += 1;
  }
  return matches === 1;
}

/**
 * Split one selector into provider + model. The tail after the LAST `:` is
 * dropped from `model` when it is a known thinking level — an exact name, an
 * unambiguous abbreviation, or the legacy `thinking` alias; every other tail
 * stays part of the model id, so provider ids that embed a colon
 * (`ollama-cloud/deepseek-v4.1-flash:1017`, `qwen3:32b`) compare literally.
 * `literal` is the id exactly as written — membership tries it before `model`,
 * because real ids can end in a level name (`glm-4.7:max`). A selector without
 * `/` has no provider prefix — membership cannot apply.
 */
export function selectorBase(
  selector: string,
): { provider: string; literal: string; model: string; base: string } | null {
  const slash = selector.indexOf("/");
  if (slash <= 0) return null;
  const provider = selector.slice(0, slash);
  const literal = selector.slice(slash + 1);
  const colon = literal.lastIndexOf(":");
  const model = colon !== -1 && stripsThinkingTail(literal.slice(colon + 1)) ? literal.slice(0, colon) : literal;
  return { provider, literal, model, base: `${provider}/${model}` };
}

export type ModelOptionSource = "verified" | "probe" | "custom";

/** One dropdown group: selector-facing provider prefix + `provider/model` options. */
export type ModelOptionGroup = {
  provider: string;
  source: ModelOptionSource;
  selectors: string[];
};

/**
 * A custom declaration as both faces below consume it: the model ids it names
 * and whether its key pool still holds a credential. The producer is
 * listCustomProviders (`has_keys` derived from the pool); a declaration whose
 * pool is drained still exists and stays editable, but offers nothing.
 */
export type CustomDeclarationView = {
  provider_id: string;
  model_ids: string[];
  has_keys: boolean;
};

/**
 * Settings dropdown source (the Interfaces face): verified entries (whose
 * `provider` IS the selector prefix) first, then custom
 * declarations that still hold a key. Probe-only entries (empty models) yield
 * no options — the UI shows the no-discovery hint instead of a free-text box.
 * A KEYLESS custom declaration is omitted entirely: every run against its
 * models fails closed in assertAppConfigComplete, so offering them would be
 * offering a chain the App cannot execute.
 */
export function composeModelOptions(
  verified: VerifiedModels[],
  custom: readonly CustomDeclarationView[],
): ModelOptionGroup[] {
  const groups: ModelOptionGroup[] = verified.map((row) => ({
    provider: row.provider,
    source: row.models.length === 0 ? "probe" : "verified",
    selectors: row.models.map((model) => `${row.provider}/${model}`),
  }));
  for (const decl of custom) {
    if (!decl.has_keys) continue;
    groups.push({
      provider: decl.provider_id,
      source: "custom",
      selectors: decl.model_ids.map((model) => `${decl.provider_id}/${model}`),
    });
  }
  return groups;
}

/**
 * Membership layer for save-chain / save-roles (spec §6.3). Syntax
 * (`parseModelChain`) is the caller's job. Per selector:
 *   (a) built-in provider with a non-empty verified cache → must hit a
 *       cached model id: the literal id first, then the base with a thinking
 *       tail removed (exact level, unambiguous abbreviation, or the legacy
 *       `thinking` alias — selectorBase). A real id may end in a level name
 *       (`glm-4.7:max`), so the literal always gets its chance.
 *   (b) probe-only (cache row, empty models) OR no cache row → syntax only
 *   (c) custom provider → same literal-then-base order against the
 *       declaration's model_ids, and the declaration must still hold a key
 *       (a drained pool makes its whole model vocabulary unusable — the same
 *       state a missing key would put a built-in provider in, so "in the
 *       declaration" alone is not enough)
 * Returns the first failing selector, or null when every selector passes.
 */
export function findFailingSelector(
  selectors: string[],
  verified: VerifiedModels[],
  custom: readonly CustomDeclarationView[],
): string | null {
  const cacheByProvider = new Map(verified.map((row) => [row.provider, row]));
  const customById = new Map(custom.map((row) => [row.provider_id, row]));
  for (const selector of selectors) {
    const parsed = selectorBase(selector);
    if (parsed === null) continue;
    const { literal, model } = parsed;
    const holds = (ids: readonly string[]): boolean => ids.includes(literal) || (model !== literal && ids.includes(model));
    const customDecl = customById.get(parsed.provider);
    if (customDecl) {
      if (!customDecl.has_keys || !holds(customDecl.model_ids)) return selector;
      continue;
    }
    const cache = cacheByProvider.get(parsed.provider);
    if (cache && cache.models.length > 0 && !holds(cache.models)) {
      return selector;
    }
  }
  return null;
}
