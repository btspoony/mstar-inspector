/**
 * Pure parsers/guards for resident SPA pages (plan 29 T4).
 * Tested without a DOM runner.
 */

export type Role = "admin" | "member";

export type InsightsSearch = { window: string; repo: string };

export type InsightsSummary = {
  window_days: number;
  repo?: string;
  reviews_total: number;
  findings_by_severity: Array<{ severity: string; count: number }>;
  findings_by_category: Array<{ category: string | null; count: number }>;
  verdict_distribution: Array<{ verdict: string; count: number }>;
  weekly_trend: Array<{ week_start: string; reviews: number; findings: number }>;
  recurring_top: Array<{ fingerprint: string; title_sample: string; count: number; repos: string[] }>;
  /**
   * Window-scoped distinct owner/repo values (plan 36 T2). Independent of
   * `repo`. Absent on payloads that did not request `include=repos` (plan
   * 36 QC F-001) — consumers default to [].
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

export type MemberRow = {
  id: string;
  github_login: string;
  role: Role;
  created_at: string;
};

export type AppsPayload = {
  viewer: { login: string; role: Role };
  apps: Array<{
    slug: string;
    github_app_id: number;
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
 * Plan 38 (spec § Provider configuration contract): whether a catalog entry
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
  /** Usability vs the App's selected runtime image (plan 38). */
  eligibility: ProviderEligibility;
};

/**
 * One row of the App's PERSISTED provider state (plan 38): a stored builtin
 * key (masked tail only) or a saved custom-provider declaration. The `kind`
 * discriminator keeps this shape disjoint from {@link CatalogProvider} — a
 * catalog entry (id/label/tier/models, no `kind`) can never be mistaken for
 * configured state, and no plaintext key ever appears here.
 */
export type ConfiguredProvider =
  | { kind: "key"; provider: string; last4: string; updated_at: string | null }
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
 * One peer tab of the chain tab model (plan 39): Default and every named
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
 * The plan-39 chain tab list: the Default tab is ALWAYS synthesized first —
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
 * Seat select value (plan 39 T2), derived from the same tab model: an absent
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

type SettingsAppMeta = {
  slug: string;
  github_app_id: number;
  status: string;
  review_enabled: boolean;
  created_by: string;
  last_webhook_at: string | null;
  /** The App's selected sandbox runtime image (registry id — plan 37). */
  sandbox_image_id: string;
};

type SettingsHealth = {
  installations: Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
  deliveries: Array<{
    event_name: string | null;
    outcome: string;
    status_code: number | null;
    created_at: string;
  }>;
  delivery_summary?: {
    latest: { event_name: string | null; outcome: string; status_code: number | null; created_at: string } | null;
    rejected24h: number;
  };
};

/** Plan 35 T4 (spec §2): every member gets base+health only. */
export type SettingsReadOnlyPayload = { can_manage: false; app: SettingsAppMeta } & SettingsHealth;

