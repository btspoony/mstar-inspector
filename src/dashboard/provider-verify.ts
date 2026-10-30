/**
 * Provider-key verification for the provider-first settings flow
 * (spec v1.1-dashboard-platform §6.1/6.2) — dashboard side.
 *
 * The settings save route verifies a freshly typed key BEFORE anything is
 * stored: built-in providers hit their list-models endpoint (or a documented
 * auth probe when no models endpoint exists), custom providers probe the
 * declared base URL, and only a successful probe returns `ok` with THAT KEY's
 * model list to record as evidence (app_provider_models). Verification is
 * outbound-only with
 * the as-typed key (never stored, never logged); storage afterwards goes
 * through the existing secretbox envelope (src/dashboard/secretbox.ts).
 *
 * Validation-only: every request is a GET to a models/identity endpoint.
 * Nothing here may POST to a chat-completion (or any inference) endpoint — a
 * key check never spends a model, and the review sandbox is the only place
 * inference happens. A provider with no key-rejecting models/usage endpoint
 * stays `unsupported` (console-managed) rather than gaining a chat probe.
 *
 * Boundary (architect decision Q2): this module imports NOTHING from
 * pipeline/review code. The endpoint map is keyed by the dashboard's own
 * PROVIDER_IDS mirror (src/dashboard/app-config-store.ts) and parity-locked
 * by tests — the pipeline's PROVIDERS envName mapping (runner injection
 * surface) is irrelevant here. Built-in specs come from the vendored omp
 * snapshots in scripts/provider-catalog/ (the API-key provider union and its
 * `validate "models-endpoint"` entries), resolved through that snapshot's own
 * alias map; ids omp does not validate keep a hand-documented entry.
 *
 * Failure reasons are structured and documented per case:
 *   - `invalid_key`        401/403 from the provider (key rejected)
 *   - `unreachable`        network failure / timeout (10s AbortSignal.timeout)
 *   - `unexpected_response` the provider answered but not with a successful,
 *                           parseable verification response
 *   - `unsupported_provider` no endpoint mapping AND no probeable host
 *                           (per-resource-host providers — see the table)
 */

import ompApiKeyProviders from "../../scripts/provider-catalog/omp-api-key-providers.json";
import ompProviderVerify from "../../scripts/provider-catalog/omp-provider-verify.json";
import { PROVIDER_IDS_BUILTIN } from "../contracts/provider-catalog.generated";
import { type CustomProviderApi } from "./app-config-store";

/** 10s outbound verification budget (spec §6.2: "10s 超时"). */
export const VERIFY_TIMEOUT_MS = 10_000;

/** The explicit User-Agent every verify request carries: a server-side client
 *  identifies itself (several provider gateways and WAFs reject a request
 *  without one). Deliberately NOT an omp SDK inference header. */
export const VERIFY_USER_AGENT = "mstar-inspector-provider-verify";

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
 *   - `probe`   — GET an identity/usage endpoint; any 2xx proves the key;
 *                 models stay [] (probe-only → empty dropdown + syntax-only
 *                 member validation, spec §6.2/§6.3)
 *   - `unsupported` — no key-rejecting models/usage endpoint exists, so the
 *                 key stays console-managed (never an inference probe)
 */
export type ProviderVerifySpec =
  | { kind: "models"; url: string; auth: VerifyAuth; anthropicVersion?: boolean }
  | { kind: "probe"; url: string; auth: VerifyAuth }
  | { kind: "unsupported"; note: string };

/** omp's `validate "models-endpoint"` entries, by omp provider id (the
 *  vendored snapshot's own header names the source version and rules). */
const OMP_MODELS_ENDPOINTS: Record<string, { url: string; headersHook?: string }> = Object.fromEntries(
  ompProviderVerify.endpoints.map((entry) => [entry.id, entry]),
);

/** The union alias map (omp provider id → catalog row id) — the SAME map the
 *  provider-catalog generator resolves ids through; read inverted below so an
 *  omp entry filed under `google` / `azure` / `opencode-zen` still reaches the
 *  inspector's `gemini` / `azure-openai` / `opencode`. */
const OMP_ID_TO_CATALOG_ID: Record<string, string> = ompApiKeyProviders.excluded.alias;

/** The omp provider id whose validate entry covers this inspector builtin
 *  (exported: the verify suite pins the alias resolution against the union
 *  snapshot). */
export function ompProviderIdFor(providerId: string): string {
  for (const [ompId, catalogId] of Object.entries(OMP_ID_TO_CATALOG_ID)) {
    if (catalogId === providerId) return ompId;
  }
  return providerId;
}

