import type { VerifiedModels } from "./app-config-store";

/**
 * The thinking levels a selector may carry as a trailing `:<level>`. Mirror of
 * packages/runner/src/token-usage.ts `THINKING_LEVELS`, which stays authoritative
 * because dashboard modules must not import review code; tests/worker/
 * settings-provider-first.test.ts locks the two key sets together.
 */
export const THINKING_LEVELS: Record<string, true> = {
  auto: true,
  off: true,
  minimal: true,
  low: true,
  medium: true,
  high: true,
  xhigh: true,
  max: true,
};

/**
 * Split one selector into provider + model. The tail after the LAST `:` is
 * dropped only when it is a known thinking level (THINKING_LEVELS); any other
 * tail stays part of the model id, so provider ids that embed a colon
 * (`ollama-cloud/deepseek-v4.1-flash:1017`, `qwen3:32b`) compare literally.
 * A selector without `/` has no provider prefix — membership cannot apply.
 */
export function selectorBase(selector: string): { provider: string; model: string; base: string } | null {
  const slash = selector.indexOf("/");
  if (slash <= 0) return null;
  const provider = selector.slice(0, slash);
  const rest = selector.slice(slash + 1);
  const colon = rest.lastIndexOf(":");
  const model = colon !== -1 && THINKING_LEVELS[rest.slice(colon + 1)] === true ? rest.slice(0, colon) : rest;
  return { provider, model, base: `${provider}/${model}` };
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
 *       cached model id (variant suffix tolerated via selectorBase)
 *   (b) probe-only (cache row, empty models) OR no cache row → syntax only
 *   (c) custom provider → must hit the declaration's model_ids, and the
 *       declaration must still hold a key (a drained pool makes its whole
 *       model vocabulary unusable — the same state a missing key would put a
 *       built-in provider in, so "in the declaration" alone is not enough)
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
    const customDecl = customById.get(parsed.provider);
    if (customDecl) {
      if (!customDecl.has_keys || !customDecl.model_ids.includes(parsed.model)) return selector;
      continue;
    }
    const cache = cacheByProvider.get(parsed.provider);
    if (cache && cache.models.length > 0 && !cache.models.includes(parsed.model)) {
      return selector;
    }
  }
  return null;
}
