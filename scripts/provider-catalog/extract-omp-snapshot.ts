/**
 * Author-time extractor for the two vendored omp snapshots:
 *   `scripts/provider-catalog/omp-api-key-providers.json`
 *   `scripts/provider-catalog/omp-provider-verify.json`
 *
 * Run against the INSTALLED `@oh-my-pi/pi-catalog` (the same SDK the runner
 * ships), so the model ids are the ones the runtime actually knows:
 *
 *   bun run scripts/provider-catalog/extract-omp-snapshot.ts
 *
 * Sources inside the package:
 *   - `src/models.json`  — the bundled model registry (authoritative model
 *     vocabulary, decoded through the package's own `getBundledModels`)
 *   - `src/compat/rules.json` — `providers.<id>` seed rows, `auth.providers`
 *     (login kind, display name, env keys) and `behavior.apiRoutes`
 *
 * Rules:
 *   1. One record per omp API-key LLM provider the models.dev snapshot lacks.
 *      A provider the catalog already carries (models.dev key, builtin source
 *      key, or the curated dedupe key) is skipped: the generator's own rule (a)
 *      restates that coverage in its header audit.
 *   2. A provider whose models span several protocols gets one record per
 *      protocol (a custom-provider declaration carries exactly one `api`):
 *      the first record keeps the provider id, later ones append the protocol
 *      suffix (`-anthropic`, `-responses`, `-completions`, `-typesafe`,
 *      `-gemini`), and `sourceProviderId` names the omp provider.
 *   3. `models` is the FULL vocabulary — no cap. The store's own bound applies
 *      at declaration time, not here.
 *   4. `baseUrl` is the most common model `baseUrl` in the record, else the
 *      seed api/base-url; null when omp ships none or only a loopback http://
 *      host (the declaration store requires https).
 *   5. The verify snapshot keeps only `login "api-key"` rules that validate a
 *      pasted key against a GET models/identity endpoint — never an inference
 *      call. `headersHook` is carried verbatim.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { createRequire } from "node:module";

const PI_CATALOG_DIR = path.dirname(
  createRequire(import.meta.url).resolve("@oh-my-pi/pi-catalog/package.json"),
);
const RULES_PATH = path.join(PI_CATALOG_DIR, "src/compat/rules.json");
const MODELS_DEV_PATH = path.resolve("scripts/provider-catalog/models.dev-2026-11-06.json");
const OUT_PROVIDERS_PATH = path.resolve("scripts/provider-catalog/omp-api-key-providers.json");
const OUT_VERIFY_PATH = path.resolve("scripts/provider-catalog/omp-provider-verify.json");

type Rule = {
  id: string;
  envVars?: string[];
  discovery?: { label?: string };
  seed?: { api?: string; baseUrl?: string | null; models?: { id: string; api?: string; baseUrl?: string }[] };
};
type AuthProvider = {
  id: string;
  name?: string;
  env?: { vars?: string[] };
  login?: {
    kind?: string;
    validate?: { kind?: string; url?: string; headersHook?: string };
  };
};
type Rules = {
  providers: Record<string, Rule>;
  auth: { providers: AuthProvider[] };
  behavior: { apiRoutes?: { provider: string; default?: string; routes?: { api: string; match?: { prefix?: string[]; exact?: string[] } }[] }[] };
};
type OmpRecord = {
  id: string;
  label: string;
  env: string;
  baseUrl: string | null;
  api: string;
  models: string[];
  sourceProviderId?: string;
};
type VerifyRecord = { id: string; url: string; headersHook?: string };

/** The naming aliases the catalog already resolves through (kept verbatim —
 *  the generator validates each target is a catalog row). */
const ALIAS: Record<string, string> = {
  abliteration: "abliteration-ai",
  "zhipu-coding-plan": "zhipuai-coding-plan",
  "minimax-code": "minimax-coding-plan",
  "minimax-code-cn": "minimax-cn-coding-plan",
  "charm-hyper": "hyper",
  moonshot: "moonshotai",
  fireworks: "fireworks-ai",
  together: "togetherai",
  novita: "novita-ai",
  nanogpt: "nano-gpt",
  "vercel-ai-gateway": "vercel",
  "gmi-cloud": "gmicloud",
  "lm-studio": "lmstudio",
  google: "gemini",
  azure: "azure-openai",
  "opencode-zen": "opencode",
};

