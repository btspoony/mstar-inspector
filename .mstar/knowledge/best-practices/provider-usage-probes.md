---
module: dashboard / provider usage probing
date: 2026-11-05
problem_type: best_practice
category: best-practices
severity: medium
tags:
  - provider-usage
  - usage-probe
  - quota-endpoints
  - key-pools
  - limit-normalization
  - abort-signal
  - shared-pools
  - spa-snapshot-parser
applies_when:
  - adding a provider family to the per-key usage action
  - changing where provider keys are stored or resolved
  - touching the usage panel or its snapshot parser
  - deciding whether a catalog provider can carry usage_probe
related_components:
  - src/dashboard/provider-usage.ts
  - src/dashboard/app-config-store.ts
  - src/dashboard/index.ts
  - src/spa/pages/usage-panel.tsx
  - src/spa/pages/data.ts
  - tests/dashboard/provider-usage.test.ts
  - tests/worker/app-config.test.ts
---

# Per-key provider usage probes: endpoint constants, two limit shapes, closed outcomes

## Context

The settings page lists each stored provider key with a verification badge, which answers "was this key accepted when it was saved" and nothing more. The per-key usage action answers the other two questions — is this key still accepted, and how much of its allowance is left — by calling the vendor's own quota or billing route with that one key. `src/dashboard/provider-usage.ts` is the whole probe surface: one table keyed by catalog id, ten families, fifteen catalog ids, and no other entry point.

The module mirrors `src/dashboard/provider-verify.ts` by contract: an injected `fetch`, the same 10 s budget (`VERIFY_TIMEOUT_MS`), the same `VERIFY_USER_AGENT`, a closed outcome vocabulary (`ok | absent | unauthorized | error`), and no import from pipeline or review code. The catalog sourcing, tier and verify-endpoint mechanics behind those ids are documented separately in `{KNOWLEDGE_DIR}/best-practices/dashboard-provider-catalog-ai-sdk.md`; this note covers only the usage face and assumes that catalog exists.

## Guidance

### The probe table is the single registry

`USAGE_PROBES` maps catalog id → `UsageProbe`, and `hasUsageProbe` is an `Object.hasOwn` check over it — a plain index would answer `constructor` with a function and hand it back as a probe. Everything else derives from that table:

- `probeProviderUsage` answers an unmapped id with `absent` + `absentCause: "no-probe"` and makes **no** outbound request; a probe that escapes a throw becomes `error`, so no caller handles an exception.
- The settings payload stamps `usage_probe: hasUsageProbe(id)` on **both** catalog branches (builtin and template) in `src/dashboard/index.ts`; the SPA renders the action only when the stamp is `true`. There is no second hand-kept list of ids anywhere.
- The route refuses an unsupported provider before touching anything else.

Adding a family therefore means: one or more endpoint constants, a header builder, an extractor returning `UsageLimit[]` or a reason string, and the catalog ids as entries in `USAGE_PROBES`. Nothing else in the route, the store or the SPA changes.

### An endpoint's host and path are not derivable from the catalog `baseUrl`

The catalog's `baseUrl` is the **inference** base; the usage route usually sits on another path and sometimes on another route family entirely. String surgery on `baseUrl` produces a plausible URL that 404s or, worse, reaches an inference endpoint.

| catalog id | catalog `baseUrl` | usage endpoint |
|---|---|---|
| `commandcode`, `commandcode-anthropic` | `https://api.commandcode.ai/provider/v1` | `…/alpha/whoami`, then `…/alpha/billing/credits` (host root) |
| `opencode-go` | `https://opencode.ai/zen/go/v1` | `https://opencode.ai/zen/go/v1/usage` |
| `zai`, `zai-coding-plan` | `https://api.z.ai/api/coding/paas/v4` | `https://api.z.ai/api/monitor/usage/quota/limit` |
| `zhipuai`, `zhipuai-coding-plan` | `https://open.bigmodel.cn/api/paas/v4` / `…/api/coding/paas/v4` | `https://open.bigmodel.cn/api/monitor/usage/quota/limit` |
| `minimax-coding-plan` / `minimax-cn-coding-plan` | `https://api.minimax.io/anthropic/v1` / `https://api.minimaxi.com/anthropic/v1` | `/v1/token_plan/remains` on the same host |
| `cline-pass` | `https://api.cline.bot/api/v1` | `/api/v1/users/me/plan/usage-limits` (Bearer + desktop client headers) |
| `synthetic` | `https://api.synthetic.new/openai/v1` | `https://api.synthetic.new/v2/quotas` |
| `umans` | `https://api.code.umans.ai/v1` | `https://api.code.umans.ai/v1/usage` |
| `hyper` | `https://hyper.charm.land/v1` | `https://hyper.charm.land/credits` |
| `kimi-for-coding` | `https://api.kimi.com/coding/v1` | `https://api.kimi.com/coding/v1/usages` |
| `cursor` | `null` (the catalog ships no base URL) | `https://api2.cursor.sh/auth/usage` |

