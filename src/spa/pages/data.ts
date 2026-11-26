
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
  memberLimit: number | null;
  reviewAttemptsThisMonth: number;
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
 * the fixed merge-class set {must-fix, should-fix, may-fix, nit} — identical
 * key set on every bucket, so the SPA's series vocabulary is stable per
 * window.
 */
export type FindingsDistributionBucket = {
  bucket_start: string;
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
  daily_trend: Array<{ day_start: string; reviews: number; findings: number }>;
  findings_distribution: FindingsDistributionBucket[];
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
    owned?: boolean;
    installed?: boolean;
    /** F1: the App's month state from its MOUNTED CHAIN; `null` = no chain,
     * which renders the dash rather than a fabricated number. */
    month?: { used_rp: number; owned: boolean; multiplier: number } | null;
    /** The workspace's own live installations of this App (D43). */
    installations?: Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
    /** The App's ordered chain in this workspace — read-only in this release. */
    chain?: AppChainEntry[];
    bot_id?: string;
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
  shared_bots?: SharedBotRow[];
  /** F9: shared GitHub Apps for the marketplace chooser (`scope = 'shared'`). */
  shared_apps?: SharedAppCard[];
  pending_installations?: PendingBindRow[];
  /** F10: absent = unknown (error face), `null` = known unlimited. */
  month_plan_rp?: number | null;
  quota_error?: boolean;
};

/** One unbound physical installation of an App the workspace may install through. */
export type PendingBindRow = {
  installation_id: number;
  account_login: string | null;
  seen_at: string;
  app_id: string;
  app_github_app_id: number;
  app_name: string;
};

function isPendingBindRow(value: unknown): value is PendingBindRow {
  return (
    isRecord(value) &&
    typeof value.installation_id === "number" &&
    Number.isSafeInteger(value.installation_id) &&
    typeof value.app_id === "string" &&
    typeof value.app_github_app_id === "number" &&
    typeof value.app_name === "string" &&
    isNullableString(value.account_login) &&
    typeof value.seen_at === "string"
  );
}

/** One row of the "Bots I can use" read (D6): the bot plus the caller's month. */
export type UsableBotRow = {
  id: string;
  name: string;
  description: string | null;
  workspace_id: string;
  workspace_name: string;
  owned: boolean;
  /** This caller may change the bot's configuration — ownership AND role. */
  can_manage: boolean;
  scope: BotScope;
  multiplier: number;
  month_used_rp: number;
};

export type UsableBotsPayload = {
  workspace_id: string;
  /** `null` is a KNOWN unlimited plan; a failed read is `quota_error`. */
  plan_monthly_rp: number | null;
  /** F10: the ceiling could not be resolved — render an error, never
   * "no ceiling". */
  quota_error?: boolean;
  bots: UsableBotRow[];
};

function isUsableBotRow(value: unknown): value is UsableBotRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.name === "string" &&
    isNullableString(value.description) &&
    typeof value.workspace_id === "string" &&
    typeof value.workspace_name === "string" &&
    typeof value.owned === "boolean" &&
    typeof value.can_manage === "boolean" &&
    isBotScope(value.scope) &&
    typeof value.multiplier === "number" &&
    typeof value.month_used_rp === "number"
  );
}

export function parseUsableBots(data: unknown): UsableBotsPayload | null {
  if (!isRecord(data)) return null;
  if (typeof data.workspace_id !== "string") return null;
  if (data.quota_error !== undefined && typeof data.quota_error !== "boolean") return null;
  if (data.plan_monthly_rp !== undefined && data.plan_monthly_rp !== null && typeof data.plan_monthly_rp !== "number") {
    return null;
  }
  if (!Array.isArray(data.bots)) return null;
  const bots: UsableBotRow[] = [];
  for (const row of data.bots) {
    if (!isUsableBotRow(row)) return null;
    bots.push(row);
  }
  return {
    workspace_id: data.workspace_id,
    plan_monthly_rp: data.plan_monthly_rp ?? null,
    ...(data.quota_error === true ? { quota_error: true } : {}),
    bots,
  };
}

/** One `shared` bot the workspace may create a target on. */
export type SharedBotRow = {
  id: string;
  github_slug: string | null;
  name: string;
  github_description?: string | null;
  owner_workspace_name?: string | null;
  capability?: string | null;
  target_count: number;
};

/** F9: one shared App card — the marketplace chooser's unit. */
export type SharedAppCard = {
  id: string;
  github_slug: string | null;
  name: string;
  github_description: string | null;
  owner_workspace_id: string | null;
  owner_workspace_name: string | null;
  capability: string | null;
  target_count: number;
};

function isSharedAppCard(value: unknown): value is SharedAppCard {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    (value.github_slug === null || typeof value.github_slug === "string") &&
    typeof value.name === "string" &&
    (value.github_description === null || typeof value.github_description === "string") &&
    (value.owner_workspace_id === null || typeof value.owner_workspace_id === "string") &&
    (value.owner_workspace_name === null || typeof value.owner_workspace_name === "string") &&
    (value.capability === null || typeof value.capability === "string") &&
    typeof value.target_count === "number"
  );
}

function isSharedBotRow(value: unknown): value is SharedBotRow {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id !== "" &&
    (value.github_slug === null || typeof value.github_slug === "string") &&
    typeof value.name === "string" &&
    typeof value.target_count === "number" &&
    (value.github_description === undefined || value.github_description === null || typeof value.github_description === "string") &&
    (value.owner_workspace_name === undefined || value.owner_workspace_name === null || typeof value.owner_workspace_name === "string") &&
    (value.capability === undefined || value.capability === null || typeof value.capability === "string")
  );
}

/**
 * The chooser's shared-bot list, all-or-nothing: one row that does not carry
 * a usable id would offer a bot the create route answers `404` for, so a
 * partially readable list is no list. A missing or non-array block is the
 * empty list — official mode is then unavailable and the manifest flow stays
 * usable.
 */
export function parseSharedBots(value: unknown): SharedBotRow[] {
  if (!Array.isArray(value)) return [];
  const rows = value.filter(isSharedBotRow);
  return rows.length === value.length ? rows : [];
}

/**
 * (spec § Provider configuration contract): whether a catalog entry
 * is usable by the App's SELECTED sandbox runtime image — `builtin` consumes
 * it via env names, `template` needs custom-provider materialization,
 * `unavailable` cannot run on that image at all. Judged server-side against
 * `app.sandbox_image_id`, never inferred client-side.
 */
export type ProviderEligibility = "builtin" | "template" | "unavailable";

/** One model's catalog-supplied sizes, in tokens. */
export type CatalogModelLimit = { contextWindow: number; maxTokens: number };

/** One selectable protocol of a mixed-protocol catalog row (server `protocols`). */
export type CatalogProtocolOption = {
  api: string;
  base_url: string | null;
  models: string[];
};

export type CatalogProvider = {
  id: string;
  label: string;
  tier: "builtin" | "template";
  base_url: string | null;
  api: string | null;
  models: string[];
  model_limits?: Record<string, CatalogModelLimit>;
  verifiable: boolean;
  usage_probe: boolean;
  eligibility: ProviderEligibility;
  display_group: "common" | "catalog";
  protocols?: CatalogProtocolOption[];
};

/** The row's vocabulary for the protocol a declaration materialized: the
 *  matching option's list, else the row's own (the default protocol's). */
export function modelsForProtocol(
  provider: CatalogProvider | undefined,
  api: string | null | undefined,
): readonly string[] {
  if (provider === undefined) return [];
  const option =
    api === null || api === undefined
      ? undefined
      : provider.protocols?.find((candidate) => candidate.api === api);
  return option?.models ?? provider.models;
}

/**
 * The store-enforced verification vocabulary (mirrors
 * `bot_provider_keys.verified_status`): `ok` = the probe proved the KEY,
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
  keyId: string;
  last4: string;
  updatedAt: string | null;
  verifiedAt: string | null;
  verifiedStatus: KeyVerifiedStatus;
};

/**
 * What the App owner stated about ONE declared model. An absent field is
 * genuinely unstated — never zero and never a guess — so the form renders it
 * blank and the synthesis writes no line for it.
 */
export type CustomProviderModelMeta = {
  contextWindow?: number;
  maxTokens?: number;
  name?: string;
  reasoning?: boolean;
  input?: string[];
};

/** The per-model overlay of one declaration, keyed by a declared model id. */
export type CustomProviderModelsMeta = Record<string, CustomProviderModelMeta>;

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
 * store's primary key `(bot_id, provider, key_id)` and the POST body carry.
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
  id: string;
  isDefault: boolean;
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
 * Per-App review levels (migration 0047) — the `review_targets.review_level`
 * closed vocabulary. Mirrors packages/shared/src/runtime `REVIEW_LEVELS`
 * across the bundle boundary (the REVIEW_TRIGGER_MODES convention: documented,
 * deliberately not imported). Values are wire-verbatim; only labels localize.
 * `null`/absent is not a member — it is "no App choice" (follow the operator
 * default).
 */