/** The models-endpoint spec omp's validate data proves for this builtin, or
 *  undefined when omp carries no plain-Bearer entry for it. An entry with a
 *  `headersHook` is skipped: its headers are computed omp-side (a project id
 *  from the environment, a client fingerprint), so a bare dashboard request is
 *  NOT the request omp validated, and the documented entry stays in charge. */
function ompVerifySpec(providerId: string): Extract<ProviderVerifySpec, { kind: "models" }> | undefined {
  const entry = OMP_MODELS_ENDPOINTS[ompProviderIdFor(providerId)];
  if (entry === undefined || entry.headersHook !== undefined) return undefined;
  return { kind: "models", url: entry.url, auth: "bearer" };
}

/**
 * The hand-documented specs for built-in ids omp 18.13.3 has no
 * `validate "models-endpoint"` entry for (DOCUMENTED_VERIFY_ENDPOINTS).
 * Cross-checked 2026-10-30; every row is a GET against a models or identity
 * endpoint — never an inference call:
 *
 * | provider        | kind     | endpoint (auth)                                 | source |
 * |-----------------|----------|-------------------------------------------------|-------|
 * | anthropic       | models   | https://api.anthropic.com/v1/models (x-api-key + anthropic-version) | documented (docs.anthropic.com); omp's anthropic rule ships no api-key models-endpoint entry |
 * | openai          | models   | https://api.openai.com/v1/models (Bearer)       | documented |
 * | gemini          | models   | https://generativelanguage.googleapis.com/v1beta/models (x-goog-api-key) | documented (ai.google.dev); key in header, never the URL; omp's `google` rule carries no models-endpoint entry |
 * | copilot         | probe    | GET https://api.github.com/user (Bearer)        | COPILOT_GITHUB_TOKEN is a GitHub token; the GitHub REST probe proves token validity (a 401 there means the token is dead). Copilot seat entitlement stays a runner-time check. |
 * | azure-openai    | unsupported | —                                            | Azure resource host is per-deployment (AZURE_OPENAI_ENDPOINT); the dashboard stores only the key — no probeable host. |
 * | groq            | models   | https://api.groq.com/openai/v1/models (Bearer)  | documented, OpenAI shape |
 * | cerebras        | models   | https://api.cerebras.ai/v1/models (Bearer)      | documented, OpenAI shape; omp validates a Cerebras key with a chat completion (inference), which the dashboard must not do |
 * | openrouter      | models   | https://openrouter.ai/api/v1/models (Bearer)    | documented (docs show Bearer on GET /api/v1/models) |
 * | mistral         | models   | https://api.mistral.ai/v1/models (Bearer)       | documented, OpenAI shape |
 * | minimax         | models   | https://api.minimax.io/v1/models (Bearer)       | documented (platform.minimax.io list-models reference) |
 * | opencode        | models   | https://opencode.ai/zen/v1/models (Bearer)      | OpenCode Zen docs list the endpoint; auth presumed Bearer Zen key [INFERENCE] |
 * | cursor          | models   | GET https://api.cursor.com/v1/models (Bearer)   | Cloud Agents API (cursor.com/docs/api) exposes GET /v1/models — a 2xx list is cached (a real dropdown), 401 still maps to invalid_key; CURSOR_ACCESS_TOKEN rides the omp cursor provider (api2.cursor.sh proxy) at review time — a token rejected here but fine there should move this entry to the proxy surface [INFERENCE] |
 * | ai-gateway      | unsupported | —                                            | Cloudflare AI Gateway path needs account + gateway ids; key alone has no fixed host. |
 * | ark             | models   | https://ark.cn-beijing.volces.com/api/v3/models (Bearer) | OpenAI-compatible base confirmed (ark.cn-beijing.volces.com/api/v3); /models is the standard path — if Ark 404s it, move to probe [INFERENCE] |
 * | kilo            | unsupported | —                                            | omp's Kilo rule (custom hook) carries no models-endpoint validate entry and the gateway model list is public — no key-rejecting models/usage endpoint; the key stays console-managed. |
 * | zai             | unsupported | —                                            | omp validates a Z.AI key with a chat completion, not a models endpoint; Z.AI documents no key-rejecting list-models or usage endpoint. The key stays console-managed. |
 * | umans           | unsupported | —                                            | omp validates a Umans key with an Anthropic-messages completion; the Umans models list is public — no key-rejecting models/usage endpoint. The key stays console-managed. |
 *
 * xai and wafer-serverless are deliberately ABSENT: omp's vendored validate
 * data supplies both URLs, so PROVIDER_VERIFY_ENDPOINTS takes them from
 * ompVerifySpec (a broken derivation then fails the parity test instead of
 * silently leaving a provider unverifiable).
 */