/** The builtin tier's models.dev source keys (generator BUILTIN_ORDER).
 *  A builtin row owns its protocol, so the union never restates these. */
const BUILTIN_IDS: Record<string, true> = Object.fromEntries(
  [
    "anthropic",
    "openai",
    "gemini",
    "copilot",
    "azure-openai",
    "groq",
    "cerebras",
    "xai",
    "openrouter",
    "kilo",
    "mistral",
    "zai",
    "umans",
    "minimax",
    "opencode",
    "cursor",
    "ai-gateway",
    "wafer-serverless",
    "ark",
  ].map((id) => [id, true]),
);

/** The builtin tier's models.dev source keys (generator BUILTIN_ORDER).
 *  A builtin row owns its protocol, so the union never restates these. */
const BUILTIN_SOURCE_KEYS: Record<string, true> = Object.fromEntries(
  [
    "anthropic",
    "openai",
    "google",
    "github-copilot",
    "azure",
    "groq",
    "cerebras",
    "xai",
    "openrouter",
    "kilo",
    "mistral",
    "zai",
    "umans-ai-coding-plan",
    "minimax",
    "opencode",
    "cloudflare-ai-gateway",
    "wafer.ai",
    "volcengine",
  ].map((key) => [key, true]),
);

/** The materializable protocol vocabulary (generator MATERIALIZABLE_APIS) and
 *  the custom-provider id grammar / URL-placeholder allowlist. A record that
 *  fails any of these is recorded as an exclusion instead of a row. */
const MATERIALIZABLE_APIS: Record<string, true> = {
  "anthropic-messages": true,
  "openai-completions": true,
  "openai-responses": true,
  typesafe: true,
};
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ALLOWED_URL_PLACEHOLDERS: Record<string, true> = { account_id: true };

/** The curated workers-ai template consumes this snapshot key (generator
 *  TEMPLATE_DEDUPE_SNAPSHOT_KEYS). */
const TEMPLATE_DEDUPE_SNAPSHOT_KEYS: Record<string, true> = { "cloudflare-workers-ai": true };

const PROTOCOL_SUFFIX: Record<string, string> = {
  "anthropic-messages": "anthropic",
  "openai-responses": "responses",
  "openai-completions": "completions",
  typesafe: "typesafe",
  "google-generative-ai": "gemini",
};

const pkg = JSON.parse(await readFile(path.join(PI_CATALOG_DIR, "package.json"), "utf8")) as { version: string };
const rules = JSON.parse(await readFile(RULES_PATH, "utf8")) as Rules;
const modelsDev = JSON.parse(await readFile(MODELS_DEV_PATH, "utf8")) as Record<string, unknown>;
const version = pkg.version;
const extracted = new Date().toISOString().slice(0, 10);

const records: OmpRecord[] = [];
const ompProviderIds: string[] = [];
const nonModel: string[] = [];
const oauthOrDeviceCode: string[] = [];
const notMaterializable: Record<string, string> = {};
/** models.dev snapshot keys this snapshot takes over (mixed-protocol rows). */
const ownsSnapshotKeys: string[] = [];

const modelsDevKeys = new Set(Object.keys(modelsDev));

function envFor(id: string, auth: AuthProvider): string[] {
  const fromAuth = auth.env?.vars ?? [];
  const fromRule = rules.providers[id]?.envVars ?? [];
  return fromRule.length > 0 ? fromRule : fromAuth;
}

function modelRows(id: string, rule: Rule | undefined) {
  const bundled = getBundledModels(id).map((m) => ({
    id: m.id,
    api: m.api,
    baseUrl: "baseUrl" in m && typeof m.baseUrl === "string" ? m.baseUrl : null,
  }));
  const seen = new Set(bundled.map((m) => m.id));
  const seeded = (rule?.seed?.models ?? []).filter((m) => !seen.has(m.id)).map((m) => ({
    id: m.id,
    api: m.api ?? rule?.seed?.api ?? "openai-completions",
    baseUrl: m.baseUrl ?? rule?.seed?.baseUrl ?? null,
  }));
  return [...bundled, ...seeded];
}