export const REVIEW_LEVELS = ["quick", "default", "deep"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

export function isReviewLevel(value: unknown): value is ReviewLevel {
  return (REVIEW_LEVELS as readonly string[]).includes(value as string);
}

/**
 * The D4 identity set — the fields the GET /api/apps list rows expose
 * (github_app_id, status, review_enabled, created_by) plus created_at and
 * the cached public GitHub profile. This is the NON-MANAGER detail face's
 * whole app shape: everything from the ops stores (installations, the delivery
 * log, sandbox_image_id, review-trigger runtime config) stays behind the
 * manager face (the server keys the split on `can_manage`).
 */
/**
 * One row of an App's ordered chain in this workspace (F7): the App's only
 * App→bot relation. `position` is the stored order, `month_used_rp` this
 * workspace's spend through that bot this month, and `owned` says whether this
 * workspace provides it (a shared bot reads false).
 */
export type AppChainEntry = {
  position: number;
  bot_id: string;
  name: string;
  description: string | null;
  provider_workspace: string;
  owned: boolean;
  /** False when the bot's owner stopped sharing it: mounted, but skipped. */
  available: boolean;
  multiplier: number;
  month_used_rp: number;
  /** The bot's own monthly cap; `null` = no cap of its own. */
  monthly_rp: number | null;
};

/**
 * The install-state slice every App face carries: the workspace's own live
 * installations of this App and its ordered chain. `pending_installations` is
 * what tells "the chain appears once an installation is bound" from "nothing is
 * mounted": it holds only UNBOUND installations of a SHARED App — an owned App
 * never binds (D47), so it carries none.
 */
export type AppChain = {
  chain?: AppChainEntry[];
  installations?: Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
  pending_installations?: PendingInstallation[];
};

function isAppChainEntry(value: unknown): value is AppChainEntry {
  return (
    isRecord(value) &&
    typeof value.position === "number" &&
    Number.isSafeInteger(value.position) &&
    typeof value.bot_id === "string" &&
    typeof value.name === "string" &&
    (value.description === null || typeof value.description === "string") &&
    typeof value.provider_workspace === "string" &&
    typeof value.owned === "boolean" &&
    typeof value.available === "boolean" &&
    typeof value.multiplier === "number" &&
    typeof value.month_used_rp === "number" &&
    (value.monthly_rp === null || typeof value.monthly_rp === "number")
  );
}

export type SettingsIdentityAppMeta = {
  github_app_id: number | null;
  status: string | null;
  review_enabled?: boolean;
  created_by: string | null;
  created_at: string;
  id: string;
  github_name: string | null;
  github_slug: string | null;
  github_description: string | null;
  github_html_url: string | null;
  github_avatar_url: string | null;
  github_metadata_synced_at?: string | null;
};

/**
 * The fields the identity card reads. Every face carries them; a Blocked face
 * omits the bot's metadata stamp, so the field is optional at the type level
 * and required-when-readable in `parseSettings`.
 */
export type AppIdentityCardApp = {
  github_app_id: number | null;
  id: string;
  github_name: string | null;
  github_description: string | null;
  github_html_url: string | null;
  github_avatar_url: string | null;
  github_metadata_synced_at?: string | null;
};

/**
 * Cached GitHub App visibility (migration 0045): the anonymous
 * `GET /apps/{slug}` probe's last answer. `unknown` = never probed or the
 * probe could not answer — treated as "cannot prove private".
 */
export type GithubVisibility = "public" | "private" | "unknown";

/**
 * The review gate's verdict vocabulary, mirroring the engine `PR_VERDICTS`
 * tuple the server validates against (`@mstar-harness/engine` is Node-only,
 * so the browser bundle cannot import it). Keep the two in step.
 */
export const PR_VERDICTS = ["ship it", "needs fixes", "blocked", "incomplete"] as const;

/**
 * The per-App review gate (migration 0045): the Check concludes `success`
 * only when the published verdict is one of `pass_verdicts` AND the tally
 * score is at least `min_score`. `pass_verdicts` is the engine `PR_VERDICTS`
 * vocabulary — the server validates it before any write.
 */
export type CheckGateSettings = {
  min_score: number;
  pass_verdicts: string[];
};

/**
 * A bot's scope (migration 0058) — the `review_bots.scope` closed vocabulary,
 * mirrored across the bundle boundary (the REVIEW_TRIGGER_MODES convention:
 * documented, deliberately not imported). `owned` serves its own workspace
 * only; `shared` is offered platform-wide and resolves nothing until an
 * installation is bound to a target.
 */
export const BOT_SCOPES = ["owned", "shared"] as const;
export type BotScope = (typeof BOT_SCOPES)[number];

export function isBotScope(value: unknown): value is BotScope {
  return (BOT_SCOPES as readonly string[]).includes(value as string);
}

/**
 * The target's bound installation on the MANAGER face; `null` = unbound.
 * `removed` is the `bot_installations.removed_at` stamp: the binding survives
 * an uninstall and reviews stop until the installation comes back.
 */
export type BoundInstallation = {
  id: number;
  account_login: string | null;
  removed: boolean;
};

/**
 * One installation the bot already carries that no live target references —
 * the install block's bind source. `account_login` is NULL until the webhook
 * reports it, exactly like the bound row.
 */
export type PendingInstallation = {
  installation_id: number;
  account_login: string | null;
  seen_at: string;
};

/**
 * Why a target's bot no longer serves it, as the server derives it on every
 * read (no stored status): the bot is `owned` and the target belongs to
 * another workspace. Closed vocabulary — a re-share clears it.
 */
export const BLOCKED_REASONS = ["bot_not_shared"] as const;
export type BlockedReason = (typeof BLOCKED_REASONS)[number];

export function isBlockedReason(value: unknown): value is BlockedReason {
  return (BLOCKED_REASONS as readonly unknown[]).includes(value);
}

type TargetOwnedSections = {
  check_gate: CheckGateSettings | null;
};

/**
 * The identity a Blocked face carries: enough to name and link the App, plus
 * the target-owned review switches. Deliberately absent: `sandbox_image_id`,
 * `last_webhook_at` and `github_metadata_synced_at` — the bot's own data.
 */
export type AppInstallApp = {
  github_app_id: number | null;
  id: string;
  github_name: string | null;
  github_slug: string | null;
  github_avatar_url: string | null;
  scope: BotScope;
};

export type BlockedAppIdentityBase = {
  github_app_id: number | null;
  id: string;
  status: string | null;
  created_by: string | null;
  scope: BotScope;
  github_name: string | null;
  github_slug: string | null;
  github_description: string | null;
  github_html_url: string | null;
  github_avatar_url: string | null;
  github_visibility: GithubVisibility | null;
  github_metadata_synced_at?: string | null;
};

export type BlockedAppIdentity = BlockedAppIdentityBase & {
  review_enabled: boolean;
  review_trigger_mode: ReviewTriggerMode;
  review_level: ReviewLevel | null;
  default_review_level: ReviewLevel;
};

/**
 * The target-owned slice every review-policy control reads. Both manager faces
 * carry it, so one component serves the full face and the Blocked face.
 */
export type TargetReviewSlice = {
  app: Pick<
    BlockedAppIdentity,
    "status" | "review_enabled" | "review_trigger_mode" | "review_level" | "default_review_level" | "github_slug"
  >;
  check_gate: CheckGateSettings | null;
};

function isPendingInstallationList(value: unknown): value is PendingInstallation[] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        isRecord(row) &&
        typeof row.installation_id === "number" &&
        Number.isSafeInteger(row.installation_id) &&
        row.installation_id > 0 &&
        isNullableString(row.account_login) &&
        typeof row.seen_at === "string",
    )
  );
}

/**
 * The manager face's App meta: the bot's identity plus the review policy the
 * workspace's target holds. Those four review fields ride with the target —
 * see {@link SettingsTargetFacts} — so an App with no repository carries the
 * bot identity alone.
 */
export type SettingsAppMeta = BotSettingsAppMeta & {
  created_by: string | null;
  github_visibility: GithubVisibility | null;
  review_trigger_mode: ReviewTriggerMode;
  review_level: ReviewLevel | null;
  default_review_level: ReviewLevel;
  review_enabled: boolean;
};

type SettingsHealth = {
  installations: Array<{ installation_id: number; account_login: string | null; seen_at: string }>;
  delivery_summary?: {
    latest: { event_name: string | null; outcome: string; status_code: number | null; created_at: string } | null;
    rejected24h: number;
  };
};

/**
 * One row of the delivery-status face. `reason` is the classifier's refusal
 * sentence (migration 0074) and is present only on a `rejected` row written
 * after that migration; the table renders it as the outcome's explanation.
 */
export type DeliveryStatusRow = {
  event_name: string | null;
  outcome: string;
  status_code: number | null;
  repository_full_name: string | null;
  reason: string | null;
  created_at: string;
};

/**
 * One filtered page of deliveries. `repos` and `types` are the App's WHOLE
 * option sets (not narrowed by the filters), so a filter whose next value sits
 * outside the current result stays selectable. `total` counts the filtered set
 * — it is what the pager walks, not the unfiltered table.
 */
export type DeliveryStatusPage = {
  rows: DeliveryStatusRow[];
  total: number;
  repos: string[];
  types: string[];
};

/** The delivery-status filters, one vocabulary for the URL and the read. */
export type DeliveryFilters = {
  repo: string;
  since: string;
  type: string;
};

export const DELIVERY_PAGE_SIZE = 20;

/**
 * The bot's identity as the bot settings face serves it: the cached GitHub
 * profile plus the bot's own execution identity. A subset of
 * {@link SettingsAppMeta} — the target detail's payload carries the same fields
 * with the workspace's review policy added.
 */
export type BotSettingsAppMeta = {
  github_app_id: number | null;
  id: string;
  name?: string | null;
  description?: string | null;
  shared_at?: string | null;
  multiplier?: number | null;
  status: string | null;
  scope: BotScope;
  /** BOT configuration: the bot payload always carries it; the App face
   * deliberately omits it (F11), so the shared meta stays optional. */
  sandbox_image_id?: string;
  last_webhook_at: string | null;
  github_name: string | null;
  github_slug: string | null;
  github_description: string | null;
  github_html_url: string | null;
  github_avatar_url: string | null;
  github_metadata_synced_at: string | null;
};

/**
 * The BOT-owned sections. They are one set on purpose: the settings face
 * composes them with the target's review policy, and the bot page serves them
 * alone. Every component that renders one of these sections takes this shape,
 * so both faces feed them the same data.
 */
