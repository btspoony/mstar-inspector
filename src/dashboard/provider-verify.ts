/**
 * Provider-key verification for the provider-first settings flow (plan 31
 * Task 3, spec v1.1-dashboard-platform §6.1/6.2) — dashboard side.
 *
 * The settings save route verifies a freshly typed key BEFORE anything is
 * stored: built-in providers hit their list-models endpoint (or a documented
 * auth probe when no models endpoint exists), custom providers probe the
 * declared base URL, and only a successful probe returns `ok` with the model
 * list to cache (app_provider_models). Verification is outbound-only with
 * the as-typed key (never stored, never logged); storage afterwards goes
 * through the existing secretbox envelope (src/dashboard/secretbox.ts).
 *
 * Boundary (architect decision Q2): this module imports NOTHING from
 * pipeline/review code. The endpoint map is keyed by the dashboard's own
 * PROVIDER_IDS mirror (src/dashboard/app-config-store.ts) and parity-locked
 * by tests — the pipeline's PROVIDERS envName mapping (runner injection
 * surface) is irrelevant here.
 *
 * Failure reasons are structured and documented per case:
 *   - `invalid_key`        401/403 from the provider (key rejected)
 *   - `unreachable`        network failure / timeout (10s AbortSignal.timeout)
 *   - `unexpected_response` the provider answered but not with a successful,
 *                           parseable verification response
 *   - `unsupported_provider` no endpoint mapping AND no probeable host
 *                           (per-resource-host providers — see the table)
 */

import { type CustomProviderApi } from "./app-config-store";

/** 10s outbound verification budget (spec §6.2: "10s 超时"). */
export const VERIFY_TIMEOUT_MS = 10_000;

/** The structured failure reasons (never a raw provider error string). */
export type VerifyFailureReason =
  | "invalid_key"
  | "unreachable"
  | "unexpected_response"
  | "unsupported_provider";

/** Verification outcome: ok + cached models, or a structured failure. */
export type VerifyResult =
  | { ok: true; models: string[] }
  | { ok: false; reason: VerifyFailureReason };

/** Verification deps (injected for tests): outbound fetch + timeout override. */
export type VerifyDeps = {
  fetch: typeof fetch;
  /** Request timeout in ms; defaults to VERIFY_TIMEOUT_MS. Tests shrink it. */
  timeoutMs?: number;
};

/** Custom-provider declaration face (subset of AppCustomProvider, spec §6.1). */
export type CustomVerifyInput = {
  baseUrl: string;
  /** The declared protocol form — selects the probe's auth shape. */
  api: CustomProviderApi;
  /** Declared model vocabulary, echoed as `models` when the probe 2xxs but
   *  the body carries no parseable list (spec §6.1: 无抓取 — the vocabulary
   *  IS the declaration). */
  modelIds: string[];
};

type VerifyAuth = "bearer" | "x-api-key" | "x-goog-api-key";

/**
 * One provider's verification spec:
 *   - `models`  — GET the provider's authenticated list-models endpoint and
 *                 parse the model list (the verified-keys cache data source)
 *   - `probe`   — auth probe on the provider's documented surface; any 2xx
 *                 proves the key; models stay [] (probe-only → empty dropdown
 *                 + syntax-only member validation, spec §6.2/§6.3)
 *   - `unsupported` — no fixed endpoint AND no probeable host with just a key
 */
export type ProviderVerifySpec =
  | { kind: "models"; url: string; auth: VerifyAuth; anthropicVersion?: boolean }
  | { kind: "probe"; method: "GET" | "POST"; url: string; auth: VerifyAuth; body?: Record<string, unknown> }
  | { kind: "unsupported"; note: string };

