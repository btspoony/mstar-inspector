/**
 * Pure parsers/guards for resident SPA pages.
 * Tested without a DOM runner.
 */

import { FREE_SLOT_REFUSAL, WORKSPACE_CREATION_CLOSED_REFUSAL } from "../../dashboard/entitlement";
import { t, type DictionaryKey, type Locale } from "../../i18n";

export type Role = "admin" | "member";

/** A workspace member's role (migration 0026 CHECK domain). */
export type WorkspaceRole = "owner" | "admin" | "member";

/** One row of the workspace member list (`GET /:ref/api/members`). */
export type MemberRow = {
  id: string;
  github_login: string;
  role: WorkspaceRole;
  created_at: string;
};

/** The workspace's plan, seat limit, meter and waiting invites. */
export type WorkspaceSummary = {
  plan: { id: string; name: string };
  /** `null` = no seat cap (the unlimited tier), never `0`. */
  memberLimit: number | null;
  reviewAttemptsThisMonth: number;
  /** Live (unexpired) pending invites — each one already occupies a seat. */
  pendingInvites: number;
};

/**
 * The member-list payload: the caller's own role, the workspace summary and
 * every workspace member.
 */
export type MembersPayload = {
  viewer: { role: WorkspaceRole };
  workspace: WorkspaceSummary;
  members: MemberRow[];
};

/** One live pending invite (`GET /:ref/api/members/invites`). */
export type InviteRow = {
  id: string;
  github_login: string;
  role: Role;
  created_at: string;
  expires_at: string;
};

export type InsightsSearch = { window: string; repo: string };

/**
 * One per-bucket distribution row of `findings_distribution` (AD-652) —
 * structurally mirrors the store's FindingsDistributionBucket
 * (the dashboard leaf exports no types). `by_severity` is zero-filled over
 * the fixed merge-class set {must-fix, should-fix, nit} — identical key set
 * on every bucket, so the SPA's series vocabulary is stable per window.
 */
export type FindingsDistributionBucket = {
  /** UTC bucket start `YYYY-MM-DD` — a day, or a Monday for week buckets. */
  bucket_start: string;
  /** "day" for clamped windowDays <= 30, "week" above (AD-652 mapping). */
  granularity: "day" | "week";
  by_severity: Record<string, number>;
};

export type InsightsSummary = {
  window_days: number;
  repo?: string;
  reviews_total: number;
  findings_by_severity: Array<{ severity: string; count: number }>;
  verdict_distribution: Array<{ verdict: string; count: number }>;
  weekly_trend: Array<{ week_start: string; reviews: number; findings: number }>;
  /**
   * Day-bucketed trend (additive `daily_trend`, window-bucketing contract
   * 2026-09-20): `weekly_trend`'s count semantics at day granularity,
   * zero-filled over the day grid. Produced only for day windows (clamped
   * `window_days <= 30`); week windows carry exactly [] — the week-window
   * trend card falls back to `weekly_trend` zero-filled over the
   * `findings_distribution` grid ({@link insightsTrendPoints}). REQUIRED
   * like the other aggregations (AD-652 precedent).
   */
  daily_trend: Array<{ day_start: string; reviews: number; findings: number }>;
  /**
   * Per-bucket findings distribution (AD-652 — additive): the
   * severity card's stacked time-series grid. REQUIRED like the
   * other aggregations — a payload missing it (or carrying malformed rows)
   * takes the same null fallback as any other shape drift; it is never
   * tolerate-absent (that is the `repos` precedent only).
   */
  findings_distribution: FindingsDistributionBucket[];
  /**
   * Window-scoped distinct owner/repo values. Independent of
   * `repo`. Absent on payloads that did not request `include=repos`
   * (QC F-001) — consumers default to [].
   */
  repos?: string[];
};

/** Radix Select forbids empty-string item values — "all" maps to no repo filter. */
export const INSIGHTS_REPO_ALL = "all";

export function insightsRepoSelectValue(repo: string): string {
  return repo === "" ? INSIGHTS_REPO_ALL : repo;
}

export function insightsRepoFromSelect(value: string): string {
  return value === INSIGHTS_REPO_ALL ? "" : value;
}

/**
 * Repo Select items (excluding 全部). Window-set repos plus the current
 * filter when it is a legal deep-link value outside the set — applied, not
 * swallowed. Sorted, de-duped.
 */
export function insightsRepoOptions(repos: readonly string[], current: string): string[] {
  const set = new Set(repos.filter((repo) => repo.length > 0));
  if (current !== "") set.add(current);
  return [...set].sort();
}

export type AppsPayload = {
  viewer: { login: string; role: Role };
  apps: Array<{
    github_app_id: number;
    github_name: string | null;
    github_slug: string | null;
    github_avatar_url: string | null;
    status: string;
    review_enabled: number;
    created_by: string;
    health: {
      latest: { event_name: string | null; outcome: string; status_code: number | null; created_at: string } | null;
      rejected24h: number;
    };
  }>;
};

/**
 * (spec § Provider configuration contract): whether a catalog entry
 * is usable by the App's SELECTED sandbox runtime image — `builtin` consumes
 * it via env names, `template` needs custom-provider materialization,
 * `unavailable` cannot run on that image at all. Judged server-side against
 * `app.sandbox_image_id`, never inferred client-side.
 */
export type ProviderEligibility = "builtin" | "template" | "unavailable";

export type CatalogProvider = {
  id: string;
  label: string;
  tier: "builtin" | "template";
  base_url: string | null;
  api: string | null;
  models: string[];
  verifiable: boolean;
  /** Usability vs the App's selected runtime image. */
  eligibility: ProviderEligibility;
  /**
   * Display-only picker group (AD-547): `common` = the 5-entry
   * 常用提供方 tier shown first, `catalog` = the 目录模板 group. Form and
   * config branching NEVER reads this — the key-only vs template flow stays
   * keyed to `tier` / `eligibility`.
   */
  display_group: "common" | "catalog";
};

/**
 * The store-enforced verification vocabulary (mirrors
 * `app_provider_keys.verified_status`): `ok` = the probe proved the KEY,
 * `reachable` = it only proved the ENDPOINT answered (the host is not known to
 * reject a bogus key), `failed` = a recorded failed verify, NULL = never
 * verified.
 */
export type KeyVerifiedStatus = "ok" | "reachable" | "failed" | null;

/**
 * One row of the settings `keys` face (the store's ProviderKeySummary): the
 * provider it belongs to, its pool identity, the masked tail and the per-key
 * bookkeeping. ONE ROW PER STORED KEY — the add flow lists every row of a
 * provider, never a single slot per provider id. The plaintext never appears
 * on this face.
 */
export type ProviderKeyRow = {
  provider: string;
  /** First 16 hex characters of the key's SHA-256 — the handle a delete takes. */
  keyId: string;
  last4: string;
  updatedAt: string | null;
  verifiedAt: string | null;
  verifiedStatus: KeyVerifiedStatus;
};

/**
 * The stored key rows of one provider, in payload order (provider-ascending,
 * then pool order). Every row comes back — a second key of a provider is its
 * own row, not an overwrite of the first.
 */