export type BotConfigSections = {
  app: BotSettingsAppMeta & { sandbox_image_id: string };
  keys: ProviderKeyRow[];
  model_chain: string | null;
  model_roles: Record<string, string>;
  model_chains: ModelChainEntry[];
  custom_providers: Array<{
    provider_id: string;
    base_url: string;
    api: string;
    model_ids: string[];
    models_meta?: CustomProviderModelsMeta;
    legacy_of?: string;
  }>;
  configured_providers: ConfiguredProvider[];
  provider_catalog_version: string;
  provider_eligibility: Record<string, ProviderEligibility>;
  model_role_ids: readonly string[];
  custom_provider_api_ids: readonly string[];
  sandbox_images: Array<{ id: string; enabled: boolean }>;
} & SettingsHealth;

/**
 * The bot page's payload: the bot-owned sections plus the ONE permission bit
 * that governs bot-scoped writes. `can_manage` answers "this caller manages
 * the workspace that OWNS the bot" — a consuming workspace gets these sections
 * read-only, and the bot's scope never enters the answer.
 */
/** The bot detail page's overview block (D23): the provider, the caller's
 * month, the consuming workspace's plan ceiling, and the mounts — the
 * editable sections stay out of this shape so the read-only region proves
 * nothing the API did not serve. */
export type BotOverview = {
  provider_workspace: string;
  month_used_rp: number;
  plan_monthly_rp: number | null;
  default_chain: string | null;
  mounted_apps: Array<{ id: string; github_app_id: number; name: string }>;
  mounted_bot_ids?: string[];
};

function parseBotOverview(value: unknown): BotOverview | null {
  if (!isRecord(value)) return null;
  if (typeof value.provider_workspace !== "string") return null;
  if (typeof value.month_used_rp !== "number") return null;
  if (value.plan_monthly_rp !== null && typeof value.plan_monthly_rp !== "number") return null;
  if (value.default_chain !== null && typeof value.default_chain !== "string") return null;
  if (!Array.isArray(value.mounted_apps)) return null;
  for (const row of value.mounted_apps) {
    if (
      !isRecord(row) ||
      typeof row.id !== "string" ||
      typeof row.github_app_id !== "number" ||
      typeof row.name !== "string"
    ) {
      return null;
    }
  }
  if (value.mounted_bot_ids !== undefined && !isStringArray(value.mounted_bot_ids)) return null;
  return {
    provider_workspace: value.provider_workspace,
    month_used_rp: value.month_used_rp,
    plan_monthly_rp: value.plan_monthly_rp,
    default_chain: value.default_chain,
    mounted_apps: value.mounted_apps.map((row) => ({
      id: row.id,
      github_app_id: row.github_app_id,
      name: row.name,
    })),
    ...(value.mounted_bot_ids === undefined ? {} : { mounted_bot_ids: value.mounted_bot_ids }),
  };
}

export type BotSettingsPayload = {
  can_manage: boolean;
  /** F10: the ceiling could not be resolved — never render "no ceiling". */
  quota_error?: boolean;
  /** Whose bot it is — independent of `scope` (publication) and `can_manage`. */
  owned?: boolean;
  official_workspace?: boolean;
  overview?: BotOverview;
} & BotConfigSections;

/** Provider-management data after the static catalog has loaded. */
export type ProviderManagementPayload = BotConfigSections & {
  provider_catalog: CatalogProvider[];
  model_limits_snapshot: string;
};

/** (spec §2): a non-manager gets the identity-only face (no ops stores). */
export type SettingsReadOnlyPayload = {
  can_manage: false;
  workspace_id: string;
  blocked: boolean;
  blocked_reason: BlockedReason | null;
  target_id?: string;
  targets_many?: boolean;
  app: SettingsIdentityAppMeta;
} & AppChain;

/**
 * The App's operator-facing display name (D0): GitHub's current name, then
 * its slug, then the immutable numeric App id — mirrors the server's
 * appDisplayName, so a rename shows up wherever the SPA names the App.
 */
export function appDisplayName(app: {
  name?: string | null;
  github_name: string | null;
  github_slug: string | null;
  github_app_id: number | null;
}): string {
  // Mirrors the server's: post-split bot rows carry null placeholders for
  // every App field, so the bot's own `name` is what a notice prints there.
  return (
    app.name ??
    app.github_name ??
    app.github_slug ??
    (app.github_app_id === null ? "the app" : String(app.github_app_id))
  );
}

type SettingsManageBase = {
  can_manage: true;
  workspace_id: string;
  installation: BoundInstallation | null;
  pending_installations: PendingInstallation[];
  blocked: false;
  blocked_reason: null;
  targets_many?: boolean;
  official_workspace?: boolean;
  can_configure_bot?: boolean;
} & AppChain & BotConfigSections;

/**
 * The manager face of an App whose workspace holds a repository under it: the
 * App's own facts, the bot's sections and the target-owned review policy.
 */
export type SettingsManagePayload = SettingsManageBase & {
  target_id: string;
  app: SettingsAppMeta;
  check_gate: CheckGateSettings | null;
};

/**
 * The manager face of an App the workspace has added no repository under yet:
 * the App's own facts and the bot's sections, with NO target-owned fact — there
 * is no target row to name, so every one of them is ABSENT rather than
 * defaulted (`target_id?: undefined` is the discriminant {@link hasTargetFacts}
 * reads).
 */
/** The App face never serves the BOT's sandbox image (F11) — an App has no
 * runtime harness of its own; the field belongs to the bot it mounts. */
type AppFaceSandbox = { sandbox_image_id?: string };

export type SettingsUntargetedPayload = SettingsManageBase & {
  target_id?: undefined;
  check_gate?: undefined;
  app: BotSettingsAppMeta & AppFaceSandbox & {
    created_by: string;
    github_visibility: GithubVisibility | null;
  };
};

/**
 * The Blocked manager face: this workspace's target on another workspace's
 * bot. It carries the target's own review configuration and the identity the
 * page needs, and NOTHING the bot owns — no installations, delivery log, keys,
 * chains, custom providers, sandbox image or metadata. Those belong to the
 * owning workspace, so their absence is the contract, not a degradation.
 */
export type SettingsBlockedPayload = {
  can_manage: true;
  blocked: true;
  blocked_reason: BlockedReason;
  workspace_id: string;
  target_id: string;
  app: BlockedAppIdentity;
  targets_many?: false;
  installation: BoundInstallation | null;
} & TargetOwnedSections & AppChain;

/**
 * The Blocked manager face of a bot this workspace holds SEVERAL repositories
 * under: no single one's policy is the App page's subject, so the
 * target-owned slice is absent and `target_id` is an explicit `null` — the
 * shape the SPA's `targets_many` notice reads.
 */
export type SettingsBlockedManyPayload = AppChain & {
  can_manage: true;
  blocked: true;
  blocked_reason: BlockedReason;
  workspace_id: string;
  target_id: null;
  targets_many: true;
  app: BlockedAppIdentityBase;
  installation: BoundInstallation | null;
};

export type SettingsPayload =
  | SettingsReadOnlyPayload
  | SettingsManagePayload
  | SettingsUntargetedPayload
  | SettingsBlockedPayload
  | SettingsBlockedManyPayload;

/**
 * The faces that carry the target-owned review policy — the ones whose
 * review controls a page may render. The server sends that slice
 * all-or-nothing, so a STRING `target_id` decides: the several-repository
 * Blocked face says `null` and carries no policy to render.
 */
export type TargetSettingsPayload = SettingsManagePayload | SettingsBlockedPayload;

export function hasTargetFacts(payload: SettingsPayload): payload is TargetSettingsPayload {
  return payload.can_manage && typeof payload.target_id === "string";
}

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
 * band's review-off count, and the status pill. An absent value is the App
 * with no repository: there is no pause switch to report, so reviews are not
 * switched off.
 */
export function reviewEnabled(app: { review_enabled?: number | boolean }): boolean {
  const value = app.review_enabled;
  if (value === undefined) return true;
  return typeof value === "boolean" ? value : value !== 0;
}

/**
 * Paused = active but reviews switched off (one predicate for
 * both faces) — over the same normalization, so the App status pill and
 * SettingsPage's OpsCard share one derivation.
 */
export function isPaused(app: { status: string | null; review_enabled?: number | boolean }): boolean {
  return app.status === "active" && !reviewEnabled(app);
}

/**
 * The App status pill's copy + tone, derived once for both faces that show it
 * (the Apps list and the App detail shell). The face itself belongs to
 * `StatusBadge` in `@design-system`; only what a status MEANS lives here.
 */