CN variants are chosen by host constant, not by rewriting an id, and GLM-family quota calls send the key as `Authorization` **verbatim** — no `Bearer` prefix.

### Two limit shapes, because the wire has two

`UsageLimit.kind` is `"window"` or `"balance"`. A window carries `usedFraction` (0..1) with an optional `limit` / `remaining` / `resetsAt`; a balance carries `remaining` and a unit. Forcing a balance into a percentage fabricates a total the vendor never stated, so it never happens. Windows are normalized through `windowLimit` + `keepTighter`, which keeps the most-binding limit per id because several model buckets share one plan pool. Units are the closed set `percent | requests | credits | usd | tokens`.

### A present-but-unreadable counter drops its limit; it never contributes 0

This is the module's central rule, held in four places:

- `fractionFromUsed` rejects non-finite and negative percentages; `fractionFromCounts` rejects a missing/zero limit and a negative used count.
- Command Code's credit components are tri-state — `undefined` (field absent, legitimately contributes nothing) versus `null` (present but unreadable, which makes the account total unknowable). Any `null` component drops the whole balance limit: summing only the readable ones would publish a partial balance as the account's credits.
- `snapshotFromRead` treats an empty extraction as `error` (`unrecognized usage payload`), never `ok` with zero bars.
- Family extractors prefer the vendor's own status over a stale percentage (MiniMax bucket status outranks a stale percent; OpenCode Go's `rate-limited` outranks `percent`; Kimi drops a window whose present counts are unusable).

The SPA repeats the discipline: a balance with no `remaining` renders the muted "nothing to report" copy rather than "0 credits".

### One classified GET makes every family mean the same thing by status

`readQuotaJson` is the only transport. It sends `accept: application/json`, `VERIFY_USER_AGENT`, then the family headers, and classifies the answer once:

| observed | outcome |
|---|---|
| 401 / 403 | `unauthorized` |
| 404 | `absent` with `absentCause: "reported-nothing"` — the probe ran, the account holds no plan to meter |
| any other non-2xx | `error` |
| 2xx with a non-object body | `error` |
| transport throw / abort | `error` |

The `reason` string is diagnostic only and is never rendered verbatim. `absent` carries two distinct causes (`no-probe` vs `reported-nothing`) because one means "no endpoint exists" and the other means "the vendor answered 404".

### One 10 s budget per probe, shared across a family's requests

`probeProviderUsage` computes `deadline = startedAt + (deps.timeoutMs ?? VERIFY_TIMEOUT_MS)` and passes it down; `readQuotaJson` derives `AbortSignal.timeout(deadline - Date.now())` per request. Command Code's two sequential GETs share that one deadline — resetting the budget per request would let a slow `whoami` buy a second full window and hang a probe at 2× the bound.

`AbortSignal.timeout` is not driven by fake timers. The bounded-transport tests therefore pin the platform clock on purpose and reproduce the bound with real single-digit-millisecond waits (`timeoutMs: 5` / `10` in `tests/dashboard/provider-usage.test.ts`); a fake-advancing test would pass while the real signal never fires.

### Keys come from two pools, each with its own AAD

`getProviderKeyPlaintext(appId, provider, keyId)` in `src/dashboard/app-config-store.ts` reads the built-in pool (`app_provider_keys`) and then the declaration pool (`app_custom_provider_keys`), decrypting each row with **its own** AAD, and returns `{ plainKey, custom }` or `null`. A `null` deliberately cannot distinguish "another App's id" from "a deleted id".

Every covered template provider — `commandcode`, `commandcode-anthropic`, `opencode-go`, `zai-coding-plan`, `zhipuai`, `zhipuai-coding-plan`, `minimax-coding-plan`, `minimax-cn-coding-plan`, `cline-pass`, `synthetic`, `hyper`, `kimi-for-coding` — stores its keys only in the declaration pool, because template providers materialize through the custom-provider machinery; only `zai`, `umans` and `cursor` are builtin-tier rows. A lookup that reads the built-in table alone answers `unknown_key` for exactly the reported providers while looking perfectly implemented.

### The route orders refusals by cost, and its vocabulary is closed

`POST /api/apps/:appId/keys/usage` (form fields `provider`, `keyId`) has four outcomes, cheapest first:

1. `400 unsupported_provider` — `!hasUsageProbe(provider)` is checked **before** any store read or outbound request.
2. `400 unknown_key` — `getProviderKeyPlaintext` returned `null`.
3. `200 { ok: true, ...snapshot }` with `Cache-Control: private, no-store`.
4. `400 unexpected` — a store/decrypt/probe throw is this closed reason, never a 5xx.

The plaintext exists only as the outbound `Authorization` header: never in a response body, never logged.

### The SPA side: strict parser, generation guard, label derived from the id

`src/spa/pages/data.ts` validates the 200 body field by field and returns `null` on any off-shape value rather than rendering it: the status must be on `ok | absent | unauthorized | error`, `kind` on `window | balance`, `unit` on the five-value set, every optional number must pass `Number.isFinite` (`typeof NaN === "number"` would otherwise render "NaN%"), and `shared` must be a boolean.