export function providerKeyRows(keys: readonly ProviderKeyRow[], provider: string): ProviderKeyRow[] {
  return keys.filter((key) => key.provider === provider);
}

/**
 * The slot a dialog-confirmed key removal's outcome renders at: the configured
 * row the delete POST targets, matched on the SAME composite identity the
 * store's primary key `(app_id, provider, key_id)` and the POST body carry.
 * Key ids hash the plaintext alone, so one key stored under two providers
 * shares its id — the provider is part of the match. `-1` when the payload
 * holds no such row (the caller clamps the outcome to the list's end).
 */
export function configuredKeySlot(
  rows: readonly ConfiguredProvider[],
  provider: string,
  keyId: string,
): number {
  return rows.findIndex((row) => row.kind === "key" && row.provider === provider && row.key_id === keyId);
}

/**
 * The tolerant remove routes (key delete / custom provider remove) answer
 * their no-op case as a 2xx `{ changed: false, message }` — nothing matched,
 * so nothing was removed. `false` is the SPA's no-change outcome (it must not
 * render the generic saved notice); `true` is a removal; `null` — any other
 * body — keeps the caller's default (the plain-text 2xx faces).
 */
export function removeChanged(body: string): boolean | null {
  try {
    const parsed = JSON.parse(body) as { changed?: unknown };
    return typeof parsed.changed === "boolean" ? parsed.changed : null;
  } catch {
    return null;
  }
}

/**
 * One row of the App's PERSISTED provider state: a stored builtin
 * key (masked tail only) or a saved custom-provider declaration. The `kind`
 * discriminator keeps this shape disjoint from {@link CatalogProvider} — a
 * catalog entry (id/label/tier/models, no `kind`) can never be mistaken for
 * configured state, and no plaintext key ever appears here.
 */
export type ConfiguredProvider =
  | {
      kind: "key";
      provider: string;
      /** The pool row's identity — the handle a per-key delete takes. */
      key_id: string;
      last4: string;
      updated_at: string | null;
      verified_at: string | null;
      verified_status: KeyVerifiedStatus;
    }
  | { kind: "custom"; provider_id: string; base_url: string; api: string; model_ids: string[] };