export function appStatusPill(
  locale: Locale,
  app: { status: string | null; review_enabled?: number | boolean },
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
  if (!isDistributionList(data.findings_distribution)) return null;
  if (!isDailyTrendList(data.daily_trend)) return null;
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
 * What a read covers: one target (a repository the workspace reviews) or the
 * whole workspace ("所有仓库"). A workspace scope is every LIVE target of the
 * caller's own workspace, resolved server-side.
 */
export type ReadScope = { kind: "target"; targetId: string } | { kind: "workspace" };

/** The scope's read stamp — two scopes with the same key are the same read. */
export function readScopeKey(scope: ReadScope): string {
  return scope.kind === "target" ? `target:${scope.targetId}` : "workspace";
}

function scopePath(scope: ReadScope): string {
  return scope.kind === "target" ? `/api/targets/${encodeURIComponent(scope.targetId)}` : "/api";
}

/**
 * Insights summary URL — `base` is the page's workspace prefix (`/dashboard`,
 * or `/dashboard/<slug>` under strict) plus the scope's own summary face:
 * `GET /api/targets/:targetId/insights/summary` for one target,
 * `GET /api/insights/summary` for the workspace. `repo` is omitted when empty
 * (the no-filter default). `include=repos` rides every read: the repo Select
 * needs the window-scoped distinct repo set on every face it can render (the
 * insights tab has no repo-less summary consumer).
 */
export function scopedInsightsSummaryUrl(
  base: string,
  scope: ReadScope,
  window: string,
  repo: string,
): string {
  const params = new URLSearchParams({ window, include: "repos" });
  if (repo !== "") params.set("repo", repo);
  return `${base}${scopePath(scope)}/insights/summary?${params.toString()}`;
}

/** The bucket sums one token-usage row (or the payload's `total`) carries. */
export type TokenUsageTotals = {
  requests: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  total: number;
  cost_usd: number;
};

/** One (provider, model) bucket of `GET /api/targets/:targetId/token-usage`. */
export type TokenUsageBucket = TokenUsageTotals & { provider: string; model: string };

/** The token-usage payload — mirrors the dashboard store's wire shape. */
export type TargetTokenUsage = {
  window_days: number;
  buckets: TokenUsageBucket[];
  total: TokenUsageTotals;
};

function isTokenUsageTotals(value: unknown): value is TokenUsageTotals {
  return (
    isRecord(value) &&
    typeof value.requests === "number" &&
    typeof value.input === "number" &&
    typeof value.cache_read === "number" &&
    typeof value.cache_write === "number" &&
    typeof value.output === "number" &&
    typeof value.total === "number" &&
    typeof value.cost_usd === "number"
  );
}

function isTokenUsageBucket(value: unknown): value is TokenUsageBucket {
  return (
    isRecord(value) &&
    typeof value.provider === "string" &&
    typeof value.model === "string" &&
    isTokenUsageTotals(value)
  );
}

/** `GET /api/targets/:targetId/token-usage`'s 200 body, validated field by field — unknown shapes → null. */
export function parseTargetTokenUsage(data: unknown): TargetTokenUsage | null {
  if (!isRecord(data) || typeof data.window_days !== "number") return null;
  if (!Array.isArray(data.buckets) || !isTokenUsageTotals(data.total)) return null;
  if (!data.buckets.every(isTokenUsageBucket)) return null;
  return data as TargetTokenUsage;
}

/**
 * Token-usage URL — the target face only (`GET /api/targets/:targetId/
 * token-usage`); the workspace has no token-usage read (the plan defers a
 * workspace aggregate). `window` rides the page's insights window verbatim.
 */
export function targetTokenUsageUrl(base: string, targetId: string, window: string): string {
  return `${base}/api/targets/${encodeURIComponent(targetId)}/token-usage?${new URLSearchParams({ window }).toString()}`;
}

export type PullRequestState = "open" | "closed" | "merged";

/**
 * The PR's reviewing-now projection (compass D11/D16), as the server decides
 * it: `live` = that PR's `review_inflight` row is held right now, carrying the
 * holding attempt's head sha (`""` for a comment trigger) and its acquisition
 * instant; `none` = a successful read with no live row, which is also every
 * queued / superseded / released / abandoned / expired attempt; `unknown` = the
 * read failed, and the client renders it as neither reviewing nor idle. The
 * client never infers this field from anything else.
 */
export type PullRequestReviewing =
  | { state: "live"; head_sha: string; acquired_at: string }
  | { state: "none" }
  | { state: "unknown" };

/**
 * The per-App pull-request ledger's head row — the list's rows and the
 * detail's `pull_request` are ONE shape: the list adds its two aggregates, the
 * detail its record totals. `failure_count` is the list's alone; the detail
 * already carries `counts.failures`, so one number has one carrier.
 */
export type PullRequestHead = {
  number: number;
  owner: string;
  repo: string;
  title: string;
  state: PullRequestState;
  head_sha: string;
  first_seen_at: string;
  last_seen_at: string;
  reviewing: PullRequestReviewing;
};

export type PullRequestRow = PullRequestHead & {
  latest_review: { verdict: string; reviewed_at: string } | null;
  failure_count: number;
};

export type PullRequestReview = {
  verdict: string;
  model: string;
  provider: string;
  reviewed_at: string;
  head_sha: string;
  round: number | null;
  duration_ms: number | null;
  severity_counts: Record<string, number>;
};

/**
 * The detail head's newest review. The head read carries the attribution
 * columns alone — the round ordinal, its run clock and its finding tally
 * belong to the paged reviews section, which is the only payload that counts
 * them.
 */
export type PullRequestLatestReview = {
  verdict: string;
  model: string;
  provider: string;
  reviewed_at: string;
  head_sha: string;
};

/**
 * One review-failure log row — the diagnostic payload this tab exists for.
 * `error_code` and `track_id` are NULL on rows recorded before migration 0106;
 * such a row renders exactly as it did before the code existed.
 */
export type PullRequestFailure = {
  stage: string;
  error: string;
  /** The PR author's sentence (migration 0107); NULL on older rows. */
  message: string | null;
  error_code: string | null;
  track_id: string | null;
  created_at: string;
};

export type PullRequestFinding = {
  finding_id: string;
  severity: string;
  title: string;
  file_path: string;
  line: number | null;
  body: string;
  review_round: number | null;
};

/** The PR detail payload's record totals — one number per record family, plus
 * the PR's own must-fix tally (the family dot's source, page-independent). */
export type PullRequestCounts = {
  findings: number;
  reviews: number;
  failures: number;
  must_fix: number;
};

/**
 * The PR detail payload (`GET …/pull-requests/:owner/:repo/:number`): the head
 * row plus its record totals. The families themselves are paged reads.
 * `latest_review` is the PR's newest review — the header's ONE source for
 * verdict and attribution, independent of whichever reviews page is loaded.
 */
export type PullRequestDetail = {
  pull_request: PullRequestHead;
  counts: PullRequestCounts;
  latest_review: PullRequestLatestReview | null;
};

/** The three record families, one paged read each. */
export type RecordSection = "findings" | "reviews" | "failures";

/**
 * One record section's page: the rows that could be shown, the server's own
 * total, and the read's two bookkeeping facts. `dropped` counts rows this
 * parser refused (they are inside `total`, so the pager would otherwise
 * promise rows no window can render); `limit` is the page size the server
 * actually applied — it clamps, so the pager must stride on this rather than
 * on the size it asked for. `limit` is absent from a payload that predates
 * the echo, and the pager then falls back to its own constant.
 */
export type RecordPage<T> = { items: T[]; total: number; dropped: number; limit?: number };

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

function parsePullRequestHead(value: unknown): PullRequestHead | null {
  if (!isRecord(value)) return null;
  if (typeof value.number !== "number" || !Number.isFinite(value.number)) return null;
  if (typeof value.owner !== "string" || typeof value.repo !== "string") return null;
  if (typeof value.first_seen_at !== "string" || typeof value.last_seen_at !== "string") return null;
  return {
    number: value.number,
    owner: value.owner,
    repo: value.repo,
    title: typeof value.title === "string" ? value.title : "",
    state: value.state === "closed" || value.state === "merged" ? value.state : "open",
    head_sha: typeof value.head_sha === "string" ? value.head_sha : "",
    first_seen_at: value.first_seen_at,
    last_seen_at: value.last_seen_at,
    reviewing: parsePullRequestReviewing(value.reviewing),
  };
}

function parsePullRequestReviewing(value: unknown): PullRequestReviewing {
  if (!isRecord(value)) return { state: "unknown" };
  if (value.state === "none") return { state: "none" };
  if (
    value.state === "live" &&
    typeof value.head_sha === "string" &&
    typeof value.acquired_at === "string"
  ) {
    return { state: "live", head_sha: value.head_sha, acquired_at: value.acquired_at };
  }
  return { state: "unknown" };
}

function parsePullRequestRow(value: unknown): PullRequestRow | null {
  const head = parsePullRequestHead(value);
  if (head === null || !isRecord(value)) return null;
  if (typeof value.failure_count !== "number") return null;
  return {
    ...head,
    latest_review: parseRowLatestReview(value.latest_review),
    failure_count: value.failure_count,
  };
}

function parseRowLatestReview(value: unknown): { verdict: string; reviewed_at: string } | null {
  if (!isRecord(value) || typeof value.reviewed_at !== "string") return null;
  return {
    verdict: typeof value.verdict === "string" ? value.verdict : "",
    reviewed_at: value.reviewed_at,
  };
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 ? value : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function parsePullRequestReview(value: unknown): PullRequestReview | null {
  if (!isRecord(value)) return null;
  if (typeof value.reviewed_at !== "string" || typeof value.head_sha !== "string") return null;
  return {
    verdict: typeof value.verdict === "string" ? value.verdict : "",
    model: typeof value.model === "string" ? value.model : "",
    provider: typeof value.provider === "string" ? value.provider : "",
    reviewed_at: value.reviewed_at,
    head_sha: value.head_sha,
    round: positiveInteger(value.round),
    duration_ms: nonNegativeInteger(value.duration_ms),
    severity_counts: parseSeverityCounts(value.severity_counts),
  };
}

function parseSeverityCounts(raw: unknown): Record<string, number> {
  if (typeof raw !== "string") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isNumberRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
  return {
    stage: value.stage,
    error: value.error,
    message: typeof value.message === "string" ? value.message : null,
    error_code: typeof value.error_code === "string" ? value.error_code : null,
    track_id: typeof value.track_id === "string" ? value.track_id : null,
    created_at: value.created_at,
  };
}

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
    review_round: positiveInteger(value.review_round),
  };
}

function present<T>(value: T | null): value is T {
  return value !== null;
}

/**
 * The list payload: `{ pull_requests: [...], repos: [...] }` — rows parsed per
 * entry, never all-or-nothing. `repos` is the App's whole distinct repository
 * set (the server's option list), strings only; an ABSENT `repos` (an older
 * payload) yields `[]`, so the toolbar offers just the all option — never a
 * re-derivation from the loaded rows, which could not see past the row cap.
 */