const DOCUMENTED_VERIFY_ENDPOINTS: Record<string, ProviderVerifySpec> = {
  anthropic: { kind: "models", url: "https://api.anthropic.com/v1/models", auth: "x-api-key", anthropicVersion: true },
  openai: { kind: "models", url: "https://api.openai.com/v1/models", auth: "bearer" },
  gemini: { kind: "models", url: "https://generativelanguage.googleapis.com/v1beta/models", auth: "x-goog-api-key" },
  copilot: { kind: "probe", url: "https://api.github.com/user", auth: "bearer" },
  "azure-openai": {
    kind: "unsupported",
    note: "Azure resource host is per-deployment (AZURE_OPENAI_ENDPOINT); the dashboard stores only the key — no probeable host",
  },
  groq: { kind: "models", url: "https://api.groq.com/openai/v1/models", auth: "bearer" },
  cerebras: { kind: "models", url: "https://api.cerebras.ai/v1/models", auth: "bearer" },
  openrouter: { kind: "models", url: "https://openrouter.ai/api/v1/models", auth: "bearer" },
  kilo: {
    kind: "unsupported",
    note: "omp's Kilo auth rule has no models-endpoint validate entry and the gateway model list is public — Kilo exposes no key-rejecting models or usage endpoint",
  },
  mistral: { kind: "models", url: "https://api.mistral.ai/v1/models", auth: "bearer" },
  zai: {
    kind: "unsupported",
    note: "omp validates a Z.AI key with a chat completion, and Z.AI documents no key-rejecting list-models or usage endpoint",
  },
  umans: {
    kind: "unsupported",
    note: "omp validates a Umans key with an Anthropic-messages completion and the Umans model list is public — no key-rejecting models or usage endpoint",
  },
  minimax: { kind: "models", url: "https://api.minimax.io/v1/models", auth: "bearer" },
  opencode: { kind: "models", url: "https://opencode.ai/zen/v1/models", auth: "bearer" },
  cursor: { kind: "models", url: "https://api.cursor.com/v1/models", auth: "bearer" },
  "ai-gateway": {
    kind: "unsupported",
    note: "Cloudflare AI Gateway path needs account + gateway ids; the key alone has no fixed host",
  },
  ark: { kind: "models", url: "https://ark.cn-beijing.volces.com/api/v3/models", auth: "bearer" },
};

/**
 * PROVIDER_VERIFY_ENDPOINTS — keyed exactly by the builtin tier's id list
 * (PROVIDER_IDS_BUILTIN, the same sequence the dashboard's PROVIDER_IDS
 * mirrors; parity-locked by tests). The vendored omp validate data answers
 * wherever it covers an id; the documented table answers for the rest. A
 * builtin neither source covers fails loudly at module load instead of
 * shipping a provider the settings face cannot verify.
 */
export const PROVIDER_VERIFY_ENDPOINTS: Record<string, ProviderVerifySpec> = Object.fromEntries(
  PROVIDER_IDS_BUILTIN.map((id) => [id, verifySpecFor(id)]),
);

/** One builtin's spec: omp's vendored validate entry first, else the
 *  documented row. */
function verifySpecFor(id: string): ProviderVerifySpec {
  const derived = ompVerifySpec(id);
  if (derived !== undefined) return derived;
  const documented = DOCUMENTED_VERIFY_ENDPOINTS[id];
  if (documented === undefined) {
    throw new Error(
      `no verify spec for builtin provider ${JSON.stringify(id)} — vendor omp's validate entry or add a documented row`,
    );
  }
  return documented;
}

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

/** Every verify request's headers: the key's auth shape plus the two headers a
 *  JSON API client sends (some gateways 406 a missing Accept, several WAFs
 *  filter a request with no User-Agent — both read as `unreachable`). */