export type ModelChainEntry = {
  name: string;
  chain: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * The reserved Default chain name — mirrors DEFAULT_CHAIN_NAME in
 * src/dashboard/app-config-store.ts. The store rejects it as a named-chain
 * name, so it can never collide with a named tab id.
 */
export const DEFAULT_CHAIN_NAME = "default";

/**
 * One peer tab of the chain tab model: Default and every named
 * chain sit at the same hierarchy.
 */
export type ChainTab = {
  /** Stable tab id — the stored chain name; {@link DEFAULT_CHAIN_NAME} for the Default tab. */
  id: string;
  /** The Default tab is non-removable; only named tabs offer remove. */
  isDefault: boolean;
  /** Stored chain value (named rows); null on the Default tab, whose editor consumes `model_chain`. */
  chain: string | null;
};

/**
 * The chain tab list: the Default tab is ALWAYS synthesized first —
 * an empty, legacy, or malformed `model_chains` payload can never remove it —
 * and payload rows named "default" collapse into that tab instead of becoming
 * named tabs. Named tab ids are the stored names, de-duplicated (first row
 * wins), keeping the payload's name-ascending order.
 */
export function modelChainTabs(modelChains: readonly ModelChainEntry[]): ChainTab[] {
  const tabs: ChainTab[] = [{ id: DEFAULT_CHAIN_NAME, isDefault: true, chain: null }];
  const seen = new Set<string>([DEFAULT_CHAIN_NAME]);
  for (const entry of modelChains) {
    if (seen.has(entry.name)) continue;
    seen.add(entry.name);
    tabs.push({ id: entry.name, isDefault: false, chain: entry.chain });
  }
  return tabs;
}

/**
 * The selected tab id coerced to a tab that actually exists — after a delete
 * or a stale payload the selection falls back to the non-removable Default
 * tab instead of pointing at a chain that no longer renders.
 */
export function activeChainTabId(tabs: readonly ChainTab[], selected: string | null | undefined): string {
  return selected !== null && selected !== undefined && tabs.some((tab) => tab.id === selected)
    ? selected
    : DEFAULT_CHAIN_NAME;
}

/**
 * Seat select value, derived from the same tab model: an absent
 * mapping, the empty string, and the reserved "default" name all mean the
 * Default chain; a stored name that no current named tab offers (deleted
 * chain, stale payload) renders as Default too — so the select never shows a
 * missing chain and the op=save-roles form never submits an invalid
 * reference (the route 400s on unknown names).
 */
export function seatSelectValue(tabs: readonly ChainTab[], stored: string | null | undefined): string {
  if (stored === null || stored === undefined || stored === "") return DEFAULT_CHAIN_NAME;
  return tabs.some((tab) => !tab.isDefault && tab.id === stored) ? stored : DEFAULT_CHAIN_NAME;
}

/**
 * One coerced seat value per role id — the SeatsCard state seed and its
 * post-reload re-derivation share this single derivation.
 */
export function seatRoleValues(
  roleIds: readonly string[],
  roles: Readonly<Record<string, string>>,
  tabs: readonly ChainTab[],
): Record<string, string> {
  const next: Record<string, string> = {};
  for (const role of roleIds) {
    next[role] = seatSelectValue(tabs, roles[role]);
  }
  return next;
}

/**
 * Per-App review trigger modes (spec review-trigger-policy §2) — the
 * migration 0022 CHECK enum. Mirrors the store's frozen
 * `REVIEW_TRIGGER_MODES` across the bundle boundary (documented, deliberately
 * not imported — the DEFAULT_CHAIN_NAME duplication-lock convention; the
 * lock test pins drift). Values are wire-verbatim; only labels localize.
 */
export const REVIEW_TRIGGER_MODES = ["open", "every_push", "manual"] as const;
export type ReviewTriggerMode = (typeof REVIEW_TRIGGER_MODES)[number];

export function isReviewTriggerMode(value: unknown): value is ReviewTriggerMode {
  return (REVIEW_TRIGGER_MODES as readonly string[]).includes(value as string);
}

/**
 * The D4 identity set — the fields the GET /api/apps list rows expose
 * (github_app_id, status, review_enabled, created_by) plus created_at and
 * the cached public GitHub profile. This is the NON-MANAGER detail face's
 * whole app shape: everything from the ops stores (installations,
 * deliveries, sandbox_image_id, review-trigger runtime config) stays behind
 * the manager face (the server keys the split on `can_manage`).
 */
export type SettingsIdentityAppMeta = {
  github_app_id: number;
  status: string;
  review_enabled: boolean;
  created_by: string;
  /** `datetime('now')` UTC string — joins the required identity keys. */
  created_at: string;
  /** The local App UID — the webhook URL's app segment (never a GitHub fact). */
  id: string;
  github_name: string | null;
  github_slug: string | null;
  github_description: string | null;
  github_html_url: string | null;
  github_avatar_url: string | null;
  github_metadata_synced_at: string | null;
};

export type SettingsAppMeta = {
  github_app_id: number;
  status: string;
  review_enabled: boolean;
  created_by: string;
  last_webhook_at: string | null;
  /**
   * The local App UID — the webhook URL's app segment (never a GitHub fact).
   * It rides BOTH payload faces — the member face returns it too, and
   * parseSettings requires it either way — because it is part of the App's
   * identity set. Only the MANAGER identity card composes the delivery URL
   * from it (a webhook repoint needs that URL).
   */
  id: string;
  /** The App's selected sandbox runtime image (registry id). */
  sandbox_image_id: string;
  /** The App's review trigger mode (spec §2) — the control's current value. */
  review_trigger_mode: ReviewTriggerMode;
  /**
   * The cached public GitHub profile the settings route serves
   * (migration 0019 columns). Every field nullable — NULL = never synced (old
   * rows must render, per-field degradation on the card); the PEM / webhook
   * secret never ride this face. Present on BOTH payload faces (AC3).
   */
  github_name: string | null;
  github_slug: string | null;
  github_description: string | null;
  github_html_url: string | null;
  github_avatar_url: string | null;
  /** `datetime('now')` UTC string; NULL = never synced. */
  github_metadata_synced_at: string | null;
};

type SettingsHealth = {
  installations: Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
  deliveries: Array<{
    event_name: string | null;
    outcome: string;
    status_code: number | null;
    /** `owner/name` of the source repo (migration 0040); NULL = unknown source. */
    repository_full_name: string | null;
    created_at: string;
  }>;
  delivery_summary?: {
    latest: { event_name: string | null; outcome: string; status_code: number | null; created_at: string } | null;
    rejected24h: number;
  };
};

/** (spec §2): a non-manager gets the identity-only face (no ops stores). */
export type SettingsReadOnlyPayload = {
  can_manage: false;
  /** The App's stable workspace id — server-resolved, never a path segment. */
  workspace_id: string;
  app: SettingsIdentityAppMeta;
};

/**
 * The App's operator-facing display name (D0): GitHub's current name, then
 * its slug, then the immutable numeric App id — mirrors the server's
 * appDisplayName, so a rename shows up wherever the SPA names the App.
 */
export function appDisplayName(app: {
  github_name: string | null;
  github_slug: string | null;
  github_app_id: number;
}): string {
  return app.github_name ?? app.github_slug ?? String(app.github_app_id);
}

/** Creator-or-admin adds the settings zones: keys, chains, providers. */
export type SettingsManagePayload = {
  can_manage: true;
  /** The App's stable workspace id — server-resolved, never a path segment. */
  workspace_id: string;
  app: SettingsAppMeta;
  keys: ProviderKeyRow[];
  model_chain: string | null;
  model_roles: Record<string, string>;
  model_chains: ModelChainEntry[];
  custom_providers: Array<{ provider_id: string; base_url: string; api: string; model_ids: string[] }>;
  /** The App's persisted provider state ONLY — empty is the valid unconfigured case. */
  configured_providers: ConfiguredProvider[];
  /** Discovery metadata + eligibility — never configured state. */
  provider_catalog: CatalogProvider[];
  model_role_ids: readonly string[];
  custom_provider_api_ids: readonly string[];
  /** The selector's choices — enabled registry entries only (never yaml/secrets). */
  sandbox_images: Array<{ id: string; enabled: boolean }>;
} & SettingsHealth;

export type SettingsPayload = SettingsReadOnlyPayload | SettingsManagePayload;

export type ModelOptionSource = "verified" | "probe" | "custom";

export type ModelOptionGroup = {
  provider: string;
  source: ModelOptionSource;
  selectors: string[];
};

export type ModelsPayload = { groups: ModelOptionGroup[] };

/** The member list is visible to every member; the manager actions are not. */
export function canInviteMembers(role: WorkspaceRole | null): boolean {
  return role === "owner" || role === "admin";
}

/**
 * Is reviewing switched on for this App? The two wire representations of
 * `review_enabled` — raw integer on the apps list face (dashboard/index.ts),
 * boolean on the settings face (`!== 0` coercion) — are normalized here, so
 * every reader shares one derivation: the pause axis (`isPaused`), the Apps
 * band's review-off count, and the status pill.
 */
export function reviewEnabled(app: { review_enabled: number | boolean }): boolean {
  return typeof app.review_enabled === "boolean" ? app.review_enabled : app.review_enabled !== 0;
}

/**
 * Paused = active but reviews switched off (one predicate for
 * both faces) — over the same normalization, so the App status pill and
 * SettingsPage's OpsCard share one derivation.
 */
export function isPaused(app: { status: string; review_enabled: number | boolean }): boolean {
  return app.status === "active" && !reviewEnabled(app);
}

/**
 * The App status pill's copy + tone, derived once for both faces that show it
 * (the Apps list and the App detail shell). The face itself belongs to
 * `StatusBadge` in `@design-system`; only what a status MEANS lives here.
 */
export function appStatusPill(
  locale: Locale,
  app: { status: string; review_enabled: number | boolean },
): { label: string; tone: "success" | "warn" } {
  const paused = isPaused(app);
  return {
    label:
      app.status === "disabled"
        ? t(locale, "apps.status.disabled")
        : paused
          ? t(locale, "apps.status.paused")
          : t(locale, "apps.status.active"),
    tone: app.status === "disabled" || paused ? "warn" : "success",
  };
}

export function parseInsightsSearch(search: string): InsightsSearch {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return { window: params.get("window") ?? "30", repo: params.get("repo") ?? "" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isNumberRecord(value: unknown): value is Record<string, number> {
  return isRecord(value) && Object.values(value).every((count) => typeof count === "number");
}

/**
 * Row-level guard for the distribution grid: every bucket must
 * carry the bucket start, the day|week granularity, and the zero-filled
 * count grid — the stacked chart reads this shape directly, so a
 * drifted row fails the parse into the page's error face instead of
 * rendering NaN/undefined series. (The field is required;
 * missing or malformed → the existing null fallback path, and no existing
 * assertion was loosened.)
 */
function isDistributionList(value: unknown): value is FindingsDistributionBucket[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        isRecord(row) &&
        typeof row.bucket_start === "string" &&
        (row.granularity === "day" || row.granularity === "week") &&
        isNumberRecord(row.by_severity),
    )
  );
}

/**
 * Row-level guard for the daily trend grid (mirror of
 * {@link isDistributionList}): every row must carry the day start and
 * both counts — the trend chart reads these shapes directly, so a drifted
 * row fails the parse into the page's error face instead of rendering
 * NaN/undefined bars.
 */
function isDailyTrendList(
  value: unknown,
): value is Array<{ day_start: string; reviews: number; findings: number }> {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        isRecord(row) &&
        typeof row.day_start === "string" &&
        typeof row.reviews === "number" &&
        typeof row.findings === "number",
    )
  );
}