export function parsePullRequestList(
  data: unknown,
): { rows: PullRequestRow[]; repos: string[] } | null {
  if (!isRecord(data) || !Array.isArray(data.pull_requests)) return null;
  const repos = Array.isArray(data.repos)
    ? data.repos.filter((value): value is string => typeof value === "string")
    : [];
  return { rows: data.pull_requests.map(parsePullRequestRow).filter(present), repos };
}

function parseLatestReview(value: unknown): PullRequestLatestReview | null {
  if (!isRecord(value) || typeof value.reviewed_at !== "string" || typeof value.head_sha !== "string") {
    return null;
  }
  return {
    verdict: typeof value.verdict === "string" ? value.verdict : "",
    model: typeof value.model === "string" ? value.model : "",
    provider: typeof value.provider === "string" ? value.provider : "",
    reviewed_at: value.reviewed_at,
    head_sha: value.head_sha,
  };
}

/**
 * The detail payload: the head row plus its record totals. The envelope is
 * strict — a missing row or a missing/non-finite tab count fails the whole
 * parse, because a silent zero would disable a tab's count. `must_fix` is the
 * exception: it is a head fact newer than the envelope, so a payload that
 * predates it is tolerated at zero (no danger dot) rather than turning the
 * whole face into an error, exactly as an absent `RecordPage.limit` is.
 */
export function parsePullRequestDetail(data: unknown): PullRequestDetail | null {
  if (!isRecord(data)) return null;
  const pull_request = parsePullRequestHead(data.pull_request);
  if (pull_request === null) return null;
  const counts = parsePullRequestCounts(data.counts);
  if (counts === null) return null;
  return { pull_request, counts, latest_review: parseLatestReview(data.latest_review) };
}

function finiteCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function parsePullRequestCounts(value: unknown): PullRequestCounts | null {
  if (!isRecord(value)) return null;
  const findings = finiteCount(value.findings);
  const reviews = finiteCount(value.reviews);
  const failures = finiteCount(value.failures);
  if (findings === null || reviews === null || failures === null) return null;
  const must_fix = value.must_fix === undefined ? 0 : finiteCount(value.must_fix);
  if (must_fix === null) return null;
  return { findings, reviews, failures, must_fix };
}

const RECORD_PARSERS = {
  findings: parsePullRequestFinding,
  reviews: parsePullRequestReview,
  failures: parsePullRequestFailure,
} satisfies { [K in RecordSection]: (value: unknown) => RecordPageItems[K] | null };

/**
 * One record page: `{ items, total, limit }` in, `{ items, total, dropped,
 * limit }` out. The envelope is strict (a missing `items` array or a
 * non-finite `total` fails the page), but every row is parsed per entry — one
 * drifted record is dropped, not the whole page — and the drop is REPORTED,
 * because the server's `total` still counts the row it could not render.
 */
export function parseRecordPage<S extends RecordSection>(
  section: S,
  data: unknown,
): RecordPage<RecordPageItems[S]> | null {
  if (!isRecord(data) || !Array.isArray(data.items)) return null;
  const total = finiteCount(data.total);
  if (total === null) return null;
  const parse = RECORD_PARSERS[section] as (value: unknown) => RecordPageItems[S] | null;
  const items = data.items.map(parse).filter(present);
  const limit = finiteCount(data.limit);
  return {
    items,
    total,
    dropped: data.items.length - items.length,
    ...(limit === null || limit <= 0 ? {} : { limit }),
  };
}

export function scopedPullRequestsUrl(base: string, scope: ReadScope, repo?: string): string {
  const path = `${base}${scopePath(scope)}/pull-requests`;
  return repo ? `${path}?repo=${encodeURIComponent(repo)}` : path;
}

/**
 * The delivery-status read URL. Filters and paging are REQUEST parameters, so
 * the server narrows and pages BEFORE the response exists — the tab never
 * hides rows it already holds. An unset filter is simply absent from the query.
 */
export function appDeliveriesUrl(
  base: string,
  appId: string,
  filters: DeliveryFilters,
  offset: number,
): string {
  const params = new URLSearchParams();
  if (filters.repo !== "") params.set("repo", filters.repo);
  if (filters.since !== "") params.set("since", filters.since);
  if (filters.type !== "") params.set("type", filters.type);
  if (offset > 0) params.set("offset", String(offset));
  const query = params.toString();
  const path = `${base}/api/apps/${encodeURIComponent(appId)}/deliveries`;
  return query === "" ? path : `${path}?${query}`;
}

/**
 * The delivery page payload: `{ deliveries: [...], total, repos, types }`.
 * The envelope is strict on `total` (a page without it cannot page), while the
 * rows parse per entry — a drifted row is dropped rather than failing the whole
 * table, and the pager still walks the server's total.
 */
export function parseDeliveryPage(data: unknown): DeliveryStatusPage | null {
  if (!isRecord(data) || !Array.isArray(data.deliveries)) return null;
  const total = finiteCount(data.total);
  if (total === null) return null;
  const names = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  return {
    rows: data.deliveries.map(parseDeliveryRow).filter(present),
    total,
    repos: names(data.repos),
    types: names(data.types),
  };
}

function parseDeliveryRow(value: unknown): DeliveryStatusRow | null {
  if (!isRecord(value)) return null;
  if (typeof value.outcome !== "string" || typeof value.created_at !== "string") return null;
  return {
    event_name: typeof value.event_name === "string" ? value.event_name : null,
    outcome: value.outcome,
    status_code: typeof value.status_code === "number" ? value.status_code : null,
    repository_full_name: typeof value.repository_full_name === "string" ? value.repository_full_name : null,
    reason: typeof value.reason === "string" ? value.reason : null,
    created_at: value.created_at,
  };
}

/**
 * The detail read URL, built from the ROW's owner/repo/number — never the
 * number alone. owner/repo are passed through `encodeURIComponent` so a
 * value carrying a segment boundary (`/`, `?`, `#`) cannot escape the
 * pull-requests path family, and {@link pullRequestRefOf} rejects `.`/`..`
 * segments before this builder runs, so a dot-segment can only reach the
 * API by normalising into a same-family 404 — never another route. The
 * `number` segment is validated decimal digits at the parse site.
 *
 * The record sections hang off this SAME address ({@link scopedPullRequestRecordsUrl}),
 * so the detail and its pages can never name different PRs.
 */
export function scopedPullRequestDetailUrl(
  base: string,
  scope: ReadScope,
  ref: PullRequestRef,
): string {
  return `${base}${scopePath(scope)}/pull-requests/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/${ref.number}`;
}

/**
 * The findings filter's catch-all choice: the rows whose `mergeClass` is
 * outside the merge-class vocabulary. It maps to the record route's
 * `unclassified` flag, never to a `severity` spelling — the route admits only
 * the vocabulary there, and a fifth spelling would be a rejected filter.
 */
export const CATCH_ALL_SEVERITY = "other";

/**
 * One record section's page URL. `offset`/`limit` ride every request — the
 * server's bounds are the contract — and `severity` only when the findings
 * filter is set; the query is encoded, so a free-form value cannot break out
 * of it.
 */
export function scopedPullRequestRecordsUrl(
  base: string,
  scope: ReadScope,
  ref: PullRequestRef,
  section: RecordSection,
  page: { offset: number; limit: number; severity?: string },
): string {
  const params = new URLSearchParams({ offset: String(page.offset), limit: String(page.limit) });
  if (page.severity === CATCH_ALL_SEVERITY) params.set("unclassified", "1");
  else if (page.severity !== undefined && page.severity !== "") params.set("severity", page.severity);
  return `${scopedPullRequestDetailUrl(base, scope, ref)}/${section}?${params.toString()}`;
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

/** One commit of the PR's head on GitHub: the repository address plus `/commit/<sha>`. */
export function githubCommitUrl(owner: string, repo: string, sha: string): string {
  return `${githubRepoUrl(owner, repo)}/commit/${encodeURIComponent(sha)}`;
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
 * The App detail page's faces: 应用设置 (the App's own configuration, the
 * default), 机器人 (the App's ordered chain, read-only), 投递状态 (the bot's
 * webhook deliveries, filtered and paged) and 已安装. The data faces — 洞察 and
 * Pull requests — belong to the repository detail, so they are not values a
 * URL can open here.
 */
export type AppDetailTab = "settings" | "bots" | "delivery" | "installations";

/**
 * URL-derived detail state: the App detail's active tab. `window`/`repo`/`pr`
 * are the repository detail's data-tab state, carried by the shared
 * {@link AppDetailSearch} shape until that surface owns them.
 */
export type AppDetailSearch = { tab: AppDetailTab; window: InsightsWindow; repo: string; pr: string };

/**
 * The `pr` param string → a detail address, or null when the param is absent
 * or malformed (the tab then renders the list). This function IS the `pr`
 * grammar — `parseAppDetailSearch` accepts exactly what it resolves, so the
 * URL state can never carry an address the detail read refuses. `.`/`..`
 * segments are rejected outright — encoding cannot neutralise a dot-segment
 * (`encodeURIComponent("..")` is `".."`), so the boundary has to be here —
 * and exactly three segments are accepted, so a longer path is not silently
 * read as its first three.
 */
export function pullRequestRefOf(pr: string): PullRequestRef | null {
  const parts = pr.split("/");
  if (parts.length !== 3) return null;
  const [owner, repo, number] = parts;
  if (owner === undefined || repo === undefined || number === undefined) return null;
  if (!/^\d+$/.test(number) || owner === "" || repo === "") return null;
  if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
  return { owner, repo, number: Number(number) };
}

/**
 * The search string as the App detail states it — the ONE derivation shared by
 * the mount initializer and the popstate re-sync (the spa-url-state-resync
 * contract). The bare path IS the 应用设置 tab; `?tab=bots`, `?tab=delivery` and
 * `?tab=installations` are the other addresses this page opens, and any other
 * value (including the retired data-tab spellings) resolves to the default. `pr` rides verbatim only when
 * `pullRequestRefOf` resolves it — the same predicate the detail face reads —
 * so the address bar never advertises an open detail that can never open.
 */
export function parseAppDetailSearch(search: string): AppDetailSearch {
  const insights = parseInsightsSearch(search);
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const rawTab = params.get("tab");
  const tab: AppDetailTab =
    rawTab === "installations" || rawTab === "delivery" || rawTab === "bots" ? rawTab : "settings";
  const window = (INSIGHTS_WINDOWS as readonly string[]).includes(insights.window)
    ? (insights.window as InsightsWindow)
    : "30";
  const rawPr = params.get("pr");
  const pr = rawPr !== null && pullRequestRefOf(rawPr) !== null ? rawPr : "";
  return { tab, window, repo: insights.repo, pr };
}

/**
 * The query string for a detail state — the inverse of
 * {@link parseAppDetailSearch}: the tab param on every non-default tab (the
 * bare path IS 应用设置), the window param only off the 30 default, the repo
 * param only when set, the pr param only when a detail is open. Loop-free by
 * construction: consumers write it with replaceState only.
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

/**
 * The repository detail's three tabs, one vocabulary for BOTH detail variants
 * (`…/repos/<uuid>` and `…/repos/all`). Kept apart from
 * {@link AppDetailTab}: the App detail's two faces are a different page.
 * `settings` is the bare path, so it has no `tab` param of its own.
 */
export type TargetDetailTab = "settings" | "insights" | "pull-requests";

/**
 * The search string as the repository detail states it: a `tab` value outside
 * the vocabulary (or its absence) is the 评审配置 default. The inverse is
 * {@link targetDetailTabQuery}.
 */
export function parseTargetDetailTab(search: string): TargetDetailTab {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search);
  const tab = params.get("tab");
  return tab === "insights" || tab === "pull-requests" ? tab : "settings";
}