function mostCommon<T>(values: T[]): T | undefined {
  const counts = new Map<T, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best: T | undefined;
  let bestCount = 0;
  for (const [v, c] of counts) {
    if (c > bestCount) {
      best = v;
      bestCount = c;
    }
  }
  return best;
}

for (const auth of rules.auth.providers) {
  const id = auth.id;
  ompProviderIds.push(id);
  const rule = rules.providers[id];
  const rows = modelRows(id, rule);
  const env = envFor(id, auth);
  const label = rule?.discovery?.label ?? auth.name ?? id;

  // Rule (a): the catalog already carries this provider. EXCEPTION — a
  // mixed-protocol provider needs one declaration per protocol, which a
  // single models.dev row cannot express, so omp owns that snapshot key.
  if (
    ALIAS[id] !== undefined ||
    Object.hasOwn(BUILTIN_IDS, id) ||
    Object.hasOwn(BUILTIN_SOURCE_KEYS, id) ||
    Object.hasOwn(TEMPLATE_DEDUPE_SNAPSHOT_KEYS, id)
  ) {
    continue;
  }
  const inModelsDev = modelsDevKeys.has(id);
  const protocols = new Set(rows.map((row) => row.api));
  // A single-protocol provider the models.dev snapshot carries already has
  // its breadth row — nothing to add here.
  if (inModelsDev && protocols.size <= 1) continue;
  // Rule (c): no env key → not an API-key model provider (search, local,
  // on-device). OAuth/device-code logins are recorded under their own rule.
  // A provider the models.dev snapshot carries keeps its breadth row either
  // way: it is named under rule (a) by the generator, never taken over here
  // without a replacement row.
  const kind = auth.login?.kind;
  const excluded = rows.length === 0 || env.length === 0 || (kind !== undefined && kind !== "api-key");
  if (excluded) {
    if (inModelsDev) continue;
    if (kind === "api-key" || kind === undefined) nonModel.push(id);
    else oauthOrDeviceCode.push(id);
    continue;
  }

  const byApi = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byApi.get(row.api) ?? [];
    list.push(row);
    byApi.set(row.api, list);
  }
  const primary = mostCommon(rows.map((r) => r.api)) ?? "openai-completions";
  const apis = [...byApi.keys()].sort((a, b) => (a === primary ? -1 : b === primary ? 1 : a.localeCompare(b)));
  // Build first, then decide ownership: a models.dev key may only be taken
  // over when at least ONE materializable record replaces it.
  const built: OmpRecord[] = [];
  for (const api of apis) {
    const group = byApi.get(api)!;
    const recordId = api === primary ? id : `${id}-${PROTOCOL_SUFFIX[api] ?? api}`;
    const baseUrl =
      mostCommon(group.map((r) => r.baseUrl).filter((b): b is string => typeof b === "string")) ??
      rule?.seed?.baseUrl ??
      rule?.seed?.api ??
      null;
    const placeholders = [...(baseUrl ?? "").matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
    const unusable =
      !ID_PATTERN.test(recordId)
        ? "id grammar"
        : !Object.hasOwn(MATERIALIZABLE_APIS, api)
          ? `protocol ${api}`
          : placeholders.some((name) => !Object.hasOwn(ALLOWED_URL_PLACEHOLDERS, name))
            ? `url placeholder ${placeholders.join(", ")}`
            : null;
    if (unusable !== null) {
      notMaterializable[recordId] = unusable;
      continue;
    }
    const record: OmpRecord = {
      id: recordId,
      label,
      env: env[0]!,
      baseUrl,
      api,
      models: group.map((r) => r.id),
    };
    if (recordId !== id) record.sourceProviderId = id;
    built.push(record);
  }
  if (built.length === 0) {
    // Nothing can replace the breadth row: leave it alone.
    if (inModelsDev) continue;
    nonModel.push(id);
    continue;
  }
  if (inModelsDev) ownsSnapshotKeys.push(id);
  records.push(...built);
}