function requestHeaders(auth: VerifyAuth, key: string): Record<string, string> {
  return { ...authHeaders(auth, key), accept: "application/json", "user-agent": VERIFY_USER_AGENT };
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
  const headers = requestHeaders(spec.auth, key);
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
 * Verify one BUILT-IN provider key by auth probe: a GET on the provider's
 * identity/usage endpoint, where any 2xx proves the key (models stay [] — the
 * probe-only signal). 401/403 → invalid_key; every other non-2xx →
 * unexpected_response; transport failures → unreachable.
 */
async function verifyProbe(
  deps: VerifyDeps,
  spec: Extract<ProviderVerifySpec, { kind: "probe" }>,
  key: string,
): Promise<VerifyResult> {
  let res: Response;
  try {
    res = await deps.fetch(spec.url, {
      method: "GET",
      headers: requestHeaders(spec.auth, key),
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
 * The probe URL a custom provider's declared base URL resolves to: EXACTLY one
 * `…/models` URL. A base already ending in `/models` keeps it; one ending in
 * `/v1` (or `/v1/`, or the bare origin) gets `/models`; any other path keeps
 * its prefix and gets `/v1/models` — the standard discovery path for both
 * OpenAI- and Anthropic-protocol providers. A declaration's query/fragment is
 * not part of the probe (it would only reach the provider's error paths).
 * null = unparseable, which the caller answers as `unreachable`.
 */
function customModelsUrl(baseUrl: string): URL | null {
  let probe: URL;
  try {
    probe = new URL(baseUrl);
  } catch {
    return null;
  }
  const path = probe.pathname.replace(/\/+$/, "");
  probe.pathname = path.endsWith("/models") ? path : path.endsWith("/v1") ? `${path}/models` : `${path}/v1/models`;
  probe.search = "";
  probe.hash = "";
  return probe;
}

/**
 * Models URLs that REJECT a bogus key, so a 2xx there proves the submitted
 * key. An ALLOW-list, never a deny-list: a URL missing here is unproven, not
 * public, and the caller records the weaker `reachable` state. That default
 * stays true for endpoints that only later start answering 2xx without a
 * credential.
 *
 * TypeSafe's omp auth rule validates `GET https://api.typesafe.ai/v1/models`
 * and carries no public-endpoint note, so a bogus key is answered 401/403
 * there. The evidence names ONE PATH, so the entry is the probe's full URL: a
 * declaration on that host with another path (`/console`) derives a different
 * probe URL and stays unproven.
 *
 * shortcut: one endpoint only, so every other custom/template declaration
 * lands `reachable`. Add an entry here only with evidence its models URL
 * answers 401/403 for a bogus key.
 */
const KEY_REJECTING_MODELS_PROBE_URLS: Readonly<Record<string, true>> = { "https://api.typesafe.ai/v1/models": true };

/** Whether a custom-provider probe on this base URL can REJECT a bogus key. */
export function customProbeCanRejectKey(baseUrl: string): boolean {
  // Judge the URL the probe will actually request, not the declared host: the
  // path decides where the key gets sent.
  const probe = customModelsUrl(baseUrl);
  // Unparseable input is unproven (the store refuses such a base URL first).
  if (probe === null) return false;
  return Object.hasOwn(KEY_REJECTING_MODELS_PROBE_URLS, probe.origin + probe.pathname);
}

/**
 * Verify one CUSTOM-provider key (spec §6.1/§6.2): probe the declared base
 * URL's models endpoint with the protocol-appropriate auth for the declared
 * `api` form (anthropic-messages → x-api-key + anthropic-version; both
 * openai-* forms and `typesafe` → Bearer — the "declared api protocol
 * equivalent" of the assignment's probe rule). 401/403 → invalid_key; ANY 2xx
 * → ok with models = the declared modelIds, verbatim (the plan's §6.1 echo
 * contract: 成功时 models = 声明 modelIds 回显，无抓取 — the vocabulary IS the
 * declaration; the response body is never scraped); every other non-2xx →
 * unexpected_response; transport failures AND an unparseable base URL →
 * unreachable. Custom providers never write app_provider_models rows — their
 * dropdown source is the declared model_ids, returned here for callers to
 * display.
 *
 * A 2xx here is NOT always proof of the key: see customProbeCanRejectKey.
 */
async function verifyCustomProvider(
  deps: VerifyDeps,
  custom: CustomVerifyInput,
  key: string,
): Promise<VerifyResult> {
  const probe = customModelsUrl(custom.baseUrl);
  if (probe === null) return { ok: false, reason: "unreachable" };
  const headers =
    custom.api === "anthropic-messages"
      ? { ...requestHeaders("x-api-key", key), "anthropic-version": "2023-06-01" }
      : requestHeaders("bearer", key);
  let res: Response;
  try {
    res = await deps.fetch(probe.toString(), {
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