/** The query string for a detail tab — the bare path IS 评审配置. */
export function targetDetailTabQuery(tab: TargetDetailTab): string {
  return tab === "settings" ? "" : `?tab=${tab}`;
}

function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "owner" || value === "admin" || value === "member";
}

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
  const pending = Array.isArray(data.pending_installations)
    ? data.pending_installations.filter(isPendingBindRow)
    : [];
  return {
    ...(data as AppsPayload),
    shared_bots: parseSharedBots(data.shared_bots),
    shared_apps: Array.isArray(data.shared_apps) ? data.shared_apps.filter(isSharedAppCard) : [],
    pending_installations: pending,
  };
}

/** One repository target row of `GET /:ref/api/targets` (product spec J1). */
export type TargetListRow = {
  target_id: string;
  repo_id: number | null;
  repo_owner: string | null;
  repo_name: string | null;
  bot_id: string;
  app_name: string;
  review_enabled: number;
  follow_workspace_defaults: number;
  last_reviewed_at: string | null;
  reviews_total: number;
  reviews_7d: number;
};

/** The add-repository dialog's application option (one row of `GET /api/apps`). */
export type RepositoryAppOption = {
  app_id: number;
  bot_id: string;
  name: string;
  slug: string | null;
};

/** One repository an installation grants — the dialog's multi-select option. */
export type InstallationRepositoryOption = { repo_id: number; owner: string; name: string };

/**
 * One option of the installation-repositories walk: the repository plus
 * whether a live target of this BOT already holds it. The claim is bot-wide
 * (a sibling workspace's row on the same bot refuses the insert), so a claimed
 * row is never selectable.
 */
export type InstallationRepository = InstallationRepositoryOption & { claimed: boolean };

function parseTargetListRow(value: unknown): TargetListRow | null {
  if (!isRecord(value)) return null;
  const { target_id, bot_id, app_name } = value;
  if (typeof target_id !== "string" || typeof bot_id !== "string" || typeof app_name !== "string") return null;
  const repoId = value.repo_id;
  const repoOwner = value.repo_owner;
  const repoName = value.repo_name;
  if (repoId !== null && typeof repoId !== "number") return null;
  if (repoOwner !== null && typeof repoOwner !== "string") return null;
  if (repoName !== null && typeof repoName !== "string") return null;
  const reviewed = value.last_reviewed_at;
  if (reviewed !== null && typeof reviewed !== "string") return null;
  if (typeof value.review_enabled !== "number") return null;
  if (typeof value.follow_workspace_defaults !== "number") return null;
  if (typeof value.reviews_total !== "number" || typeof value.reviews_7d !== "number") return null;
  return {
    target_id,
    repo_id: repoId,
    repo_owner: repoOwner,
    repo_name: repoName,
    bot_id,
    app_name,
    review_enabled: value.review_enabled,
    follow_workspace_defaults: value.follow_workspace_defaults,
    last_reviewed_at: reviewed,
    reviews_total: value.reviews_total,
    reviews_7d: value.reviews_7d,
  };
}

/**
 * The repository list, all-or-nothing: a row the page cannot read would render
 * a repository with no identity or no status, so one bad row is no list (the
 * `parseSharedBots` rule). A payload without a `targets` array is not this face.
 */
export function parseTargets(data: unknown): TargetListRow[] | null {
  if (!isRecord(data) || !Array.isArray(data.targets)) return null;
  const rows: TargetListRow[] = [];
  for (const value of data.targets) {
    const row = parseTargetListRow(value);
    if (row === null) return null;
    rows.push(row);
  }
  return rows;
}

/**
 * The chosen App's live installations, read off the settings payload the add
 * dialog already asks for (`installations[]` — the `bot_installations` rows).
 * Its own lean parser, because the dialog needs this ONE section: the full
 * settings parse is the settings page's contract and needs a manager face.
 */
export function parseAppInstallations(data: unknown): PendingInstallation[] | null {
  if (!isRecord(data)) return null;
  if (!isPendingInstallationList(data.installations)) return null;
  return data.installations;
}

/**
 * The installation-repositories face. `degraded` says some installation failed
 * while the rest answered, so the dialog can offer what it has and say so.
 * `claimed` is the bot-wide duplicate predicate the insert will apply: a row
 * without it would be offered as selectable and could only fail.
 */
export function parseInstallationRepositories(
  data: unknown,
): { repositories: InstallationRepository[]; degraded: boolean } | null {
  if (!isRecord(data) || !Array.isArray(data.repositories)) return null;
  const repositories: InstallationRepository[] = [];
  for (const value of data.repositories) {
    if (!isRecord(value)) return null;
    const { repo_id, owner, name, claimed } = value;
    if (typeof repo_id !== "number" || typeof owner !== "string" || typeof name !== "string") return null;
    if (typeof claimed !== "boolean") return null;
    repositories.push({ repo_id, owner, name, claimed });
  }
  return { repositories, degraded: data.degraded === true };
}

/** One row `POST /api/targets` reports under `created` — a written target. */
export type CreatedTarget = { target_id: string; repo_id: number; repo_owner: string; repo_name: string };

/**
 * `POST /api/targets` 201 body. `duplicates` is the partial outcome the dialog
 * reports: the rows in `created` are written, the listed repositories are not.
 */
export function parseTargetCreate(
  body: string,
): { created: CreatedTarget[]; duplicates: InstallationRepositoryOption[] } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.created)) return null;
  const created: CreatedTarget[] = [];
  for (const value of parsed.created) {
    if (!isRecord(value)) continue;
    const { target_id, repo_id, repo_owner, repo_name } = value;
    if (
      typeof target_id !== "string" ||
      typeof repo_id !== "number" ||
      typeof repo_owner !== "string" ||
      typeof repo_name !== "string"
    ) {
      continue;
    }
    created.push({ target_id, repo_id, repo_owner, repo_name });
  }
  const duplicates: InstallationRepositoryOption[] = [];
  if (Array.isArray(parsed.duplicates)) {
    for (const value of parsed.duplicates) {
      if (!isRecord(value)) continue;
      const { repo_id, owner, name } = value;
      if (typeof repo_id !== "number" || typeof owner !== "string" || typeof name !== "string") continue;
      duplicates.push({ repo_id, owner, name });
    }
  }
  return { created, duplicates };
}

/**
 * `POST /api/workspaces` 201 body — the new workspace's ref plus the page the
 * creator lands on (that workspace's repository overview). The landing is
 * server-chosen: only the Worker knows the deployment's tenant read mode, and
 * `strict`'s sole-workspace resolver cannot name a workspace once a second one
 * exists.
 */
export function parseCreatedWorkspace(data: string): { id: string; homePath: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.homePath !== "string") {
    return null;
  }
  return { id: parsed.id, homePath: parsed.homePath };
}

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

function isKeyVerifiedStatus(value: unknown): value is KeyVerifiedStatus {
  return value === null || value === "ok" || value === "reachable" || value === "failed";
}

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

function isCatalogModelLimit(value: unknown): value is CatalogModelLimit {
  return (
    isRecord(value) &&
    typeof value.contextWindow === "number" &&
    Number.isInteger(value.contextWindow) &&
    value.contextWindow > 0 &&
    typeof value.maxTokens === "number" &&
    Number.isInteger(value.maxTokens) &&
    value.maxTokens > 0
  );
}

function isCatalogModelLimits(value: unknown): value is Record<string, CatalogModelLimit> {
  return isRecord(value) && Object.values(value).every(isCatalogModelLimit);
}