// Verify snapshot: only api-key logins that validate against a GET endpoint.
const endpoints: VerifyRecord[] = [];
for (const auth of rules.auth.providers) {
  const login = auth.login;
  if (login?.kind !== "api-key") continue;
  if (login.validate?.kind !== "models-endpoint" || typeof login.validate.url !== "string") continue;
  const entry: VerifyRecord = { id: auth.id, url: login.validate.url };
  if (login.validate.headersHook !== undefined) entry.headersHook = login.validate.headersHook;
  endpoints.push(entry);
}

records.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
endpoints.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

const providersOut = {
  source: {
    package: "@oh-my-pi/pi-catalog",
    version,
    extracted,
    upstream: [
      "src/compat/rules.json — `providers.<id>` seed rows (model ids, api, baseUrl) and `auth.providers` (login kind, display name, env keys)",
      "src/compat/rules/providers/<id>.kdl — authored provider contract (discovery label, seed api/base-url, default model)",
      "src/compat/rules/runtime/behavior.kdl — `api-routes` (per-model protocol routes; a mixed-protocol provider needs one record per protocol)",
      "src/models.json — the bundled model registry, decoded with the package's own getBundledModels (the runtime's authoritative vocabulary)",
    ],
    rules: [
      "One record per omp API-key LLM provider that the models.dev snapshot lacks. Not materialized: ids already in the catalog, naming aliases of a catalog row, non-model providers (search / local-inference / no env key), and OAuth- or device-code-only logins.",
      "`api` is the provider's materializable protocol (anthropic-messages / openai-completions / openai-responses / typesafe). A mixed-protocol provider gets one record per protocol — a custom-provider declaration carries exactly one `api`.",
      "`baseUrl` is the record's most common model base URL, else the authored seed base URL or factory default; null when omp ships none, or when omp's default is a loopback http:// endpoint (the declaration store requires https), so the operator supplies it at save time.",
      "`models` is the provider's FULL seed/bundled vocabulary — no cap.",
      "A mixed-protocol provider contributes one record per protocol; `sourceProviderId` names the omp provider where a record id differs from it.",
    ],
  },
  providers: records,
  ompProviderIds,
  ownsSnapshotKeys,
  excluded: {
    alias: ALIAS,
    nonModel: nonModel.sort(),
    oauthOrDeviceCode: oauthOrDeviceCode.sort(),
    notMaterializable,
  },
};

const verifyOut = {
  source: {
    package: "@oh-my-pi/pi-catalog",
    version,
    extracted,
    upstream: [
      "src/compat/rules/auth/*.kdl — every `login \"api-key\"` block carrying a `validate \"models-endpoint\"` entry",
      "src/compat/rules.json — the compiled auth rules (login kind + validate entry)",
    ],
    rules: [
      "One record per omp auth rule that validates a pasted key against a models/identity endpoint. `id` is the omp provider id and `url` is the validated URL verbatim (a query string is part of it).",
      "`headersHook` names the omp request-header hook applied on top of the Bearer header. Its headers are computed omp-side (a project id from the environment, a client fingerprint), so the dashboard cannot reproduce it.",
      "A provider whose omp rule validates with `chat-completions` or `anthropic-messages` (inference) has no record here — the dashboard never runs inference to check a key.",
    ],
    headersHooks: [...new Set(endpoints.map((e) => e.headersHook).filter((h): h is string => h !== undefined))].sort(),
  },
  endpoints,
};

await writeFile(OUT_PROVIDERS_PATH, `${JSON.stringify(providersOut, null, 2)}\n`);
await writeFile(OUT_VERIFY_PATH, `${JSON.stringify(verifyOut, null, 2)}\n`);

console.log(
  `omp ${version}: ${records.length} provider records, ${endpoints.length} verify endpoints, ` +
    `${nonModel.length} non-model, ${oauthOrDeviceCode.length} oauth/device-code — extracted ${extracted}`,
);