/** Creator-or-admin adds the settings zones: keys, chains, providers. */
export type SettingsManagePayload = {
  can_manage: true;
  app: SettingsAppMeta;
  keys: Array<{ provider: string; last4: string; updated_at: string | null }>;
  model_chain: string | null;
  model_roles: Record<string, string>;
  model_chains: ModelChainEntry[];
  custom_providers: Array<{ provider_id: string; base_url: string; api: string; model_ids: string[] }>;
  /** Plan 38: the App's persisted provider state ONLY — empty is the valid unconfigured case. */
  configured_providers: ConfiguredProvider[];
  /** Plan 38: discovery metadata + eligibility — never configured state. */
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

export function canViewMembers(role: Role | null): boolean {
  return role === "admin";
}

export function canManageApp(viewer: { login: string; role: Role }, app: { created_by: string }): boolean {
  return viewer.role === "admin" || app.created_by.toLowerCase() === viewer.login.toLowerCase();
}

export function isPaused(app: { status: string; review_enabled: number }): boolean {
  return app.status === "active" && app.review_enabled === 0;
}

export function parseInsightsSearch(search: string): InsightsSearch {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  return { window: params.get("window") ?? "30", repo: params.get("repo") ?? "" };
}

export function insightsSummaryUrl(search: InsightsSearch, includeRepos = false): string {
  const params = new URLSearchParams();
  if (search.window !== "" && search.window !== "30") params.set("window", search.window);
  if (search.repo !== "") params.set("repo", search.repo);
  // Opt-in repos aggregation (plan 36 QC F-001): only the records page
  // requests it, so default summary reads never pay the DISTINCT scan+sort.
  if (includeRepos) params.set("include", "repos");
  const query = params.toString();
  return query === "" ? "/dashboard/api/insights/summary" : `/dashboard/api/insights/summary?${query}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseInsights(data: unknown): InsightsSummary | null {
  if (!isRecord(data) || typeof data.window_days !== "number" || typeof data.reviews_total !== "number") return null;
  if (!Array.isArray(data.findings_by_severity) || !Array.isArray(data.findings_by_category)) return null;
  if (!Array.isArray(data.verdict_distribution) || !Array.isArray(data.weekly_trend) || !Array.isArray(data.recurring_top)) {
    return null;
  }
  // `repos` is opt-in (plan 36 QC F-001): absent on payloads that did not
  // request include=repos (and on rolled-back Workers) — tolerate missing,
  // reject malformed.
  if (data.repos !== undefined && !isStringArray(data.repos)) return null;
  return data as InsightsSummary;
}

/**
 * Segmented window options (days) for the insights window ToggleGroup — a
 * legal subset of the API window domain (`^\d+$`, store clamp ≤90), zero API
 * extension. (Lives here since plan 40 retired the home module; the names
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
 * off-set value is normalized (plan 36 QC F-002), so the address bar
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
 * the URL so it reflects the applied filter (plan 36 QC F-002).
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

/** The records-page URL for an insights filter (default window/repo omitted). */
export function searchHref(pathname: "/dashboard/insights", search: InsightsSearch): string {
  const params = new URLSearchParams();
  if (search.window !== "" && search.window !== "30") params.set("window", search.window);
  if (search.repo !== "") params.set("repo", search.repo);
  const query = params.toString();
  return query === "" ? pathname : `${pathname}?${query}`;
}

/** One-line verdict distribution for the summary card. */
export function verdictLine(data: InsightsSummary): string {
  return data.verdict_distribution.map((row) => `${row.verdict} ${row.count}`).join(" · ");
}

export function parseMembers(data: unknown): MemberRow[] | null {
  if (!isRecord(data) || !Array.isArray(data.members)) return null;
  const members: MemberRow[] = [];
  for (const row of data.members) {
    if (!isRecord(row)) return null;
    if (typeof row.id !== "string" || typeof row.github_login !== "string" || typeof row.created_at !== "string") {
      return null;
    }
    if (row.role !== "admin" && row.role !== "member") return null;
    members.push({
      id: row.id,
      github_login: row.github_login,
      role: row.role,
      created_at: row.created_at,
    });
  }
  return members;
}

export function parseApps(data: unknown): AppsPayload | null {
  if (!isRecord(data) || !isRecord(data.viewer) || !Array.isArray(data.apps)) return null;
  const login = data.viewer.login;
  const role = data.viewer.role;
  if (typeof login !== "string" || (role !== "admin" && role !== "member")) return null;
  return data as AppsPayload;
}

/**
 * Row-level guard for the plan-38 configured list: every row must carry the
 * `kind` discriminator, so a catalog-shaped entry (no `kind`) can never be
 * parsed as configured state.
 */
function isConfiguredProviderList(value: unknown): value is ConfiguredProvider[] {
  return (
    Array.isArray(value) &&
    value.every((row) => {
      if (!isRecord(row)) return false;
      if (row.kind === "key") {
        return (
          typeof row.provider === "string" &&
          typeof row.last4 === "string" &&
          (row.updated_at === null || typeof row.updated_at === "string")
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

/**
 * Row-level guard for the plan-38 catalog: tier + eligibility are the
 * load-bearing discriminators, and the Add Provider UI renders/branches on
 * `models` / `verifiable` / `base_url` / `api`, so a drifted row missing any
 * of them fails the parse instead of breaking the page.
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
        (row.base_url === null || typeof row.base_url === "string") &&
        (row.api === null || typeof row.api === "string") &&
        typeof row.verifiable === "boolean" &&
        isStringArray(row.models),
    )
  );
}

/**
 * Which configuration form a selected Add Provider entry requires (plan 38):
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

export function parseSettings(data: unknown): SettingsPayload | null {
  if (!isRecord(data) || !isRecord(data.app)) return null;
  if (typeof data.can_manage !== "boolean") return null;
  if (typeof data.app.slug !== "string" || typeof data.app.status !== "string") return null;
  if (typeof data.app.review_enabled !== "boolean") return null;
  if (typeof data.app.created_by !== "string" || typeof data.app.github_app_id !== "number") return null;
  // Plan 37: the selected runtime-image id rides BOTH faces (registry id
  // only — never image-local configuration or secrets).
  if (typeof data.app.sandbox_image_id !== "string") return null;
  if (!Array.isArray(data.installations) || !Array.isArray(data.deliveries)) return null;
  if (!data.can_manage) return data as SettingsPayload;
  if (!Array.isArray(data.keys)) return null;
  if (!Array.isArray(data.model_role_ids) || !isStringArray(data.model_role_ids)) return null;
  if (!Array.isArray(data.custom_provider_api_ids) || !isStringArray(data.custom_provider_api_ids)) return null;
  if (!Array.isArray(data.model_chains)) return null;
  // Plan 38 clean cutover: the primary list is configured state and the
  // catalog is discovery-only — BOTH are required and row-validated, so the
  // old `providers` dump (or catalog rows masquerading as configured state)
  // fails the parse instead of silently passing.
  if (!isConfiguredProviderList(data.configured_providers)) return null;
  if (!isCatalogProviderList(data.provider_catalog)) return null;
  // Plan 37 manage face: the selector choices — { id, enabled } rows only.
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