function isCatalogProtocolOptions(value: unknown): value is CatalogProtocolOption[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (option) =>
        isRecord(option) &&
        typeof option.api === "string" &&
        (option.base_url === null || typeof option.base_url === "string") &&
        isStringArray(option.models),
    )
  );
}

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
        isCatalogModelLimits(row.model_limits) &&
        typeof row.verifiable === "boolean" &&
        typeof row.usage_probe === "boolean" &&
        (row.protocols === undefined || isCatalogProtocolOptions(row.protocols)) &&
        isStringArray(row.models),
    )
  );
}

export type StaticProviderCatalog = {
  provider_catalog: Omit<CatalogProvider, "eligibility">[];
  model_limits_snapshot: string;
};

export function parseProviderCatalog(value: unknown): StaticProviderCatalog | null {
  if (!isRecord(value) || !Array.isArray(value.provider_catalog) ||
    typeof value.model_limits_snapshot !== "string" || value.model_limits_snapshot.length === 0) return null;
  const rows = value.provider_catalog.map((row: unknown) =>
    isRecord(row) ? { ...row, eligibility: row.tier } : row);
  return isCatalogProviderList(rows) ? value as StaticProviderCatalog : null;
}

function parseCatalogReference(data: Record<string, unknown>): boolean {
  if (typeof data.provider_catalog_version !== "string" || data.provider_catalog_version.length === 0 ||
    !isRecord(data.provider_eligibility) || !Object.values(data.provider_eligibility).every((value) =>
      value === "builtin" || value === "template" || value === "unavailable")) return false;
  return true;
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

/** One allowance of the usage-probe snapshot (the usage route's fixed wire contract). */
export type UsageLimit = {
  id: string;
  kind: "window" | "balance";
  usedFraction?: number;
  remaining?: number;
  extraRemaining?: number;
  limit?: number;
  unit: "percent" | "requests" | "credits" | "usd" | "tokens";
  resetsAt?: number;
  shared?: boolean;
};

export type UsageSnapshot = {
  status: "ok" | "absent" | "unauthorized" | "error";
  fetchedAt: number;
  limits: UsageLimit[];
  reason?: string;
  absentCause?: "no-probe" | "reported-nothing";
};

const USAGE_STATUSES = ["ok", "absent", "unauthorized", "error"] as const;
const USAGE_LIMIT_KINDS = ["window", "balance"] as const;
const USAGE_UNITS = ["percent", "requests", "credits", "usd", "tokens"] as const;

function isUsageStatus(value: unknown): value is UsageSnapshot["status"] {
  return typeof value === "string" && (USAGE_STATUSES as readonly string[]).includes(value);
}

function isUsageLimitKind(value: unknown): value is UsageLimit["kind"] {
  return typeof value === "string" && (USAGE_LIMIT_KINDS as readonly string[]).includes(value);
}

function isUsageUnit(value: unknown): value is UsageLimit["unit"] {
  return typeof value === "string" && (USAGE_UNITS as readonly string[]).includes(value);
}

function isAbsentCause(value: unknown): value is NonNullable<UsageSnapshot["absentCause"]> {
  return value === "no-probe" || value === "reported-nothing";
}

function parseUsageLimit(raw: unknown): UsageLimit | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== "string") return null;
  if (!isUsageLimitKind(raw.kind)) return null;
  if (!isUsageUnit(raw.unit)) return null;
  const limit: UsageLimit = { id: raw.id, kind: raw.kind, unit: raw.unit };
  if (raw.usedFraction !== undefined) {
    if (typeof raw.usedFraction !== "number" || !Number.isFinite(raw.usedFraction)) return null;
    limit.usedFraction = raw.usedFraction;
  }
  if (raw.remaining !== undefined) {
    if (typeof raw.remaining !== "number" || !Number.isFinite(raw.remaining)) return null;
    limit.remaining = raw.remaining;
  }
  if (raw.extraRemaining !== undefined) {
    if (typeof raw.extraRemaining !== "number" || !Number.isFinite(raw.extraRemaining)) return null;
    limit.extraRemaining = raw.extraRemaining;
  }
  if (raw.limit !== undefined) {
    if (typeof raw.limit !== "number" || !Number.isFinite(raw.limit)) return null;
    limit.limit = raw.limit;
  }
  if (raw.resetsAt !== undefined) {
    if (typeof raw.resetsAt !== "number" || !Number.isFinite(raw.resetsAt)) return null;
    limit.resetsAt = raw.resetsAt;
  }
  if (raw.shared !== undefined) {
    if (typeof raw.shared !== "boolean") return null;
    limit.shared = raw.shared;
  }
  return limit;
}