/**
 * PROVIDER_VERIFY_ENDPOINTS — keyed by PROVIDER_IDS (parity-locked by tests:
 * a new provider id MUST get an entry here — models, probe, or unsupported).
 * Updated 2026-09-03 against provider docs:
 *
 * | provider        | kind     | endpoint (auth)                                 | notes |
 * |-----------------|----------|-------------------------------------------------|-------|
 * | anthropic       | models   | https://api.anthropic.com/v1/models (x-api-key + anthropic-version) | confirmed (docs.anthropic.com) |
 * | openai          | models   | https://api.openai.com/v1/models (Bearer)       | confirmed |
 * | gemini          | models   | https://generativelanguage.googleapis.com/v1beta/models (x-goog-api-key) | confirmed (ai.google.dev); key in header, never the URL |
 * | copilot         | probe    | GET https://api.github.com/user (Bearer)        | COPILOT_GITHUB_TOKEN is a GitHub token; the GitHub REST probe proves token validity (a 401 there means the token is dead). Copilot seat entitlement stays a runner-time check. |
 * | azure-openai    | unsupported | —                                            | Azure resource host is per-deployment (AZURE_OPENAI_ENDPOINT); the dashboard stores only the key — no probeable host. |
 * | groq            | models   | https://api.groq.com/openai/v1/models (Bearer)  | confirmed, OpenAI shape |
 * | cerebras        | models   | https://api.cerebras.ai/v1/models (Bearer)      | confirmed, OpenAI shape |
 * | xai             | models   | https://api.x.ai/v1/models (Bearer)             | confirmed, OpenAI shape |
 * | openrouter      | models   | https://openrouter.ai/api/v1/models (Bearer)    | confirmed (docs show Bearer on GET /api/v1/models) |
 * | kilo            | probe    | POST https://api.kilo.ai/api/gateway/chat/completions (Bearer) | gateway model list is PUBLIC (docs: "no authentication required") — it cannot validate a key; probe = 1-token chat on the cheapest auto tier. |
 * | mistral         | models   | https://api.mistral.ai/v1/models (Bearer)       | confirmed, OpenAI shape |
 * | zai             | probe    | POST https://api.z.ai/api/paas/v4/chat/completions (Bearer) | no list-models endpoint in Z.AI docs (docs.z.ai/llms.txt); probe = 1-token chat. |
 * | umans           | probe    | POST https://api.code.umans.ai/v1/chat/completions (Bearer) | docs describe the models endpoint as public → cannot validate a key; probe = 1-token chat. |
 * | minimax         | models   | https://api.minimax.io/v1/models (Bearer)       | confirmed (platform.minimax.io list-models reference) |
 * | opencode        | models   | https://opencode.ai/zen/v1/models (Bearer)      | OpenCode Zen docs list the endpoint; auth presumed Bearer Zen key [INFERENCE] |
 * | cursor          | models   | GET https://api.cursor.com/v1/models (Bearer)   | Cloud Agents API (cursor.com/docs/api) exposes GET /v1/models — a 2xx list is cached (a real dropdown), 401 still maps to invalid_key; CURSOR_ACCESS_TOKEN rides the omp cursor provider (api2.cursor.sh proxy) at review time — a token rejected here but fine there should move this entry to the proxy surface [INFERENCE] |
 * | ai-gateway      | unsupported | —                                            | Cloudflare AI Gateway path needs account + gateway ids; key alone has no fixed host. |
 * | wafer-serverless| models   | https://pass.wafer.ai/v1/models (Bearer)        | OpenAI-compatible base from wafer docs (pass.wafer.ai/v1); /models is the standard discovery path [INFERENCE] |
 * | ark             | models   | https://ark.cn-beijing.volces.com/api/v3/models (Bearer) | OpenAI-compatible base confirmed (ark.cn-beijing.volces.com/api/v3); /models is the standard path — if Ark 404s it, move to probe [INFERENCE] |
 *
 * Probe model-id literals (`kilo-auto/small`, `glm-5.3-flash`, `umans-flash`)
 * are pinned probe fixtures. A retired or renamed id makes that provider
 * unverifiable until a redeploy updates this table.
 */