export function parseInsights(data: unknown): InsightsSummary | null {
  if (!isRecord(data) || typeof data.window_days !== "number" || typeof data.reviews_total !== "number") return null;
  if (
    !Array.isArray(data.findings_by_severity) ||
    !Array.isArray(data.verdict_distribution) ||
    !Array.isArray(data.weekly_trend)
  ) {
    return null;
  }
  // (AD-652): required — a rolled-back Worker's payload (no field)
  // or any drifted row takes the same null fallback as the fields above.
  // Not tolerate-absent: that face is the opt-in `repos` field only.
  if (!isDistributionList(data.findings_distribution)) return null;
  // (window-bucketing contract 2026-09-20): required along the same
  // AD-652 precedent — a rolled-back Worker's payload (no field) or any
  // drifted row takes the same null fallback; never tolerate-absent.
  if (!isDailyTrendList(data.daily_trend)) return null;
  // `repos` is opt-in (QC F-001): absent on payloads that did not
  // request include=repos (and on rolled-back Workers) — tolerate missing,
  // reject malformed.
  if (data.repos !== undefined && !isStringArray(data.repos)) return null;
  return data as InsightsSummary;
}

/**
 * Segmented window options (days) for the insights window ToggleGroup — a
 * legal subset of the API window domain (`^\d+$`, store clamp ≤90), zero API
 * extension. (Lives here since the home module was retired; the names
 * say insights — these helpers serve only the records page.)
 */
export const INSIGHTS_WINDOWS = ["7", "30", "90"] as const;
export type InsightsWindow = (typeof INSIGHTS_WINDOWS)[number];

/**
 * URL window → segment: the `window` param when it is one of
 * INSIGHTS_WINDOWS, else the default 30. Arbitrary integer windows stay
 * legal on the API, but the records page only offers the segmented set, so
 * off-set values resolve to the default instead of leaving the control
 * without an active segment. The page rewrites the URL on mount when an
 * off-set value is normalized (QC F-002), so the address bar
 * reflects the applied filter.
 */
export function insightsWindow(search: string): InsightsWindow {
  const raw = parseInsightsSearch(search).window;
  return (INSIGHTS_WINDOWS as readonly string[]).includes(raw) ? (raw as InsightsWindow) : "30";
}

/**
 * The search string with an off-set window normalized to the default
 * segment (e.g. "?window=60" → "" since 30 is the default, or
 * "?window=60&repo=acme/web" → "?repo=acme%2Fweb"). Returns the input
 * unchanged when the window is already a segment. Used on mount to rewrite
 * the URL so it reflects the applied filter (QC F-002).
 */
export function normalizeWindowSearch(search: string): string {
  const raw = parseInsightsSearch(search);
  const window = insightsWindow(search);
  if (raw.window === window) return search;
  const params = new URLSearchParams();
  if (window !== "30") params.set("window", window);
  if (raw.repo !== "") params.set("repo", raw.repo);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** One-line verdict distribution for the summary card. */
export function verdictLine(data: InsightsSummary): string {
  return data.verdict_distribution.map((row) => `${row.verdict} ${row.count}`).join(" · ");
}

/** One trend-bucket row the trend card renders — a day (day windows) or a Monday (week windows). */
export type InsightsTrendPoint = { bucket_start: string; reviews: number; findings: number };

/**
 * The trend card's buckets for the payload's window (window-bucketing
 * contract 2026-09-20): day windows (clamped `window_days <= 30`) map
 * `daily_trend` directly; week windows read the frozen `weekly_trend`
 * zero-filled over the `findings_distribution` bucket grid (the store's
 * weekGrid — every `weekly_trend` bucket start is on it by construction),
 * so each window carries exactly as many buckets as the stacked charts.
 * The `> 30` predicate deliberately mirrors the store's granularity
 * derivation (insights-store.ts, clamped window): the wire echoes the
 * clamped window and the SPA re-derives from it by contract, not by
 * import — the dashboard leaf exports no types.
 */
export function insightsTrendPoints(data: InsightsSummary): InsightsTrendPoint[] {
  if (data.window_days <= 30) {
    return data.daily_trend.map((row) => ({
      bucket_start: row.day_start,
      reviews: row.reviews,
      findings: row.findings,
    }));
  }
  const countsByWeekStart = new Map<string, { reviews: number; findings: number }>(
    data.weekly_trend.map((row) => [row.week_start, { reviews: row.reviews, findings: row.findings }]),
  );
  return data.findings_distribution.map((bucket) => {
    const row = countsByWeekStart.get(bucket.bucket_start);
    return { bucket_start: bucket.bucket_start, reviews: row?.reviews ?? 0, findings: row?.findings ?? 0 };
  });
}

/**
 * Per-App insights summary URL — `base` is the page's workspace prefix
 * (`/dashboard`, or `/dashboard/<slug>` under strict) plus the Worker's
 * `GET /api/apps/:appId/insights/summary` face. `repo` is omitted when empty
 * (the no-filter default). `include=repos` rides every read: the repo Select
 * needs the window-scoped distinct repo set on every face it can render (the
 * insights tab has no repo-less summary consumer).
 */
export function appInsightsSummaryUrl(
  base: string,
  appId: string,
  window: string,
  repo: string,
): string {
  const params = new URLSearchParams({ window, include: "repos" });
  if (repo !== "") params.set("repo", repo);
  return `${base}/api/apps/${encodeURIComponent(appId)}/insights/summary?${params.toString()}`;
}

/**
 * The per-App pull-request ledger (the Pull requests tab). One row per PR
 * the App received — the list face and the detail's `pull_request` share
 * this exact shape.
 */
export type PullRequestState = "open" | "closed" | "merged";

export type PullRequestRow = {
  number: number;
  owner: string;
  repo: string;
  title: string;
  state: PullRequestState;
  head_sha: string;
  first_seen_at: string;
  last_seen_at: string;
  latest_review: { verdict: string; reviewed_at: string } | null;
  failure_count: number;
};

export type PullRequestReview = {
  verdict: string;
  summary_md: string;
  model: string;
  provider: string;
  reviewed_at: string;
  head_sha: string;
};

/** One review-failure log row — the diagnostic payload this tab exists for. */
export type PullRequestFailure = { stage: string; error: string; created_at: string };

export type PullRequestFinding = {
  finding_id: string;
  severity: string;
  title: string;
  file_path: string;
  /** `null` on file-level findings with no line anchor. */
  line: number | null;
  body: string;
};

/** The PR detail payload's record totals — one number per record family. */
export type PullRequestCounts = { findings: number; reviews: number; failures: number };

/**
 * The PR detail payload (`GET …/pull-requests/:owner/:repo/:number`): the head
 * row plus its record totals. The families themselves are paged reads.
 */
export type PullRequestDetail = {
  pull_request: PullRequestRow;
  counts: PullRequestCounts;
};

/** The three record families, one paged read each. */
export type RecordSection = "findings" | "reviews" | "failures";

/** One record section's page: its rows plus the total the pager counts against. */
export type RecordPage<T> = { items: T[]; total: number };

/** Each section's row type — what `parseRecordPage` yields for that section. */
export type RecordPageItems = {
  findings: PullRequestFinding;
  reviews: PullRequestReview;
  failures: PullRequestFailure;
};

/**
 * The detail address: one App can be installed on several repos, so the
 * same number exists in more than one and owner/repo ride with it (the
 * number-only path was retired for exactly that ambiguity).
 */
export type PullRequestRef = { owner: string; repo: string; number: number };

/**
 * Per-row list parse (QC: one nullable row must not blank the list). The
 * nullable DISPLAY fields coerce to "" and an unknown state clamps to
 * "open"; only the address and timestamp fields stay required — a row
 * without them cannot be listed or fetched, so it is dropped individually
 * and the rest of the list still renders. The returned row always carries
 * non-null strings (the type is not weakened).
 */
function parsePullRequestRow(value: unknown): PullRequestRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.number !== "number" || !Number.isFinite(value.number)) return null;
  if (typeof value.owner !== "string" || typeof value.repo !== "string") return null;
  if (typeof value.first_seen_at !== "string" || typeof value.last_seen_at !== "string") return null;
  if (typeof value.failure_count !== "number") return null;
  return {
    number: value.number,
    owner: value.owner,
    repo: value.repo,
    title: typeof value.title === "string" ? value.title : "",
    state: value.state === "closed" || value.state === "merged" ? value.state : "open",
    head_sha: typeof value.head_sha === "string" ? value.head_sha : "",
    first_seen_at: value.first_seen_at,
    last_seen_at: value.last_seen_at,
    latest_review: parseLatestReview(value.latest_review),
    failure_count: value.failure_count,
  };
}