/** `POST /keys/usage`'s 200 body, validated field by field — unknown shapes → null. */
export function parseUsageSnapshot(raw: unknown): UsageSnapshot | null {
  if (!isRecord(raw)) return null;
  if (!isUsageStatus(raw.status)) return null;
  if (typeof raw.fetchedAt !== "number") return null;
  if (!Array.isArray(raw.limits)) return null;
  const limits: UsageLimit[] = [];
  for (const row of raw.limits) {
    const limit = parseUsageLimit(row);
    if (limit === null) return null;
    limits.push(limit);
  }
  const snapshot: UsageSnapshot = { status: raw.status, fetchedAt: raw.fetchedAt, limits };
  if (raw.reason !== undefined) {
    if (typeof raw.reason !== "string") return null;
    snapshot.reason = raw.reason;
  }
  if (raw.absentCause !== undefined) {
    if (!isAbsentCause(raw.absentCause)) return null;
    snapshot.absentCause = raw.absentCause;
  }
  return snapshot;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

export function parseSettings(data: unknown): SettingsPayload | null {
  if (!isRecord(data)) return null;
  if (!isRecord(data.app)) return null;
  if (typeof data.can_manage !== "boolean") return null;
  if (typeof data.workspace_id !== "string" || data.workspace_id.length === 0) return null;
  if (data.app.status !== null && typeof data.app.status !== "string") return null;
  if (!isNullableString(data.app.created_by)) return null;
  if (data.app.github_app_id !== null && typeof data.app.github_app_id !== "number") return null;
  if (typeof data.app.id !== "string") return null;
  if (!isNullableString(data.app.github_slug)) return null;
  if (typeof data.blocked !== "boolean") return null;
  if (data.blocked_reason !== null && !isBlockedReason(data.blocked_reason)) return null;
  if (data.blocked !== (data.blocked_reason !== null)) return null;
  if (data.targets_many !== undefined && typeof data.targets_many !== "boolean") return null;
  if (data.blocked) {
    if (
      data.app.github_metadata_synced_at !== undefined &&
      !isNullableString(data.app.github_metadata_synced_at)
    ) {
      return null;
    }
  }
  const hasTarget = data.target_id !== undefined;
  const blockedMany = data.blocked && data.target_id === null;
  if (hasTarget && !blockedMany && (typeof data.target_id !== "string" || data.target_id.length === 0)) return null;
  if (!blockedMany && (data.app.review_enabled !== undefined) !== hasTarget) return null;
  if (!data.can_manage) {
    if (typeof data.app.created_at !== "string") return null;
    if (hasTarget && typeof data.app.review_enabled !== "boolean") return null;
    if (
      !isNullableString(data.app.github_name) ||
      !isNullableString(data.app.github_description) ||
      !isNullableString(data.app.github_html_url) ||
      !isNullableString(data.app.github_avatar_url)
    ) {
      return null;
    }
    if (!data.blocked && !isNullableString(data.app.github_metadata_synced_at)) return null;
    return data as SettingsPayload;
  }
  if (data.blocked) {
    if (!hasTarget) return null;
    if (
      !isNullableString(data.app.github_name) ||
      !isNullableString(data.app.github_description) ||
      !isNullableString(data.app.github_html_url) ||
      !isNullableString(data.app.github_avatar_url) ||
      !isNullableGithubVisibility(data.app.github_visibility)
    ) {
      return null;
    }
    if (!isBotScope(data.app.scope)) return null;
    if (blockedMany !== (data.targets_many === true)) return null;
    if (blockedMany) {
      if (data.app.review_enabled !== undefined) return null;
      if (data.installation !== null && !isBoundInstallation(data.installation)) return null;
      return data as SettingsPayload;
    }
    if (typeof data.app.review_enabled !== "boolean") return null;
    if (!isReviewTriggerMode(data.app.review_trigger_mode)) return null;
    if (data.app.review_level !== null && !isReviewLevel(data.app.review_level)) return null;
    if (!isReviewLevel(data.app.default_review_level)) return null;
    if (data.check_gate !== null && !isCheckGateSettings(data.check_gate)) return null;
    if (data.installation !== null && !isBoundInstallation(data.installation)) return null;
    return data as SettingsPayload;
  }
  if (typeof data.official_workspace !== "boolean") return null;
  if (typeof data.can_configure_bot !== "boolean") return null;
  if (data.app.sandbox_image_id !== undefined && typeof data.app.sandbox_image_id !== "string") return null;
  if (!isBotScope(data.app.scope)) return null;
  if (data.installation !== null && !isBoundInstallation(data.installation)) return null;
  if (!isPendingInstallationList(data.pending_installations)) return null;
  if (!Array.isArray(data.installations)) return null;
  if (!isProviderKeyRowList(data.keys)) return null;
  if (!Array.isArray(data.model_role_ids) || !isStringArray(data.model_role_ids)) return null;
  if (!Array.isArray(data.custom_provider_api_ids) || !isStringArray(data.custom_provider_api_ids)) return null;
  if (!Array.isArray(data.model_chains)) return null;
  if (!isConfiguredProviderList(data.configured_providers)) return null;
  if (!parseCatalogReference(data)) return null;
  if (!isSandboxImageList(data.sandbox_images)) return null;
  if (!isNullableGithubVisibility(data.app.github_visibility)) return null;
  if (
    data.chain !== undefined &&
    (!Array.isArray(data.chain) || !data.chain.every(isAppChainEntry))
  ) {
    return null;
  }
  if (!hasTarget) return data as SettingsPayload;
  if (!isReviewTriggerMode(data.app.review_trigger_mode)) return null;
  if (data.app.review_level !== null && !isReviewLevel(data.app.review_level)) return null;
  if (!isReviewLevel(data.app.default_review_level)) return null;
  if (data.check_gate !== null && !isCheckGateSettings(data.check_gate)) return null;
  return data as SettingsPayload;
}

function isSandboxImageList(value: unknown): value is Array<{ id: string; enabled: boolean }> {
  return (
    Array.isArray(value) &&
    value.every((row) => isRecord(row) && typeof row.id === "string" && typeof row.enabled === "boolean")
  );
}

/**
 * The bot page's payload: the bot-owned sections plus `can_manage`. Validated
 * field by field like {@link parseSettings} — a payload that cannot round-trip
 * fails the parse instead of rendering a control the server would refuse.
 */
export function parseBotSettings(data: unknown): BotSettingsPayload | null {
  if (!isRecord(data)) return null;
  if (!isRecord(data.app)) return null;
  if (typeof data.can_manage !== "boolean") return null;
  const app = data.app;
  if ((app.github_app_id !== null && typeof app.github_app_id !== "number") || typeof app.id !== "string") return null;
  if (app.status !== null && typeof app.status !== "string") return null;
  if (!isBotScope(app.scope)) return null;
  if (typeof app.sandbox_image_id !== "string") return null;
  if (
    !isNullableString(app.last_webhook_at) ||
    !isNullableString(app.github_name) ||
    !isNullableString(app.github_slug) ||
    !isNullableString(app.github_description) ||
    !isNullableString(app.github_html_url) ||
    !isNullableString(app.github_avatar_url) ||
    !isNullableString(app.github_metadata_synced_at)
  ) {
    return null;
  }
  if (!Array.isArray(data.installations)) return null;
  if (!isProviderKeyRowList(data.keys)) return null;
  if (data.model_chain !== null && typeof data.model_chain !== "string") return null;
  if (!isRecord(data.model_roles) || !Array.isArray(data.model_chains)) return null;
  if (!Array.isArray(data.custom_providers)) return null;
  if (!isConfiguredProviderList(data.configured_providers)) return null;
  if (!parseCatalogReference(data)) return null;
  if (!Array.isArray(data.model_role_ids) || !isStringArray(data.model_role_ids)) return null;
  if (!Array.isArray(data.custom_provider_api_ids) || !isStringArray(data.custom_provider_api_ids)) return null;
  if (!isSandboxImageList(data.sandbox_images)) return null;
  if (data.overview !== undefined && data.overview !== null && parseBotOverview(data.overview) === null) return null;
  if (data.owned !== undefined && typeof data.owned !== "boolean") return null;
  if (data.quota_error !== undefined && typeof data.quota_error !== "boolean") return null;
  return {
    ...(data as BotSettingsPayload),
    overview: data.overview == null ? undefined : parseBotOverview(data.overview) ?? undefined,
  };
}

function isPrVerdict(value: unknown): value is (typeof PR_VERDICTS)[number] {
  return (PR_VERDICTS as readonly string[]).includes(value as string);
}

function isCheckGateSettings(value: unknown): value is CheckGateSettings {
  return (
    isRecord(value) &&
    typeof value.min_score === "number" &&
    Number.isInteger(value.min_score) &&
    value.min_score >= 0 &&
    value.min_score <= 100 &&
    isStringArray(value.pass_verdicts) &&
    value.pass_verdicts.every(isPrVerdict)
  );
}

function isNullableGithubVisibility(value: unknown): value is GithubVisibility | null {
  return value === null || value === "public" || value === "private" || value === "unknown";
}

function isBoundInstallation(value: unknown): value is BoundInstallation {
  return (
    isRecord(value) &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    isNullableString(value.account_login) &&
    typeof value.removed === "boolean"
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

/** The workspace concurrency face: the stored cap plus its own range. */
export type ConcurrencySettings = {
  concurrency: number;
  min: number;
  max: number;
  degraded: boolean;
};

/**
 * Whether a concurrency form must not submit: a degraded read's conservative
 * fallback is never a value anyone stored, and an empty draft cannot be a
 * repair. A typed value IS the repair, so the form stays usable.
 */
export function concurrencySubmitBlocked(degraded: boolean, draft: string | null): boolean {
  if (draft === null) return degraded;
  return draft.trim() === "";
}

export function parseConcurrencySettings(data: unknown): ConcurrencySettings | null {
  if (!isRecord(data)) return null;
  const { concurrency, min, max, degraded } = data;
  if (typeof concurrency !== "number") return null;
  if (typeof min !== "number" || typeof max !== "number") return null;
  if (typeof degraded !== "boolean") return null;
  return { concurrency, min, max, degraded };
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

/**
 * The workspace's default review-gate floor for new Apps. `degraded` means the
 * stored value could not be read, so `minScore` is the platform fallback and
 * the card must not offer it as if someone had stored it.
 */
export type CheckMinScoreSettings = {
  minScore: number;
  min: number;
  max: number;
  degraded: boolean;
};

export function parseCheckMinScoreSettings(data: unknown): CheckMinScoreSettings | null {
  if (!isRecord(data)) return null;
  const { min_score, min, max, degraded } = data;
  if (typeof min_score !== "number" || typeof min !== "number" || typeof max !== "number") return null;
  if (typeof degraded !== "boolean") return null;
  return { minScore: min_score, min, max, degraded };
}

/** A write's answer: the stored floor, or null on a body that is not JSON. */
export function parseStoredCheckMinScore(body: string): number | null {
  try {
    const data: unknown = JSON.parse(body);
    return isRecord(data) && typeof data.min_score === "number" ? data.min_score : null;
  } catch {
    return null;
  }
}

/**
 * The card's credit block, all integer RP: the month's spend, the ceiling the
 * judging profile sets for this workspace's plan, the source split and the
 * profile label. `null` on the payload means `self-hosted` (no ceiling to
 * report, no card).
 */
export type ReviewUsageQuota = {
  usedRp: number;
  limitRp: number | null;
  sharedRp: number;
  byokRp: number;
  rpPerCredit: number;
  profileVersion: number;
  profileFrom: string;
  resetOn: string;
};

/**
 * The settings usage card's payload: the UTC month, the two published-review
 * counts, the shared-bot row's state and the credit block. A drifted field
 * fails the parse into the card's error face instead of rendering an undefined
 * number.
 */
export type ReviewUsage = {
  month: string;
  sharedReviews: number;
  ownReviews: number;
  sharedBot: "available" | "not-in-plan" | "not-designated";
  quota: ReviewUsageQuota | null;
};

function parseReviewUsageQuota(value: unknown): ReviewUsageQuota | null {
  if (!isRecord(value)) return null;
  const { usedRp, limitRp, sharedRp, byokRp, rpPerCredit, profileVersion, profileFrom, resetOn } = value;
  if (
    typeof usedRp !== "number" ||
    typeof sharedRp !== "number" ||
    typeof byokRp !== "number" ||
    typeof rpPerCredit !== "number" ||
    typeof profileVersion !== "number" ||
    typeof profileFrom !== "string" ||
    typeof resetOn !== "string"
  ) {
    return null;
  }
  if (limitRp !== null && typeof limitRp !== "number") return null;
  return { usedRp, limitRp, sharedRp, byokRp, rpPerCredit, profileVersion, profileFrom, resetOn };
}

export function parseReviewUsage(data: unknown): ReviewUsage | null {
  if (!isRecord(data)) return null;
  const { month, sharedReviews, ownReviews, sharedBot, quota } = data;
  if (typeof month !== "string") return null;
  if (typeof sharedReviews !== "number" || typeof ownReviews !== "number") return null;
  if (sharedBot !== "available" && sharedBot !== "not-in-plan" && sharedBot !== "not-designated") return null;
  const parsedQuota = quota === undefined || quota === null ? null : parseReviewUsageQuota(quota);
  if (quota !== undefined && quota !== null && parsedQuota === null) return null;
  return { month, sharedReviews, ownReviews, sharedBot, quota: parsedQuota };
}

export function splitModelChain(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0);
}

/**
 * I-000645: swap one chain entry with its neighbour. The stored order IS the
 * chain string (no ordinal column), so reordering is a pure array swap the
 * existing `join(", ")` save persists. `delta` is -1 (up) or +1 (down); an index
 * at the end, or a list too short to have a neighbour there, comes back
 * unchanged rather than wrapping — the end buttons are disabled anyway, and a
 * wrap would silently reorder a chain the operator only nudged.
 */
export function moveChainEntry(chain: readonly string[], index: number, delta: -1 | 1): string[] {
  const target = index + delta;
  const moved = chain[index];
  const displaced = chain[target];
  if (moved === undefined || displaced === undefined) return [...chain];
  const next = [...chain];
  next[index] = displaced;
  next[target] = moved;
  return next;
}

/**
 * One chain row's React key. Keyed by INDEX a swap remounts both rows and drops
 * keyboard focus mid-reorder (I-000645: "focus stays on the moved row's
 * control"). The selector plus its occurrence ordinal is stable across a move:
 * React re-parents the existing node — focus, hover and the pressed control all
 * travel with it — and duplicate selectors still get one key each.
 */
export function chainRowKey(chain: readonly string[], index: number): string {
  const selector = chain[index] ?? "";
  let occurrence = 0;
  for (let i = 0; i < index; i += 1) if (chain[i] === selector) occurrence += 1;
  return `${selector}#${occurrence}`;
}

/** Same GitHub login grammar the invite route enforces. */
export const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

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