export const PROVIDER_VERIFY_ENDPOINTS: Record<string, ProviderVerifySpec> = {
  anthropic: { kind: "models", url: "https://api.anthropic.com/v1/models", auth: "x-api-key", anthropicVersion: true },
  openai: { kind: "models", url: "https://api.openai.com/v1/models", auth: "bearer" },
  gemini: { kind: "models", url: "https://generativelanguage.googleapis.com/v1beta/models", auth: "x-goog-api-key" },
  copilot: { kind: "probe", method: "GET", url: "https://api.github.com/user", auth: "bearer" },
  "azure-openai": {
    kind: "unsupported",
    note: "Azure resource host is per-deployment (AZURE_OPENAI_ENDPOINT); the dashboard stores only the key — no probeable host",
  },
  groq: { kind: "models", url: "https://api.groq.com/openai/v1/models", auth: "bearer" },
  cerebras: { kind: "models", url: "https://api.cerebras.ai/v1/models", auth: "bearer" },
  xai: { kind: "models", url: "https://api.x.ai/v1/models", auth: "bearer" },
  openrouter: { kind: "models", url: "https://openrouter.ai/api/v1/models", auth: "bearer" },
  kilo: {
    kind: "probe",
    method: "POST",
    url: "https://api.kilo.ai/api/gateway/chat/completions",
    auth: "bearer",
    body: { model: "kilo-auto/small", messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
  },
  mistral: { kind: "models", url: "https://api.mistral.ai/v1/models", auth: "bearer" },
  zai: {
    kind: "probe",
    method: "POST",
    url: "https://api.z.ai/api/paas/v4/chat/completions",
    auth: "bearer",
    body: { model: "glm-5.3-flash", messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
  },
  umans: {
    kind: "probe",
    method: "POST",
    url: "https://api.code.umans.ai/v1/chat/completions",
    auth: "bearer",
    body: { model: "umans-flash", messages: [{ role: "user", content: "ping" }], max_tokens: 1 },
  },
  minimax: { kind: "models", url: "https://api.minimax.io/v1/models", auth: "bearer" },
  opencode: { kind: "models", url: "https://opencode.ai/zen/v1/models", auth: "bearer" },
  cursor: { kind: "models", url: "https://api.cursor.com/v1/models", auth: "bearer" },
  "ai-gateway": {
    kind: "unsupported",
    note: "Cloudflare AI Gateway path needs account + gateway ids; the key alone has no fixed host",
  },
  "wafer-serverless": { kind: "models", url: "https://pass.wafer.ai/v1/models", auth: "bearer" },
  ark: { kind: "models", url: "https://ark.cn-beijing.volces.com/api/v3/models", auth: "bearer" },
};

/** Authorization header shape per VerifyAuth. The key NEVER goes elsewhere
 *  (not in the URL — Gemini probes use the header for exactly this reason). */
function authHeaders(auth: VerifyAuth, key: string): Record<string, string> {
  switch (auth) {
    case "bearer":
      return { authorization: `Bearer ${key}` };
    case "x-api-key":
      return { "x-api-key": key };
    case "x-goog-api-key":
      return { "x-goog-api-key": key };
  }
}

/**
 * Parse the common list-models response shapes into model ids:
 *   - OpenAI shape `{ data: [{ id }] }` (anthropic uses the same `data[].id`)
 *   - Gemini shape `{ models: [{ name: "models/foo" }] }` — the `models/`
 *     prefix is stripped (the selector the pipeline consumes is the bare id)
 * Returns null when the body has NEITHER shape (an error envelope or a shape
 * we do not understand → unexpected_response); [] when the recognized array
 * is present but empty (a valid 2xx with zero models → ok with empty cache).
 * Duplicates are dropped, order preserved.
 */
function parseModelList(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null) return null;
  const record = body as Record<string, unknown>;
  const out: string[] = [];
  if (Array.isArray(record.data)) {
    for (const entry of record.data) {
      if (typeof entry !== "object" || entry === null) continue;
      const id = (entry as Record<string, unknown>).id;
      if (typeof id === "string" && id.length > 0) out.push(id);
    }
    return dedupeStrings(out);
  }
  if (Array.isArray(record.models)) {
    for (const entry of record.models) {
      if (typeof entry !== "object" || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const name = typeof e.name === "string" ? e.name : undefined;
      const id = typeof e.id === "string" ? e.id : undefined;
      const raw = name ?? id;
      if (raw && raw.length > 0) {
        out.push(raw.startsWith("models/") ? raw.slice("models/".length) : raw);
      }
    }
    return dedupeStrings(out);
  }
  return null;
}

/** Drop duplicates preserving first-seen order (a provider may list a model
 *  more than once across the two recognized shapes). */
function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Verify one BUILT-IN provider key against its list-models endpoint.
 * 401/403 → invalid_key; any other non-2xx → unexpected_response; 2xx with an
 * unparseable body → unexpected_response; 2xx with a parseable list (possibly
 * empty) → ok + models. Transport failures/timeouts → unreachable.
 */
async function verifyModelsEndpoint(
  deps: VerifyDeps,
  spec: Extract<ProviderVerifySpec, { kind: "models" }>,
  key: string,
): Promise<VerifyResult> {
  const headers = authHeaders(spec.auth, key);
  if (spec.anthropicVersion) headers["anthropic-version"] = "2023-06-01";
  let res: Response;
  try {
    res = await deps.fetch(spec.url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(deps.timeoutMs ?? VERIFY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "invalid_key" };
  }
  if (!res.ok) {
    return { ok: false, reason: "unexpected_response" };
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { ok: false, reason: "unexpected_response" };
  }
  const models = parseModelList(body);
  if (models === null) {
    return { ok: false, reason: "unexpected_response" };
  }
  return { ok: true, models };
}

/**
 * Verify one BUILT-IN provider key by auth probe: any 2xx proves the key
 * (models stay [] — the probe-only signal). 401/403 → invalid_key; every
 * other non-2xx → unexpected_response; transport failures → unreachable.
 */
async function verifyProbe(
  deps: VerifyDeps,
  spec: Extract<ProviderVerifySpec, { kind: "probe" }>,
  key: string,
): Promise<VerifyResult> {
  const headers = authHeaders(spec.auth, key);
  if (spec.body) headers["content-type"] = "application/json";
  let res: Response;
  try {
    res = await deps.fetch(spec.url, {
      method: spec.method,
      headers,
      body: spec.body ? JSON.stringify(spec.body) : undefined,
      signal: AbortSignal.timeout(deps.timeoutMs ?? VERIFY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "invalid_key" };
  }
  if (!res.ok) {
    return { ok: false, reason: "unexpected_response" };
  }
  return { ok: true, models: [] };
}

/**
 * Normalize the custom provider's declared base URL into a probe path: a
 * declaration already ending in `/v1` probes `{base}/models` (its models
 * endpoint), everything else probes `{base}/v1/models` — the standard
 * discovery path for both OpenAI- and Anthropic-protocol providers.
 */
function customModelsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/v1") ? `${trimmed}/models` : `${trimmed}/v1/models`;
}

/**
 * Verify one CUSTOM-provider key (spec §6.1/§6.2): probe the declared base
 * URL's models endpoint with the protocol-appropriate auth for the declared
 * `api` form (anthropic-messages → x-api-key + anthropic-version; both
 * openai-* forms → Bearer — the "declared api protocol equivalent" of the
 * assignment's probe rule). 401/403 → invalid_key; ANY 2xx → ok with models
 * = the declared modelIds, verbatim (the plan's §6.1 echo contract: 成功时
 * models = 声明 modelIds 回显，无抓取 — the vocabulary IS the declaration;
 * the response body is never scraped); every other non-2xx →
 * unexpected_response; transport failures → unreachable. Custom providers
 * never write app_provider_models rows — their dropdown source is the
 * declared model_ids, returned here for callers to display.
 */
async function verifyCustomProvider(
  deps: VerifyDeps,
  custom: CustomVerifyInput,
  key: string,
): Promise<VerifyResult> {
  const anthropicStyle = custom.api === "anthropic-messages";
  const headers: Record<string, string> = anthropicStyle
    ? { "x-api-key": key, "anthropic-version": "2023-06-01" }
    : { authorization: `Bearer ${key}` };
  let res: Response;
  try {
    res = await deps.fetch(customModelsUrl(custom.baseUrl), {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(deps.timeoutMs ?? VERIFY_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, reason: "unreachable" };
  }
  if (res.status === 401 || res.status === 403) {
    return { ok: false, reason: "invalid_key" };
  }
  if (!res.ok) {
    return { ok: false, reason: "unexpected_response" };
  }
  return { ok: true, models: custom.modelIds };
}

/**
 * Verify a freshly typed provider key against its provider's public surface
 * (spec §6.2). Callers pass the NOT-yet-stored plaintext key; the module
 * sends it outbound only, never logs it, and returns a structured result.
 * Built-in providers come from PROVIDER_VERIFY_ENDPOINTS; a `custom` input
 * routes to the custom-provider probe instead (custom declarations carry
 * their own base URL + protocol).
 */
export async function verifyProviderKey(
  deps: VerifyDeps,
  provider: string,
  key: string,
  custom?: CustomVerifyInput,
): Promise<VerifyResult> {
  if (custom !== undefined) {
    return verifyCustomProvider(deps, custom, key);
  }
  const spec = PROVIDER_VERIFY_ENDPOINTS[provider];
  if (spec === undefined) {
    return { ok: false, reason: "unsupported_provider" };
  }
  switch (spec.kind) {
    case "models":
      return verifyModelsEndpoint(deps, spec, key);
    case "probe":
      return verifyProbe(deps, spec, key);
    case "unsupported":
      return { ok: false, reason: "unsupported_provider" };
  }
}