/** The row's latest-review slot: coerced to null unless it is a real review. */
function parseLatestReview(value: unknown): { verdict: string; reviewed_at: string } | null {
  if (!isRecord(value) || typeof value.reviewed_at !== "string") return null;
  return {
    verdict: typeof value.verdict === "string" ? value.verdict : "",
    reviewed_at: value.reviewed_at,
  };
}

/**
 * One review entry (QC: the pipeline persists `provider: null`, and
 * model/summary/verdict can be absent too). The nullable text fields
 * coerce to "" at this boundary so the view never renders null; the
 * entry is dropped only when its timestamp/head anchor is missing.
 */
function parsePullRequestReview(value: unknown): PullRequestReview | null {
  if (!isRecord(value)) return null;
  if (typeof value.reviewed_at !== "string" || typeof value.head_sha !== "string") return null;
  return {
    verdict: typeof value.verdict === "string" ? value.verdict : "",
    summary_md: typeof value.summary_md === "string" ? value.summary_md : "",
    model: typeof value.model === "string" ? value.model : "",
    provider: typeof value.provider === "string" ? value.provider : "",
    reviewed_at: value.reviewed_at,
    head_sha: value.head_sha,
  };
}

function parsePullRequestFailure(value: unknown): PullRequestFailure | null {
  if (!isRecord(value)) return null;
  if (
    typeof value.stage !== "string" ||
    typeof value.error !== "string" ||
    typeof value.created_at !== "string"
  ) {
    return null;
  }
  return { stage: value.stage, error: value.error, created_at: value.created_at };
}

/**
 * One finding entry (QC: repo-wide findings persist `file_path: null`).
 * title/file_path/body coerce to ""; the entry is dropped without its id
 * (the detail list keys by finding_id) or a malformed line anchor.
 */