`src/spa/pages/usage-panel.tsx` probes when the row's usage action is clicked and again on every re-click — the re-click **is** the cache; there is deliberately no polling and no server-side cache, so a key that just died never shows a stale bar. The panel renders directly under the key's row: session/week/month windows become a three-cell bar row in that fixed order, any other window falls back to one line each, and a balance renders as the muted bottom line. A `generation` counter discards responses that resolve after close or after a switch to another key. Transport failure, a non-200 status, a non-JSON body and a `null` parse all collapse into the same danger notice as the wire's `error` face.

The row label is the segment after the **last** `:` of the normalized limit id (`cline-pass:session` → `session`), looked up as `settings.providers.usage.window.<segment>`; an unknown segment never renders verbatim — it falls back to the numbered `settings.providers.usage.limit.generic` label (or `genericSingle` when the snapshot holds one limit), because the segment can be vendor bucket text. A new family must therefore pick ids whose last segment is a dictionary key, and an unknown one degrades to the generic label instead of leaking vendor vocabulary.

### `shared: true` means one account-wide pool, not a per-key allowance

Set only where the vendor reports a single account-level number every stored key would repeat: Charm Hyper's prepaid balance, Synthetic's five-hour and weekly pools, and Command Code's credit balance (the org pool when `whoami` names one). The panel appends the "account-wide" wording so three key rows drawing on one pool do not read as three independent quotas. A per-key allowance must never carry the flag — it would understate what a rotated key still has.

### Scope boundary: API key, not OAuth, not a composite credential

The probe speaks one bearer-style credential, so coverage stops where the vendor's usage route needs something else:

- OAuth-only surfaces stay out (Claude subscription usage, Codex, Gemini CLI, GitHub Copilot, Antigravity, Factory Droid, Muse Code, xAI OAuth) — their catalog rows keep `usage_probe: false`, so no action is offered.
- Alibaba token plan reads a JSON credential carrying a console cookie; this product stores a bare API key, so it stays unsupported.
- Cursor is covered **only** through `GET /auth/usage`; its OAuth surfaces (`/api/usage-summary`, `GetPlanInfo`) are out of scope.

Excluding a family is a catalog-stamp decision, not a runtime failure: no probe means no button, not a probe that always errors.

## Why This Matters

A usage bar is read as a fact about money and access. Two failure modes are worse than showing nothing: a counter defaulted to 0 renders a healthy empty bar for a spent key, and a partially summed balance publishes a number the vendor never stated. Dropping an unreadable limit makes the gap visible instead. The same reasoning drives the two-pool lookup and the ordering rule — a silently `unknown_key` provider, or an outbound request fired for a provider that has no probe, both look like working code.

The endpoint constants exist because the alternative (deriving from `baseUrl`) fails only on the families where the usage route lives elsewhere — exactly the families a new engineer is most likely to get wrong.

## When to Apply

- Adding a provider family to the usage action, or a catalog id to an existing family.
- Deciding whether a newly catalogued provider may carry `usage_probe`.
- Changing where provider keys are written, read, or decrypted.
- Touching the usage panel, its snapshot parser, or the i18n keys under `settings.providers.usage.*`.
- Reviewing a diff that adds an outbound request to `src/dashboard/provider-usage.ts`.

## Examples

### Adding a family

```ts
// 1. endpoint constant — never derived from meta.baseUrl
const WIDGET_USAGE_URL = "https://api.widget.example/v1/quota";

// 2. extractor: return limits, or a reason string for an unusable payload
const widgetUsage: UsageProbe = async (input, key) => {
  const read = await readQuotaJson(input, WIDGET_USAGE_URL, { authorization: `Bearer ${key}` });
  return snapshotFromRead(read, (body) => {
    const usedFraction = fractionFromCounts(toNumber(body.used), toNumber(body.cap));
    return usedFraction === undefined
      ? "no usable counters"
      : [windowLimit({ id: "widget:session", usedFraction, unit: "requests" })];
  });
};

// 3. register the catalog ids — this alone flips usage_probe on both catalog branches
const USAGE_PROBES = Object.freeze({
  // …
  widget: widgetUsage,
});
```

### Dropping versus zero-filling an unreadable counter

```ts
// Wrong: an unreadable field silently becomes "0 used"
const used = toNumber(row.used) ?? 0;

// Right: unusable counters yield undefined and the limit is dropped whole
const usedFraction = fractionFromCounts(toNumber(row.used), toNumber(row.cap));
if (usedFraction === undefined) continue;
```

### Trusting a 200 as success

```ts
// Wrong: MiniMax answers HTTP 200 for a rejected credential
if (response.ok) return body;

// Right: the vendor's own status is the success signal
const baseResp = asRecord(body.base_resp);
const statusCode = toNumber(baseResp?.status_code);
if (statusCode !== undefined && statusCode !== 0) return `usage request rejected (${statusCode})`;
```