function parsePullRequestFinding(value: unknown): PullRequestFinding | null {
  if (!isRecord(value)) return null;
  if (typeof value.finding_id !== "string") return null;
  if (typeof value.line !== "number" && value.line !== null) return null;
  return {
    finding_id: value.finding_id,
    severity: typeof value.severity === "string" ? value.severity : "",
    title: typeof value.title === "string" ? value.title : "",
    file_path: typeof value.file_path === "string" ? value.file_path : "",
    line: value.line,
    body: typeof value.body === "string" ? value.body : "",
  };
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

/** The list payload: `{ pull_requests: [...] }` — parsed per row, never all-or-nothing. */
export function parsePullRequestList(data: unknown): PullRequestRow[] | null {
  if (!isRecord(data) || !Array.isArray(data.pull_requests)) return null;
  return data.pull_requests.map(parsePullRequestRow).filter(present);
}

/**
 * The detail payload: the head row plus its record totals. The envelope is
 * strict — a missing row or a missing/non-finite count fails the whole parse,
 * because a silent zero would disable a tab's count.
 */
export function parsePullRequestDetail(data: unknown): PullRequestDetail | null {
  if (!isRecord(data)) return null;
  const pull_request = parsePullRequestRow(data.pull_request);
  if (pull_request === null) return null;
  const counts = parsePullRequestCounts(data.counts);
  if (counts === null) return null;
  return { pull_request, counts };
}

/** A count is required and finite; anything else fails the payload. */
function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePullRequestCounts(value: unknown): PullRequestCounts | null {
  if (!isRecord(value)) return null;
  const findings = finiteCount(value.findings);
  const reviews = finiteCount(value.reviews);
  const failures = finiteCount(value.failures);
  if (findings === null || reviews === null || failures === null) return null;
  return { findings, reviews, failures };
}

/** One row parser per section — the page parse below is keyed by it. */
const RECORD_PARSERS = {
  findings: parsePullRequestFinding,
  reviews: parsePullRequestReview,
  failures: parsePullRequestFailure,
} satisfies { [K in RecordSection]: (value: unknown) => RecordPageItems[K] | null };

/**
 * One record page: `{ items, total }`. The envelope is strict (a missing
 * `items` array or a non-finite `total` fails the page), but every row is
 * parsed per entry — one drifted record is dropped, not the whole page.
 */
export function parseRecordPage<S extends RecordSection>(
  section: S,
  data: unknown,
): RecordPage<RecordPageItems[S]> | null {
  if (!isRecord(data) || !Array.isArray(data.items)) return null;
  const total = finiteCount(data.total);
  if (total === null) return null;
  const parse = RECORD_PARSERS[section] as (value: unknown) => RecordPageItems[S] | null;
  return { items: data.items.map(parse).filter(present), total };
}

export function appPullRequestsUrl(base: string, appId: string): string {
  return `${base}/api/apps/${encodeURIComponent(appId)}/pull-requests`;
}

/**
 * The detail read URL, built from the ROW's owner/repo/number — never the
 * number alone. owner/repo are passed through `encodeURIComponent` so a
 * value carrying a segment boundary (`/`, `?`, `#`) cannot escape the
 * pull-requests path family, and {@link pullRequestRefOf} rejects `.`/`..`
 * segments before this builder runs, so a dot-segment can only reach the
 * API by normalising into a same-family 404 — never another route. The
 * `number` segment is validated decimal digits at the parse site.
 */
export function appPullRequestDetailUrl(base: string, appId: string, ref: PullRequestRef): string {
  return `${base}/api/apps/${encodeURIComponent(appId)}/pull-requests/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.number}`;
}

/**
 * One record section's page URL. `offset`/`limit` ride every request — the
 * server's bounds are the contract — and `severity` only when the findings
 * filter is set; the query is encoded, so a free-form value cannot break out
 * of it.
 */
export function appPullRequestRecordsUrl(
  base: string,
  appId: string,
  ref: PullRequestRef,
  section: RecordSection,
  page: { offset: number; limit: number; severity?: string },
): string {
  const params = new URLSearchParams({ offset: String(page.offset), limit: String(page.limit) });
  if (page.severity !== undefined && page.severity !== "") params.set("severity", page.severity);
  return `${appPullRequestDetailUrl(base, appId, ref)}/${section}?${params.toString()}`;
}

/**
 * The PR's own repository on GitHub, built from the ROW's owner/repo. Each
 * segment is passed through `encodeURIComponent`, so a hostile segment stays
 * inside the URL path — it cannot rewrite the host, the query or the fragment.
 */
export function githubRepoUrl(owner: string, repo: string): string {
  return `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

/** The PR on GitHub: the same repository address plus its `/pull/<number>`. */
export function githubPullRequestUrl(owner: string, repo: string, number: number): string {
  return `${githubRepoUrl(owner, repo)}/pull/${encodeURIComponent(String(number))}`;
}

/**
 * The PR state pill's copy + tone, derived once for the list and the
 * detail face. The state vocabulary is the API contract's closed set; the
 * face itself belongs to `StatusBadge` in `@design-system`.
 */
export function pullRequestStatePill(
  locale: Locale,
  state: PullRequestState,
): { label: string; tone: "accent" | "success" | "neutral" } {
  if (state === "merged") return { label: t(locale, "pullRequests.state.merged"), tone: "success" };
  if (state === "closed") return { label: t(locale, "pullRequests.state.closed"), tone: "neutral" };
  return { label: t(locale, "pullRequests.state.open"), tone: "accent" };
}

/**
 * The App detail page's tabs (应用设置 / 已安装 / 洞察 / Pull requests). The
 * last three are manager-only — they render from the manage payload.
 */
export type AppDetailTab = "settings" | "installations" | "insights" | "pull-requests";

/**
 * URL-derived detail state: the active tab, the insights filters, and the
 * open PR detail (`pr` = `owner/repo/number`).
 */
export type AppDetailSearch = { tab: AppDetailTab; window: InsightsWindow; repo: string; pr: string };

/** The `pr` search param shape: `owner/repo/number`, number = decimal digits. */
const PR_PARAM_PATTERN = /^[^/]+\/[^/]+\/\d+$/;

/**
 * The `pr` param string → a detail address, or null when the param is
 * absent or malformed (the tab then renders the list). `.`/`..` segments
 * are rejected outright — encoding cannot neutralise a dot-segment
 * (`encodeURIComponent("..")` is `".."`), so the boundary has to be here.
 */
export function pullRequestRefOf(pr: string): PullRequestRef | null {
  const [owner, repo, number] = pr.split("/");
  if (owner === undefined || repo === undefined || number === undefined) return null;
  if (!/^\d+$/.test(number) || owner === "" || repo === "") return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return { owner, repo, number: Number(number) };
}

/**
 * The search string as the detail page states it — the ONE derivation
 * shared by the mount initializer and the popstate re-sync (the
 * spa-url-state-resync contract), built on the pinned insights helpers
 * (off-set windows resolve to the default segment). The manager-gated tab
 * values (`installations`, `insights`, `pull-requests`) are honored only for
 * managers; a non-manager — or any other tab value — always resolves to the
 * settings tab. `pr` rides verbatim when it matches the `owner/repo/number`
 * shape.
 */
export function parseAppDetailSearch(search: string, canManage: boolean): AppDetailSearch {
  const insights = parseInsightsSearch(search);
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const rawTab = params.get("tab");
  // The bare path IS settings — the only legal non-settings values are the
  // three manager tabs, gated by the payload's can_manage.
  const tab: AppDetailTab =
    canManage && (rawTab === "installations" || rawTab === "insights" || rawTab === "pull-requests")
      ? rawTab
      : "settings";
  const window = (INSIGHTS_WINDOWS as readonly string[]).includes(insights.window)
    ? (insights.window as InsightsWindow)
    : "30";
  const rawPr = params.get("pr");
  const pr = rawPr !== null && PR_PARAM_PATTERN.test(rawPr) ? rawPr : "";
  return { tab, window, repo: insights.repo, pr };
}

/**
 * The query string for a detail state — the inverse of
 * {@link parseAppDetailSearch}: the tab param on every non-settings tab
 * (the bare path IS the settings tab), the window param only off the 30
 * default, the repo param only when set, the pr param only when a detail
 * is open. Loop-free by construction: consumers write it with replaceState
 * only.
 */
export function appDetailSearchQuery(search: AppDetailSearch): string {
  const params = new URLSearchParams();
  if (search.tab !== "settings") params.set("tab", search.tab);
  if (search.window !== "30") params.set("window", search.window);
  if (search.repo !== "") params.set("repo", search.repo);
  if (search.pr !== "") params.set("pr", search.pr);
  const query = params.toString();
  return query === "" ? "" : `?${query}`;
}

/** The role vocabulary of `workspace_members.role` (migration 0026 CHECK). */
function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "owner" || value === "admin" || value === "member";
}

/**
 * The `workspace` block of the member payload — every field is required, so a
 * rolled-back Worker (no summary) fails the parse instead of rendering a page
 * with invented limits. `memberLimit` is present in both modes and is `null`
 * for the unlimited tier (no cap), which is a real value, not a missing one.
 */
function parseWorkspaceSummary(data: unknown): WorkspaceSummary | null {
  if (!isRecord(data) || !isRecord(data.plan)) return null;
  const { plan } = data;
  if (typeof plan.id !== "string" || typeof plan.name !== "string") return null;
  if (
    (data.memberLimit !== null && typeof data.memberLimit !== "number") ||
    typeof data.reviewAttemptsThisMonth !== "number"
  ) {
    return null;
  }
  if (typeof data.pendingInvites !== "number") return null;
  return {
    plan: { id: plan.id, name: plan.name },
    memberLimit: data.memberLimit,
    reviewAttemptsThisMonth: data.reviewAttemptsThisMonth,
    pendingInvites: data.pendingInvites,
  };
}

/**
 * `GET /:ref/api/members` — the caller's own workspace role plus the member
 * list. A drifted row (unknown role) fails the parse instead of rendering a
 * role the server never grants.
 */
export function parseMembers(data: unknown): MembersPayload | null {
  if (!isRecord(data) || !isRecord(data.viewer) || !Array.isArray(data.members)) return null;
  const viewerRole = data.viewer.role;
  if (!isWorkspaceRole(viewerRole)) return null;
  const workspace = parseWorkspaceSummary(data.workspace);
  if (!workspace) return null;
  const members: MemberRow[] = [];
  for (const row of data.members) {
    if (!isRecord(row)) return null;
    if (typeof row.id !== "string" || typeof row.github_login !== "string" || typeof row.created_at !== "string") {
      return null;
    }
    if (!isWorkspaceRole(row.role)) return null;
    members.push({
      id: row.id,
      github_login: row.github_login,
      role: row.role,
      created_at: row.created_at,
    });
  }
  return { viewer: { role: viewerRole }, workspace, members };
}

/**
 * `GET /:ref/api/members/invites` — the live pending invites. An invite role is
 * `admin` or `member` only (`owner` is never invitable, migration 0028).
 */
export function parseInvites(data: unknown): InviteRow[] | null {
  if (!isRecord(data) || !Array.isArray(data.invites)) return null;
  const invites: InviteRow[] = [];
  for (const row of data.invites) {
    if (!isRecord(row)) return null;
    if (
      typeof row.id !== "string" ||
      typeof row.github_login !== "string" ||
      typeof row.created_at !== "string" ||
      typeof row.expires_at !== "string"
    ) {
      return null;
    }
    if (row.role !== "admin" && row.role !== "member") return null;
    invites.push({
      id: row.id,
      github_login: row.github_login,
      role: row.role,
      created_at: row.created_at,
      expires_at: row.expires_at,
    });
  }
  return invites;
}

/**
 * One active support grant — the members' undismissable notice row
 * (`GET /:ref/api/support/grants`): who, why, and until when. Nothing here is
 * actionable by the tenant: the server has no route that ends or edits a grant.
 */
export type SupportGrantRow = {
  operator_login: string;
  reason: string;
  expires_at: string;
};

/** `GET /:ref/api/support/grants` — the workspace's live grants. */
export function parseSupportGrants(data: unknown): SupportGrantRow[] | null {
  if (!isRecord(data) || !Array.isArray(data.grants)) return null;
  const grants: SupportGrantRow[] = [];
  for (const row of data.grants) {
    if (!isRecord(row)) return null;
    if (
      typeof row.operator_login !== "string" ||
      typeof row.reason !== "string" ||
      typeof row.expires_at !== "string"
    ) {
      return null;
    }
    grants.push({
      operator_login: row.operator_login,
      reason: row.reason,
      expires_at: row.expires_at,
    });
  }
  return grants;
}

/**
 * The granted operator's read-only view (`GET /:ref/api/support/workspace`) —
 * exactly the AC2 field set: the workspace's four identity fields, members as
 * login + role, and the active grants. A drifted payload fails the parse rather
 * than rendering a field the server never grants.
 */
export type SupportWorkspaceView = {
  workspace: { id: string; name: string; slug: string; created_at: string };
  members: Array<{ github_login: string; role: WorkspaceRole }>;
  grants: SupportGrantRow[];
};

export function parseSupportView(data: unknown): SupportWorkspaceView | null {
  if (!isRecord(data) || !isRecord(data.workspace) || !Array.isArray(data.members)) return null;
  const workspace = data.workspace;
  if (
    typeof workspace.id !== "string" ||
    typeof workspace.name !== "string" ||
    typeof workspace.slug !== "string" ||
    typeof workspace.created_at !== "string"
  ) {
    return null;
  }
  const members: SupportWorkspaceView["members"] = [];
  for (const row of data.members) {
    if (!isRecord(row) || typeof row.github_login !== "string" || !isWorkspaceRole(row.role)) return null;
    members.push({ github_login: row.github_login, role: row.role });
  }
  const grants = parseSupportGrants({ grants: data.grants });
  if (grants === null) return null;
  return {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      created_at: workspace.created_at,
    },
    members,
    grants,
  };
}

export function parseApps(data: unknown): AppsPayload | null {
  if (!isRecord(data) || !isRecord(data.viewer) || !Array.isArray(data.apps)) return null;
  const login = data.viewer.login;
  const role = data.viewer.role;
  if (typeof login !== "string" || (role !== "admin" && role !== "member")) return null;
  return data as AppsPayload;
}

/**
 * `POST /api/workspaces` 201 body — the new workspace's ref plus the Apps page
 * the creator lands on. The landing is server-chosen: only the Worker knows the
 * deployment's tenant read mode, and `strict`'s sole-workspace resolver cannot
 * name a workspace once a second one exists.
 */
export function parseCreatedWorkspace(data: string): { id: string; appsPath: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.appsPath !== "string") {
    return null;
  }
  return { id: parsed.id, appsPath: parsed.appsPath };
}

/**
 * Row-level guard for the configured list: every row must carry the
 * `kind` discriminator, so a catalog-shaped entry (no `kind`) can never be
 * parsed as configured state. A key row also carries its pool identity plus
 * the per-key verification columns — without the identity the row could be
 * neither deleted nor re-verified.
 */
function isConfiguredProviderList(value: unknown): value is ConfiguredProvider[] {
  return (
    Array.isArray(value) &&
    value.every((row) => {
      if (!isRecord(row)) return false;
      if (row.kind === "key") {
        return (
          typeof row.provider === "string" &&
          typeof row.key_id === "string" &&
          typeof row.last4 === "string" &&
          isNullableString(row.updated_at) &&
          isNullableString(row.verified_at) &&
          isKeyVerifiedStatus(row.verified_status)
        );
      }
      if (row.kind === "custom") {
        return (
          typeof row.provider_id === "string" &&
          typeof row.base_url === "string" &&
          typeof row.api === "string" &&
          isStringArray(row.model_ids)
        );
      }
      return false;
    })
  );
}

/** The verification vocabulary is closed — an off-vocabulary value fails the parse. */
function isKeyVerifiedStatus(value: unknown): value is KeyVerifiedStatus {
  return value === null || value === "ok" || value === "reachable" || value === "failed";
}

/**
 * Row-level guard for the `keys` face the add flow renders per provider:
 * a drifted row (no pool identity, no masked tail, an off-vocabulary status)
 * fails the parse instead of rendering a row nothing can address.
 */
function isProviderKeyRowList(value: unknown): value is ProviderKeyRow[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        isRecord(row) &&
        typeof row.provider === "string" &&
        typeof row.keyId === "string" &&
        typeof row.last4 === "string" &&
        isNullableString(row.updatedAt) &&
        isNullableString(row.verifiedAt) &&
        isKeyVerifiedStatus(row.verifiedStatus),
    )
  );
}

/**
 * Row-level guard for the catalog: tier + eligibility are the
 * load-bearing discriminators, and the Add Provider UI renders/branches on
 * `models` / `verifiable` / `base_url` / `api`, so a drifted row missing any
 * of them fails the parse instead of breaking the page. Review handoff S2:
 * `display_group` is word-checked too — the picker groups on
 * it, so a row without the stamp (or with a stray value) must fail the
 * parse rather than silently drop out of both groups.
 */
function isCatalogProviderList(value: unknown): value is CatalogProvider[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        isRecord(row) &&
        typeof row.id === "string" &&
        typeof row.label === "string" &&
        (row.tier === "builtin" || row.tier === "template") &&
        (row.eligibility === "builtin" ||
          row.eligibility === "template" ||
          row.eligibility === "unavailable") &&
        (row.display_group === "common" || row.display_group === "catalog") &&
        (row.base_url === null || typeof row.base_url === "string") &&
        (row.api === null || typeof row.api === "string") &&
        typeof row.verifiable === "boolean" &&
        isStringArray(row.models),
    )
  );
}

/**
 * Which configuration form a selected Add Provider entry requires:
 * `key` = verifiable builtin (verify-first `/keys/verify`), `template` =
 * custom-provider materialization (`op=add-template-provider`), `console` =
 * console-only provider with no in-app verify path.
 */
export type ProviderFormKind = "key" | "template" | "console";

/** Resolves the Add Provider selection to its catalog entry (null = nothing picked / unknown id). */
export function selectedCatalogProvider(
  catalog: readonly CatalogProvider[],
  selectedId: string | null | undefined,
): CatalogProvider | null {
  if (typeof selectedId !== "string" || selectedId === "") return null;
  return catalog.find((provider) => provider.id === selectedId) ?? null;
}

/** The selected entry's configuration requirements — the form the add flow transitions to. */
export function providerFormKind(provider: CatalogProvider): ProviderFormKind {
  if (provider.tier === "template") return "template";
  if (!provider.verifiable) return "console";
  return "key";
}

/** `string | null` presence check — the cached GitHub profile columns are nullable (NULL = never synced). */
function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function parseSettings(data: unknown): SettingsPayload | null {
  if (!isRecord(data) || !isRecord(data.app)) return null;
  if (typeof data.can_manage !== "boolean") return null;
  // The delivery URL's workspace segment: the server-resolved id, required on
  // both faces (a path ref may be a slug and must never be printed).
  if (typeof data.workspace_id !== "string" || data.workspace_id.length === 0) return null;
  if (typeof data.app.status !== "string") return null;
  if (typeof data.app.review_enabled !== "boolean") return null;
  if (typeof data.app.created_by !== "string" || typeof data.app.github_app_id !== "number") return null;
  // The local App UID rides BOTH faces; the cached GitHub slug is a nullable
  // GitHub fact (NULL = never synced).
  if (typeof data.app.id !== "string") return null;
  if (!isNullableString(data.app.github_slug)) return null;
  if (!data.can_manage) {
    // Identity-only non-manager face (App detail IA): the D4
    // identity set — created_at joins the required keys; everything from
    // the ops stores (installations/deliveries/sandbox image/trigger mode)
    // is NOT part of this face and is not required. The cached GitHub
    // profile is required presence, nullable per field (NULL = never
    // synced) — the identity face has nothing else to render.
    if (typeof data.app.created_at !== "string") return null;
    if (
      !isNullableString(data.app.github_name) ||
      !isNullableString(data.app.github_description) ||
      !isNullableString(data.app.github_html_url) ||
      !isNullableString(data.app.github_avatar_url) ||
      !isNullableString(data.app.github_metadata_synced_at)
    ) {
      return null;
    }
    return data as SettingsPayload;
  }
  // The selected runtime-image id rides the MANAGER face (registry id
  // only — never image-local configuration or secrets).
  if (typeof data.app.sandbox_image_id !== "string") return null;
  // The trigger mode too — the mode control's current value; an
  // off-vocabulary value (DB CHECK makes it impossible from a correct
  // worker) fails the parse instead of rendering a dead selection.
  if (!isReviewTriggerMode(data.app.review_trigger_mode)) return null;
  if (!Array.isArray(data.installations) || !Array.isArray(data.deliveries)) return null;
  if (!isProviderKeyRowList(data.keys)) return null;
  if (!Array.isArray(data.model_role_ids) || !isStringArray(data.model_role_ids)) return null;
  if (!Array.isArray(data.custom_provider_api_ids) || !isStringArray(data.custom_provider_api_ids)) return null;
  if (!Array.isArray(data.model_chains)) return null;
  // Clean cutover: the primary list is configured state and the
  // catalog is discovery-only — BOTH are required and row-validated, so the
  // old `providers` dump (or catalog rows masquerading as configured state)
  // fails the parse instead of silently passing.
  if (!isConfiguredProviderList(data.configured_providers)) return null;
  if (!isCatalogProviderList(data.provider_catalog)) return null;
  // The manage face: the selector choices — { id, enabled } rows only.
  if (!isSandboxImageList(data.sandbox_images)) return null;
  return data as SettingsPayload;
}

function isSandboxImageList(value: unknown): value is Array<{ id: string; enabled: boolean }> {
  return (
    Array.isArray(value) &&
    value.every((row) => isRecord(row) && typeof row.id === "string" && typeof row.enabled === "boolean")
  );
}

export function parseModels(data: unknown): ModelsPayload | null {
  if (!isRecord(data) || !Array.isArray(data.groups)) return null;
  const groups: ModelOptionGroup[] = [];
  for (const group of data.groups) {
    if (!isRecord(group) || typeof group.provider !== "string") return null;
    if (group.source !== "verified" && group.source !== "probe" && group.source !== "custom") return null;
    if (!isStringArray(group.selectors)) return null;
    groups.push({ provider: group.provider, source: group.source, selectors: group.selectors });
  }
  return { groups };
}

/** The workspace concurrency face: the stored cap plus the ceiling and range it must respect. */
export type ConcurrencySettings = {
  concurrency: number;
  system: number;
  min: number;
  max: number;
  /** The stored cap could not be read: both numbers above are the conservative fallback. */
  degraded: boolean;
};

export function parseConcurrencySettings(data: unknown): ConcurrencySettings | null {
  if (!isRecord(data)) return null;
  const { concurrency, system, min, max, degraded } = data;
  if (typeof concurrency !== "number" || typeof system !== "number") return null;
  if (typeof min !== "number" || typeof max !== "number") return null;
  if (typeof degraded !== "boolean") return null;
  return { concurrency, system, min, max, degraded };
}

/**
 * A write's answer: the value the server actually stored, or null on a body
 * that is not JSON or carries no number. The parse is guarded here — a 2xx
 * whose body is not JSON is still a landed write (the status said so), and
 * letting `JSON.parse` throw would report that save as a failure.
 */
export function parseStoredConcurrency(body: string): number | null {
  try {
    const data: unknown = JSON.parse(body);
    return isRecord(data) && typeof data.concurrency === "number" ? data.concurrency : null;
  } catch {
    return null;
  }
}

export function splitModelChain(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0);
}

/** Same GitHub login grammar the invite route enforces. */
export const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9-]{1,39}$/;

export function inviteLoginNoticeKey(login: string): "notice.error.enterLogin" | "notice.error.invalidLogin" | null {
  const trimmed = login.trim();
  if (trimmed.length === 0) return "notice.error.enterLogin";
  if (!GITHUB_LOGIN_PATTERN.test(trimmed)) return "notice.error.invalidLogin";
  return null;
}

/**
 * Which localized copy a creation POST's 409 refusal reads as. The route
 * answers two named bodies in English only (`FREE_SLOT_REFUSAL` /
 * `WORKSPACE_CREATION_CLOSED_REFUSAL`), and the shell already states those two
 * rules for the disabled menu row — so the same rule keeps one wording in both
 * locales instead of a second English paragraph on a zh-CN page. `null` = an
 * unrecognised refusal: the caller renders the server's own words.
 */
export function createWorkspaceRefusalKey(status: number, body: string): DictionaryKey | null {
  if (status !== 409) return null;
  if (body === FREE_SLOT_REFUSAL) return "nav.newWorkspaceBlockedFreeSlot";
  if (body === WORKSPACE_CREATION_CLOSED_REFUSAL) return "nav.newWorkspaceBlockedFlag";
  return null;
}

