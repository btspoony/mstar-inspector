import { Hono, type Context, type Handler } from "hono";
import { getCookie } from "hono/cookie";
import { orderedReads } from "./ordered-reads";
import { providerCatalog } from "./provider-catalog";
import { PR_VERDICTS, type PrVerdict } from "@mstar-harness/engine";
import { deploymentModeOf, type DeploymentMode, type Env } from "../worker/env";
import {
  BIND_OAUTH_SCOPE,
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGitHubUser,
  isGitHubOrgAdmin,
  logOAuthFailure,
} from "./oauth";
import {
  FIRST_INSTANCE_COOKIE,
  FIRST_INSTANCE_MAX_AGE_SEC,
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_SEC,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  createFirstInstanceValue,
  createSessionValue,
  createStateValue,
  expireCookie,
  randomToken,
  readSessionValue,
  serializeCookie,
  signValue,
  timingSafeEqual,
  verifyStateValue,
  verifyValue,
  type SessionPayload,
} from "./session";
import {
  MANIFEST_HOLD_COOKIE,
  MANIFEST_HOLD_MAX_AGE_SEC,
  MANIFEST_STATE_COOKIE,
  MANIFEST_STATE_MAX_AGE_SEC,
  buildHoldPayload,
  buildManifest,
  buildManifestCreateUrl,
  createManifestStateValue,
  encryptHoldValue,
  exchangeManifestCode,
  logManifestFailure,
  readHoldValue,
  readManifestStateValue,
  type ManifestHoldPayload,
} from "./manifest";
import { GITHUB_CODE_SHAPE } from "./github-code-shape";
import {
  AppCountExceededError,
  createReviewBotsStore,
  type DeliveryFilters,
  type DeliverySummary,
  type GithubAppRow,
  type GithubAppTenantRow,
  type LedgerScope,
  type PullRequestReviewing,
  type BotScope,
  type BotScopedRow,
  setAppScope,
  setReviewBotScope,
} from "./apps-store";
import {
  checkGateOf,
  createTargetsStore,
  effectiveTargetSettings,
  getWorkspaceReviewDefaults,
  REVIEW_TRIGGER_MODES,
  setWorkspaceReviewDefaults,
  workspaceDefaultsOfListRow,
  type EffectiveTargetSettings,
  type ReviewTargetRow,
  type ReviewTriggerMode,
  type TargetReviewConfig,
  type WorkspaceReviewDefaults,
} from "./targets-store";
import {
  countFreeMembershipsForLogin,
  countLiveWorkspaces,
  countMembersAndPendingInvites,
  createWorkspace,
  deleteWorkspace,
  getSoleWorkspaceAccess,
  getWorkspaceAccessById,
  getWorkspaceAccessByRef,
  getWorkspaceByRef,
  getWorkspaceMember,
  getWorkspaceRequestAccess,
  listWorkspaceMembers,
  listWorkspaceMembershipOptions,
  setWorkspaceName,
  type WorkspaceAccess,
  type WorkspaceMembershipOption,
  type WorkspaceRole,
  type WorkspaceRow,
} from "./workspace-store";
import {
  ACCEPT_MEMBER_CAP_REFUSAL,
  FREE_SLOT_REFUSAL,
  FreeWorkspaceSlotError,
  INVITE_FREE_SLOT_REFUSAL,
  MEMBER_CAP_REFUSAL,
  MemberCapError,
  WORKSPACE_CREATION_CLOSED_REFUSAL,
  checkEntitlement,
  UNLIMITED_PLAN_ID,
  resolveWorkspacePlan,
  resolveWorkspacePlans,
  sharedBotAvailability,
} from "./entitlement";
import { readReviewUsage, reviewUsageMonth } from "./review-usage-store";
import { readWorkspaceQuota } from "./quota-faces";
import { quotaMonth, resolveMonthlyQuota } from "../store/quota-store";
import { countUsageEventsSince } from "../store/usage-store";
import {
  type AcceptInviteOutcome,
  InvitePendingExistsError,
  acceptInvite,
  createInvite,
  getInviteInWorkspace,
  getPendingInviteByLogin,
  listInviteDiscoveryForLogin,
  listPendingInvites,
  revokeInvite,
} from "./invite-store";
import {
  fetchAppInstallations,
  fetchAppMetadata,
  fetchAppVisibility,
  fetchInstallationRepositories,
  isGithubMetadataStale,
  fetchInstallationAccount,
  mintInstallationAccessToken,
  mintInstallationJwt,
  type InstallationRepository,
} from "./github-app-metadata";
import { SecretboxKeyError, createSecretbox } from "./secretbox";
import {
  CLOUDFLARE_ACCOUNT_ID_PATTERN,
  CUSTOM_PROVIDER_API_IDS,
  CUSTOM_PROVIDER_ID_PATTERN,
  DEFAULT_CHAIN_NAME,
  InvalidCustomProviderError,
  isValidCustomProviderBaseUrl,
  MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH,
  MAX_CUSTOM_PROVIDER_COUNT,
  MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH,
  MAX_MODEL_CHAIN_NAME_LENGTH,
  MAX_MODEL_SELECTOR_LENGTH,
  MAX_KEYS_PER_PROVIDER,
  MAX_PROVIDER_KEY_LENGTH,
  MODEL_CHAIN_NAME_PATTERN,
  MODEL_ROLE_IDS,
  PROVIDER_IDS,
  PROVIDER_META,
  ProviderEndpointLockedError,
  ProviderKeyLimitError,
  createAppConfigStore,
  parseModelChain,
  type AppConfigBatchFace,
  type AppConfigStore,
  type BotWriteAuthority,
  type CustomProviderApi,
  type CustomProviderModelMeta,
  type CustomProviderModelsMeta,
} from "./app-config-store";
import { LEGACY_PROVIDER_IDS } from "../contracts/provider-catalog.generated";
import { isFindingSeverity } from "../contracts/finding-severity";
import { MAX_CUSTOM_PROVIDER_MODEL_IDS } from "../contracts/provider-models";
import { enabledSandboxImages, getSandboxImage } from "../contracts/sandbox-images";
import { isCommandConfigKey } from "../../packages/shared/src/credential-key";
import { composeModelOptions, findFailingSelector } from "./model-membership";
import {
  fetchDeclaredProviderModels,
  modelIdsForProtocol,
  verifyFetch,
  verifyProviderKey,
  type VerifyFailureReason,
} from "./provider-verify";
import { endpointHost, probeProviderUsage, usageProbeHosts } from "./provider-usage";
import {
  countUsers,
  deleteWorkspaceMember,
  getUserByLogin,
  isLoginRemoved,
  parseLoginList,
  signInDashboardUser,
  updateWorkspaceMemberRole,
  type DashboardD1,
  type DashboardUserRow,
} from "./users";
import {
  hasValidGrant,
  insertAuditEvent,
  listActiveSupportGrants,
  listAuditEvents,
} from "./operator-store";
import { isFlagEnabled } from "../admin/flags";
import {
  errorPage,
  forbiddenPage,
  maintenancePage,
  manifestConfirmPage,
  manifestErrorPage,
  manifestOnboardingPage,
  manifestStartPage,
  notFoundPage,
  removedPage,
} from "./views";
import { clampWindow, createInsightsStore } from "./insights-store";
import {
  CONCURRENCY_MIN,
  RuntimeConfigError,
  UnknownWorkspaceError,
  WORKSPACE_CONCURRENCY_MAX,
  getMaintenanceMode,
  getWorkspaceCheckMinScore,
  getWorkspaceConcurrency,
  isConcurrencyValue,
  maintenanceClosed,
  readDefaultReviewLevel,
  readOfficialWorkspaceId,
  setWorkspaceConcurrency,
  type DegradedReason,
  type MaintenanceMode,
} from "./runtime-config-store";
import { readTargetTokenUsage } from "./token-usage-store";
import { isReviewLevel, type ReviewLevel } from "../../packages/shared/src/runtime";
import {
  CHECK_MIN_SCORE_MAX,
  CHECK_MIN_SCORE_MIN,
  isCheckMinScoreValue,
} from "../contracts/review-gate";
import { isLocale, resolveLocale, serializeLocaleCookie, t, type DictionaryKey, type Locale } from "../i18n";
import {
  RESERVED_WORKSPACE_SLUGS,
  WORKSPACE_FAMILY_SEGMENTS,
  reposHomePath,
  wantsHtml,
} from "../spa/routes";
import { SPA_POST_FORM_HEADER, SPA_POST_FORM_VALUE } from "../spa/post-form-headers";

type WorkspacePrincipal =
  | "member"
  | "invitee"
  | "operator-granted"
  | "operator-denied"
  | "outsider";

/**
 * Per-request values the workspace tenancy middleware attaches: `tenant`
 * exists only on a workspace path (the workspace ref was classified from the
 * first path segment). The routing gate classifies WITHOUT a database read (an
 * anonymous request must not learn whether a workspace exists or pay a D1
 * round trip);
 * `workspaceScope` then resolves the live workspace and the caller's principal
 * after the session and user row are known.
 */
export type DashboardVariables = {
  tenant?: {
    ref: string;
    workspaceId: string | null;
    workspaceRow?: WorkspaceRow;
    role: WorkspaceRole | null;
    principal: WorkspacePrincipal | null;
  };
  authUser?: DashboardUserRow;
  authSession?: SessionPayload;
  authWorkspace?: { workspace: WorkspaceRow; role: WorkspaceRole | null };
  workspaceScope?: WorkspaceScope | null;
  maintenance?: MaintenanceMode;
};

type DashboardContext = Context<{ Bindings: Env; Variables: DashboardVariables }>;

type WorkspaceScope = { workspaceId: string; role: WorkspaceRole };

export const dashboardApp = new Hono<{ Bindings: Env; Variables: DashboardVariables }>();

const DASHBOARD_SHELL_REDIRECT = "/dashboard";
const REPOS_LIST_REDIRECT = "/dashboard/repos";
const APPS_LIST_REDIRECT = "/dashboard/apps";

function scopedAppPath(c: DashboardContext, path: string): string {
  const tenant = c.get("tenant");
  if (!tenant) return path;
  const inFamily = [REPOS_LIST_REDIRECT, APPS_LIST_REDIRECT].some(
    (base) => path === base || path.startsWith(`${base}/`),
  );
  return inFamily ? `/dashboard/${tenant.ref}${path.slice(DASHBOARD_MOUNT.length)}` : path;
}

/**
 * The workspace ref a platform operator is visiting under a live support
 * grant, or null when this login is not such a visitor: the shell asks the ONE
 * classifier the gate uses ({@link classifyWorkspacePrincipal}), so the boot
 * and the request can never disagree about who the caller is.
 *
 * Every fact the decision needs — the workspace row, the login's membership
 * role and its users row — is already in {@link workspaceBoot}'s result, so
 * this reads nothing of its own. An unresolved workspace, a membership, a live
 * invite, no grant and a lapsed grant all answer null — and the shell then
 * behaves exactly as before.
 */
export async function operatorSupportWorkspace(
  env: Env,
  boot: WorkspaceBoot,
): Promise<string | null> {
  const access = boot.access;
  if (access === null || access === undefined || access.user === null) return null;
  if (!isPlatformOperator(env, access.user.github_login)) return null;
  const db = dashboardD1(env);
  if (db === null) return null;
  const { principal } = await classifyWorkspacePrincipal(
    env,
    db,
    access,
    access.user,
    new Date().toISOString(),
    access.role,
  );
  return principal === "operator-granted" ? access.id : null;
}

/**
 * The boot result: the extras the SPA shell reads plus the ONE workspace-access
 * resolution they were derived from.
 */
export type WorkspaceBoot = {
  workspaceRef?: string;
  canCreateApp?: boolean;
  needsWorkspace?: boolean;
  workspaceRequired?: boolean;
  access: WorkspaceAccess | null;
  memberships: WorkspaceMembershipOption[];
};

/**
 * The boot extras for one signed-in login: whether the login belongs to no
 * live workspace yet, the workspace ref the SHELL should navigate with, and
 * whether this login may run the App-creation flow.
 *
 * `requestedRef` is the workspace the request addresses — the `/:workspaceRef`
 * segment of the page that carries the shell. Creation is judged in THAT
 * workspace (owner/admin there), because the App the flow creates lands there.
 * A request that names no workspace (the root workbench, `/index.html`, a
 * client-side navigation whose boot outlived its pathname) falls back to the
 * deployment's sole workspace, and only when the deployment really has one:
 * several workspaces leave nothing to attribute the App to, so the shell says
 * so instead of guessing.
 *
 * An unbound store answers nothing at all: storage is a configuration failure,
 * not a permission answer, and every caller already has its own honest
 * `db_unbound` outcome — `/manifest/start` 500s before minting a slug or
 * cookie, the callback parks the hold and serves the resumable confirm link
 * (QC F-005), and confirm keeps the hold. Reporting `canCreateApp: false` here
 * would 403 a storage outage and burn the only copy of the App credentials.
 */
export async function workspaceBoot(
  env: Env,
  login: string,
  requestedRef?: string,
): Promise<WorkspaceBoot> {
  const db = dashboardD1(env);
  if (db === null) return { access: null, memberships: [] };
  const [access, memberships] = await Promise.all([
    requestedRef === undefined
      ? getSoleWorkspaceAccess(db, login)
      : getWorkspaceAccessByRef(db, requestedRef, login),
    listWorkspaceMembershipOptions(db, login),
  ]);
  const boot = { access, memberships };
  if (memberships.length === 0) return { ...boot, canCreateApp: false, needsWorkspace: true };
  if (access !== null) {
    return {
      ...boot,
      workspaceRef: access.id,
      canCreateApp: canManageRole(access.role),
    };
  }
  if (requestedRef !== undefined) return { ...boot, canCreateApp: false };
  if ((await countLiveWorkspaces(db)) > 1) {
    return { ...boot, workspaceRequired: true, canCreateApp: false };
  }
  return { ...boot, canCreateApp: false };
}

/**
 * The signed-in login's live workspace memberships as the SPA boot's switcher
 * rows (`{id, slug, name, role, plan}`) — the shell's only source of a
 * workspace ref and of the caller's role there. An unbound store answers `[]`.
 *
 * `plan` answers the top bar's chip for EVERY row, not just the addressed
 * workspace: a switch only rewrites the URL and never re-boots, so the chip
 * must read the plan of whichever workspace the URL then names. Both modes
 * carry it (D16: the mode gates rendering, never the payload) — `self-hosted`
 * resolves `Unlimited` before any DB read.
 *
 * The plans are resolved for the whole list at once ({@link resolveWorkspacePlans}),
 * so the switcher costs one subscription read however many workspaces it names;
 * resolving row by row would repeat that read per row.
 */
export async function workspaceMembershipsWithPlans(
  env: Env,
  rows: WorkspaceMembershipOption[],
): Promise<Array<WorkspaceMembershipOption & { plan: string }>> {
  const db = dashboardD1(env);
  if (db === null) return [];
  const mode = deploymentModeOf(env.DEPLOYMENT_MODE);
  const plans = await resolveWorkspacePlans(
    db,
    rows.map((row) => row.id),
    mode,
  );
  return rows.map((row) => ({ ...row, plan: plans.get(row.id)!.name }));
}

/**
 * The signed-in login's live pending invitations — the invitee's discovery
 * surface in the SPA boot, so an invited outsider sees a path to accept without
 * knowing the workspace's ref (they are not a member yet).
 *
 * An unbound store answers `[]` (no discovery is possible, not "no invite");
 * the accept POST still fails closed on its own storage check.
 */
export async function pendingInvitesForLogin(
  env: Env,
  login: string,
): Promise<Array<{ workspaceRef: string; inviteId: string; role: "admin" | "member"; expiresAt: string }>> {
  const db = dashboardD1(env);
  if (db === null) return [];
  return listInviteDiscoveryForLogin(db, login, new Date().toISOString());
}

type CreationTarget =
  | { kind: "ok"; workspaceId: string; workspaceRef: string }
  | { kind: "denied" }
  | { kind: "workspace_required" }
  | { kind: "db_unbound" };

async function resolveCreationTarget(
  env: Env,
  login: string,
  requestedRef: string | undefined,
  byId = false,
): Promise<CreationTarget> {
  const db = dashboardD1(env);
  if (db === null) return { kind: "db_unbound" };
  const access =
    requestedRef === undefined
      ? await getSoleWorkspaceAccess(db, login)
      : byId
        ? await getWorkspaceAccessById(db, requestedRef, login)
        : await getWorkspaceAccessByRef(db, requestedRef, login);
  if (access === null) {
    if (requestedRef === undefined && (await countLiveWorkspaces(db)) > 1) {
      return { kind: "workspace_required" };
    }
    return { kind: "denied" };
  }
  if (!canManageRole(access.role)) return { kind: "denied" };
  return { kind: "ok", workspaceId: access.id, workspaceRef: access.id };
}

function creationRefusal(
  c: DashboardContext,
  login: string,
  target: Exclude<CreationTarget, { kind: "ok" | "db_unbound" }>,
): Response {
  const locale = requestLocale(c);
  switch (target.kind) {
    case "workspace_required":
      return creationDeniedResponse(c, t(locale, "manifest.error.workspaceRequired"));
    case "denied":
      return c.html(forbiddenPage(login, locale), 403);
  }
}

function creationDeniedResponse(c: DashboardContext, message: string): Response {
  if (!wantsHtml(c.req.header("Accept") ?? null) && !wantsHtmlFormNavigation(c)) {
    return c.json({ code: "workspace_required", message }, 409);
  }
  return c.html(manifestErrorPage(message, false, requestLocale(c)), 409);
}

function floorRepairLink(
  locale: Locale,
  target: CreationTarget,
): { phrase: string; text: string; href: string; end: string } | null {
  return target.kind === "ok"
    ? {
        phrase: t(locale, "manifest.error.floorRepair"),
        text: t(locale, "manifest.error.floorRepairLink"),
        href: `/dashboard/${target.workspaceRef}/settings`,
        end: t(locale, "manifest.error.floorRepairEnd"),
      }
    : null;
}

function workspaceFloorUnreadablePage(
  locale: Locale,
  reason: DegradedReason | undefined,
  target: CreationTarget,
): string {
  if (reason === "read-failed") {
    return manifestErrorPage(t(locale, "manifest.error.workspaceFloorReadFailed"), true, locale);
  }
  if (reason === "malformed") {
    return manifestErrorPage(t(locale, "manifest.error.workspaceFloorMalformed"), true, locale);
  }
  return manifestErrorPage(
    t(locale, "manifest.error.workspaceFloorUnreadable"),
    true,
    locale,
    floorRepairLink(locale, target),
  );
}

/**
 * The post-authentication landing page. `/dashboard` (the root workbench) has
 * no workspace segment, so its data reads have no base to hang off; every
 * signed-in producer (OAuth callback, the login bounce) names a workspace route
 * instead.
 *
 * A login with NO live membership never lands on a workspace page: it would
 * answer the outsider 404, so sign-in ends on `/dashboard`, whose shell offers
 * workspace creation. A multi-workspace deployment has no sole workspace, so
 * the landing names the login's OWN first membership — a real route, and the
 * order (`name`, then `id`) is stable, so the same login lands in the same
 * place. The switcher keeps offering every other membership from there.
 */
export async function signedInLanding(
  env: Env,
  login: string,
  boot?: WorkspaceBoot,
): Promise<string> {
  const extras = boot ?? (await workspaceBoot(env, login));
  if (extras.workspaceRef !== undefined) return reposHomePath(extras.workspaceRef);
  if (extras.needsWorkspace === true) return DASHBOARD_MOUNT;
  const first = extras.memberships[0];
  if (first !== undefined) return reposHomePath(first.id);
  console.warn(JSON.stringify({ event: "dashboard_landing", reason: "no_sole_workspace" }));
  return DASHBOARD_MOUNT;
}

type ManifestSuccessTarget = { kind: "ok"; path: string } | { kind: "workspace_gone" };

async function manifestSuccessTarget(
  env: Env,
  workspaceId: string,
  githubAppId: number,
): Promise<ManifestSuccessTarget> {
  const db = dashboardD1(env);
  const workspace = db === null || workspaceId === "" ? null : await getWorkspaceByRef(db, workspaceId);
  if (workspace === null) return { kind: "workspace_gone" };
  return { kind: "ok", path: `/dashboard/${workspace.id}/apps/${githubAppId}/onboarding` };
}

function isSpaFetchPost(c: DashboardContext): boolean {
  return c.req.header(SPA_POST_FORM_HEADER) === SPA_POST_FORM_VALUE;
}

function wantsHtmlFormNavigation(c: DashboardContext): boolean {
  return wantsHtml(c.req.header("Accept") ?? null) && !isSpaFetchPost(c);
}

function pinnedPostMutationResponse(
  c: DashboardContext,
  redirectTo: string,
  message: string,
  status: 200 | 400 | 404 | 409 | 500 = 200,
): Response {
  const htmlNavigation = wantsHtmlFormNavigation(c);
  if (status === 404 && c.get("tenant")) {
    return htmlNavigation ? c.html(notFoundPage(requestLocale(c)), 404) : c.text(message, status);
  }
  if (htmlNavigation) {
    return c.redirect(scopedAppPath(c, redirectTo), 302);
  }
  return c.text(message, status);
}

function requestLocale(c: DashboardContext): Locale {
  return resolveLocale(c.req.raw);
}


function dashboardSecrets(env: Env) {
  const clientId = env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = env.GITHUB_OAUTH_CLIENT_SECRET;
  const sessionSecret = env.DASHBOARD_SESSION_SECRET;
  return clientId && clientSecret && sessionSecret ? { clientId, clientSecret, sessionSecret } : null;
}

type DashboardDb = DashboardD1 & AppConfigBatchFace;

function dashboardD1(env: Env): DashboardDb | null {
  const db = (env as Env & { DB?: DashboardDb }).DB;
  return db ?? null;
}


function errorTypeName(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}

function isAppsUniqueViolation(err: unknown, column: "github_app_id"): boolean {
  // 0115 moved the credential row (and its UNIQUE) to github_apps; the
  // bot-era prefix stays matched so a pre-migration world still classifies.
  return (
    err instanceof Error &&
    (err.message.includes(`github_apps.${column}`) || err.message.includes(`review_bots.${column}`))
  );
}

const DASHBOARD_MOUNT = "/dashboard";

function isRetiredAppPath(pathname: string): boolean {
  const relative = pathname.startsWith(`${DASHBOARD_MOUNT}/`)
    ? pathname.slice(DASHBOARD_MOUNT.length)
    : pathname;
  const [, first, second] = relative.split("/");
  return (first === "apps" && second !== undefined) || (first === "api" && second === "apps");
}

const WORKSPACE_SEGMENTS: ReadonlySet<string> = new Set(
  WORKSPACE_FAMILY_SEGMENTS.filter((segment) => segment !== "settings" && segment !== "repos"),
);

function classifyDashboardPath(pathname: string): { kind: "workspace"; ref: string } | { kind: "other" } {
  const relative =
    pathname === DASHBOARD_MOUNT || pathname.startsWith(`${DASHBOARD_MOUNT}/`)
      ? pathname.slice(DASHBOARD_MOUNT.length)
      : pathname;
  const [, first, second] = relative.split("/");
  if (
    first !== undefined &&
    !RESERVED_WORKSPACE_SLUGS.has(first) &&
    second !== undefined &&
    WORKSPACE_SEGMENTS.has(second)
  ) {
    return { kind: "workspace", ref: first };
  }
  return { kind: "other" };
}

async function tenantNotFound(c: DashboardContext): Promise<Response> {
  return wantsHtml(c.req.header("Accept") ?? null)
    ? c.html(notFoundPage(requestLocale(c)), 404)
    : await c.notFound();
}

/**
 * The maintenance window's answer, split by surface: every `/api/` path
 * (`/dashboard/api/*` and `/dashboard/<ref>/api/*`) answers the documented JSON
 * so the SPA parses a state, and every page answers the J7 HTML (operator
 * reason + start time, no ETA promise).
 */
export function maintenanceResponse(c: DashboardContext, mode: MaintenanceMode): Response {
  c.header("Cache-Control", "private, no-store");
  return /^\/dashboard\/(?:api\/|[^/]+\/api\/)/.test(c.req.path)
    ? c.json({ maintenance: true, reason: mode.reason, since: mode.since }, 503)
    : c.html(maintenancePage(mode.reason, mode.since, requestLocale(c)), 503);
}

/**
 * The maintenance gate (D20) — the ONE middleware both dashboard mounts use.
 * Every workspace route table `access` class is unchanged: this gate sits
 * ahead of dispatch, so it closes the surface wholesale rather than widening
 * or narrowing any route's declared access.
 *
 * Mounted twice, for the same reason `dashboardTenantGate` is: the SPA shell
 * pages are answered by `spaDispatch` in `src/worker/index.ts` BEFORE
 * `app.route("/dashboard", dashboardApp)`, so a gate mounted only inside
 * `dashboardApp` would let `GET /dashboard` and every browser page load through
 * while closing the API. The worker mount covers every page and API request;
 * the `dashboardApp` mount (after the workspace/member gate) keeps a direct
 * mount correct. The first run wins, so the read happens once per request.
 *
 * Ungated: `/healthz` is an `app` route and `/_internal_admin/*` mounts on the
 * operator sub-app, so none is under the `/dashboard/*` prefix
 * this gate is mounted on. `/dashboard/login` and `/dashboard/oauth/callback`
 * stay open (the member guard's own exempt pair): the console that reopens the
 * platform needs a session, so an expired cookie must be renewable during the
 * window. Both answer a page the window has nothing to add to.
 * `/dashboard/locale` and `/dashboard/logout` join them
 * ({@link WINDOW_OPEN_PATHS}): the login page this gate still serves carries the
 * EN/中文 toggle, and a closed platform must never trap a cookie on the browser
 * — neither route touches workspace data.
 *
 * The window is read ONCE per request and parked on the context; an unreadable
 * window (`getMaintenanceMode`) counts as CLOSED — the fence around the
 * destructive backfill must not vanish because a settings read broke.
 */
export const dashboardMaintenanceGate: Handler<{
  Bindings: Env;
  Variables: DashboardVariables;
}> = async (c, next) => {
  if (c.get("maintenance") !== undefined) return next();
  if (WINDOW_OPEN_PATHS.has(c.req.path)) return next();
  const db = dashboardD1(c.env);
  const mode =
    db === null
      ? { enabled: false, reason: null, since: null, unreadable: false }
      : await getMaintenanceMode(db);
  c.set("maintenance", mode);
  return maintenanceClosed(mode) ? maintenanceResponse(c, mode) : next();
};

/**
 * The tenant route-family gate. Mounted twice: by `src/worker/index.ts` on
 * `/dashboard/*` BEFORE SPA dispatch (so a retired App HTML request cannot be
 * served by the SPA shell before the 404 decision) and by `dashboardApp` ahead
 * of its routes. It only CLASSIFIES: it issues no D1 read, and the workspace
 * row plus the caller's membership are resolved by the session guard after
 * cookie verification. The first run wins — the second returns on the
 * `tenant` it already set.
 */
export const dashboardTenantGate: Handler<{
  Bindings: Env;
  Variables: DashboardVariables;
}> = async (c, next) => {
  if (c.get("tenant")) return next();
  if (isRetiredAppPath(c.req.path)) return tenantNotFound(c);
  const target = classifyDashboardPath(c.req.path);
  if (target.kind !== "workspace") return next();
  c.set("tenant", {
    ref: target.ref,
    workspaceId: null,
    role: null,
    principal: null,
  });
  return next();
};

dashboardApp.use("*", dashboardTenantGate);

const GUARD_EXEMPT_PATHS = new Set(["/dashboard/login", "/dashboard/oauth/callback"]);

const WINDOW_OPEN_PATHS = new Set([
  ...GUARD_EXEMPT_PATHS,
  "/dashboard/locale",
  "/dashboard/logout",
]);

dashboardApp.use("*", async (c, next) => {
  if (GUARD_EXEMPT_PATHS.has(c.req.path)) return next();
  const sessionSecret = c.env.DASHBOARD_SESSION_SECRET;
  if (!sessionSecret) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), sessionSecret);
  if (!session) {
    if (c.req.path === "/dashboard/locale") return next();
    return c.redirect("/dashboard/login", 302);
  }
  if (c.req.path === "/dashboard/logout" || c.req.path === "/dashboard/locale") return next();
  const db = dashboardD1(c.env);
  if (!db) {
    if (c.req.path === "/dashboard/manifest/callback" || c.req.path === "/dashboard/manifest/confirm") {
      return next();
    }
    return c.text("dashboard storage is not configured", 500);
  }
  const tenant = c.get("tenant");
  const access = tenant ? await getWorkspaceRequestAccess(db, session.login, tenant.ref) : null;
  const user = tenant ? access?.user : await getUserByLogin(db, session.login);
  if (!user) {
    console.warn(
      JSON.stringify({
        event: "dashboard_access",
        stage: "guard",
        reason: "not_a_member",
        login: session.login,
      }),
    );
    c.header("Set-Cookie", expireCookie(SESSION_COOKIE));
    if (wantsHtmlFormNavigation(c)) {
      return c.redirect("/dashboard/login", 302);
    }
    return c.html(removedPage(session.login, requestLocale(c)), 403);
  }
  c.set("authUser", user);
  c.set("authSession", session);
  if (access?.workspace) c.set("authWorkspace", { workspace: access.workspace, role: access.role });
  return next();
});

async function classifyWorkspacePrincipal(
  env: Env,
  db: DashboardDb,
  workspace: { id: string },
  user: { id: string; github_login: string },
  now: string,
  role: WorkspaceRole | null,
): Promise<{ principal: WorkspacePrincipal; role: WorkspaceRole | null }> {
  if (role !== null) return { principal: "member", role };
  const invited = await getPendingInviteByLogin(db, workspace.id, user.github_login, now);
  if (invited !== null) return { principal: "invitee", role: null };
  if (!isPlatformOperator(env, user.github_login)) return { principal: "outsider", role: null };
  const granted = await hasValidGrant(db, workspace.id, user.github_login, now);
  return { principal: granted ? "operator-granted" : "operator-denied", role: null };
}

dashboardApp.use("/:workspaceRef/api/*", async (c, next) => {
  c.header("Cache-Control", "private, no-store");
  return next();
});

dashboardApp.use("*", async (c, next) => {
  if (c.get("workspaceScope") !== undefined) return next();
  const tenant = c.get("tenant");
  const db = dashboardD1(c.env);
  const access = c.get("authWorkspace");
  const user = c.get("authUser");
  if (!tenant || !db || !access || !user) {
    c.set("workspaceScope", null);
    return next();
  }
  const { workspace } = access;
  const now = new Date().toISOString();
  const { principal, role } = await classifyWorkspacePrincipal(c.env, db, workspace, user, now, access.role);
  if (role !== null) {
    c.set("tenant", { ref: tenant.ref, workspaceId: workspace.id, workspaceRow: workspace, role, principal });
    c.set("workspaceScope", { workspaceId: workspace.id, role });
    return next();
  }
  if (principal === "operator-denied") {
    await insertAuditEvent(db, {
      workspaceId: workspace.id,
      actorLogin: user.github_login,
      action: "support.denied",
      now,
    });
    c.set("tenant", { ref: tenant.ref, workspaceId: workspace.id, workspaceRow: workspace, role: null, principal });
    c.set("workspaceScope", null);
    return await tenantNotFound(c);
  }
  if (principal === "operator-granted") {
    const read = isOperatorReadPath(c.req.path, c.req.method);
    await insertAuditEvent(db, {
      workspaceId: workspace.id,
      actorLogin: user.github_login,
      action: read ? "support.read" : "support.forbidden",
      now,
    });
    c.set("tenant", { ref: tenant.ref, workspaceId: workspace.id, workspaceRow: workspace, role: null, principal });
    c.set("workspaceScope", null);
    if (!read) return c.json({ error: "forbidden" }, 403);
    return next();
  }
  c.set("tenant", {
    ref: tenant.ref,
    workspaceId: workspace.id,
    workspaceRow: workspace,
    role: null,
    principal,
  });
  c.set("workspaceScope", null);
  return next();
});

dashboardApp.use("*", dashboardMaintenanceGate);

/**
 * Platform-operator allowlist membership — NOCASE, same parser as every login
 * list. The ONE allowlist predicate: the admin gate (`src/admin/gate.ts`)
 * imports this rather than restating it.
 */
export function isPlatformOperator(env: Env, login: string): boolean {
  return parseLoginList(env.PLATFORM_OPERATORS).some(
    (entry) => entry.toLowerCase() === login.toLowerCase(),
  );
}

function isOperatorReadPath(path: string, method: string): boolean {
  const routeMethod = method === "HEAD" ? "get" : method.toLowerCase();
  return APP_ROUTES.some(
    (route) => route.access === "read" && route.method === routeMethod && path.endsWith(route.path),
  );
}

async function startOAuthLogin(c: DashboardContext): Promise<Response> {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (session) return c.redirect(await signedInLanding(c.env, session.login), 302);
  const state = await createStateValue(secrets.sessionSecret);
  c.header("Set-Cookie", serializeCookie(OAUTH_STATE_COOKIE, state, OAUTH_STATE_MAX_AGE_SEC));
  const callbackUri = `${new URL(c.req.url).origin}/dashboard/oauth/callback`;
  return c.redirect(buildAuthorizeUrl(secrets.clientId, callbackUri, state), 302);
}

dashboardApp.get("/login", startOAuthLogin);
dashboardApp.post("/login", startOAuthLogin);

dashboardApp.get("/oauth/callback", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const bindCookie = getCookie(c, BIND_STATE_COOKIE);
  if (bindCookie !== undefined && bindCookie === c.req.query("state")) {
    return completeInstallationBind(c, secrets, bindCookie);
  }
  c.header("Set-Cookie", expireCookie(OAUTH_STATE_COOKIE));
  const stateOk = await verifyStateValue(
    getCookie(c, OAUTH_STATE_COOKIE),
    c.req.query("state"),
    secrets.sessionSecret,
  );
  if (!stateOk) {
    logOAuthFailure("state_verify", "state_mismatch");
    return c.html(errorPage(t(requestLocale(c), "common.oauth.stateInvalid"), requestLocale(c)), 400);
  }
  const code = c.req.query("code");
  if (!code) {
    logOAuthFailure("callback", "missing_code");
    return c.html(errorPage(t(requestLocale(c), "common.oauth.missingCode"), requestLocale(c)), 400);
  }
  if (!GITHUB_CODE_SHAPE.test(code)) {
    logOAuthFailure("callback", "unsafe_code_shape");
    return c.html(errorPage(t(requestLocale(c), "common.oauth.codeRejected"), requestLocale(c)), 400);
  }
  const callbackUri = `${new URL(c.req.url).origin}/dashboard/oauth/callback`;
  const token = await exchangeCodeForToken(code, secrets.clientId, secrets.clientSecret, callbackUri);
  if (!token) {
    return c.html(errorPage(t(requestLocale(c), "common.oauth.codeRejected"), requestLocale(c)), 502);
  }
  const user = await fetchGitHubUser(token);
  if (!user) {
    return c.html(errorPage(t(requestLocale(c), "common.oauth.profileFailed"), requestLocale(c)), 502);
  }
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  let deploymentMode: DeploymentMode;
  try {
    deploymentMode = deploymentModeOf(c.env.DEPLOYMENT_MODE);
  } catch (error) {
    return c.text((error as Error).message, 500);
  }
  const emptyInstance = deploymentMode === "self-hosted" && (await countUsers(db)) === 0;
  if (!(await isFlagEnabled(db, "signup_open")) && (await getUserByLogin(db, user.login)) === null) {
    logOAuthFailure("sign_in", "signup_closed", { login: user.login });
    c.header("Set-Cookie", undefined);
    return c.html(errorPage(t(requestLocale(c), "common.oauth.signupClosed"), requestLocale(c)), 403);
  }
  const decision = await signInDashboardUser(db, user.login);
  if (decision.outcome === "deny") {
    logOAuthFailure("sign_in", "removed", { login: user.login });
    c.header("Set-Cookie", undefined);
    return c.html(removedPage(user.login, requestLocale(c)), 403);
  }
  const session = await createSessionValue(user.login, user.name, secrets.sessionSecret);
  c.header("Set-Cookie", serializeCookie(SESSION_COOKIE, session, SESSION_MAX_AGE_SEC), {
    append: true,
  });
  const landing = await signedInLanding(c.env, user.login);
  if (emptyInstance && decision.created) {
    c.header(
      "Set-Cookie",
      serializeCookie(
        FIRST_INSTANCE_COOKIE,
        await createFirstInstanceValue(user.login, secrets.sessionSecret),
        FIRST_INSTANCE_MAX_AGE_SEC,
      ),
      { append: true },
    );
  }
  return c.redirect(landing, 302);
});

dashboardApp.get("/logout", (c) => {
  c.header("Set-Cookie", expireCookie(SESSION_COOKIE));
  c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
  c.header("Set-Cookie", expireCookie(MANIFEST_STATE_COOKIE), { append: true });
  return c.redirect("/dashboard/login", 302);
});

const WORKSPACE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const WORKSPACE_ID_ATTEMPTS = 6;
export const WORKSPACE_NAME_MAX_LENGTH = 80;

function createWorkspaceId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(22));
  const suffix = Array.from(
    bytes,
    (b) => WORKSPACE_ID_ALPHABET[b % WORKSPACE_ID_ALPHABET.length]!,
  ).join("");
  return `ws_${suffix}`;
}

dashboardApp.post("/api/workspaces", async (c) => {
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  const user = c.get("authUser");
  if (!user) return c.redirect("/dashboard/login", 302);
  const form = await c.req.parseBody();
  const name = typeof form.name === "string" ? form.name.trim() : "";
  if (name.length === 0) return c.text("Enter a workspace name.", 400);
  if (name.length > WORKSPACE_NAME_MAX_LENGTH) {
    return c.text(`Workspace name must be at most ${WORKSPACE_NAME_MAX_LENGTH} characters.`, 400);
  }
  const mode = deploymentModeOf(c.env.DEPLOYMENT_MODE);
  try {
    if (!(await isFlagEnabled(db, "workspace_creation_open"))) {
      return c.text(WORKSPACE_CREATION_CLOSED_REFUSAL, 409);
    }
    if (mode === "saas") {
      const verdict = await checkEntitlement({
        db,
        mode,
        workspaceId: null,
        kind: "free-workspace-slot",
        freeMembershipCount: () => countFreeMembershipsForLogin(db, user.github_login),
      });
      if (!verdict.ok) throw new FreeWorkspaceSlotError(FREE_SLOT_REFUSAL);
    }
    const createdAt = new Date().toISOString();
    for (let attempt = 0; attempt < WORKSPACE_ID_ATTEMPTS; attempt++) {
      const id = createWorkspaceId();
      const created = await createWorkspace(
        db,
        {
          id,
          name,
          userId: user.id,
          githubLogin: user.github_login,
          createdAt,
        },
        mode,
      );
      if (created) {
        return c.json(
          { id, slug: id, name, role: "owner" as const, homePath: reposHomePath(id) },
          201,
        );
      }
    }
    return c.text("Could not allocate a workspace id — try again.", 500);
  } catch (err) {
    if (err instanceof FreeWorkspaceSlotError) return c.text(err.message, 409);
    throw err;
  }
});


/**
 * Safe 302 target for the locale toggle. The Referer header is
 * attacker-influenced (open-redirect surface): EVERY non-empty value is
 * parsed with `new URL(referer, origin)` — never echoed raw — and accepted
 * only when the resolved origin equals the request origin AND the resulting
 * pathname+search starts with `/` without a `//` prefix (a `//` pathname is
 * protocol-relative, e.g. `https://origin/\evil.example` normalizes to
 * `//evil.example`). Missing/empty Referer, off-origin URLs, protocol-
 * relative `//host`, backslash-authority tricks (`/\evil.example` parses as
 * `https://evil.example/`), and unparseable junk all fall back to
 * /dashboard. Never echoes an absolute or protocol-relative URL.
 */
function safeLocaleRedirect(referer: string | null | undefined, origin: string): string {
  if (!referer) return "/dashboard";
  try {
    const url = new URL(referer, origin);
    if (url.origin === origin) {
      const path = `${url.pathname}${url.search}`;
      if (path.startsWith("/") && !path.startsWith("//")) return path;
    }
  } catch {
  }
  return "/dashboard";
}

async function readLocaleFromBody(c: DashboardContext): Promise<Locale | null> {
  const contentType = c.req.header("Content-Type") ?? "";
  try {
    if (contentType.includes("application/json")) {
      const body = (await c.req.json()) as { locale?: unknown };
      return isLocale(body.locale) ? body.locale : null;
    }
    const form = await c.req.parseBody();
    return isLocale(form.locale) ? form.locale : null;
  } catch {
    return null;
  }
}

dashboardApp.post("/locale", async (c) => {
  const locale = await readLocaleFromBody(c);
  if (!locale) return c.text("invalid locale", 400);
  c.header("Set-Cookie", serializeLocaleCookie(locale));
  const location = safeLocaleRedirect(c.req.header("Referer"), new URL(c.req.raw.url).origin);
  return c.redirect(location, 302);
});


// Start: logged-in only. The SPA's create form posts under the workspace page
// it is on (`/:workspaceRef/manifest/start`), so the target workspace comes
// from the request itself; the deployment-level path resolves the sole
// workspace instead. Then: mint the row id (a UUID — the manifest form needs
// the hook URL before GitHub creates the App, and this id is the URL's app
// segment) and the single-use CSRF state cookie CARRYING both that id and the
// target workspace (createManifestStateValue — same createStateValue HMAC
// discipline), and render the zero-JS form POST to
// https://github.com/settings/apps/new (state rides the form-action query).
// The manifest's webhook URL is the App's own route
// /webhook/{workspaceId}/{appId}.
// Logged out → 302 to login (IA routing table).
async function manifestStartRoute(c: DashboardContext, workspaceRef: string | undefined): Promise<Response> {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const target = await resolveCreationTarget(c.env, session.login, workspaceRef);
  if (target.kind === "db_unbound") return c.text("dashboard storage is not configured", 500);
  if (target.kind !== "ok") return creationRefusal(c, session.login, target);
  const appId = crypto.randomUUID();
  const state = await createManifestStateValue(secrets.sessionSecret, appId, target.workspaceId);
  c.header("Set-Cookie", serializeCookie(MANIFEST_STATE_COOKIE, state, MANIFEST_STATE_MAX_AGE_SEC));
  const manifest = buildManifest(
    new URL(c.req.url).origin,
    session.login,
    target.workspaceId,
    appId,
  );
  return c.html(
    manifestStartPage(
      session,
      manifest.name,
      JSON.stringify(manifest),
      buildManifestCreateUrl(state),
      requestLocale(c),
      target.workspaceRef,
    ),
  );
}

dashboardApp.post("/manifest/start", (c) => manifestStartRoute(c, undefined));
dashboardApp.post("/:workspaceRef/manifest/start", (c) => manifestStartRoute(c, c.req.param("workspaceRef")));

dashboardApp.get("/manifest/callback", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  c.header("Set-Cookie", expireCookie(MANIFEST_STATE_COOKIE));
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const state = await readManifestStateValue(
    getCookie(c, MANIFEST_STATE_COOKIE),
    c.req.query("state"),
    secrets.sessionSecret,
  );
  if (!state) {
    logManifestFailure("state_verify", "state_mismatch");
    return c.html(
      manifestErrorPage(t(requestLocale(c), "manifest.error.stateMismatch"), false, requestLocale(c)),
      400,
    );
  }
  const target = await resolveCreationTarget(c.env, session.login, state.workspaceId, true);
  if (target.kind === "denied" || target.kind === "workspace_required") {
    logManifestFailure("callback", "not_a_creator");
    return creationRefusal(c, session.login, target);
  }
  const code = c.req.query("code");
  if (!code) {
    logManifestFailure("callback", "missing_code");
    return c.html(manifestErrorPage(t(requestLocale(c), "manifest.error.missingCode"), false, requestLocale(c)), 400);
  }
  if (!GITHUB_CODE_SHAPE.test(code)) {
    logManifestFailure("callback", "unsafe_code_shape");
    return c.html(manifestErrorPage(t(requestLocale(c), "manifest.error.codeRejected"), false, requestLocale(c)), 400);
  }
  const conversion = await exchangeManifestCode(code);
  if (!conversion) {
    return c.html(manifestErrorPage(t(requestLocale(c), "manifest.error.codeRejected"), false, requestLocale(c)), 502);
  }
  const locale = requestLocale(c);
  let mode: DeploymentMode;
  try {
    mode = deploymentModeOf(c.env.DEPLOYMENT_MODE);
  } catch (error) {
    return c.text((error as Error).message, 500);
  }
  const holdPayload = buildHoldPayload(conversion, session.login, state.appId, state.workspaceId);
  const hold = await encryptHoldValue(holdPayload, secrets.sessionSecret);
  const outcome = await commitManifestApp({
    db: dashboardD1(c.env),
    encryptionKey: c.env.DASHBOARD_ENCRYPTION_KEY,
    hold: holdPayload,
    login: session.login,
    workspaceId: target.kind === "ok" ? target.workspaceId : null,
    mode,
  });
  const parkHold = () =>
    c.header("Set-Cookie", serializeCookie(MANIFEST_HOLD_COOKIE, hold, MANIFEST_HOLD_MAX_AGE_SEC), {
      append: true,
    });
  switch (outcome.kind) {
    case "success": {
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
      const target = await manifestSuccessTarget(c.env, outcome.workspaceId, outcome.row.github_app_id);
      if (target.kind === "workspace_gone") {
        logManifestFailure("callback", "workspace_gone");
        return c.html(manifestErrorPage(t(locale, "manifest.error.workspaceGone"), false, locale), 409);
      }
      return c.redirect(target.path, 302);
    }
    case "login_mismatch": {
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
      return c.html(manifestErrorPage(t(locale, "manifest.error.loginMismatch"), false, locale), 403);
    }
    case "db_unbound":
      parkHold();
      return c.html(manifestErrorPage(t(locale, "manifest.error.dbUnbound"), true, locale), 500);
    case "encrypt_failed":
      parkHold();
      return c.html(manifestErrorPage(t(locale, "manifest.error.noEncryptionKey"), true, locale), 500);
    case "already_connected":
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
      return c.html(manifestErrorPage(t(locale, "manifest.error.alreadyConnected"), false, locale), 409);
    case "app_cap_reached":
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
      return c.html(
        manifestErrorPage(t(locale, "manifest.error.appCapReached", { limit: outcome.limit }), false, locale),
        409,
      );
    case "workspace_gate_unreadable":
      parkHold();
      return c.html(workspaceFloorUnreadablePage(locale, outcome.reason, target), 500);
    case "db_rejected":
      parkHold();
      return c.html(manifestErrorPage(t(locale, "manifest.error.dbRejected"), true, locale), 500);
  }
});

dashboardApp.post("/manifest/commit", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const hold = await readHoldValue(getCookie(c, MANIFEST_HOLD_COOKIE), secrets.sessionSecret);
  if (!hold) {
    logManifestFailure("commit", "hold_missing_or_expired");
    c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
    return c.redirect("/dashboard", 302);
  }
  const target = await resolveCreationTarget(c.env, session.login, hold.workspaceId, true);
  if (target.kind === "denied" || target.kind === "workspace_required") {
    logManifestFailure("commit", "not_a_creator");
    return creationRefusal(c, session.login, target);
  }
  const locale = requestLocale(c);
  const outcome = await commitManifestApp({
    db: dashboardD1(c.env),
    encryptionKey: c.env.DASHBOARD_ENCRYPTION_KEY,
    hold,
    login: session.login,
    workspaceId: target.kind === "ok" ? target.workspaceId : null,
    mode: deploymentModeOf(c.env.DEPLOYMENT_MODE),
  });
  switch (outcome.kind) {
    case "success": {
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      const target = await manifestSuccessTarget(c.env, outcome.workspaceId, outcome.row.github_app_id);
      if (target.kind === "workspace_gone") {
        logManifestFailure("commit", "workspace_gone");
        return c.html(manifestErrorPage(t(locale, "manifest.error.workspaceGone"), false, locale), 409);
      }
      return c.redirect(target.path, 302);
    }
    case "login_mismatch": {
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      return c.html(manifestErrorPage(t(locale, "manifest.error.loginMismatch"), false, locale), 403);
    }
    case "db_unbound":
      return c.text("dashboard storage is not configured", 500);
    case "encrypt_failed":
      return c.html(manifestErrorPage(t(locale, "manifest.error.noEncryptionKey"), true, locale), 500);
    case "already_connected":
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      return c.html(manifestErrorPage(t(locale, "manifest.error.alreadyConnected"), false, locale), 409);
    case "app_cap_reached":
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      return c.html(
        manifestErrorPage(t(locale, "manifest.error.appCapReached", { limit: outcome.limit }), false, locale),
        409,
      );
    case "workspace_gate_unreadable":
      return c.html(workspaceFloorUnreadablePage(locale, outcome.reason, target), 500);
    case "db_rejected":
      return c.html(manifestErrorPage(t(locale, "manifest.error.dbRejected"), true, locale), 500);
  }
});


type ManifestCommitOutcome =
  | { kind: "success"; row: GithubAppRow; workspaceId: string }
  | { kind: "login_mismatch" }
  | { kind: "db_unbound" }
  | { kind: "encrypt_failed" }
  | { kind: "already_connected" }
  | { kind: "workspace_gate_unreadable"; reason?: DegradedReason }
  | { kind: "app_cap_reached"; limit: number }
  | { kind: "db_rejected" };

async function commitManifestApp(args: {
  db: DashboardDb | null;
  encryptionKey: string | undefined;
  hold: ManifestHoldPayload;
  login: string;
  workspaceId: string | null;
  mode: DeploymentMode;
}): Promise<ManifestCommitOutcome> {
  const { db, encryptionKey, hold, login, workspaceId, mode } = args;
  if (hold.login !== login) {
    logManifestFailure("commit", "login_mismatch");
    return { kind: "login_mismatch" };
  }
  if (!db || workspaceId === null) return { kind: "db_unbound" };
  let privateKeyEnc: string;
  let webhookSecretEnc: string;
  try {
    const box = createSecretbox(encryptionKey);
    privateKeyEnc = await box.encryptSecret(
      hold.pem,
      `github_apps.private_key_enc:${hold.appId}`,
    );
    webhookSecretEnc = await box.encryptSecret(
      hold.webhook_secret,
      `github_apps.webhook_secret_enc:${hold.appId}`,
    );
  } catch (err) {
    logManifestFailure("commit", "encrypt_failed", {
      error_type: errorTypeName(err),
      key_error: err instanceof SecretboxKeyError,
    });
    return { kind: "encrypt_failed" };
  }
  const apps = createReviewBotsStore(db);
  const workspaceFloor = await getWorkspaceCheckMinScore(db, workspaceId);
  if (workspaceFloor.degraded) {
    logManifestFailure("commit", "db_error", { error_type: "workspace_gate_unreadable" });
    return { kind: "workspace_gate_unreadable", reason: workspaceFloor.reason };
  }
  const verdict = await checkEntitlement({
    db,
    mode,
    workspaceId,
    kind: "app-count",
    liveAppCount: () => apps.countLiveApps(workspaceId),
  });
  if (!verdict.ok && verdict.refusal.kind === "app-count") {
    logManifestFailure("commit", "app_cap_reached", { apps_per_workspace: verdict.refusal.limit });
    return { kind: "app_cap_reached", limit: verdict.refusal.limit };
  }
  try {
    const row = await apps.createApp({
      id: hold.appId,
      githubSlug: hold.slug,
      githubAppId: hold.id,
      name: hold.name,
      privateKeyEnc,
      webhookSecretEnc,
      createdBy: login,
      workspaceId,
      maxApps: verdict.plan.appsPerWorkspace,
    });
    return { kind: "success", row, workspaceId };
  } catch (err) {
    if (err instanceof AppCountExceededError) {
      logManifestFailure("commit", "app_cap_reached", { apps_per_workspace: err.limit });
      return { kind: "app_cap_reached", limit: err.limit };
    }
    if (isAppsUniqueViolation(err, "github_app_id")) {
      logManifestFailure("commit", "github_app_id_conflict", { github_app_id: hold.id });
      return { kind: "already_connected" };
    }
    logManifestFailure("commit", "db_error", { error_type: errorTypeName(err) });
    return { kind: "db_rejected" };
  }
}

dashboardApp.get("/manifest/confirm", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const hold = await readHoldValue(getCookie(c, MANIFEST_HOLD_COOKIE), secrets.sessionSecret);
  if (!hold || hold.login !== session.login) return c.redirect("/dashboard", 302);
  const target = await resolveCreationTarget(c.env, session.login, hold.workspaceId, true);
  if (target.kind === "denied" || target.kind === "workspace_required") {
    c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
    logManifestFailure("confirm", "not_a_creator");
    return creationRefusal(c, session.login, target);
  }
  return c.html(
    manifestConfirmPage(
      session,
      {
        id: hold.id,
        name: hold.name,
        slug: hold.slug,
        webhookUrl: `${new URL(c.req.url).origin}/webhook/${hold.workspaceId}/${hold.appId}`,
      },
      requestLocale(c),
      target.kind === "ok" ? target.workspaceRef : null,
    ),
  );
});

const appOnboardingRoute = async (c: DashboardContext) => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const app = await resolveScopedApp(
    createReviewBotsStore(member.db),
    c.req.param("appId") ?? "",
    member.scope,
  );
  if (!app) {
    return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404);
  }
  if (!canManageApp(member.scope)) {
    return c.html(forbiddenPage(member.session.login, requestLocale(c)), 403);
  }
  const origin = new URL(c.req.url).origin;
  const live = await liveTargetsForBot(member.db, member.scope.workspaceId, app.id);
  return c.html(
    manifestOnboardingPage(
      member.session,
      {
        id: app.github_app_id,
        name: app.name,
        slug: app.github_slug,
        webhookUrl: `${origin}/webhook/${member.scope.workspaceId}/${app.id}`,
      },
      requestLocale(c),
      c.get("tenant")?.ref ?? null,
      live.length === 1 ? live[0]!.id : null,
    ),
  );
};


type AdminGate =
  | {
      ok: true;
      session: SessionPayload;
      db: DashboardDb;
      user: DashboardUserRow;
      scope: WorkspaceScope;
    }
  | { ok: false; response: Response };

const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/;

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function requireAdmin(c: DashboardContext): Promise<AdminGate> {
  const member = await requireMember(c);
  if (!member.ok) return { ok: false, response: member.response };
  const { scope } = member;
  if (scope === null || (scope.role !== "owner" && scope.role !== "admin")) {
    return {
      ok: false,
      response: c.html(forbiddenPage(member.session.login, requestLocale(c)), 403),
    };
  }
  return { ok: true, session: member.session, db: member.db, user: member.user, scope };
}

function inviteMutationResponse(
  c: DashboardContext,
  message: string,
  status: 200 | 400 | 403 | 404 | 409 | 410,
): Response {
  return c.text(message, status);
}

const memberListRoute = async (c: DashboardContext) => {
  const tenant = c.get("tenant");
  if (tenant?.principal === "operator-granted") {
    const db = dashboardD1(c.env);
    if (!db || tenant.workspaceId === null) return await tenantNotFound(c);
    const rows = await listWorkspaceMembers(db, tenant.workspaceId);
    return c.json({
      viewer: { login: c.get("authUser")?.github_login ?? null, role: null },
      members: rows.map((row) => ({ github_login: row.github_login, role: row.role })),
    });
  }
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const members = await listWorkspaceMembers(member.db, member.scope.workspaceId);
  const plan = await resolveWorkspacePlan(
    member.db,
    member.scope.workspaceId,
    deploymentModeOf(c.env.DEPLOYMENT_MODE),
  );
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const reviewAttemptsThisMonth = await countUsageEventsSince(
    member.db,
    member.scope.workspaceId,
    monthStart,
  );
  const seats = await countMembersAndPendingInvites(
    member.db,
    member.scope.workspaceId,
    now.toISOString(),
  );
  const pendingInvites = Math.max(seats - members.length, 0);
  return c.json({
    viewer: { login: member.user.github_login, role: member.scope.role },
    workspace: {
      plan: { id: plan.id, name: plan.name },
      memberLimit: plan.includedMembers,
      reviewAttemptsThisMonth,
      pendingInvites,
    },
    members: members.map((row) => ({
      id: row.id,
      github_login: row.github_login,
      role: row.role,
      created_at: row.created_at,
    })),
  });
};

const inviteListRoute = async (c: DashboardContext) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const now = new Date().toISOString();
  const invites = await listPendingInvites(gate.db, gate.scope.workspaceId, now);
  return c.json({
    invites: invites.map((row) => ({
      id: row.id,
      github_login: row.github_login,
      role: row.role,
      created_at: row.created_at,
      expires_at: row.expires_at,
    })),
  });
};

const inviteCreateRoute = async (c: DashboardContext) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const login = typeof form.login === "string" ? form.login.trim() : "";
  const role = typeof form.role === "string" ? form.role : "member";
  if (role !== "admin" && role !== "member") {
    return inviteMutationResponse(c, "Role must be admin or member.", 400);
  }
  if (login.length === 0) {
    return inviteMutationResponse(c, "Enter a GitHub login to invite.", 400);
  }
  if (!GITHUB_LOGIN_PATTERN.test(login)) {
    return inviteMutationResponse(
      c,
      `${login} is not a valid GitHub login — use 1–39 letters, digits, or hyphens.`,
      400,
    );
  }
  if (await isLoginRemoved(gate.db, login)) {
    return inviteMutationResponse(
      c,
      "invite.login_removed — this login was removed on this deployment; a deployment operator must clear the removal record before it can be invited.",
      409,
    );
  }
  const now = new Date();
  const members = await listWorkspaceMembers(gate.db, gate.scope.workspaceId);
  if (members.some((row) => row.github_login.toLowerCase() === login.toLowerCase())) {
    return inviteMutationResponse(c, "Already a member.", 409);
  }
  try {
    const mode = deploymentModeOf(c.env.DEPLOYMENT_MODE);
    const seats = await countMembersAndPendingInvites(
      gate.db,
      gate.scope.workspaceId,
      now.toISOString(),
    );
    const verdict = await checkEntitlement({
      db: gate.db,
      mode,
      workspaceId: gate.scope.workspaceId,
      kind: "member-slot",
      seats,
    });
    if (!verdict.ok && verdict.refusal.kind === "member-slot") {
      throw new MemberCapError(MEMBER_CAP_REFUSAL(verdict.refusal.limit));
    }
    await createInvite(
      gate.db,
      {
        workspaceId: gate.scope.workspaceId,
        login,
        role,
        invitedBy: gate.user.id,
        now: now.toISOString(),
        expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
      },
      mode,
    );
  } catch (err) {
    if (err instanceof MemberCapError) {
      return inviteMutationResponse(c, err.message, 409);
    }
    if (err instanceof InvitePendingExistsError) {
      return inviteMutationResponse(c, "invite.pending_exists", 409);
    }
    throw err;
  }
  return inviteMutationResponse(c, "ok", 200);
};

const inviteRevokeRoute = async (c: DashboardContext) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const revoked = await revokeInvite(gate.db, gate.scope.workspaceId, c.req.param("id") ?? "");
  if (!revoked) return inviteMutationResponse(c, "unknown invite", 404);
  return inviteMutationResponse(c, "ok", 200);
};

const inviteAcceptRoute = async (c: DashboardContext) => {
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  const tenant = c.get("tenant");
  if (!tenant || tenant.workspaceId === null) return await tenantNotFound(c);
  const user = c.get("authUser");
  if (!user) return await tenantNotFound(c);
  const inviteId = c.req.param("id") ?? "";
  const invite = await getInviteInWorkspace(db, tenant.workspaceId, inviteId);
  if (!invite) return await tenantNotFound(c);

  const now = new Date().toISOString();
  const mode = deploymentModeOf(c.env.DEPLOYMENT_MODE);
  const wouldAccept =
    invite.status === "pending" &&
    invite.expires_at > now &&
    invite.github_login.toLowerCase() === user.github_login.toLowerCase();
  if (wouldAccept) {
    const verdict = await checkEntitlement({
      db,
      mode,
      workspaceId: tenant.workspaceId,
      kind: "free-workspace-slot",
      freeMembershipCount: () => countFreeMembershipsForLogin(db, user.github_login),
    });
    if (!verdict.ok) return inviteMutationResponse(c, INVITE_FREE_SLOT_REFUSAL, 409);
  }

  let outcome: AcceptInviteOutcome;
  try {
    outcome = await acceptInvite(db, inviteId, user.github_login, now, mode);
  } catch (err) {
    if (err instanceof FreeWorkspaceSlotError) {
      return inviteMutationResponse(c, err.message, 409);
    }
    throw err;
  }
  switch (outcome.kind) {
    case "accepted":
      return inviteMutationResponse(c, `ok ${outcome.role}`, 200);
    case "member_cap":
      return inviteMutationResponse(c, ACCEPT_MEMBER_CAP_REFUSAL(outcome.limit), 409);
    case "expired":
      return inviteMutationResponse(c, "invite.expired", 409);
    case "gone":
      return inviteMutationResponse(c, "invite is no longer pending", 410);
    case "not_found":
      return await tenantNotFound(c);
  }
};

const memberRemoveRoute = async (c: DashboardContext) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const userId = typeof form.userId === "string" ? form.userId : "";
  const target = await getWorkspaceMember(gate.db, gate.scope.workspaceId, userId);
  if (!target) {
    return inviteMutationResponse(c, "unknown member", 404);
  }
  if (gate.scope.role === "owner" && target.role === "owner") {
    const owners = (await listWorkspaceMembers(gate.db, gate.scope.workspaceId)).filter(
      (row) => row.role === "owner",
    );
    if (owners.length <= 1) {
      return inviteMutationResponse(c, "Cannot remove the last owner.", 409);
    }
  }
  if (target.github_login.toLowerCase() === gate.user.github_login.toLowerCase()) {
    return inviteMutationResponse(c, "You cannot remove yourself.", 400);
  }
  if (gate.scope.role === "admin" && target.role !== "member") {
    return c.html(forbiddenPage(gate.session.login, requestLocale(c)), 403);
  }
  if (!(await deleteWorkspaceMember(gate.db, gate.scope.workspaceId, target.id))) {
    return inviteMutationResponse(c, "Cannot remove the last owner.", 409);
  }
  return inviteMutationResponse(c, "ok", 200);
};

const workspaceDeleteRoute = async (c: DashboardContext) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  if (gate.scope.role !== "owner") {
    return c.text("Only the workspace owner can delete it.", 403);
  }
  await deleteWorkspace(gate.db, gate.scope.workspaceId, new Date().toISOString());
  return c.json({ deleted: true, next: "/dashboard" }, 200);
};

const memberRoleRoute = async (c: DashboardContext) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const userId = typeof form.userId === "string" ? form.userId : "";
  const role = typeof form.role === "string" ? form.role : "";
  if (role !== "owner" && role !== "admin" && role !== "member") {
    return inviteMutationResponse(c, "Role must be owner, admin or member.", 400);
  }
  const target = await getWorkspaceMember(gate.db, gate.scope.workspaceId, userId);
  if (!target) {
    return inviteMutationResponse(c, "unknown member", 404);
  }
  if (gate.scope.role === "admin") {
    return c.html(forbiddenPage(gate.session.login, requestLocale(c)), 403);
  }
  if (target.role === role) return inviteMutationResponse(c, "ok", 200);
  if (target.github_login.toLowerCase() === gate.user.github_login.toLowerCase()) {
    const owners = (await listWorkspaceMembers(gate.db, gate.scope.workspaceId)).filter(
      (row) => row.role === "owner",
    );
    if (owners.length <= 1) {
      return inviteMutationResponse(c, "You cannot demote yourself while you are the only owner.", 409);
    }
  }
  if (!(await updateWorkspaceMemberRole(gate.db, gate.scope.workspaceId, target.id, role))) {
    return inviteMutationResponse(c, "Cannot demote the last owner.", 409);
  }
  return inviteMutationResponse(c, "ok", 200);
};


const onlyOwnGrant = <T extends { operator_login: string }>(rows: T[], login: string): T[] =>
  rows.filter((row) => row.operator_login.toLowerCase() === login.toLowerCase());

const supportWorkspaceRoute = async (c: DashboardContext) => {
  const tenant = c.get("tenant");
  const db = dashboardD1(c.env);
  if (!tenant || tenant.workspaceId === null || !db) return await tenantNotFound(c);
  if (tenant.principal !== "operator-granted") {
    return tenant.principal === "member"
      ? c.json({ error: "forbidden" }, 403)
      : await tenantNotFound(c);
  }
  const workspace = tenant.workspaceRow;
  const login = c.get("authUser")?.github_login;
  if (!workspace || login === undefined) return await tenantNotFound(c);
  const now = new Date().toISOString();
  const [members, all] = await Promise.all([
    listWorkspaceMembers(db, workspace.id),
    listActiveSupportGrants(db, workspace.id, now),
  ]);
  const grants = onlyOwnGrant(all, login);
  return c.json({
    workspace: {
      id: workspace.id,
      name: workspace.name,
      slug: workspace.slug,
      created_at: workspace.created_at,
    },
    members: members.map((row) => ({ github_login: row.github_login, role: row.role })),
    grants: grants.map((row) => ({
      operator_login: row.operator_login,
      reason: row.reason,
      expires_at: row.expires_at,
    })),
  });
};

const supportGrantsRoute = async (c: DashboardContext) => {
  const tenant = c.get("tenant");
  const db = dashboardD1(c.env);
  if (!tenant || !db) return await tenantNotFound(c);
  let workspaceId: string | null;
  let ownLogin: string | null = null;
  if (tenant.principal === "operator-granted") {
    workspaceId = tenant.workspaceId;
    ownLogin = c.get("authUser")?.github_login ?? null;
  } else {
    const member = await requireMember(c);
    if (!member.ok) return member.response;
    workspaceId = member.scope.workspaceId;
  }
  if (workspaceId === null) return c.json({ error: "not_found" }, 404);
  const live = await listActiveSupportGrants(db, workspaceId, new Date().toISOString());
  const grants = ownLogin === null ? live : onlyOwnGrant(live, ownLogin);
  return c.json({
    grants: grants.map((row) => ({
      operator_login: row.operator_login,
      reason: row.reason,
      expires_at: row.expires_at,
    })),
  });
};

const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 200;

const auditListRoute = async (c: DashboardContext) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const raw = c.req.query("limit");
  let limit = AUDIT_DEFAULT_LIMIT;
  if (raw !== undefined) {
    if (!/^\d+$/.test(raw)) return c.json({ error: "limit must be a positive integer" }, 400);
    limit = Math.min(Number(raw), AUDIT_MAX_LIMIT);
  }
  const events = await listAuditEvents(gate.db, gate.scope.workspaceId, limit);
  return c.json({
    events: events.map((row) => ({
      actor_login: row.actor_login,
      action: row.action,
      created_at: row.created_at,
    })),
  });
};

const workspaceNameRoute = async (c: DashboardContext) => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  if (member.scope.role !== "owner") {
    return wantsHtml(c.req.header("Accept") ?? null)
      ? c.html(forbiddenPage(member.session.login, requestLocale(c)), 403)
      : c.json({ error: "forbidden" }, 403);
  }
  let name = "";
  try {
    const body = (await c.req.json()) as { name?: unknown };
    name = typeof body.name === "string" ? body.name.trim() : "";
  } catch {
  }
  if (name.length === 0) {
    return c.json({ key: "workspace.nameRequired", message: t("en", "workspace.nameRequired") }, 400);
  }
  if (name.length > WORKSPACE_NAME_MAX_LENGTH) {
    return c.json(
      {
        key: "workspace.nameTooLong",
        params: { max: WORKSPACE_NAME_MAX_LENGTH },
        message: t("en", "workspace.nameTooLong", { max: WORKSPACE_NAME_MAX_LENGTH }),
      },
      400,
    );
  }
  const row = await setWorkspaceName(member.db, member.scope.workspaceId, name);
  if (row === null) return await tenantNotFound(c);
  return c.json({ name: row.name });
};

const workspaceConcurrencyGate = async (c: DashboardContext) => {
  const member = await requireMember(c);
  if (!member.ok) return { ok: false as const, response: member.response };
  if (!canManageRole(member.scope.role)) {
    return { ok: false as const, response: await tenantNotFound(c) };
  }
  return { ok: true as const, member };
};

const workspaceConcurrencyReadRoute = async (c: DashboardContext) => {
  const gate = await workspaceConcurrencyGate(c);
  if (!gate.ok) return gate.response;
  const caps = await getWorkspaceConcurrency(gate.member.db, gate.member.scope.workspaceId);
  return c.json({
    concurrency: caps.concurrency,
    min: CONCURRENCY_MIN,
    max: WORKSPACE_CONCURRENCY_MAX,
    degraded: caps.degraded,
  });
};

const workspaceConcurrencyWriteRoute = async (c: DashboardContext) => {
  const gate = await workspaceConcurrencyGate(c);
  if (!gate.ok) return gate.response;
  const { db, user, scope } = gate.member;
  let value: unknown;
  try {
    const body = (await c.req.json()) as { concurrency?: unknown };
    value = body.concurrency;
  } catch {
  }
  if (!isConcurrencyValue(value, WORKSPACE_CONCURRENCY_MAX)) {
    return keyed400(c, SETTINGS_400_KEYS.concurrencyInvalid, {
      min: CONCURRENCY_MIN,
      max: WORKSPACE_CONCURRENCY_MAX,
    });
  }
  try {
    return c.json({ concurrency: await setWorkspaceConcurrency(db, scope.workspaceId, value, user.github_login) });
  } catch (err) {
    if (!(err instanceof RuntimeConfigError)) throw err;
    if (err.reason === "unknown_workspace") return await tenantNotFound(c);
    return keyed400(c, SETTINGS_400_KEYS.concurrencyInvalid, {
      min: CONCURRENCY_MIN,
      max: WORKSPACE_CONCURRENCY_MAX,
    });
  }
};

const workspaceCheckMinScoreReadRoute = async (c: DashboardContext) => {
  const gate = await workspaceConcurrencyGate(c);
  if (!gate.ok) return gate.response;
  const read = await getWorkspaceCheckMinScore(gate.member.db, gate.member.scope.workspaceId);
  return c.json({
    min_score: read.minScore,
    min: CHECK_MIN_SCORE_MIN,
    max: CHECK_MIN_SCORE_MAX,
    degraded: read.degraded,
  });
};

const workspaceCheckMinScoreWriteRoute = async (c: DashboardContext) => {
  const gate = await workspaceConcurrencyGate(c);
  if (!gate.ok) return gate.response;
  const { db, user, scope } = gate.member;
  let value: unknown;
  try {
    const body = (await c.req.json()) as { min_score?: unknown };
    value = body.min_score;
  } catch {
  }
  if (!isCheckMinScoreValue(value)) {
    return keyed400(c, SETTINGS_400_KEYS.checkScoreInvalid, {
      min: CHECK_MIN_SCORE_MIN,
      max: CHECK_MIN_SCORE_MAX,
    });
  }
  try {
    await setWorkspaceReviewDefaults(db, scope.workspaceId, { checkMinScore: value }, user.github_login);
    return c.json({ min_score: value });
  } catch (err) {
    if (!(err instanceof RuntimeConfigError)) throw err;
    if (err.reason === "unknown_workspace") return await tenantNotFound(c);
    return keyed400(c, SETTINGS_400_KEYS.checkScoreInvalid, {
      min: CHECK_MIN_SCORE_MIN,
      max: CHECK_MIN_SCORE_MAX,
    });
  }
};

const reviewUsageReadRoute = async (c: DashboardContext) => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const { db, scope } = member;
  const mode = deploymentModeOf(c.env.DEPLOYMENT_MODE);
  const now = new Date();
  const window = reviewUsageMonth(now);
  const [rows, plan, sharedBots] = await Promise.all([
    readReviewUsage(db, window, scope.workspaceId),
    resolveWorkspacePlan(db, scope.workspaceId, mode),
    createReviewBotsStore(db).listSharedBots(scope.workspaceId),
  ]);
  const row = rows[0];
  if (!row) return await tenantNotFound(c);
  const quota =
    mode === "saas" ? await readWorkspaceQuota(db, scope.workspaceId, plan.id, now) : null;
  return c.json({
    month: window.month,
    sharedReviews: row.sharedReviews,
    ownReviews: row.ownReviews,
    sharedBot: sharedBotAvailability(plan, sharedBots.length > 0),
    quota,
  });
};


/**
 * Route-local member gate shared by every workspace App route. Exported so a
 * test can drive the gate on a mount without the session guard (the only
 * caller shape that takes the fallback read below).
 */
export async function requireMember(c: DashboardContext): Promise<
  | {
      ok: true;
      session: SessionPayload;
      db: DashboardDb;
      user: DashboardUserRow;
      scope: WorkspaceScope;
    }
  | { ok: false; response: Response }
> {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return { ok: false, response: c.text("dashboard OAuth is not configured", 500) };
  const session =
    c.get("authSession") ?? (await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret));
  if (!session) return { ok: false, response: c.redirect("/dashboard/login", 302) };
  const db = dashboardD1(c.env);
  if (!db) return { ok: false, response: c.text("dashboard storage is not configured", 500) };
  const user = c.get("authUser") ?? (await getUserByLogin(db, session.login));
  if (!user) return { ok: false, response: c.html(forbiddenPage(session.login, requestLocale(c)), 403) };
  const tenant = c.get("tenant");
  const scope = c.get("workspaceScope") ?? null;
  if (!tenant || scope === null || tenant.principal !== "member") {
    return { ok: false, response: await tenantNotFound(c) };
  }
  return { ok: true, session, db, user, scope };
}

function canManageRole(role: WorkspaceRole | null): boolean {
  return role === "owner" || role === "admin";
}

function canManageApp(scope: WorkspaceScope): boolean {
  return canManageRole(scope.role);
}

function canWriteBotScope(
  app: Pick<GithubAppRow, "workspace_id" | "scope">,
  scope: WorkspaceScope,
): boolean {
  return app.workspace_id === scope.workspaceId;
}

function canReadBotScope(
  app: Pick<GithubAppRow, "workspace_id" | "scope">,
  scope: WorkspaceScope,
): boolean {
  return app.workspace_id === scope.workspaceId || app.scope === "shared";
}

async function resolveScopedApp(
  apps: ReturnType<typeof createReviewBotsStore>,
  appIdParam: string,
  scope: WorkspaceScope,
): Promise<GithubAppRow | null> {
  const githubAppId = parseGithubAppId(appIdParam);
  if (githubAppId === null) return null;
  return apps.getScopedAppByGithubId(githubAppId, scope.workspaceId);
}

async function liveTargetsForBot(
  db: DashboardD1,
  workspaceId: string,
  botId: string,
): Promise<ReviewTargetRow[]> {
  return (await createTargetsStore(db).listLiveByBot(botId)).filter(
    (target) => target.workspace_id === workspaceId,
  );
}

function appDisplayName(
  app: {
    name?: string | null;
    github_name: string | null;
    github_slug: string | null;
    github_app_id: number | null;
  },
): string {
  // Post-split bot routes carry null placeholders for every App field (F2), so
  // the BOT's own name is what a notice prints there; an App-shaped row still
  // resolves through its GitHub metadata, then the bare id.
  return (
    app.github_name ??
    app.github_slug ??
    app.name ??
    (app.github_app_id === null ? "the app" : String(app.github_app_id))
  );
}

type BlockedReason = "bot_not_shared";

function blockedReasonFor(
  app: Pick<GithubAppRow, "scope" | "workspace_id">,
  targetWorkspaceId: string,
): BlockedReason | null {
  return app.scope === "owned" && app.workspace_id !== targetWorkspaceId
    ? "bot_not_shared"
    : null;
}

/**
 * The Apps list with the health column data (AL-20-2): every row
 * carries its health summary (the App's newest review-verdict
 * webhook_deliveries row — outcome tier, see the store's deliverySummaries —
 * plus the 24h rejected count). The health column reads webhook_deliveries —
 * NOT the review_bots.last_webhook_at column, which stays the L5 "last
 * verified delivery" stamp (display-only, no computed health).
 *
 * The summaries come from the store's BATCHED deliverySummaries face
 * (QC wave 1, W-1): two D1 statements per batch for any N instead
 * of the per-App 2N fan-out — this helper runs on GET /api/apps (the SPA
 * JSON face), so the statement count must not scale with the App count.
 * Owned bots form one App-wide batch; shared bots the workspace does not own
 * form a second batch scoped to its target repositories. Each batch is split
 * into chunks of up to 90 bots to stay under D1's bound-parameter cap, so the
 * cost is two statements per chunk: four for any workspace under 90 Apps of
 * each kind.
 * A request lists the workspace's own bots plus every `shared` bot it holds a
 * live target on (`targetedBotIds`) — the target is the entitlement, so a
 * target created on an official bot does not vanish from this list.
 * shortcut: the workspace filter runs over the joined list in memory
 * (single-tenant scale today); upgrade: to a workspace-filtered store query
 * when a workspace can hold enough Apps for the scan to matter.
 */
/**
 * F1: the App list's MEMBERSHIP is the union the installation relation
 * defines — an App this workspace owns, an App it holds a bound installation
 * on, or a shared App it has a live target on. The relation is NOT filtered
 * back through a visibility list: a shared App with a bound installation and
 * no target must still appear (and select the `installed` default).
 *
 * DEFERRED by recorded PM decision D43 (delivery-compass): `app_installations`
 * belongs to install-state-chain Task 2; membership reads `app_workspaces`,
 * `github_apps` and the bound `github_app_installations` row instead.
 */
async function appsListWithHealth(
  apps: ReturnType<typeof createReviewBotsStore>,
  scope: WorkspaceScope,
  installedIds: ReadonlySet<string>,
  targetedBotIds: ReadonlySet<string>,
): Promise<Array<GithubAppRow & { health: DeliverySummary }>> {
  const rows = (await apps.listApps()).filter(
    (app) =>
      app.workspace_id === scope.workspaceId ||
      installedIds.has(app.id) ||
      (app.scope === "shared" && targetedBotIds.has(app.id)),
  );
  const owned = rows.filter((app) => canWriteBotScope(app, scope));
  const consumed = rows.filter((app) => !canWriteBotScope(app, scope));
  const [ownedSummaries, consumedSummaries] = await Promise.all([
    apps.deliverySummaries(owned.map((app) => app.id)),
    apps.deliverySummaries(consumed.map((app) => app.id), scope.workspaceId),
  ]);
  const summaries = { ...ownedSummaries, ...consumedSummaries };
  return rows.map((app) => ({ ...app, health: summaries[app.id]! }));
}

const appListRoute = async (c: DashboardContext) => {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const apps = createReviewBotsStore(gate.db);
  const targetByBot = new Map(
    (await createTargetsStore(gate.db).listLive(gate.scope.workspaceId)).map((target) => [
      target.app_id,
      target,
    ]),
  );
  const defaults = await getWorkspaceReviewDefaults(gate.db, gate.scope.workspaceId);
  // F1/D43: installation membership comes from relations that exist today —
  // never from `app_installations` (install-state-chain owns that cutover) —
  // and it is what the LIST is built from, not a post-filter.
  const installedIds = new Set(await apps.listInstalledBotIds(gate.scope.workspaceId));
  const rows = await appsListWithHealth(
    apps,
    gate.scope,
    installedIds,
    new Set(targetByBot.keys()),
  );
  const month = quotaMonth(new Date());
  const spendRows = (
    await gate.db
      .prepare(
        `SELECT bot_id, COALESCE(SUM(rp), 0) AS total FROM usage_events
          WHERE workspace_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 AND bot_id IS NOT NULL
          GROUP BY bot_id`,
      )
      .bind(gate.scope.workspaceId, month.startIso, month.endIso)
      .all<{ bot_id: string; total: number }>()
  ).results;
  const spend = new Map(spendRows.map((row) => [row.bot_id, Number(row.total)]));
  // F1: an App's month state comes from the bots its CHAIN mounts — never from
  // a same-id bot. No chain means `null`, which the SPA renders as the dash.
  const chains = await apps.listInstallChainBots(gate.scope.workspaceId);
  const quota = await readPlanMonthlyRp(
    gate.db,
    gate.scope.workspaceId,
    month.startIso,
    deploymentModeOf(c.env.DEPLOYMENT_MODE),
  );
  return c.json({
    viewer: { login: gate.user.github_login, role: gate.user.role },
    // F10: an UNKNOWN ceiling is an explicit error state, not an omitted field
    // that a UI could read as "no ceiling".
    ...(quota.kind === "unknown" ? { quota_error: true } : {}),
    ...(quota.kind === "unknown" ? {} : { month_plan_rp: quota.kind === "unlimited" ? null : quota.rp }),
    apps: rows.map((app) => {
      const target = targetByBot.get(app.id);
      return {
        github_app_id: app.github_app_id,
        owned: app.workspace_id === gate.scope.workspaceId,
        installed: installedIds.has(app.id),
        // `null` = no chain mounted, so nothing is metered. A number is the
        // sum of this workspace's spend through the mounted bots.
        month: (() => {
          const chain = chains.get(app.id) ?? [];
          if (chain.length === 0) return null;
          return {
            used_rp: chain.reduce((total, bot) => total + (spend.get(bot.botId) ?? 0), 0),
            owned: chain.every((bot) => bot.owned),
            multiplier: chain.reduce((product, bot) => product * bot.multiplier, 1),
          };
        })(),
        bot_id: app.id,
        github_name: app.github_name ?? null,
        github_slug: app.github_slug ?? null,
        github_avatar_url: app.github_avatar_url ?? null,
        status: app.status,
        ...(target === undefined
          ? {}
          : { review_enabled: effectiveTargetSettings(target, defaults).reviewEnabled ? 1 : 0 }),
        created_by: app.created_by,
        health: {
          latest: app.health.latest
            ? {
                event_name: app.health.latest.event_name,
                outcome: app.health.latest.outcome,
                status_code: app.health.latest.status_code,
                created_at: app.health.latest.created_at,
              }
            : null,
          rejected24h: app.health.rejected24h,
        },
      };
    }),
    // F9: the chooser lists shared GitHub AppS, selected by `scope`.
    shared_apps: await apps.listSharedApps(gate.scope.workspaceId),
    shared_bots: await apps.listSharedBots(gate.scope.workspaceId),
    // The installed tab's pending-bind rows: every unbound physical
    // installation of an App this workspace may install through — its own,
    // or a shared one (D8/D43 — install states are install-state-chain Task 2's).
    pending_installations: await apps.listWorkspacePendingInstallationsNamed(gate.scope.workspaceId),
  });
};

/**
 * One ordered read of every bot this workspace may use (D6/D18): its own
 * first — own-before-shared, name case-insensitively inside each group, the
 * bot id as tie-break — plus the caller's month spend per bot, batched in
 * ONE aggregate statement so the read never fans out per row.
 */
async function usableBotsRead(
  db: DashboardDb,
  workspaceId: string,
  role: WorkspaceRole,
  mode: DeploymentMode,
): Promise<{
  workspace_id: string;
  plan_monthly_rp?: number | null;
  bots: Array<Record<string, unknown>>;
}> {
  const rows = await createReviewBotsStore(db).listUsableBots(workspaceId);
  const month = quotaMonth(new Date());
  const spendRows = (
    await db
      .prepare(
        `SELECT bot_id, COALESCE(SUM(rp), 0) AS total
           FROM usage_events
          WHERE workspace_id = ?1 AND occurred_at >= ?2 AND occurred_at < ?3 AND bot_id IS NOT NULL
          GROUP BY bot_id`,
      )
      .bind(workspaceId, month.startIso, month.endIso)
      .all<{ bot_id: string; total: number }>()
  ).results;
  const spend = new Map(spendRows.map((row) => [row.bot_id, Number(row.total)]));
  const quota = await readPlanMonthlyRp(db, workspaceId, month.startIso, mode);
  return {
    workspace_id: workspaceId,
    ...(quota.kind === "unknown" ? { quota_error: true } : {}),
    ...(quota.kind === "unknown" ? {} : { plan_monthly_rp: quota.kind === "unlimited" ? null : quota.rp }),
    bots: rows.map((bot) => ({
      id: bot.id,
      name: bot.name,
      description: bot.description,
      workspace_id: bot.workspace_id,
      workspace_name: bot.workspace_name,
      owned: bot.workspace_id === workspaceId,
      can_manage: bot.workspace_id === workspaceId && canManageRole(role),
      scope: bot.scope,
      multiplier: bot.multiplier,
      month_used_rp: spend.get(bot.id) ?? 0,
    })),
  };
}

/**
 * The consuming workspace's plan ceiling (D31): NULL when the plan is
 * unlimited, the deployment is self-hosted, or no profile row covers the
 * plan — every such case reads as "no ceiling", never as an error.
 */
async function readPlanMonthlyRp(
  db: DashboardDb,
  workspaceId: string,
  monthStart: string,
  mode: DeploymentMode,
): Promise<{ kind: "ceiling"; rp: number } | { kind: "unlimited" } | { kind: "unknown" }> {
  // F10: the resolver is deployment-aware (self-hosted has no plan), and a
  // failed read reports "unknown" — never a fabricated unlimited allowance.
  if (mode !== "saas") return { kind: "unlimited" };
  try {
    const plan = await resolveWorkspacePlan(db, workspaceId, "saas");
    if (plan.id === UNLIMITED_PLAN_ID) return { kind: "unlimited" };
    const monthlyRp = (await resolveMonthlyQuota(db, monthStart, plan.id)).monthlyRp;
    // A NULL quota row is the profile's own "no ceiling" spelling.
    return monthlyRp === null ? { kind: "unlimited" } : { kind: "ceiling", rp: monthlyRp };
  } catch {
    return { kind: "unknown" };
  }
}

const usableBotsRoute = async (c: DashboardContext) => {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  c.header("Cache-Control", "private, no-store");
  return c.json(
    await usableBotsRead(
      gate.db,
      gate.scope.workspaceId,
      gate.scope.role,
      deploymentModeOf(c.env.DEPLOYMENT_MODE),
    ),
  );
};

async function appStatusAction(
  c: DashboardContext,
  action: "disable" | "enable" | "delete",
): Promise<Response> {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const apps = createReviewBotsStore(gate.db);
  const app = await resolveScopedApp(apps, c.req.param("appId") ?? "", gate.scope);
  if (!app) return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404);
  if (!canManageApp(gate.scope)) return c.html(forbiddenPage(gate.session.login, requestLocale(c)), 403);
  if (!canWriteBotScope(app, gate.scope)) return botReadOnlyResponse(c);
  if (action === "delete") {
    await apps.softDeleteApp(app.id);
  } else {
    await apps.setAppStatus(app.id, action === "disable" ? "disabled" : "active");
  }
  return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "ok");
}


/**
 * The bot-shaped row bot-configuration routes serve (task 4 F2): the bot's own
 * columns — scope, shared_at, sandbox image, workspace — and the keys the
 * payload keeps as PLACEHOLDERS. No App field is sourced through a same-id
 * join: metadata/operational keys are constant null and `github_app_id` is
 * null until `install-state-chain` resolves mounts through `app_install_bots`.
 * For migrated rows, where the ids happen to be equal, the bot id still keys
 * the bot-scoped config tables, so every bot write keeps working.
 */
export type BotRouteRow = {
  id: string;
  workspace_id: string;
  name: string;
  scope: BotScope;
  shared_at: string | null;
  sandbox_image_id: string;
  created_at: string;
  github_app_id: number | null;
  status: null;
  created_by: null;
  last_webhook_at: null;
  github_name: null;
  github_slug: null;
  github_description: null;
  github_html_url: null;
  github_avatar_url: null;
  github_metadata_synced_at: null;
  review_enabled: null;
};

function botRouteRow(bot: BotScopedRow): BotRouteRow {
  return {
    id: bot.id,
    workspace_id: bot.workspace_id,
    name: bot.name,
    scope: bot.scope,
    shared_at: bot.shared_at,
    sandbox_image_id: bot.sandbox_image_id,
    created_at: bot.created_at,
    github_app_id: null,
    status: null,
    created_by: null,
    last_webhook_at: null,
    github_name: null,
    github_slug: null,
    github_description: null,
    github_html_url: null,
    github_avatar_url: null,
    github_metadata_synced_at: null,
    review_enabled: null,
  };
}

type AppSettingsGate =
  | {
      ok: true;
      session: SessionPayload;
      db: DashboardDb;
      /** The bot row with payload placeholders — never App-sourced fields. */
      app: BotRouteRow;
      target: ReviewTargetRow | null;
      targets_many: boolean;
      user: DashboardUserRow;
      scope: WorkspaceScope;
    }
  | { ok: false; response: Response };

async function requireAppVisible(c: DashboardContext): Promise<AppSettingsGate> {
  const member = await requireMember(c);
  if (!member.ok) return member;
  // Bot-configuration routes address the BOT by `review_bots.id` (`:botId`):
  // an all-digits segment never reaches the query (the store refuses it —
  // F1), so the two id spaces cannot be confused. Authorization is the bot's
  // own workspace/scope; the row the payload composes is bot-shaped — no App
  // field comes through a same-id join (F2).
  const bot = await createReviewBotsStore(member.db).getScopedBotById(
    c.req.param("botId") ?? "",
    member.scope.workspaceId,
  );
  if (!bot) return { ok: false, response: pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404) };
  const app = botRouteRow(bot);
  const live = await liveTargetsForBot(member.db, member.scope.workspaceId, bot.id);
  return {
    ok: true,
    session: member.session,
    db: member.db,
    app,
    target: live.length === 1 ? live[0]! : null,
    targets_many: live.length > 1,
    user: member.user,
    scope: member.scope,
  };
}

/**
 * The App detail's settings face — the same contract as the pre-split
 * `/api/apps/:appId/settings`: resolution by numeric GitHub App id, REAL App
 * fields (the bot route's null placeholders stay on the bot routes), the
 * App's own installations and pending binds, and the bot-scoped sections
 * keyed by the SAME id (the ids are equal this release — D34 keeps them
 * independent, so nothing here joins App onto bot).
 */
const appDetailSettingsRoute = async (c: DashboardContext) => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const store = createReviewBotsStore(member.db);
  const githubAppId = parseGithubAppId(c.req.param("appId") ?? "");
  const appRow = githubAppId === null ? null : await store.getScopedAppByGithubId(githubAppId, member.scope.workspaceId);
  if (!appRow) return c.json({ error: "unknown app" }, 404);
  const live = await liveTargetsForBot(member.db, member.scope.workspaceId, appRow.id);
  const target = live.length === 1 ? live[0]! : null;
  const targetsMany = live.length > 1;
  const blockedReason = blockedReasonFor(appRow, member.scope.workspaceId);
  try {
    c.header("Cache-Control", "private, no-store");
    const defaults = await getWorkspaceReviewDefaults(member.db, member.scope.workspaceId);
    if (!canManageApp(member.scope)) {
      return c.json({
        can_manage: false,
        workspace_id: member.scope.workspaceId,
        ...(target === null ? {} : { target_id: target.id }),
        blocked: blockedReason !== null,
        blocked_reason: blockedReason,
        installations: await installationsVisibleTo(store, appRow, member.scope.workspaceId),
        app: {
          github_app_id: appRow.github_app_id,
          status: appRow.status,
          ...(target === null
            ? {}
            : { review_enabled: effectiveTargetSettings(target, defaults).reviewEnabled }),
          created_by: appRow.created_by,
          created_at: appRow.created_at,
          github_name: appRow.github_name ?? null,
          github_slug: appRow.github_slug ?? null,
          id: appRow.id,
          github_description: appRow.github_description ?? null,
          github_html_url: appRow.github_html_url ?? null,
          github_avatar_url: appRow.github_avatar_url ?? null,
          ...(blockedReason === null
            ? { github_metadata_synced_at: appRow.github_metadata_synced_at ?? null }
            : {}),
        },
      });
    }
    // No target holds an installation id (the pre-split route already served
    // `installation: null` here), so the bound row stays unresolved until
    // install-state-chain owns the binding read.
    const binding = null;
    if (blockedReason !== null) {
      const effective = target === null ? null : effectiveTargetSettings(target, defaults);
      const checkGate = effective === null ? null : checkGateOf(effective);
      const defaultReviewLevel = target === null ? null : (await readDefaultReviewLevel(member.db)).value;
      return c.json({
        can_manage: true,
        blocked: true,
        blocked_reason: blockedReason,
        workspace_id: member.scope.workspaceId,
        targets_many: targetsMany,
        target_id: target === null ? null : target.id,
        ...(target === null
          ? {}
          : {
              check_gate:
                checkGate === null
                  ? null
                  : { min_score: checkGate.minScore, pass_verdicts: [...checkGate.passVerdicts] },
            }),
        app: {
          github_app_id: appRow.github_app_id,
          id: appRow.id,
          status: appRow.status,
          created_by: appRow.created_by,
          ...(target === null
            ? {}
            : {
                review_enabled: effective!.reviewEnabled,
                review_trigger_mode: effective!.triggerMode,
                review_level: effective!.level,
                default_review_level: defaultReviewLevel,
              }),
          scope: appRow.scope,
          github_name: appRow.github_name ?? null,
          github_slug: appRow.github_slug ?? null,
          github_description: appRow.github_description ?? null,
          github_html_url: appRow.github_html_url ?? null,
          github_avatar_url: appRow.github_avatar_url ?? null,
          github_visibility: appRow.github_visibility ?? null,
        },
        installation: binding,
      });
    }
    const effective = target === null ? null : effectiveTargetSettings(target, defaults);
    const checkGate = effective === null ? null : checkGateOf(effective);
    const defaultReviewLevel = target === null ? null : (await readDefaultReviewLevel(member.db)).value;
    const officialWorkspaceId = await readOfficialWorkspaceId(member.db);
    const targetOwned =
      target === null
        ? { app: {}, top: {} }
        : {
            app: {
              review_enabled: effective!.reviewEnabled,
              review_trigger_mode: effective!.triggerMode,
              review_level: effective!.level,
              default_review_level: defaultReviewLevel,
            },
            top: {
              target_id: target.id,
              check_gate:
                checkGate === null
                  ? null
                  : { min_score: checkGate.minScore, pass_verdicts: [...checkGate.passVerdicts] },
            },
          };
    if (!c.env.DASHBOARD_ENCRYPTION_KEY) {
      return c.text("the app settings need a configured DASHBOARD_ENCRYPTION_KEY", 500);
    }
    // F11: the App face is App-scoped. Nothing here reads a BOT through an
    // equal id — the split keeps them independent, so a same-id bot's keys,
    // chains, providers or sandbox would be a different entity's data.
    // The bot-owned sections therefore stay empty on the App payload; the
    // bot's configuration lives only on `/bots/:botId`.
    const catalog = await providerCatalog();
    const appInstallations = await installationsVisibleTo(store, appRow, member.scope.workspaceId);
    const appDelivery = await store.deliverySummary(appRow.id, member.scope.workspaceId);
    const sections = {
      installations: [] as Array<unknown>,
      keys: [] as Array<unknown>,
      model_chain: null as string | null,
      model_roles: {} as Record<string, string>,
      model_chains: [] as Array<unknown>,
      custom_providers: [] as Array<unknown>,
      configured_providers: [] as Array<unknown>,
      provider_catalog_version: catalog.version,
      provider_eligibility: {} as Record<string, string>,
      model_role_ids: MODEL_ROLE_IDS,
      custom_provider_api_ids: CUSTOM_PROVIDER_API_IDS,
      sandbox_images: enabledSandboxImages().map((image) => ({ id: image.id, enabled: image.enabled })),
      delivery_summary: {
        latest: appDelivery.latest
          ? {
              event_name: appDelivery.latest.event_name,
              outcome: appDelivery.latest.outcome,
              status_code: appDelivery.latest.status_code,
              created_at: appDelivery.latest.created_at,
            }
          : null,
        rejected24h: appDelivery.rejected24h,
      },
    };
    const installations = appInstallations;
    return c.json({
      can_manage: true,
      workspace_id: member.scope.workspaceId,
      targets_many: targetsMany,
      ...targetOwned.top,
      app: {
        github_app_id: appRow.github_app_id,
        status: appRow.status,
        created_by: appRow.created_by,
        last_webhook_at: appRow.last_webhook_at ?? null,
        // F11: no same-id bot read — sandbox_image_id is the BOT's column. The
        // App payload omits it; the bot page is where it is configured.

        github_name: appRow.github_name ?? null,
        github_slug: appRow.github_slug ?? null,
        github_visibility: appRow.github_visibility ?? null,
        scope: appRow.scope,
        id: appRow.id,
        github_description: appRow.github_description ?? null,
        github_html_url: appRow.github_html_url ?? null,
        github_avatar_url: appRow.github_avatar_url ?? null,
        github_metadata_synced_at: appRow.github_metadata_synced_at ?? null,
        ...targetOwned.app,
      },
      installation: binding,
      pending_installations: await store.listPendingInstallations(appRow.id, member.scope.workspaceId),
      // F7: the bots this App's chain actually mounts in THIS workspace — the
      // only App-to-bot relation that exists. Empty until install-state-chain
      // writes the chain, and never inferred from an id coincidence.
      mounted_bot_ids: (
        await member.db
          .prepare(
            `SELECT bot_id FROM app_install_bots
              WHERE github_app_id = ?1 AND workspace_id = ?2 ORDER BY position`,
          )
          .bind(appRow.id, member.scope.workspaceId)
          .all<{ bot_id: string }>()
      ).results.map((row) => row.bot_id),
      blocked: false,
      blocked_reason: null,
      official_workspace: officialWorkspaceId !== null && officialWorkspaceId === appRow.workspace_id,
      can_configure_bot: canWriteBotScope(appRow, member.scope),
      ...sections,
      installations,
    });
  } catch (err) {
    logSettingsFailure("api_render", appRow.id, err);
    return c.text("the app settings could not be read from encrypted storage", 500);
  }
};

async function requireAppSettings(c: DashboardContext): Promise<AppSettingsGate> {
  const gate = await requireAppVisible(c);
  if (!gate.ok) return gate;
  if (!canManageApp(gate.scope)) {
    return { ok: false, response: c.html(forbiddenPage(gate.session.login, requestLocale(c)), 403) };
  }
  if (!c.env.DASHBOARD_ENCRYPTION_KEY) {
    return {
      ok: false,
      response: c.text("the app settings need a configured DASHBOARD_ENCRYPTION_KEY", 500),
    };
  }
  return gate;
}

function logSettingsFailure(stage: string, appId: string, err: unknown): void {
  console.warn(
    JSON.stringify({
      event: "dashboard_settings",
      stage,
      app_id: appId,
      error_type: errorTypeName(err),
      key_error: err instanceof SecretboxKeyError,
    }),
  );
}

function settingsFailureNotice(err: unknown): string {
  return err instanceof SecretboxKeyError
    ? "This deployment has no valid DASHBOARD_ENCRYPTION_KEY for its stored keys — ask the operator to configure it, then resubmit."
    : "The dashboard database rejected the change — nothing was stored. You can resubmit.";
}

function isOmpRuntimeImage(sandboxImageId: string): boolean {
  return getSandboxImage(sandboxImageId)?.runtime === "omp";
}

function repositoryLandingPath(gate: { target: ReviewTargetRow | null }): string | null {
  return gate.target === null ? null : `${REPOS_LIST_REDIRECT}/${gate.target.id}`;
}

/** F12: the authority a bot-configuration write carries into the store. */
function botWriteAuthority(gate: { app: { id: string }; scope: WorkspaceScope }): BotWriteAuthority {
  return { botId: gate.app.id, workspaceId: gate.scope.workspaceId, role: gate.scope.role };
}

function settingsPostResponse(
  c: DashboardContext,
  landing: string | null,
  message: string,
  status: 200 | 500 = 200,
): Response {
  return pinnedPostMutationResponse(c, landing ?? REPOS_LIST_REDIRECT, message, status);
}

function settingsRemoveResponse(
  c: DashboardContext,
  landing: string | null,
  changed: boolean,
  message: string,
): Response {
  if (wantsHtmlFormNavigation(c)) {
    return c.redirect(scopedAppPath(c, landing ?? REPOS_LIST_REDIRECT), 302);
  }
  return c.json({ changed, message }, 200);
}

const SETTINGS_400_KEYS = {
  providerRequired: "settings.error.providerRequired",
  providerUnknown: "settings.error.providerUnknown",
  providerUnavailableOnHarness: "settings.error.providerUnavailableOnHarness",
  apiKeyRequired: "settings.error.apiKeyRequired",
  apiKeyTooLong: "settings.error.apiKeyTooLong",
  apiKeyCommandPrefix: "settings.error.apiKeyCommandPrefix",
  providerKeyLimit: "settings.error.providerKeyLimit",
  chainFieldDuplicated: "settings.error.chainFieldDuplicated",
  chainTooLong: "settings.error.chainTooLong",
  chainEmpty: "settings.error.chainEmpty",
  roleFieldDuplicated: "settings.error.roleFieldDuplicated",
  roleUnknown: "settings.error.roleUnknown",
  roleFieldsMissingAll: "settings.error.roleFieldsMissingAll",
  roleFieldMissing: "settings.error.roleFieldMissing",
  roleFieldsMissing: "settings.error.roleFieldsMissing",
  roleChainUnknown: "settings.error.roleChainUnknown",
  chainNameInvalid: "settings.error.chainNameInvalid",
  chainValueRequired: "settings.error.chainValueRequired",
  defaultChainRemoveProtected: "settings.error.defaultChainRemoveProtected",
  providerIdRequired: "settings.error.providerIdRequired",
  providerIdInvalid: "settings.error.providerIdInvalid",
  providerIdBuiltin: "settings.error.providerIdBuiltin",
  providerIdBaseConfig: "settings.error.providerIdBaseConfig",
  customProviderMax: "settings.error.customProviderMax",
  baseUrlRequired: "settings.error.baseUrlRequired",
  baseUrlInvalid: "settings.error.baseUrlInvalid",
  baseUrlTooLong: "settings.error.baseUrlTooLong",
  apiProtocolRequired: "settings.error.apiProtocolRequired",
  apiProtocolUnknown: "settings.error.apiProtocolUnknown",
  modelIdsRequired: "settings.error.modelIdsRequired",
  modelIdsTooMany: "settings.error.modelIdsTooMany",
  modelIdTooLong: "settings.error.modelIdTooLong",
  customProviderDeclRejected: "settings.error.customProviderDeclRejected",
  customProviderUndeclared: "settings.error.customProviderUndeclared",
  modelMetaInvalid: "settings.error.modelMetaInvalid",
  modelMetaMalformed: "settings.error.modelMetaMalformed",
  providerModelsEmpty: "settings.error.providerModelsEmpty",
  providerModelsKeyRequired: "settings.error.providerModelsKeyRequired",
  providerEndpointLocked: "settings.error.providerEndpointLocked",
  templateUnknown: "settings.error.templateUnknown",
  templateIncomplete: "settings.error.templateIncomplete",
  accountIdRequired: "settings.error.accountIdRequired",
  accountIdInvalid: "settings.error.accountIdInvalid",
  templateIdBuiltin: "settings.error.templateIdBuiltin",
  templateIdBaseConfig: "settings.error.templateIdBaseConfig",
  materializedBaseUrlInvalid: "settings.error.materializedBaseUrlInvalid",
  templateApiUnsupported: "settings.error.templateApiUnsupported",
  templateNoModels: "settings.error.templateNoModels",
  templateMaterializeMax: "settings.error.templateMaterializeMax",
  runtimeHarnessUnknown: "settings.error.runtimeHarnessUnknown",
  triggerModeUnknown: "settings.error.triggerModeUnknown",
  reviewLevelUnknown: "settings.error.reviewLevelUnknown",
  checkScoreInvalid: "settings.error.checkScoreInvalid",
  checkVerdictUnknown: "settings.error.checkVerdictUnknown",
  allowlistToggleInvalid: "settings.error.allowlistToggleInvalid",
  allowlistTooManyOwners: "settings.error.allowlistTooManyOwners",
  allowlistInvalidOwner: "settings.error.allowlistInvalidOwner",
  fieldDuplicated: "settings.error.fieldDuplicated",
  unknownOperation: "settings.error.unknownOperation",
  githubMetadataRefreshFailed: "settings.error.githubMetadataRefreshFailed",
  concurrencyInvalid: "settings.error.concurrencyInvalid",
  usageProbeOffVendorHost: "settings.error.usageProbeOffVendorHost",
  usageProbeUnreadableEndpoint: "settings.error.usageProbeUnreadableEndpoint",
} as const satisfies Record<string, DictionaryKey>;

const MODEL_SIZE_FIELDS = [
  ["contextWindow", "context window"],
  ["maxTokens", "max token count"],
] as const;

function parseCustomProviderModelsMeta(
  raw: string,
  modelIds: readonly string[],
): { meta: CustomProviderModelsMeta } | { error: DictionaryKey; params: Record<string, string> } {
  let entries: Record<string, unknown> = {};
  if (raw.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { error: SETTINGS_400_KEYS.modelMetaMalformed, params: {} };
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { error: SETTINGS_400_KEYS.modelMetaMalformed, params: {} };
    }
    entries = parsed as Record<string, unknown>;
  }
  const invalid = (model: string, field: string) => ({
    error: SETTINGS_400_KEYS.modelMetaInvalid,
    params: { model, field },
  });
  const meta: CustomProviderModelsMeta = {};
  for (const modelId of modelIds) {
    const entry = entries[modelId];
    if (entry !== undefined && entry !== null && (typeof entry !== "object" || Array.isArray(entry))) {
      return invalid(modelId, "model metadata");
    }
    const record = (entry ?? {}) as Record<string, unknown>;
    const statement: CustomProviderModelMeta = {};
    for (const [field, label] of MODEL_SIZE_FIELDS) {
      const value = record[field];
      if (value === undefined || value === null) continue;
      if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
        return invalid(modelId, label);
      }
      statement[field] = value;
    }
    if (record.name !== undefined) {
      if (typeof record.name !== "string") return invalid(modelId, "display name");
      statement.name = record.name;
    }
    if (record.reasoning !== undefined) {
      if (typeof record.reasoning !== "boolean") return invalid(modelId, "reasoning");
      statement.reasoning = record.reasoning;
    }
    if (record.input !== undefined) {
      if (!Array.isArray(record.input) || record.input.some((modality) => typeof modality !== "string")) {
        return invalid(modelId, "accepted inputs");
      }
      statement.input = [...record.input];
    }
    for (const key of Object.keys(record)) {
      if (key !== "contextWindow" && key !== "maxTokens" && key !== "name" && key !== "reasoning" && key !== "input") {
        return invalid(modelId, key);
      }
    }
    if (Object.keys(statement).length > 0) meta[modelId] = statement;
  }
  for (const modelId of Object.keys(entries)) {
    if (!modelIds.includes(modelId)) return invalid(modelId, "model id");
  }
  return { meta };
}

function settings400Response(
  c: DashboardContext,
  landing: string | null,
  key: DictionaryKey,
  params?: Record<string, string | number>,
): Response {
  if (wantsHtmlFormNavigation(c)) {
    return c.redirect(scopedAppPath(c, landing ?? REPOS_LIST_REDIRECT), 302);
  }
  return keyed400(c, key, params);
}

function keyed400(
  c: DashboardContext,
  key: DictionaryKey,
  params?: Record<string, string | number>,
): Response {
  return c.json({ key, message: t("en", key, params), ...(params ? { params } : {}) }, 400);
}

function settingsKeyLimitResponse(
  c: DashboardContext,
  landing: string | null,
  provider: string,
): Response {
  return settings400Response(c, landing, SETTINGS_400_KEYS.providerKeyLimit, {
    provider,
    limit: MAX_KEYS_PER_PROVIDER,
  });
}

type MappedVerifyReason =
  | "invalid_key"
  | "quota_exhausted"
  | "rate_limited"
  | "unreachable"
  | "unexpected"
  | "unsupported_provider";

function mapVerifyReason(reason: VerifyFailureReason): MappedVerifyReason {
  return reason === "unexpected_response" ? "unexpected" : reason;
}
function verifyFailCopy(reason: MappedVerifyReason): string {
  if (reason === "invalid_key") return "That API key was rejected by the provider — nothing was stored.";
  if (reason === "quota_exhausted") {
    return "That provider account is out of quota or credit — nothing was stored. The key itself may still be valid.";
  }
  if (reason === "rate_limited") {
    return "The provider throttled the verification request — nothing was stored, and the key was not judged. Retry shortly; if it keeps happening, the account may genuinely be out of quota.";
  }
  if (reason === "unreachable") return "The provider could not be reached — nothing was stored.";
  if (reason === "unsupported_provider") {
    return "This provider can't be verified here — manage the key in the provider console. Nothing was stored.";
  }
  return "The provider returned an unexpected response — nothing was stored.";
}

function settingsVerifyFailResponse(
  c: DashboardContext,
  landing: string | null,
  reason: VerifyFailureReason,
): Response {
  const mapped = mapVerifyReason(reason);
  const message = verifyFailCopy(mapped);
  if (wantsHtmlFormNavigation(c)) {
    return c.redirect(scopedAppPath(c, landing ?? REPOS_LIST_REDIRECT), 302);
  }
  return c.json({ ok: false, reason: mapped, message }, 400);
}

function membershipFailCopy(selector: string): string {
  return `Selector ${selector} is not in this App's verified models.`;
}

const MEMBERSHIP_FAIL_CODE = "not_in_verified_models" as const;

function settingsMembershipFailResponse(
  c: DashboardContext,
  landing: string | null,
  selector: string,
): Response {
  const message = membershipFailCopy(selector);
  if (wantsHtmlFormNavigation(c)) {
    return c.redirect(scopedAppPath(c, landing ?? REPOS_LIST_REDIRECT), 302);
  }
  return c.json({ code: MEMBERSHIP_FAIL_CODE, message, selector }, 400);
}

type GithubMetadataRefresh =
  | { status: "refreshed"; row: GithubAppRow }
  | { status: "fresh"; row: GithubAppRow }
  | { status: "skipped"; row: GithubAppRow }
  | { status: "failed"; row: GithubAppRow };

async function refreshGithubMetadata(
  app: GithubAppRow,
  apps: ReturnType<typeof createReviewBotsStore>,
  encryptionKey: string | undefined,
  options: { force: boolean },
): Promise<GithubMetadataRefresh> {
  if (!options.force) {
    const stale = isGithubMetadataStale(
      app.github_slug === null ? app.github_metadata_attempted_at : app.github_metadata_synced_at,
    );
    if (!stale) return { status: "fresh", row: app };
  }
  if (!encryptionKey) return { status: "skipped", row: app };
  const markAttempt = async (stillUnsynced: boolean): Promise<void> => {
    if (!stillUnsynced) return;
    try {
      await apps.touchGithubMetadataAttempt(app.id);
    } catch (err) {
      logSettingsFailure("github_metadata_attempt", app.id, err);
    }
  };
  const probeVisibility = async (slug: string | null): Promise<void> => {
    if (slug === null) return;
    try {
      const visibility = await fetchAppVisibility(slug);
      if (visibility !== null) await apps.saveGithubVisibility(app.id, visibility);
    } catch (err) {
      logSettingsFailure("github_visibility", app.id, err);
    }
  };
  const reconcileInstallations = async (decryptedPem: string): Promise<void> => {
    try {
      const observedAt = await apps.currentTimestamp();
      const result = await fetchAppInstallations(app.github_app_id, decryptedPem);
      if (result.ok) await apps.reconcileInstallations(app.id, result.installationIds, observedAt);
    } catch (err) {
      logSettingsFailure("github_installations", app.id, err);
    }
  };
  try {
    const decryptedPem = await createSecretbox(encryptionKey).decryptSecret(
      app.private_key_enc,
      `github_apps.private_key_enc:${app.id}`,
    );
    const result = await fetchAppMetadata(app.github_app_id, decryptedPem);
    if (!result.ok) {
      console.warn(
        JSON.stringify({ event: "dashboard_settings", stage: "github_metadata_fetch", app_id: app.id }),
      );
      await markAttempt(app.github_slug === null);
      return { status: "failed", row: app };
    }
    await apps.saveGithubMetadata(app.id, result.metadata);
    await reconcileInstallations(decryptedPem);
    await probeVisibility(result.metadata.githubSlug ?? app.github_slug);
    const row = (await apps.getAppById(app.id)) ?? app;
    await markAttempt(row.github_slug === null);
    return { status: "refreshed", row };
  } catch (err) {
    logSettingsFailure("github_metadata_refresh", app.id, err);
    await markAttempt(app.github_slug === null);
    return { status: "failed", row: app };
  }
}

/**
 * The App-wide read sections. A workspace that does not own the App (a shared
 * bot's consumer) gets none of the App's installations, keys, chains or custom
 * providers, and a delivery summary limited to its own target repositories.
 */
async function botScopedSections(
  db: DashboardDb,
  app: BotRouteRow,
  encryptionKey: string,
  scope: WorkspaceScope,
) {
  const apps = createReviewBotsStore(db);
  const store = createAppConfigStore(db, encryptionKey);
  const owner = canWriteBotScope(app, scope);
  // The mount list is EMPTY until install-state-chain populates
  // app_install_bots (D43-adjacent F2): physical github_app_installations are
  // App-side state a bot payload never sources through a same-id join.
  const emptyInstallations: Awaited<ReturnType<typeof apps.listInstallations>> = [];
  const [installations, deliverySummary, maskedKeys, modelChain, modelChainSeats, modelChains, customProviders, customKeys] =
    owner
      ? await orderedReads([
          Promise.resolve(emptyInstallations),
          apps.deliverySummary(app.id),
          store.listProviderKeys(app.id),
          store.getModelChain(app.id),
          store.getModelChainSeats(app.id),
          store.getModelChains(app.id),
          store.listCustomProviders(app.id),
          store.listCustomProviderKeys(app.id),
        ])
      : [[], await apps.deliverySummary(app.id, scope.workspaceId), [], null, {}, [], [], []];
  const catalog = await providerCatalog();
  const keyRows = [...maskedKeys, ...customKeys];
  const ompRuntime = isOmpRuntimeImage(app.sandbox_image_id);
  return {
    installations,
    delivery_summary: {
      latest: deliverySummary.latest
        ? {
            event_name: deliverySummary.latest.event_name,
            outcome: deliverySummary.latest.outcome,
            status_code: deliverySummary.latest.status_code,
            created_at: deliverySummary.latest.created_at,
          }
        : null,
      rejected24h: deliverySummary.rejected24h,
    },
    keys: keyRows,
    model_chain: modelChain,
    model_roles: modelChainSeats,
    model_chains: modelChains,
    custom_providers: customProviders.map(({ provider_id, base_url, api, model_ids, models_meta }) => ({
      provider_id,
      base_url,
      api,
      model_ids: [...model_ids],
      ...(Object.hasOwn(LEGACY_PROVIDER_IDS, provider_id)
        ? { legacy_of: LEGACY_PROVIDER_IDS[provider_id]! }
        : {}),
      ...(models_meta === undefined ? {} : { models_meta }),
    })),
    configured_providers: [
      ...keyRows.map((key) => ({
        kind: "key" as const,
        provider: key.provider,
        key_id: key.keyId,
        last4: key.last4,
        updated_at: key.updatedAt,
        verified_at: key.verifiedAt,
        verified_status: key.verifiedStatus,
      })),
      ...customProviders.map((row) => ({
        kind: "custom" as const,
        provider_id: row.provider_id,
        base_url: row.base_url,
        api: row.api,
        model_ids: [...row.model_ids],
      })),
    ],
    provider_catalog_version: catalog.version,
    provider_eligibility: Object.fromEntries(
      Object.entries(PROVIDER_META).map(([id, meta]) => [id, ompRuntime ? meta.tier : "unavailable"]),
    ),
    model_role_ids: MODEL_ROLE_IDS,
    custom_provider_api_ids: CUSTOM_PROVIDER_API_IDS,
    sandbox_images: enabledSandboxImages().map((image) => ({ id: image.id, enabled: image.enabled })),
  };
}

const appSettingsRoute = async (c: DashboardContext) => {
  const gate = await requireAppVisible(c);
  if (!gate.ok) return gate.response;
  const apps = createReviewBotsStore(gate.db);
  // No App metadata refresh here: the refresh writes github_apps columns
  // through credentials a bot route never resolves (F2). The refresh lives
  // on the App route /api/apps/:appId/refresh-metadata.
  const app = gate.app;
  const blockedReason = blockedReasonFor(app, gate.scope.workspaceId);
  const target = gate.target;
  try {
    c.header("Cache-Control", "private, no-store");
    // Inside the try, like every other settings read: the route's catch is the
    // only guard that logs `api_render` and answers the controlled 500.
    const defaults = await getWorkspaceReviewDefaults(gate.db, gate.scope.workspaceId);
    if (!canManageApp(gate.scope)) {
      return c.json({
        can_manage: false,
        workspace_id: gate.scope.workspaceId,
        ...(target === null ? {} : { target_id: target.id }),
        blocked: blockedReason !== null,
        blocked_reason: blockedReason,
        app: {
          github_app_id: app.github_app_id,
          status: app.status,
          ...(target === null
            ? {}
            : { review_enabled: effectiveTargetSettings(target, defaults).reviewEnabled }),
          created_by: app.created_by,
          created_at: app.created_at,
          github_name: app.github_name ?? null,
          github_slug: app.github_slug ?? null,
          id: app.id,
          github_description: app.github_description ?? null,
          github_html_url: app.github_html_url ?? null,
          github_avatar_url: app.github_avatar_url ?? null,
          ...(blockedReason === null
            ? { github_metadata_synced_at: app.github_metadata_synced_at ?? null }
            : {}),
        },
      });
    }
    // App-sourced keys are null placeholders on a bot route (F2): visibility
    // and the mount list resolve with install-state-chain.
    const githubVisibility = null;
    const installationPayload = null;
    if (blockedReason !== null) {
      const effective = target === null ? null : effectiveTargetSettings(target, defaults);
      const checkGate = effective === null ? null : checkGateOf(effective);
      const defaultReviewLevel = target === null ? null : (await readDefaultReviewLevel(gate.db)).value;
      return c.json({
        can_manage: true,
        blocked: true,
        blocked_reason: blockedReason,
        workspace_id: gate.scope.workspaceId,
        targets_many: gate.targets_many,
        target_id: target === null ? null : target.id,
        ...(target === null
          ? {}
          : {
              check_gate:
                checkGate === null
                  ? null
                  : { min_score: checkGate.minScore, pass_verdicts: [...checkGate.passVerdicts] },
            }),
        app: {
          github_app_id: app.github_app_id,
          id: app.id,
          status: app.status,
          created_by: app.created_by,
          ...(target === null
            ? {}
            : {
                review_enabled: effective!.reviewEnabled,
                review_trigger_mode: effective!.triggerMode,
                review_level: effective!.level,
                default_review_level: defaultReviewLevel,
              }),
          scope: app.scope,
          github_name: app.github_name ?? null,
          github_slug: app.github_slug ?? null,
          github_description: app.github_description ?? null,
          github_html_url: app.github_html_url ?? null,
          github_avatar_url: app.github_avatar_url ?? null,
          github_visibility: githubVisibility,
        },
        installation: installationPayload,
      });
    }
    const effective = target === null ? null : effectiveTargetSettings(target, defaults);
    const checkGate = effective === null ? null : checkGateOf(effective);
    const defaultReviewLevel = target === null ? null : (await readDefaultReviewLevel(gate.db)).value;
    const officialWorkspaceId = await readOfficialWorkspaceId(gate.db);
    const targetOwned =
      target === null
        ? { app: {}, top: {} }
        : {
            app: {
              review_enabled: effective!.reviewEnabled,
              review_trigger_mode: effective!.triggerMode,
              review_level: effective!.level,
              default_review_level: defaultReviewLevel,
            },
            top: {
              target_id: target.id,
              check_gate:
                checkGate === null
                  ? null
                  : { min_score: checkGate.minScore, pass_verdicts: [...checkGate.passVerdicts] },
            },
          };
    const base = {
      workspace_id: gate.scope.workspaceId,
      targets_many: gate.targets_many,
      app: {
        github_app_id: app.github_app_id,
        status: app.status,
        created_by: app.created_by,
        last_webhook_at: app.last_webhook_at ?? null,
        sandbox_image_id: app.sandbox_image_id,
        github_name: app.github_name ?? null,
        github_slug: app.github_slug ?? null,
        github_visibility: githubVisibility,
        scope: app.scope,
        id: app.id,
        github_description: app.github_description ?? null,
        github_html_url: app.github_html_url ?? null,
        github_avatar_url: app.github_avatar_url ?? null,
        github_metadata_synced_at: app.github_metadata_synced_at ?? null,
      },
      installation: installationPayload,
      pending_installations: [],
      blocked: blockedReason !== null,
      blocked_reason: blockedReason,
      official_workspace: officialWorkspaceId !== null && officialWorkspaceId === app.workspace_id,
      can_configure_bot: canWriteBotScope(app, gate.scope),
    };
    if (!c.env.DASHBOARD_ENCRYPTION_KEY) {
      return c.text("the app settings need a configured DASHBOARD_ENCRYPTION_KEY", 500);
    }
    const botSections = await botScopedSections(gate.db, gate.app, c.env.DASHBOARD_ENCRYPTION_KEY, gate.scope);
    return c.json({
      can_manage: true,
      ...base,
      ...targetOwned.top,
      app: { ...base.app, ...targetOwned.app },
      ...botSections,
    });
  } catch (err) {
    logSettingsFailure("api_render", gate.app.id, err);
    return c.text("the app settings could not be read from encrypted storage", 500);
  }
};

function parseGithubAppId(appIdParam: string): number | null {
  if (!/^[0-9]+$/.test(appIdParam)) return null;
  const githubAppId = Number(appIdParam);
  return Number.isSafeInteger(githubAppId) && githubAppId > 0 ? githubAppId : null;
}

const appBotRoute = async (c: DashboardContext) => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const bot = await createReviewBotsStore(member.db).getVisibleBotById(
    c.req.param("botId") ?? "",
    member.scope.workspaceId,
  );
  if (!bot) return c.json({ error: "unknown app" }, 404);
  // `scope` and `sandbox_image_id` in the payload mean the BOT's own columns;
  // every App-sourced key is a null placeholder (F2).
  const app = botRouteRow(bot);
  if (!c.env.DASHBOARD_ENCRYPTION_KEY) {
    return c.text("the app settings need a configured DASHBOARD_ENCRYPTION_KEY", 500);
  }
  const month = quotaMonth(new Date());
  const apps = createReviewBotsStore(member.db);
  const [sections, provider, spendRow, mountRows, quota, defaultChain] = await Promise.all([
    botScopedSections(member.db, app, c.env.DASHBOARD_ENCRYPTION_KEY, member.scope),
    member.db
      .prepare(`SELECT name FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
      .bind(bot.workspace_id)
      .first<{ name: string }>(),
    member.db
      .prepare(
        `SELECT COALESCE(SUM(rp), 0) AS total FROM usage_events
          WHERE workspace_id = ?1 AND bot_id = ?2 AND occurred_at >= ?3 AND occurred_at < ?4`,
      )
      .bind(member.scope.workspaceId, bot.id, month.startIso, month.endIso)
      .first<{ total: number }>(),
    // F6: the chain rows, joined to the App's numeric id + display name — the
    // values the App detail route resolves. Empty until install-state-chain's
    // writers land, which is an honest "not mounted" answer.
    member.db
      .prepare(
        `SELECT DISTINCT m.github_app_id FROM app_install_bots m
          WHERE m.workspace_id = ?1 AND m.bot_id = ?2
          ORDER BY m.github_app_id`,
      )
      .bind(member.scope.workspaceId, bot.id)
      .all<{ github_app_id: string }>(),
    readPlanMonthlyRp(
      member.db,
      member.scope.workspaceId,
      month.startIso,
      deploymentModeOf(c.env.DEPLOYMENT_MODE),
    ),
    // F4: the capability summary reads the DEFAULT chain without owner
    // authority — no keys, no named chains, nothing secret.
    apps.readDefaultChainSummary(bot.id),
  ]);
  const mountIdentities = await apps.listAppIdentities(
    mountRows.results.map((row) => row.github_app_id),
  );
  // F5: ownership (whose bot it is) is separate from publication scope (who
  // may use it) and from this viewer's manage permission.
  const owned = bot.workspace_id === member.scope.workspaceId;
  return c.json({
    can_manage: owned && canManageApp(member.scope),
    owned,
    app: {
      github_app_id: app.github_app_id,
      id: app.id,
      name: bot.name,
      description: bot.description,
      status: app.status,
      scope: app.scope,
      shared_at: bot.shared_at,
      sandbox_image_id: app.sandbox_image_id,
      multiplier: bot.multiplier,
      monthly_rp: bot.monthly_rp,
      last_webhook_at: app.last_webhook_at ?? null,
      github_name: app.github_name ?? null,
      github_slug: app.github_slug ?? null,
      github_description: app.github_description ?? null,
      github_html_url: app.github_html_url ?? null,
      github_avatar_url: app.github_avatar_url ?? null,
      github_metadata_synced_at: app.github_metadata_synced_at ?? null,
    },
    overview: {
      provider_workspace: provider?.name ?? bot.workspace_id,
      month_used_rp: Number(spendRow?.total ?? 0),
      plan_quota: quota.kind,
      plan_monthly_rp: quota.kind === "ceiling" ? quota.rp : null,
      default_chain: defaultChain,
      mounted_apps: mountIdentities.map((row) => ({
        id: row.id,
        github_app_id: row.github_app_id,
        name: row.name,
      })),
      mounted_bot_ids: mountRows.results.map((row) => row.github_app_id),
    },
    ...sections,
  });
};

type ScopeSwitchKind = "app" | "bot";

const SCOPE_SWITCH_COPY: Record<
  ScopeSwitchKind,
  { notFound: string; outsideOfficial: string }
> = {
  app: { notFound: "app not found", outsideOfficial: "app is outside the official workspace" },
  bot: { notFound: "bot not found", outsideOfficial: "bot is outside the official workspace" },
};

/**
 * One share-switch route. `kind` decides WHICH resolution, column and audit
 * action the write uses: the App switch resolves `:appId` as the numeric
 * GitHub App id and writes `github_apps.scope`; the bot switch resolves
 * `:botId` as the `review_bots.id` string and writes `review_bots.scope`.
 * The two id spaces cannot resolve on the wrong route, so a bot id and an
 * App id can never be confused.
 */
function scopeSwitchRoute(kind: ScopeSwitchKind) {
  return async (c: DashboardContext): Promise<Response> => {
    const gate = await requireMember(c);
    if (!gate.ok) return gate.response;
    const copy = SCOPE_SWITCH_COPY[kind];
    let entity: { id: string; workspace_id?: string } | null = null;
    if (kind === "app") {
      entity = await resolveScopedApp(
        createReviewBotsStore(gate.db),
        c.req.param("appId") ?? "",
        gate.scope,
      );
    } else {
      entity = await createReviewBotsStore(gate.db).getScopedBotById(
        c.req.param("botId") ?? "",
        gate.scope.workspaceId,
      );
    }
    if (!entity) return c.json({ error: "unknown app" }, 404);
    if (!canManageApp(gate.scope)) return c.json({ error: "forbidden" }, 403);
    if (!canWriteBotScope(entity as GithubAppRow, gate.scope)) return botReadOnlyResponse(c);
    let scope: unknown;
    let confirm: unknown;
    try {
      const body = (await c.req.json()) as { scope?: unknown; confirm?: unknown };
      scope = body.scope;
      confirm = body.confirm;
    } catch {
    }
    if (scope !== "owned" && scope !== "shared") {
      return c.json({ error: 'body must be { scope: "owned" | "shared" }' }, 400);
    }
    const args = {
      scope: scope as BotScope,
      confirm: confirm === true,
      actor: gate.session.login,
      now: new Date().toISOString(),
    };
    const outcome =
      kind === "app"
        ? await setAppScope(gate.db, { appId: entity.id, ...args })
        : await setReviewBotScope(gate.db, {
            botId: entity.id,
            ...args,
            // F12: the store itself re-checks ownership and the owner/admin
            // authority, so a caller that bypasses this route cannot write.
            authority: { workspaceId: gate.scope.workspaceId, role: gate.scope.role },
          });
    if (outcome.outcome === "bot_not_found") return c.json({ error: copy.notFound }, 404);
    if (outcome.outcome === "forbidden") return c.json({ error: "forbidden" }, 403);
    if (outcome.outcome === "outside_official_workspace") {
      return c.json({ error: copy.outsideOfficial }, 409);
    }
    if (outcome.outcome === "confirm_required") {
      return c.json({ error: "confirm required" }, 409);
    }
    return c.json({ scope: outcome.scope, sharedAt: outcome.sharedAt });
  };
}

const appScopeRoute = scopeSwitchRoute("app");
const botScopeRoute = scopeSwitchRoute("bot");

const DELIVERY_PAGE_LIMIT = 20;
const DELIVERY_PAGE_OFFSET_MAX = 100_000;

const DELIVERY_SINCE_DAYS_MAX = 3650;

type DeliveryQueryResult =
  | { ok: true; filters: DeliveryFilters }
  | { ok: false; error: string };

function parseDeliveryQuery(c: DashboardContext): DeliveryQueryResult {
  const repo = c.req.query("repo") ?? "";
  const since = c.req.query("since") ?? "";
  const type = c.req.query("type") ?? "";
  const rawOffset = c.req.query("offset") ?? "0";
  if (repo !== "" && !/^[^/]+\/[^/]+$/.test(repo)) {
    return { ok: false, error: "invalid repo" };
  }
  let sinceDays: number | null = null;
  if (since !== "") {
    if (!/^[0-9]+$/.test(since)) return { ok: false, error: "invalid since" };
    const days = Number(since);
    if (!Number.isSafeInteger(days) || days < 1 || days > DELIVERY_SINCE_DAYS_MAX) {
      return { ok: false, error: "invalid since" };
    }
    sinceDays = days;
  }
  if (!/^[0-9]+$/.test(rawOffset)) return { ok: false, error: "invalid offset" };
  const offset = Number(rawOffset);
  if (!Number.isSafeInteger(offset) || offset > DELIVERY_PAGE_OFFSET_MAX) {
    return { ok: false, error: "invalid offset" };
  }
  return {
    ok: true,
    filters: {
      repo: repo === "" ? null : repo,
      sinceDays,
      eventName: type === "" ? null : type,
      limit: DELIVERY_PAGE_LIMIT,
      offset,
    },
  };
}

const appDeliveriesRoute = async (c: DashboardContext) => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const app = await resolveScopedApp(
    createReviewBotsStore(member.db),
    c.req.param("appId") ?? "",
    member.scope,
  );
  if (!app) return c.json({ error: "unknown app" }, 404);
  const query = parseDeliveryQuery(c);
  if (!query.ok) return c.json({ error: query.error }, 400);
  const page = await createReviewBotsStore(member.db).listDeliveries(
    app.id,
    query.filters,
    canWriteBotScope(app, member.scope) ? null : member.scope.workspaceId,
  );
  c.header("Cache-Control", "private, no-store");
  return c.json({
    deliveries: page.rows.map((row) => ({
      event_name: row.event_name,
      outcome: row.outcome,
      status_code: row.status_code,
      repository_full_name: row.repository_full_name,
      reason: row.reason,
      created_at: row.created_at,
    })),
    total: page.total,
    repos: page.repos,
    types: page.types,
  });
};

const appRefreshMetadataRoute = async (c: DashboardContext): Promise<Response> => {
  // App-side operation (the metadata lives on github_apps): resolves the App
  // by its numeric GitHub App id — not the bot gate, which reads :botId.
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const apps = createReviewBotsStore(member.db);
  const app = await resolveScopedApp(apps, c.req.param("appId") ?? "", member.scope);
  if (!app) return c.json({ error: "unknown app" }, 404);
  if (!canManageApp(member.scope)) return c.json({ error: "forbidden" }, 403);
  if (!canWriteBotScope(app, member.scope)) return botReadOnlyResponse(c);
  if (!c.env.DASHBOARD_ENCRYPTION_KEY) {
    return c.text("the app settings need a configured DASHBOARD_ENCRYPTION_KEY", 500);
  }
  const live = await liveTargetsForBot(member.db, member.scope.workspaceId, app.id);
  const landing = repositoryLandingPath({ target: live.length === 1 ? live[0]! : null });
  const refresh = await refreshGithubMetadata(app, apps, c.env.DASHBOARD_ENCRYPTION_KEY, {
    force: true,
  });
  if (refresh.status !== "refreshed") {
    return settings400Response(c, landing, SETTINGS_400_KEYS.githubMetadataRefreshFailed);
  }
  return settingsPostResponse(c, landing, `Refreshed ${appDisplayName(refresh.row)} from GitHub.`);
};

type DeclaredVocabulary =
  | {
      ok: true;
      api: CustomProviderApi;
      baseUrl: string;
      current: readonly string[];
      models: string[];
    }
  | { ok: false; response: Response };

async function loadDeclaredVocabulary(
  c: DashboardContext,
  gate: { app: { id: string }; target: ReviewTargetRow | null },
  store: AppConfigStore,
  providerId: string,
): Promise<DeclaredVocabulary> {
  const landing = repositoryLandingPath(gate);
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
    return { ok: false, response: settings400Response(c, landing, SETTINGS_400_KEYS.providerIdInvalid) };
  }
  const declared = (await store.listCustomProviders(gate.app.id)).find((row) => row.provider_id === providerId);
  if (declared === undefined) {
    return {
      ok: false,
      response: settings400Response(c, landing, SETTINGS_400_KEYS.customProviderUndeclared, {
        provider: providerId,
      }),
    };
  }
  const keys = await store.listCustomProviderKeys(gate.app.id, providerId);
  const first = keys[0];
  const stored =
    first === undefined ? null : await store.getProviderKeyPlaintext(gate.app.id, providerId, first.keyId);
  const fetched = await fetchDeclaredProviderModels(
    { fetch: verifyFetch },
    { baseUrl: declared.base_url, api: declared.api },
    stored?.plainKey ?? null,
  );
  if (!fetched.ok) {
    if (fetched.keyless && (fetched.reason === "invalid_key" || fetched.reason === "quota_exhausted")) {
      return {
        ok: false,
        response: settings400Response(c, landing, SETTINGS_400_KEYS.providerModelsKeyRequired, {
          provider: providerId,
        }),
      };
    }
    return { ok: false, response: settingsVerifyFailResponse(c, landing, fetched.reason) };
  }
  const models = modelIdsForProtocol(fetched.entries, declared.api);
  if (models.length === 0) {
    return {
      ok: false,
      response: settings400Response(c, landing, SETTINGS_400_KEYS.providerModelsEmpty, { provider: providerId }),
    };
  }
  if (models.length > MAX_CUSTOM_PROVIDER_MODEL_IDS) {
    return {
      ok: false,
      response: settings400Response(c, landing, SETTINGS_400_KEYS.modelIdsTooMany, {
        count: models.length,
        limit: MAX_CUSTOM_PROVIDER_MODEL_IDS,
      }),
    };
  }
  if (models.some((id) => id.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH)) {
    return {
      ok: false,
      response: settings400Response(c, landing, SETTINGS_400_KEYS.modelIdTooLong, {
        limit: MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH,
      }),
    };
  }
  return { ok: true, api: declared.api, baseUrl: declared.base_url, current: declared.model_ids, models };
}

const appProviderModelsPreviewRoute = async (c: DashboardContext): Promise<Response> => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  if (!canReadBotScope(gate.app, gate.scope)) return botReadOnlyResponse(c);
  const providerId = (c.req.query("provider") ?? "").trim();
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  try {
    const vocabulary = await loadDeclaredVocabulary(c, gate, store, providerId);
    if (!vocabulary.ok) return vocabulary.response;
    const current = new Set(vocabulary.current);
    const fetched = new Set(vocabulary.models);
    c.header("Cache-Control", "private, no-store");
    return c.json({
      ok: true,
      provider: providerId,
      current: vocabulary.current.length,
      fetched: vocabulary.models.length,
      kept: vocabulary.models.filter((id) => current.has(id)).length,
      added: vocabulary.models.filter((id) => !current.has(id)).length,
      dropped: vocabulary.current.filter((id) => !fetched.has(id)).length,
    });
  } catch (err) {
    logSettingsFailure("provider_models_preview", gate.app.id, err);
    return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
  }
};

const providerCatalogRoute = async (c: DashboardContext) => {
  if (c.get("tenant")?.principal !== "operator-granted") {
    const member = await requireMember(c);
    if (!member.ok) return member.response;
  }
  const catalog = await providerCatalog();
  const etag = `"${catalog.version}"`;
  c.header("ETag", etag);
  c.header("Cache-Control", c.req.query("v") === catalog.version
    ? "private, max-age=31536000, immutable"
    : "private, no-cache");
  if (c.req.header("If-None-Match")?.split(",").some((value) =>
    value.trim() === "*" || value.trim().replace(/^W\//, "") === etag)) {
    return c.body(null, 304);
  }
  c.header("Content-Type", "application/json; charset=UTF-8");
  return c.body(catalog.json);
};

const appModelsRoute = async (c: DashboardContext) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  if (!canReadBotScope(gate.app, gate.scope)) return botReadOnlyResponse(c);
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  try {
    const [verified, custom] = await orderedReads([
      store.getVerifiedModels(gate.app.id),
      store.listCustomProviders(gate.app.id),
    ]);
    c.header("Cache-Control", "private, no-store");
    return c.json({ groups: composeModelOptions(verified, custom) });
  } catch (err) {
    logSettingsFailure("api_models", gate.app.id, err);
    return c.text("the app models could not be read", 500);
  }
};

type DeclaredKeyAppendOutcome =
  | { status: "appended" }
  | { status: "undeclared" }
  | { status: "endpoint-locked" }
  | { status: "limit" }
  | { status: "rejected"; reason: VerifyFailureReason };

async function appendDeclaredProviderKey(
  store: AppConfigStore,
  authority: BotWriteAuthority,
  appId: string,
  providerId: string,
  plainKey: string,
): Promise<DeclaredKeyAppendOutcome> {
  const declared = (await store.listCustomProviders(appId)).find((row) => row.provider_id === providerId);
  if (declared === undefined) return { status: "undeclared" };
  const verified = await verifyProviderKey({ fetch: verifyFetch }, providerId, plainKey, {
    baseUrl: declared.base_url,
    api: declared.api,
    modelIds: declared.model_ids,
  });
  if (!verified.ok) return { status: "rejected", reason: verified.reason };
  try {
    await store.addCustomProviderKey(authority, appId, providerId, plainKey, {
      base_url: declared.base_url,
      api: declared.api,
    });
  } catch (err) {
    if (err instanceof InvalidCustomProviderError) return { status: "undeclared" };
    if (err instanceof ProviderEndpointLockedError) return { status: "endpoint-locked" };
    if (err instanceof ProviderKeyLimitError) return { status: "limit" };
    throw err;
  }
  return { status: "appended" };
}

function verifyKeyed400(
  c: DashboardContext,
  key: DictionaryKey,
  params: Record<string, string | number>,
): Response {
  return c.json({ ok: false, reason: "unexpected" as const, key, message: t("en", key, params), params }, 400);
}

const appKeyVerifyRoute = async (c: DashboardContext) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  if (!canWriteBotScope(gate.app, gate.scope)) return botReadOnlyResponse(c);
  const form = await c.req.parseBody();
  const provider = typeof form.provider === "string" ? form.provider.trim() : "";
  const plainKey = typeof form.key === "string" ? form.key.trim() : "";
  if (provider === "" || plainKey === "" || plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
    return c.json({ ok: false, reason: "unexpected" as const }, 400);
  }
  // note: A `!`-prefixed key would be run as a shell command by the review
  // runtime's config-value resolver (packages/shared/src/credential-key.ts) — the
  // same rule the runner's payload decoder enforces fail-closed. The keyed
  // face reuses the existing `unexpected` reason (the enum is closed; the
  // ProviderKeyLimit path below sets the precedent).
  if (isCommandConfigKey(plainKey)) {
    return c.json(
      {
        ok: false,
        reason: "unexpected" as const,
        key: SETTINGS_400_KEYS.apiKeyCommandPrefix,
        message: t("en", SETTINGS_400_KEYS.apiKeyCommandPrefix),
      },
      400,
    );
  }
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  if (!PROVIDER_IDS.includes(provider)) {
    try {
      const outcome = await appendDeclaredProviderKey(store, botWriteAuthority(gate), gate.app.id, provider, plainKey);
      if (outcome.status === "undeclared") {
        return verifyKeyed400(c, SETTINGS_400_KEYS.customProviderUndeclared, { provider });
      }
      if (outcome.status === "endpoint-locked") {
        return verifyKeyed400(c, SETTINGS_400_KEYS.providerEndpointLocked, { provider });
      }
      if (outcome.status === "limit") {
        return verifyKeyed400(c, SETTINGS_400_KEYS.providerKeyLimit, {
          provider,
          limit: MAX_KEYS_PER_PROVIDER,
        });
      }
      if (outcome.status === "rejected") {
        return c.json({ ok: false, reason: mapVerifyReason(outcome.reason) }, 400);
      }
      return c.json({ ok: true, provider });
    } catch (err) {
      logSettingsFailure("verify_key", gate.app.id, err);
      return c.json({ ok: false, reason: "unexpected" as const }, 500);
    }
  }
  if (!isOmpRuntimeImage(gate.app.sandbox_image_id)) {
    return c.json(
      {
        ok: false,
        reason: "unsupported_provider" as const,
        key: SETTINGS_400_KEYS.providerUnavailableOnHarness,
        message: t("en", SETTINGS_400_KEYS.providerUnavailableOnHarness, {
          provider,
          image: gate.app.sandbox_image_id,
        }),
        params: { provider, image: gate.app.sandbox_image_id },
      },
      400,
    );
  }
  try {
    const verified = await verifyProviderKey({ fetch: verifyFetch }, provider, plainKey);
    if (!verified.ok) {
      return c.json({ ok: false, reason: mapVerifyReason(verified.reason) }, 400);
    }
    await store.saveVerifiedKey(botWriteAuthority(gate), gate.app.id, provider, plainKey, verified.models);
    return c.json({ ok: true, provider, models: verified.models });
  } catch (err) {
    logSettingsFailure("verify_key", gate.app.id, err);
    if (err instanceof ProviderKeyLimitError) {
      return verifyKeyed400(c, SETTINGS_400_KEYS.providerKeyLimit, {
        provider,
        limit: MAX_KEYS_PER_PROVIDER,
      });
    }
    return c.json({ ok: false, reason: "unexpected" as const }, 500);
  }
};

const appKeyUsageRoute = async (c: DashboardContext) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  if (!canReadBotScope(gate.app, gate.scope)) return botReadOnlyResponse(c);
  const form = await c.req.parseBody();
  const provider = typeof form.provider === "string" ? form.provider.trim() : "";
  const keyId = typeof form.keyId === "string" ? form.keyId.trim() : "";
  const probeHosts = usageProbeHosts(provider);
  if (probeHosts === null) {
    return c.json({ ok: false, reason: "unsupported_provider" as const }, 400);
  }
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  try {
    const stored = await store.getProviderKeyPlaintext(gate.app.id, provider, keyId);
    if (stored === null) return c.json({ ok: false, reason: "unknown_key" as const }, 400);
    if (stored.custom) {
      const declaredBaseUrl = await store.getCustomProviderBaseUrl(gate.app.id, provider);
      const declaredHost = declaredBaseUrl === null ? null : endpointHost(declaredBaseUrl);
      if (declaredHost === null || !probeHosts.includes(declaredHost)) {
        const key =
          declaredHost === null
            ? SETTINGS_400_KEYS.usageProbeUnreadableEndpoint
            : SETTINGS_400_KEYS.usageProbeOffVendorHost;
        const params: Record<string, string | number> =
          declaredHost === null ? { provider } : { provider, host: declaredHost };
        return c.json(
          {
            ok: false,
            reason: "unsupported_provider" as const,
            key,
            message: t("en", key, params),
            params,
          },
          400,
        );
      }
    }
    const snapshot = await probeProviderUsage({ fetch: verifyFetch }, provider, stored.plainKey);
    c.header("Cache-Control", "private, no-store");
    return c.json({ ok: true, ...snapshot });
  } catch (err) {
    logSettingsFailure("key_usage", gate.app.id, err);
    return c.json({ ok: false, reason: "unexpected" as const }, 400);
  }
};

const BOT_SCOPED_SETTINGS_OPS: ReadonlySet<string> = new Set([
  "add-key",
  "save-chain",
  "save-roles",
  "add-chain",
  "remove-chain",
  "add-custom-provider",
  "add-custom-provider-key",
  "add-template-provider",
  "update-provider-models",
  "sync-provider-models",
  "remove-custom-provider",
  "save-sandbox-image",
]);

function botReadOnlyResponse(c: DashboardContext): Response {
  return c.json({ key: "settings.error.botReadOnly", message: t("en", "settings.error.botReadOnly") }, 403);
}

const appSettingsSaveRoute = async (c: DashboardContext) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody({ all: true });
  const op = typeof form.op === "string" ? form.op : "";
  if (BOT_SCOPED_SETTINGS_OPS.has(op) && !canWriteBotScope(gate.app, gate.scope)) {
    return botReadOnlyResponse(c);
  }
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  if (op === "add-key") {
    const provider = typeof form.provider === "string" ? form.provider.trim() : "";
    const plainKey = typeof form.key === "string" ? form.key.trim() : "";
    if (!PROVIDER_IDS.includes(provider)) {
      return provider === ""
        ? settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerRequired)
        : settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerUnknown, { provider });
    }
    if (!isOmpRuntimeImage(gate.app.sandbox_image_id)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerUnavailableOnHarness, {
        provider,
        image: gate.app.sandbox_image_id,
      });
    }
    if (plainKey === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyRequired);
    }
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyTooLong, {
        count: plainKey.length,
        limit: MAX_PROVIDER_KEY_LENGTH,
      });
    }
    // note: A `!`-prefixed key would be run as a shell command by the review
    // runtime's config-value resolver (packages/shared/src/credential-key.ts) — the
    // same rule the runner's payload decoder enforces fail-closed.
    if (isCommandConfigKey(plainKey)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyCommandPrefix);
    }
    try {
      const verified = await verifyProviderKey({ fetch: verifyFetch }, provider, plainKey);
      if (!verified.ok) {
        return settingsVerifyFailResponse(c, repositoryLandingPath(gate), verified.reason);
      }
      await store.saveVerifiedKey(botWriteAuthority(gate), gate.app.id, provider, plainKey, verified.models);
    } catch (err) {
      logSettingsFailure("add_key", gate.app.id, err);
      if (err instanceof ProviderKeyLimitError) {
        return settingsKeyLimitResponse(c, repositoryLandingPath(gate), provider);
      }
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, repositoryLandingPath(gate), `Stored the ${provider} key for ${appDisplayName(gate.app)} — it is only ever shown masked.`,
    );
  }
  if (op === "save-chain") {
    if (Array.isArray(form.model_chain)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.chainFieldDuplicated);
    }
    const raw = typeof form.model_chain === "string" ? form.model_chain : "";
    try {
      if (raw.trim() === "") {
        await store.setModelChain(botWriteAuthority(gate), gate.app.id, null);
        return settingsPostResponse(c, repositoryLandingPath(gate), `Cleared the model chain for ${appDisplayName(gate.app)} — reviews fail closed until a chain + provider keys are configured (per-App only).`,
        );
      }
      if (raw.length > MAX_MODEL_SELECTOR_LENGTH) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.chainTooLong, {
          count: raw.length,
          limit: MAX_MODEL_SELECTOR_LENGTH,
        });
      }
      const selectors = parseModelChain(raw);
      if (selectors.length === 0) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.chainEmpty);
      }
      const failing = findFailingSelector(
        selectors,
        await store.getVerifiedModels(gate.app.id),
        await store.listCustomProviders(gate.app.id),
      );
      if (failing) {
        return settingsMembershipFailResponse(c, repositoryLandingPath(gate), failing);
      }
      await store.setModelChain(botWriteAuthority(gate), gate.app.id, raw);
    } catch (err) {
      logSettingsFailure("save_chain", gate.app.id, err);
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, repositoryLandingPath(gate), `Saved the model chain for ${appDisplayName(gate.app)}.`);
  }
  if (op === "save-roles") {
    const refs: Record<string, string> = {};
    for (const [field, value] of Object.entries(form)) {
      if (!field.startsWith("role_")) continue;
      if (Array.isArray(value)) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.roleFieldDuplicated, { field });
      }
      if (typeof value !== "string") continue;
      const role = field.slice("role_".length);
      if (!MODEL_ROLE_IDS.includes(role)) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.roleUnknown, { role });
      }
      refs[role] = value.trim();
    }
    const missingSeats = MODEL_ROLE_IDS.filter((role) => !(role in refs));
    if (missingSeats.length === MODEL_ROLE_IDS.length) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.roleFieldsMissingAll);
    }
    if (missingSeats.length > 0) {
      return settings400Response(
        c,
        repositoryLandingPath(gate),
        missingSeats.length === 1 ? SETTINGS_400_KEYS.roleFieldMissing : SETTINGS_400_KEYS.roleFieldsMissing,
        { roles: missingSeats.join(", ") },
      );
    }
    try {
      const chains = await store.getModelChains(gate.app.id);
      const knownChains = new Set(chains.map((chain) => chain.name));
      for (const [role, chainName] of Object.entries(refs)) {
        if (chainName === "" || chainName === DEFAULT_CHAIN_NAME) continue;
        if (!knownChains.has(chainName)) {
          return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.roleChainUnknown, { role });
        }
      }
      await store.setModelChainSeats(botWriteAuthority(gate), gate.app.id, refs);
    } catch (err) {
      logSettingsFailure("save_roles", gate.app.id, err);
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, repositoryLandingPath(gate), `Saved the role models for ${appDisplayName(gate.app)}.`);
  }
  if (op === "add-chain") {
    const name = typeof form.name === "string" ? form.name.trim() : "";
    const chain = typeof form.chain === "string" ? form.chain : "";
    if (name === "" || name === DEFAULT_CHAIN_NAME || !MODEL_CHAIN_NAME_PATTERN.test(name)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.chainNameInvalid, {
        limit: MAX_MODEL_CHAIN_NAME_LENGTH,
      });
    }
    if (chain.trim() === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.chainValueRequired);
    }
    if (chain.length > MAX_MODEL_SELECTOR_LENGTH) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.chainTooLong, {
        count: chain.length,
        limit: MAX_MODEL_SELECTOR_LENGTH,
      });
    }
    const selectors = parseModelChain(chain);
    if (selectors.length === 0) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.chainEmpty);
    }
    const failing = findFailingSelector(
      selectors,
      await store.getVerifiedModels(gate.app.id),
      await store.listCustomProviders(gate.app.id),
    );
    if (failing) {
      return settingsMembershipFailResponse(c, repositoryLandingPath(gate), failing);
    }
    try {
      await store.upsertModelChain(botWriteAuthority(gate), gate.app.id, name, chain);
    } catch (err) {
      logSettingsFailure("add_chain", gate.app.id, err);
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, repositoryLandingPath(gate), `Saved the ${name} model chain for ${appDisplayName(gate.app)}.`);
  }
  if (op === "remove-chain") {
    const name = typeof form.name === "string" ? form.name.trim() : "";
    if (name === "" || name === DEFAULT_CHAIN_NAME) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.defaultChainRemoveProtected);
    }
    try {
      await store.removeModelChain(botWriteAuthority(gate), gate.app.id, name);
    } catch (err) {
      logSettingsFailure("remove_chain", gate.app.id, err);
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, repositoryLandingPath(gate), `Removed the ${name} model chain for ${appDisplayName(gate.app)} — seats using it fall back to the default chain.`);
  }
  if (op === "add-custom-provider") {
    const providerId = typeof form.provider_id === "string" ? form.provider_id.trim() : "";
    const baseUrl = typeof form.base_url === "string" ? form.base_url.trim() : "";
    const api = typeof form.api === "string" ? form.api.trim() : "";
    const modelIds = parseModelChain(typeof form.model_ids === "string" ? form.model_ids : "");
    const plainKey = typeof form.key === "string" ? form.key.trim() : "";
    if (providerId === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerIdRequired);
    }
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerIdInvalid);
    }
    if (PROVIDER_IDS.includes(providerId)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerIdBuiltin, { provider: providerId });
    }
    const declaredCustomProviders = await store.listCustomProviders(gate.app.id);
    if (
      !declaredCustomProviders.some((p) => p.provider_id === providerId) &&
      declaredCustomProviders.length >= MAX_CUSTOM_PROVIDER_COUNT
    ) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.customProviderMax, {
        limit: MAX_CUSTOM_PROVIDER_COUNT,
      });
    }
    if (baseUrl === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.baseUrlRequired);
    }
    if (!isValidCustomProviderBaseUrl(baseUrl)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.baseUrlInvalid);
    }
    if (baseUrl.length > MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.baseUrlTooLong, {
        count: baseUrl.length,
        limit: MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH,
      });
    }
    if (api === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiProtocolRequired);
    }
    if (!CUSTOM_PROVIDER_API_IDS.includes(api as (typeof CUSTOM_PROVIDER_API_IDS)[number])) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiProtocolUnknown, { api });
    }
    if (modelIds.length === 0) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.modelIdsRequired);
    }
    if (modelIds.length > MAX_CUSTOM_PROVIDER_MODEL_IDS) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.modelIdsTooMany, {
        count: modelIds.length,
        limit: MAX_CUSTOM_PROVIDER_MODEL_IDS,
      });
    }
    if (modelIds.some((id) => id.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.modelIdTooLong, {
        limit: MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH,
      });
    }
    if (plainKey === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyRequired);
    }
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyTooLong, {
        count: plainKey.length,
        limit: MAX_PROVIDER_KEY_LENGTH,
      });
    }
    // note: A `!`-prefixed key would be run as a shell command by the review
    // runtime's config-value resolver (packages/shared/src/credential-key.ts) — the
    // same rule the runner's payload decoder enforces fail-closed.
    if (isCommandConfigKey(plainKey)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyCommandPrefix);
    }
    try {
      const verified = await verifyProviderKey(
        { fetch: verifyFetch },
        providerId,
        plainKey,
        {
          baseUrl,
          api: api as (typeof CUSTOM_PROVIDER_API_IDS)[number],
          modelIds,
        },
      );
      if (!verified.ok) {
        return settingsVerifyFailResponse(c, repositoryLandingPath(gate), verified.reason);
      }
      await store.upsertCustomProvider(
        botWriteAuthority(gate),
        gate.app.id,
        { provider_id: providerId, base_url: baseUrl, api: api as (typeof CUSTOM_PROVIDER_API_IDS)[number], model_ids: modelIds },
        plainKey,
      );
    } catch (err) {
      logSettingsFailure("add_custom_provider", gate.app.id, err);
      if (err instanceof ProviderEndpointLockedError) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerEndpointLocked, {
          provider: providerId,
        });
      }
      if (err instanceof InvalidCustomProviderError) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.customProviderDeclRejected);
      }
      if (err instanceof ProviderKeyLimitError) {
        return settingsKeyLimitResponse(c, repositoryLandingPath(gate), providerId);
      }
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, repositoryLandingPath(gate), `Declared custom provider ${providerId} for ${appDisplayName(gate.app)} — its key is stored encrypted and injected by environment variable name.`,
    );
  }
  if (op === "add-custom-provider-key") {
    const providerId = typeof form.provider_id === "string" ? form.provider_id.trim() : "";
    const plainKey = typeof form.key === "string" ? form.key.trim() : "";
    if (providerId === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerIdRequired);
    }
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerIdInvalid);
    }
    if (plainKey === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyRequired);
    }
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyTooLong, {
        count: plainKey.length,
        limit: MAX_PROVIDER_KEY_LENGTH,
      });
    }
    // note: A `!`-prefixed key would be run as a shell command by the review
    // runtime's config-value resolver (packages/shared/src/credential-key.ts).
    if (isCommandConfigKey(plainKey)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyCommandPrefix);
    }
    try {
      const outcome = await appendDeclaredProviderKey(store, botWriteAuthority(gate), gate.app.id, providerId, plainKey);
      if (outcome.status === "undeclared") {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.customProviderUndeclared, {
          provider: providerId,
        });
      }
      if (outcome.status === "endpoint-locked") {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerEndpointLocked, {
          provider: providerId,
        });
      }
      if (outcome.status === "limit") {
        return settingsKeyLimitResponse(c, repositoryLandingPath(gate), providerId);
      }
      if (outcome.status === "rejected") {
        return settingsVerifyFailResponse(c, repositoryLandingPath(gate), outcome.reason);
      }
    } catch (err) {
      logSettingsFailure("add_custom_provider_key", gate.app.id, err);
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(
      c,
      repositoryLandingPath(gate),
      `Added another ${providerId} key for ${appDisplayName(gate.app)} — it is only ever shown masked.`,
    );
  }
  if (op === "add-template-provider") {
    const templateId = typeof form.template_id === "string" ? form.template_id.trim() : "";
    const accountId = typeof form.account_id === "string" ? form.account_id.trim() : "";
    const formBaseUrl = typeof form.base_url === "string" ? form.base_url.trim() : "";
    const plainKey = typeof form.key === "string" ? form.key.trim() : "";
    const template = PROVIDER_META[templateId];
    if (template === undefined || template.tier !== "template") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.templateUnknown);
    }
    const requestedApi = typeof form.api === "string" ? form.api.trim() : "";
    const protocolOptions = template.protocols ?? [
      { api: template.api, baseUrl: template.baseUrl, models: template.models },
    ];
    const protocol =
      requestedApi === "" ? protocolOptions[0] : protocolOptions.find((option) => option.api === requestedApi);
    if (protocol === undefined) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.templateApiUnsupported, {
        api: requestedApi,
      });
    }
    const baseUrlTemplate = formBaseUrl !== "" ? formBaseUrl : protocol.baseUrl;
    if (baseUrlTemplate === null || baseUrlTemplate === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.templateIncomplete);
    }
    if (baseUrlTemplate.includes("{account_id}")) {
      if (accountId === "") {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.accountIdRequired);
      }
      if (!CLOUDFLARE_ACCOUNT_ID_PATTERN.test(accountId)) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.accountIdInvalid);
      }
    }
    if (PROVIDER_IDS.includes(templateId)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.templateIdBuiltin, { template: templateId });
    }
    const baseUrl = baseUrlTemplate.replace("{account_id}", accountId);
    if (!isValidCustomProviderBaseUrl(baseUrl)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.materializedBaseUrlInvalid);
    }
    if (baseUrl.length > MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.baseUrlTooLong, {
        count: baseUrl.length,
        limit: MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH,
      });
    }
    if (!CUSTOM_PROVIDER_API_IDS.includes(protocol.api as (typeof CUSTOM_PROVIDER_API_IDS)[number])) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.templateApiUnsupported, {
        api: String(protocol.api),
      });
    }
    const modelIds = [...protocol.models].slice(0, MAX_CUSTOM_PROVIDER_MODEL_IDS);
    if (modelIds.length === 0) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.templateNoModels);
    }
    if (modelIds.some((id) => id.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.modelIdTooLong, {
        limit: MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH,
      });
    }
    if (plainKey === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyRequired);
    }
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyTooLong, {
        count: plainKey.length,
        limit: MAX_PROVIDER_KEY_LENGTH,
      });
    }
    // note: A `!`-prefixed key would be run as a shell command by the review
    // runtime's config-value resolver (packages/shared/src/credential-key.ts) — the
    // same rule the runner's payload decoder enforces fail-closed.
    if (isCommandConfigKey(plainKey)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.apiKeyCommandPrefix);
    }
    const declaredCustomProviders = await store.listCustomProviders(gate.app.id);
    const storedDeclaration = declaredCustomProviders.find((p) => p.provider_id === templateId);
    if (
      storedDeclaration === undefined &&
      declaredCustomProviders.length >= MAX_CUSTOM_PROVIDER_COUNT
    ) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.templateMaterializeMax, {
        limit: MAX_CUSTOM_PROVIDER_COUNT,
      });
    }
    const declApi = storedDeclaration?.api ?? (protocol.api as (typeof CUSTOM_PROVIDER_API_IDS)[number]);
    const declModelIds = storedDeclaration?.model_ids ?? modelIds;
    try {
      const verified = await verifyProviderKey(
        { fetch: verifyFetch },
        templateId,
        plainKey,
        {
          baseUrl,
          api: declApi,
          modelIds: declModelIds,
        },
      );
      if (!verified.ok) {
        return settingsVerifyFailResponse(c, repositoryLandingPath(gate), verified.reason);
      }
      await store.upsertCustomProvider(
        botWriteAuthority(gate),
        gate.app.id,
        { provider_id: templateId, base_url: baseUrl, api: declApi, model_ids: declModelIds },
        plainKey,
      );
    } catch (err) {
      logSettingsFailure("add_template_provider", gate.app.id, err);
      if (err instanceof ProviderEndpointLockedError) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerEndpointLocked, {
          provider: templateId,
        });
      }
      if (err instanceof InvalidCustomProviderError) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.customProviderDeclRejected);
      }
      if (err instanceof ProviderKeyLimitError) {
        return settingsKeyLimitResponse(c, repositoryLandingPath(gate), templateId);
      }
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, repositoryLandingPath(gate), `Materialized the ${template.label} template as custom provider ${templateId} for ${appDisplayName(gate.app)} — its key is stored encrypted and injected by environment variable name.`,
    );
  }
  if (op === "update-provider-models") {
    const providerId = typeof form.provider === "string" ? form.provider.trim() : "";
    const modelIds = parseModelChain(typeof form.model_ids === "string" ? form.model_ids : "");
    if (providerId === "") {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerIdRequired);
    }
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.providerIdInvalid);
    }
    if (modelIds.length === 0) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.modelIdsRequired);
    }
    if (modelIds.length > MAX_CUSTOM_PROVIDER_MODEL_IDS) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.modelIdsTooMany, {
        count: modelIds.length,
        limit: MAX_CUSTOM_PROVIDER_MODEL_IDS,
      });
    }
    if (modelIds.some((id) => id.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH)) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.modelIdTooLong, {
        limit: MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH,
      });
    }
    let statedMeta: CustomProviderModelsMeta | undefined;
    const rawMeta = form.models_meta;
    if (rawMeta !== undefined) {
      if (typeof rawMeta !== "string") {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.modelMetaMalformed);
      }
      if (rawMeta.trim() !== "") {
        const stated = parseCustomProviderModelsMeta(rawMeta, modelIds);
        if ("error" in stated) {
          return settings400Response(c, repositoryLandingPath(gate), stated.error, stated.params);
        }
        statedMeta = stated.meta;
      }
    }
    try {
      await store.updateCustomProviderModels(
        botWriteAuthority(gate),
        gate.app.id,
        providerId,
        modelIds,
        statedMeta,
      );
    } catch (err) {
      logSettingsFailure("update_provider_models", gate.app.id, err);
      if (err instanceof InvalidCustomProviderError) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.customProviderUndeclared, {
          provider: providerId,
        });
      }
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(
      c,
      repositoryLandingPath(gate),
      `Saved the ${providerId} model list for ${appDisplayName(gate.app)}.`,
    );
  }
  if (op === "sync-provider-models") {
    const providerId = typeof form.provider === "string" ? form.provider.trim() : "";
    try {
      const vocabulary = await loadDeclaredVocabulary(c, gate, store, providerId);
      if (!vocabulary.ok) return vocabulary.response;
      await store.updateCustomProviderModels(
        botWriteAuthority(gate),
        gate.app.id,
        providerId,
        vocabulary.models,
      );
      return settingsPostResponse(
        c,
        repositoryLandingPath(gate),
        `Synced ${vocabulary.models.length} models for ${providerId} from its endpoint for ${appDisplayName(gate.app)}.`,
      );
    } catch (err) {
      logSettingsFailure("sync_provider_models", gate.app.id, err);
      if (err instanceof InvalidCustomProviderError) {
        return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.customProviderUndeclared, {
          provider: providerId,
        });
      }
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
  }
  if (op === "remove-custom-provider") {
    const providerId = typeof form.provider_id === "string" ? form.provider_id.trim() : "";
    let removed: boolean;
    try {
      removed = await store.removeCustomProvider(botWriteAuthority(gate), gate.app.id, providerId);
    } catch (err) {
      logSettingsFailure("remove_custom_provider", gate.app.id, err);
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsRemoveResponse(
      c,
      repositoryLandingPath(gate),
      removed,
      removed
        ? `Removed the custom provider ${providerId} from ${appDisplayName(gate.app)}.`
        : `No custom provider ${providerId === "" ? "(unspecified)" : providerId} on ${appDisplayName(gate.app)} — nothing changed.`,
    );
  }
  if (op === "save-sandbox-image") {
    const imageId = typeof form.sandbox_image_id === "string" ? form.sandbox_image_id.trim() : "";
    const image = getSandboxImage(imageId);
    if (!image || !image.enabled) {
      return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.runtimeHarnessUnknown);
    }
    try {
      await createReviewBotsStore(gate.db).setSandboxImage(gate.app.id, image.id);
    } catch (err) {
      logSettingsFailure("save_sandbox_image", gate.app.id, err);
      return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, repositoryLandingPath(gate), `Saved the ${image.id} runtime harness for ${appDisplayName(gate.app)}.`);
  }
  return settings400Response(c, repositoryLandingPath(gate), SETTINGS_400_KEYS.unknownOperation);
};

const appKeyDeleteRoute = async (c: DashboardContext) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  if (!canWriteBotScope(gate.app, gate.scope)) return botReadOnlyResponse(c);
  const form = await c.req.parseBody();
  const provider = typeof form.provider === "string" ? form.provider.trim() : "";
  const keyId = typeof form.key_id === "string" ? form.key_id.trim() : "";
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  let removed: boolean;
  try {
    const declaredCustom = (await store.listCustomProviders(gate.app.id)).some(
      (row) => row.provider_id === provider,
    );
    removed = declaredCustom
      ? await store.deleteCustomProviderKey(botWriteAuthority(gate), gate.app.id, provider, keyId)
      : await store.deleteProviderKey(botWriteAuthority(gate), gate.app.id, provider, keyId);
  } catch (err) {
    logSettingsFailure("remove_key", gate.app.id, err);
    return settingsPostResponse(c, repositoryLandingPath(gate), settingsFailureNotice(err), 500);
  }
  return settingsRemoveResponse(
    c,
    repositoryLandingPath(gate),
    removed,
    removed
      ? `Removed the stored ${provider} key for ${appDisplayName(gate.app)}.`
      : `No stored ${provider === "" ? "(unspecified)" : provider} key on ${appDisplayName(gate.app)} — nothing changed.`,
  );
};

const INSIGHTS_REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;
const INSIGHTS_INCLUDE_VALUES = ["repos"] as const;

type InsightsParams =
  | {
      ok: true;
      windowDays: number;
      repoFilter?: { owner: string; repo: string };
      rawRepo?: string;
      includeRepos: boolean;
    }
  | { ok: false; reason: string };

function parseInsightsParams(query: { window?: string; repo?: string; include?: string }): InsightsParams {
  let windowDays = 30;
  const rawWindow = query.window;
  if (rawWindow !== undefined) {
    if (!/^\d+$/.test(rawWindow)) {
      return { ok: false, reason: "window must be a non-negative integer number of days" };
    }
    windowDays = Number(rawWindow);
  }

  let repoFilter: { owner: string; repo: string } | undefined;
  let rawRepo: string | undefined;
  const rawRepoParam = query.repo;
  if (rawRepoParam !== undefined) {
    if (!INSIGHTS_REPO_PATTERN.test(rawRepoParam)) {
      return { ok: false, reason: "repo must be owner/repo" };
    }
    rawRepo = rawRepoParam;
    const slash = rawRepoParam.indexOf("/");
    repoFilter = { owner: rawRepoParam.slice(0, slash), repo: rawRepoParam.slice(slash + 1) };
  }

  let includeRepos = false;
  const rawInclude = query.include;
  if (rawInclude !== undefined) {
    const parts = rawInclude.split(",").map((part) => part.trim());
    if (parts.length === 0 || parts.some((part) => !(INSIGHTS_INCLUDE_VALUES as readonly string[]).includes(part))) {
      return { ok: false, reason: "include must be a comma-separated list of: repos" };
    }
    includeRepos = parts.includes("repos");
  }

  return { ok: true, windowDays, repoFilter, rawRepo, includeRepos };
}

async function insightsSummaryJson(
  c: DashboardContext,
  params: Extract<InsightsParams, { ok: true }>,
  scope: LedgerScope,
  db: DashboardDb,
): Promise<Response> {
  const insights = await createInsightsStore(db, {
    windowDays: params.windowDays,
    repo: params.repoFilter,
    includeRepos: params.includeRepos,
    ...scope,
  });
  return c.json({
    window_days: clampWindow(params.windowDays),
    ...(params.repoFilter !== undefined ? { repo: params.rawRepo } : {}),
    reviews_total: insights.reviewsTotal,
    findings_by_severity: insights.findingsBySeverity,
    verdict_distribution: insights.verdictDistribution,
    weekly_trend: insights.weeklyTrend,
    daily_trend: insights.dailyTrend,
    findings_distribution: insights.findingsDistribution,
    repos: insights.repos,
  });
}

const targetInsightsRoute = async (c: DashboardContext) => {
  const gate = await requireTargetManagerJson(c);
  if (!gate.ok) return gate.response;
  const params = parseInsightsParams({
    window: c.req.query("window"),
    repo: c.req.query("repo"),
    include: c.req.query("include"),
  });
  if (!params.ok) return c.json({ error: params.reason }, 400);
  return insightsSummaryJson(c, params, gate.scope, gate.db);
};

const targetTokenUsageRoute = async (c: DashboardContext) => {
  const gate = await requireTargetManagerJson(c);
  if (!gate.ok) return gate.response;
  const params = parseInsightsParams({ window: c.req.query("window") });
  if (!params.ok) return c.json({ error: params.reason }, 400);
  return c.json(await readTargetTokenUsage(gate.db, gate.scope, params.windowDays));
};

async function requireWorkspaceManagerJson(
  c: DashboardContext,
): Promise<
  | { ok: true; scope: LedgerScope; db: DashboardDb; store: ReturnType<typeof createReviewBotsStore> }
  | { ok: false; response: Response }
> {
  const member = await requireMember(c);
  if (!member.ok) return member;
  if (!canManageApp(member.scope)) return { ok: false, response: c.json({ error: "forbidden" }, 403) };
  return {
    ok: true,
    scope: { kind: "workspace", workspaceId: member.scope.workspaceId },
    db: member.db,
    store: createReviewBotsStore(member.db),
  };
}

const workspaceInsightsRoute = async (c: DashboardContext) => {
  const gate = await requireWorkspaceManagerJson(c);
  if (!gate.ok) return gate.response;
  const params = parseInsightsParams({
    window: c.req.query("window"),
    repo: c.req.query("repo"),
    include: c.req.query("include"),
  });
  if (!params.ok) return c.json({ error: params.reason }, 400);
  return insightsSummaryJson(c, params, gate.scope, gate.db);
};


async function requireTargetManagerJson(
  c: DashboardContext,
): Promise<
  | {
      ok: true;
      target: ReviewTargetRow;
      scope: Extract<LedgerScope, { kind: "target" }>;
      db: DashboardDb;
      store: ReturnType<typeof createReviewBotsStore>;
    }
  | { ok: false; response: Response }
> {
  const member = await requireMember(c);
  if (!member.ok) return member;
  const target = await createTargetsStore(member.db).getInWorkspace(
    member.scope.workspaceId,
    c.req.param("targetId") ?? "",
  );
  if (!target) return { ok: false, response: c.json({ error: "unknown target" }, 404) };
  if (!canManageApp(member.scope)) return { ok: false, response: c.json({ error: "forbidden" }, 403) };
  return {
    ok: true,
    target,
    scope: { kind: "target", targetId: target.id, workspaceId: member.scope.workspaceId },
    db: member.db,
    store: createReviewBotsStore(member.db),
  };
}

/**
 * The installation rows a workspace may walk for one App. A shared App (or any
 * App the caller's workspace does not own) is installed on other customers'
 * accounts too, so only the rows bound to the caller's workspace count.
 */
function installationsVisibleTo(
  apps: ReturnType<typeof createReviewBotsStore>,
  app: Pick<GithubAppRow, "id" | "scope" | "workspace_id">,
  workspaceId: string,
) {
  return app.scope === "shared" || app.workspace_id !== workspaceId
    ? apps.listInstallationsBoundTo(app.id, workspaceId)
    : apps.listInstallations(app.id);
}

const BIND_STATE_COOKIE = "__Host-mstar-bind-state";
const BIND_STATE_MAX_AGE_SEC = 600;
const BIND_STATE_KIND = "installation-bind";

type BindStatePayload = {
  kind: typeof BIND_STATE_KIND;
  nonce: string;
  login: string;
  workspaceId: string;
  botId: string;
  installationId: number;
  returnTo: string;
  exp: number;
};

async function readBindState(
  cookieValue: string,
  stateParam: string | undefined,
  secret: string,
): Promise<BindStatePayload | null> {
  if (!stateParam) return null;
  const enc = new TextEncoder();
  if (!timingSafeEqual(enc.encode(cookieValue), enc.encode(stateParam))) return null;
  const raw = await verifyValue(cookieValue, secret);
  if (raw === null) return null;
  let payload: Partial<BindStatePayload>;
  try {
    payload = JSON.parse(raw) as Partial<BindStatePayload>;
  } catch {
    return null;
  }
  if (payload.kind !== BIND_STATE_KIND) return null;
  if (typeof payload.exp !== "number" || payload.exp <= Math.floor(Date.now() / 1000)) return null;
  if (
    typeof payload.login !== "string" ||
    typeof payload.workspaceId !== "string" ||
    typeof payload.botId !== "string" ||
    typeof payload.installationId !== "number" ||
    typeof payload.returnTo !== "string" ||
    !payload.returnTo.startsWith("/dashboard/")
  ) {
    return null;
  }
  return payload as BindStatePayload;
}

/**
 * Start binding one pending installation of a shared App to the caller's
 * workspace. Nothing is written here: the caller is sent through a GitHub
 * OAuth step-up (`read:org`), and the callback binds only after the user's own
 * token proves they administer the installation's account.
 */
const appBindInstallationRoute = async (c: DashboardContext): Promise<Response> => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const apps = createReviewBotsStore(member.db);
  const app = await resolveScopedApp(apps, c.req.param("appId") ?? "", member.scope);
  if (!app) return c.json({ error: "unknown app" }, 404);
  if (!canManageApp(member.scope)) return c.json({ error: "forbidden" }, 403);
  if (app.scope !== "shared") return c.json({ error: "bot is not shared" }, 404);
  const form = await c.req.parseBody();
  const raw = form["installationId"];
  const installationId = typeof raw === "string" ? Number(raw) : Number.NaN;
  if (!Number.isSafeInteger(installationId) || installationId <= 0) {
    return c.json({ error: "installationId required" }, 400);
  }
  const binding = await apps.getInstallationBinding(app.id, installationId);
  if (binding?.removed_at === null && binding.bound_workspace_id === member.scope.workspaceId) {
    return c.json({ botId: app.id, installationId, bound: true });
  }
  const pending = await apps.listPendingInstallations(app.id, member.scope.workspaceId);
  if (!pending.some((row) => row.installation_id === installationId)) {
    return c.json({ error: "unknown installation" }, 404);
  }
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const workspaceRef = c.req.param("workspaceRef") ?? member.scope.workspaceId;
  const payload: BindStatePayload = {
    kind: BIND_STATE_KIND,
    nonce: randomToken(),
    login: member.session.login,
    workspaceId: member.scope.workspaceId,
    botId: app.id,
    installationId,
    returnTo: `/dashboard/${encodeURIComponent(workspaceRef)}/apps/${app.github_app_id}?tab=settings`,
    exp: Math.floor(Date.now() / 1000) + BIND_STATE_MAX_AGE_SEC,
  };
  const state = await signValue(JSON.stringify(payload), secrets.sessionSecret);
  c.header("Set-Cookie", serializeCookie(BIND_STATE_COOKIE, state, BIND_STATE_MAX_AGE_SEC));
  const callbackUri = `${new URL(c.req.url).origin}/dashboard/oauth/callback`;
  return c.json({
    botId: app.id,
    installationId,
    bound: false,
    authorize_url: buildAuthorizeUrl(secrets.clientId, callbackUri, state, BIND_OAUTH_SCOPE),
  });
};

/**
 * The OAuth callback half of the bind: the state must be this session's own
 * bind cookie, the GitHub user must be the signed-in user and still a manager
 * of the workspace, and their token must show they administer the account the
 * installation is installed on (the user themself, or an org they are an
 * active admin of). Only then is the installation bound to the workspace.
 */
async function completeInstallationBind(
  c: DashboardContext,
  secrets: NonNullable<ReturnType<typeof dashboardSecrets>>,
  bindCookie: string,
): Promise<Response> {
  c.header("Set-Cookie", expireCookie(BIND_STATE_COOKIE));
  const locale = requestLocale(c);
  const fail = (key: Parameters<typeof t>[1], status: 400 | 403 | 404 | 409 | 500 | 502, reason: string) => {
    logOAuthFailure("installation_bind", reason);
    return c.html(errorPage(t(locale, key), locale), status);
  };
  const state = await readBindState(bindCookie, c.req.query("state"), secrets.sessionSecret);
  if (state === null) return fail("common.oauth.stateInvalid", 400, "state_mismatch");
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session || session.login.toLowerCase() !== state.login.toLowerCase()) {
    return fail("common.oauth.stateInvalid", 400, "session_mismatch");
  }
  const code = c.req.query("code");
  if (!code) return fail("common.oauth.missingCode", 400, "missing_code");
  if (!GITHUB_CODE_SHAPE.test(code)) return fail("common.oauth.codeRejected", 400, "unsafe_code_shape");
  const callbackUri = `${new URL(c.req.url).origin}/dashboard/oauth/callback`;
  const token = await exchangeCodeForToken(code, secrets.clientId, secrets.clientSecret, callbackUri);
  if (!token) return fail("common.oauth.codeRejected", 502, "token_exchange");
  const user = await fetchGitHubUser(token);
  if (!user) return fail("common.oauth.profileFailed", 502, "user_fetch");
  if (user.login.toLowerCase() !== session.login.toLowerCase()) {
    return fail("common.oauth.bindDenied", 403, "user_mismatch");
  }
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  const stillManager = async () => {
    const access = await getWorkspaceAccessById(db, state.workspaceId, session.login);
    return access !== null && canManageRole(access.role);
  };
  if (!(await stillManager())) return fail("common.oauth.bindDenied", 403, "not_workspace_manager");
  const apps = createReviewBotsStore(db);
  const named = await apps.getAppById(state.botId);
  const app =
    named === null || named.deleted_at !== null
      ? null
      : await apps.getScopedAppByGithubId(named.github_app_id, state.workspaceId);
  if (app === null || app.scope !== "shared") return fail("common.oauth.bindUnavailable", 404, "unknown_app");
  const binding = await apps.getInstallationBinding(app.id, state.installationId);
  if (binding === null || binding.removed_at !== null) {
    return fail("common.oauth.bindUnavailable", 404, "unknown_installation");
  }
  if (binding.bound_workspace_id !== null && binding.bound_workspace_id !== state.workspaceId) {
    return fail("common.oauth.bindConflict", 409, "bound_elsewhere");
  }
  if (!c.env.DASHBOARD_ENCRYPTION_KEY) return c.text("dashboard encryption is not configured", 500);
  let account: Awaited<ReturnType<typeof fetchInstallationAccount>>;
  try {
    const pem = await createSecretbox(c.env.DASHBOARD_ENCRYPTION_KEY).decryptSecret(
      app.private_key_enc,
      `github_apps.private_key_enc:${app.id}`,
    );
    account = await fetchInstallationAccount(state.installationId, await mintInstallationJwt(app.github_app_id, pem));
  } catch (err) {
    logSettingsFailure("installation_bind_key", app.id, err);
    account = null;
  }
  if (account === null) return fail("common.oauth.bindUnavailable", 502, "installation_fetch");
  const administers =
    account.type === "User"
      ? account.login.toLowerCase() === user.login.toLowerCase()
      : account.type === "Organization" && (await isGitHubOrgAdmin(token, account.login));
  if (!administers) return fail("common.oauth.bindDenied", 403, "not_account_admin");
  const maintenance = await getMaintenanceMode(db);
  if (maintenanceClosed(maintenance)) return maintenanceResponse(c, maintenance);
  if (!(await stillManager())) return fail("common.oauth.bindDenied", 403, "not_workspace_manager");
  const outcome = await apps.bindInstallation(app.id, state.installationId, state.workspaceId);
  if (outcome === "bound_elsewhere") return fail("common.oauth.bindConflict", 409, "bound_elsewhere");
  if (outcome === "unknown") return fail("common.oauth.bindUnavailable", 404, "unknown_installation");
  return c.redirect(state.returnTo, 302);
}

function pullRequestWireColumns(row: {
  title: string | null;
  state: string;
  head_sha: string | null;
  reviewing: PullRequestReviewing;
}) {
  return {
    title: row.title ?? "",
    state: row.state === "merged" || row.state === "closed" ? row.state : "open",
    head_sha: row.head_sha ?? "",
    reviewing: row.reviewing,
  };
}

type ParseRepoFilterResult =
  | { ok: true; filter: { owner: string; repo: string } | null }
  | { ok: false };

function parseRepoFilter(c: DashboardContext): ParseRepoFilterResult {
  const raw = c.req.query("repo");
  if (raw === undefined) return { ok: true, filter: null };
  const slash = raw.indexOf("/");
  if (slash <= 0) return { ok: false };
  const owner = raw.slice(0, slash);
  const repo = raw.slice(slash + 1);
  if (repo === "" || repo.includes("/")) return { ok: false };
  return { ok: true, filter: { owner, repo } };
}

async function pullRequestsJson(
  c: DashboardContext,
  scope: LedgerScope,
  db: DashboardDb,
  filter: { owner: string; repo: string } | null,
): Promise<Response> {
  const { rows, repos } = await createReviewBotsStore(db).listPullRequests(scope, filter ?? undefined);
  return c.json({
    pull_requests: rows.map((row) => ({ ...row, ...pullRequestWireColumns(row) })),
    repos,
  });
}

const targetPullRequestsRoute = async (c: DashboardContext) => {
  c.header("Cache-Control", "private, no-store");
  const gate = await requireTargetManagerJson(c);
  if (!gate.ok) return gate.response;
  const parsed = parseRepoFilter(c);
  if (!parsed.ok) return c.json({ error: "invalid repo" }, 400);
  return pullRequestsJson(c, gate.scope, gate.db, parsed.filter);
};

const workspacePullRequestsRoute = async (c: DashboardContext) => {
  c.header("Cache-Control", "private, no-store");
  const gate = await requireWorkspaceManagerJson(c);
  if (!gate.ok) return gate.response;
  const parsed = parseRepoFilter(c);
  if (!parsed.ok) return c.json({ error: "invalid repo" }, 400);
  return pullRequestsJson(c, gate.scope, gate.db, parsed.filter);
};

const RECORD_PAGE_LIMIT = { default: 10, min: 1, max: 50 } as const;

const RECORD_PAGE_OFFSET_MAX = 100_000;

type ParsePagingResult = { ok: true; offset: number; limit: number } | { ok: false };

function parseRecordPaging(c: DashboardContext): ParsePagingResult {
  const rawLimit = c.req.query("limit");
  const rawOffset = c.req.query("offset");
  if (rawLimit !== undefined && !/^[0-9]+$/.test(rawLimit)) return { ok: false };
  if (rawOffset !== undefined && !/^[0-9]+$/.test(rawOffset)) return { ok: false };
  const requestedLimit = rawLimit === undefined ? RECORD_PAGE_LIMIT.default : Number(rawLimit);
  const offset = rawOffset === undefined ? 0 : Number(rawOffset);
  if (!Number.isSafeInteger(requestedLimit) || !Number.isSafeInteger(offset)) return { ok: false };
  if (offset > RECORD_PAGE_OFFSET_MAX) return { ok: false };
  const limit = Math.min(RECORD_PAGE_LIMIT.max, Math.max(RECORD_PAGE_LIMIT.min, requestedLimit));
  return { ok: true, offset, limit };
}

function pullRequestNumberOf(c: DashboardContext): number | null {
  const raw = c.req.param("number") ?? "";
  const number = /^[0-9]+$/.test(raw) ? Number(raw) : Number.NaN;
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

type LedgerGate = () => Promise<
  | {
      ok: true;
      scope: LedgerScope;
      db: DashboardDb;
      store: ReturnType<typeof createReviewBotsStore>;
    }
  | { ok: false; response: Response }
>;

const pullRequestDetailRoute = async (c: DashboardContext, gateOf: LedgerGate) => {
  c.header("Cache-Control", "private, no-store");
  const gate = await gateOf();
  if (!gate.ok) return gate.response;
  const number = pullRequestNumberOf(c);
  if (number === null) return c.json({ error: "unknown pull request" }, 404);
  const owner = c.req.param("owner") ?? "";
  const repo = c.req.param("repo") ?? "";
  const head = await gate.store.getPullRequestHead(gate.scope, owner, repo, number);
  if (head === null) return c.json({ error: "unknown pull request" }, 404);
  const counts = await gate.store.countPullRequestRecords(gate.scope, owner, repo, number);
  return c.json({
    pull_request: {
      number: head.pr_number,
      owner: head.owner,
      repo: head.repo,
      ...pullRequestWireColumns(head),
      first_seen_at: head.first_seen_at,
      last_seen_at: head.last_seen_at,
    },
    counts,
    latest_review:
      head.latest_review === null
        ? null
        : {
            verdict: head.latest_review.verdict,
            model: head.latest_review.model ?? "",
            provider: head.latest_review.provider ?? "",
            reviewed_at: head.latest_review.reviewed_at,
            head_sha: head.latest_review.head_sha,
          },
  });
};

type PullRequestRecordSection = "findings" | "reviews" | "failures";

const pullRequestRecordsRoute = async (
  c: DashboardContext,
  gateOf: LedgerGate,
  section: PullRequestRecordSection,
) => {
  c.header("Cache-Control", "private, no-store");
  const gate = await gateOf();
  if (!gate.ok) return gate.response;
  const number = pullRequestNumberOf(c);
  if (number === null) return c.json({ error: "unknown pull request" }, 404);
  const paging = parseRecordPaging(c);
  if (!paging.ok) return c.json({ error: "invalid paging" }, 400);
  const owner = c.req.param("owner") ?? "";
  const repo = c.req.param("repo") ?? "";
  const { offset, limit } = paging;
  if (section === "findings") {
    const rawSeverity = c.req.query("severity") ?? "";
    const rawUnclassified = c.req.query("unclassified") ?? "";
    const unclassified = rawUnclassified === "1";
    const malformed =
      (rawUnclassified !== "" && !unclassified) ||
      (unclassified && rawSeverity !== "") ||
      (rawSeverity !== "" && !isFindingSeverity(rawSeverity));
    if (malformed) {
      const head = await gate.store.getPullRequestHead(gate.scope, owner, repo, number);
      if (head === null) return c.json({ error: "unknown pull request" }, 404);
      const outsideVocabulary = rawSeverity !== "" && !isFindingSeverity(rawSeverity);
      return c.json({ error: outsideVocabulary ? "invalid severity" : "invalid filter" }, 400);
    }
    const page = await gate.store.listPullRequestFindings(gate.scope, owner, repo, number, {
      offset,
      limit,
      severity: rawSeverity === "" ? null : rawSeverity,
      unclassified,
    });
    if (page === null) return c.json({ error: "unknown pull request" }, 404);
    return c.json({
      items: page.items.map((finding) => ({
        finding_id: finding.finding_id,
        severity: finding.severity ?? "",
        title: finding.title ?? "",
        file_path: finding.file_path ?? "",
        line: finding.line,
        body: finding.body ?? "",
        review_round: finding.review_round,
      })),
      total: page.total,
      limit,
    });
  }
  if (section === "reviews") {
    const page = await gate.store.listPullRequestReviews(gate.scope, owner, repo, number, { offset, limit });
    if (page === null) return c.json({ error: "unknown pull request" }, 404);
    return c.json({
      items: page.items.map((review) => ({
        verdict: review.verdict,
        model: review.model ?? "",
        provider: review.provider ?? "",
        reviewed_at: review.reviewed_at,
        head_sha: review.head_sha,
        round: review.round,
        severity_counts: review.severity_counts,
        duration_ms: review.duration_ms,
      })),
      total: page.total,
      limit,
    });
  }
  const rawScope = c.req.query("scope") ?? "";
  if (rawScope !== "" && rawScope !== "head" && rawScope !== "all") {
    return c.json({ error: "invalid scope" }, 400);
  }
  const page = await gate.store.listPullRequestFailures(gate.scope, owner, repo, number, {
    offset,
    limit,
    history: rawScope === "all",
  });
  if (page === null) return c.json({ error: "unknown pull request" }, 404);
  return c.json({ items: page.items, total: page.total, limit });
};


type TargetListRow = {
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

const targetListRoute = async (c: DashboardContext): Promise<Response> => {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const targets = await createTargetsStore(gate.db).listLiveWithApp(gate.scope.workspaceId);
  // The defaults ride the list statement (one statement per target row join),
  // so this face stays inside its three-read budget.
  const defaults = workspaceDefaultsOfListRow(targets[0]);
  const rows: TargetListRow[] = targets.map((target) => ({
    target_id: target.id,
    repo_id: target.repo_id,
    repo_owner: target.repo_owner,
    repo_name: target.repo_name,
    bot_id: target.app_id,
    app_name: target.app_name,
    review_enabled: effectiveTargetSettings(target, defaults).reviewEnabled ? 1 : 0,
    follow_workspace_defaults: target.follow_workspace_defaults,
    last_reviewed_at: target.last_reviewed_at,
    reviews_total: target.reviews_total,
    reviews_7d: target.reviews_7d,
  }));
  return c.json({ targets: rows });
};

async function walkInstallationRepositories(
  db: DashboardDb,
  app: GithubAppRow,
  workspaceId: string,
  encryptionKey: string | undefined,
): Promise<{
  byRepoId: Map<number, InstallationRepository>;
  installations: number;
  failures: number;
} | null> {
  if (!encryptionKey) return null;
  let jwt: string;
  try {
    const pem = await createSecretbox(encryptionKey).decryptSecret(
      app.private_key_enc,
      `github_apps.private_key_enc:${app.id}`,
    );
    jwt = await mintInstallationJwt(app.github_app_id, pem);
  } catch (err) {
    logSettingsFailure("installation_repositories_key", app.id, err);
    return null;
  }
  const installations = await installationsVisibleTo(createReviewBotsStore(db), app, workspaceId);
  const byRepoId = new Map<number, InstallationRepository>();
  let failures = 0;
  for (const installation of installations) {
    const token = await mintInstallationAccessToken(installation.installation_id, jwt);
    if (token === null) {
      failures += 1;
      continue;
    }
    const repositories = await fetchInstallationRepositories(token);
    if (repositories === null) {
      failures += 1;
      continue;
    }
    for (const repository of repositories) {
      if (!byRepoId.has(repository.repo_id)) byRepoId.set(repository.repo_id, repository);
    }
  }
  return { byRepoId, installations: installations.length, failures };
}

const appInstallationRepositoriesRoute = async (c: DashboardContext): Promise<Response> => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const app = await resolveScopedApp(
    createReviewBotsStore(member.db),
    c.req.param("appId") ?? "",
    member.scope,
  );
  if (!app) return c.json({ error: "unknown app" }, 404);
  if (!canManageApp(member.scope)) return c.json({ error: "forbidden" }, 403);
  const walked = await walkInstallationRepositories(
    member.db,
    app,
    member.scope.workspaceId,
    c.env.DASHBOARD_ENCRYPTION_KEY,
  );
  if (walked === null || (walked.installations > 0 && walked.failures === walked.installations)) {
    return c.json({ error: "installation_repositories_unavailable" }, 502);
  }
  const liveTargets = await createTargetsStore(member.db).listLiveByBot(app.id);
  const claimedRepoIds = new Set<number>();
  const claimedNames = new Set<string>();
  for (const target of liveTargets) {
    if (target.repo_id !== null) claimedRepoIds.add(target.repo_id);
    else if (target.repo_owner !== null && target.repo_name !== null) {
      claimedNames.add(`${target.repo_owner}/${target.repo_name}`.toLowerCase());
    }
  }
  return c.json({
    repositories: [...walked.byRepoId.values()].map((repository) => ({
      ...repository,
      claimed:
        claimedRepoIds.has(repository.repo_id) ||
        claimedNames.has(`${repository.owner}/${repository.name}`.toLowerCase()),
    })),
    degraded: walked.failures > 0,
  });
};

function parseRepositoryBodyRow(value: unknown): { repo_id: number; owner: string; name: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as { repo_id?: unknown; owner?: unknown; name?: unknown };
  if (typeof row.repo_id !== "number" || !Number.isInteger(row.repo_id) || row.repo_id <= 0) return null;
  if (typeof row.owner !== "string" || row.owner.trim() === "") return null;
  if (typeof row.name !== "string" || row.name.trim() === "") return null;
  return { repo_id: row.repo_id, owner: row.owner.trim(), name: row.name.trim() };
}

const targetCreateRoute = async (c: DashboardContext): Promise<Response> => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  if (!canManageApp(member.scope)) return c.json({ error: "forbidden" }, 403);
  let botId = "";
  let rawRepositories: unknown = null;
  try {
    const body = (await c.req.json()) as { bot_id?: unknown; repositories?: unknown };
    botId = typeof body.bot_id === "string" ? body.bot_id.trim() : "";
    rawRepositories = body.repositories;
  } catch {
  }
  const repositories: Array<{ repo_id: number; owner: string; name: string }> = [];
  if (Array.isArray(rawRepositories)) {
    for (const entry of rawRepositories) {
      const parsed = parseRepositoryBodyRow(entry);
      if (parsed === null) return c.json({ error: "invalid repository" }, 400);
      repositories.push(parsed);
    }
  }
  if (botId === "" || repositories.length === 0) {
    return c.json({ error: "no repositories selected" }, 400);
  }
  const apps = createReviewBotsStore(member.db);
  const named = await apps.getAppById(botId);
  if (!named || named.deleted_at !== null) return c.json({ error: "unknown app" }, 404);
  const app = await resolveScopedApp(apps, String(named.github_app_id), member.scope);
  if (!app) return c.json({ error: "unknown app" }, 404);
  const walked = await walkInstallationRepositories(
    member.db,
    app,
    member.scope.workspaceId,
    c.env.DASHBOARD_ENCRYPTION_KEY,
  );
  if (walked === null || walked.failures > 0) {
    return c.json({ error: "installation_repositories_unavailable" }, 502);
  }
  const repoIds = repositories.filter((repository) => !walked.byRepoId.has(repository.repo_id)).map((repository) => repository.repo_id);
  if (repoIds.length > 0) {
    return c.json({ error: "repository_not_installed", repo_ids: [...new Set(repoIds)] }, 400);
  }
  const store = createTargetsStore(member.db);
  const created: Array<{ target_id: string; repo_id: number; repo_owner: string; repo_name: string }> = [];
  const duplicates: Array<{ repo_id: number; owner: string; name: string }> = [];
  for (const repository of repositories) {
    const outcome = await store.create({
      workspaceId: member.scope.workspaceId,
      botId: app.id,
      repoId: repository.repo_id,
      repoOwner: repository.owner,
      repoName: repository.name,
      createdBy: member.user.github_login,
    });
    if (outcome.outcome === "created") {
      created.push({
        target_id: outcome.target.id,
        repo_id: repository.repo_id,
        repo_owner: repository.owner,
        repo_name: repository.name,
      });
    } else {
      duplicates.push(repository);
    }
  }
  return c.json({ created, duplicates }, 201);
};


type ReviewSettingsPayload = {
  trigger_mode: ReviewTriggerMode;
  review_level: ReviewLevel | null;
  check_min_score: number;
  check_pass_verdicts: PrVerdict[];
  check_pass_verdicts_readable: boolean;
  review_drafts: boolean;
  review_enabled: boolean;
};

type TargetEffectivePayload = ReviewSettingsPayload;

function reviewSettingsPayload(settings: EffectiveTargetSettings): ReviewSettingsPayload {
  return {
    trigger_mode: settings.triggerMode,
    review_level: settings.level,
    check_min_score: settings.checkMinScore,
    check_pass_verdicts: [...settings.checkPassVerdicts],
    check_pass_verdicts_readable: settings.checkPassVerdictsReadable,
    review_drafts: settings.reviewDrafts,
    review_enabled: settings.reviewEnabled,
  };
}

function workspaceDefaultsPayload(defaults: WorkspaceReviewDefaults): ReviewSettingsPayload {
  return reviewSettingsPayload(defaults);
}

type TargetSettingsPayload = {
  target_id: string;
  repo_id: number | null;
  repo_owner: string | null;
  repo_name: string | null;
  bot_id: string;
  app_name: string;
  app_id: number | null;
  app_avatar_url: string | null;
  review_enabled: number;
  follow_workspace_defaults: number;
  review_drafts: 0 | 1;
};

async function targetSettingsPayload(
  db: DashboardDb,
  target: ReviewTargetRow,
  defaults: WorkspaceReviewDefaults,
): Promise<{ target: TargetSettingsPayload; effective: TargetEffectivePayload; defaults: ReviewSettingsPayload }> {
  const app = await createReviewBotsStore(db).getAppById(target.app_id);
  const effective = effectiveTargetSettings(target, defaults);
  return {
    target: {
      target_id: target.id,
      repo_id: target.repo_id,
      repo_owner: target.repo_owner,
      repo_name: target.repo_name,
      bot_id: target.app_id,
      app_name: app === null ? "" : appDisplayName(app),
      app_id: app === null ? null : app.github_app_id,
      app_avatar_url: app === null ? null : app.github_avatar_url,
      review_enabled: target.review_enabled,
      follow_workspace_defaults: target.follow_workspace_defaults,
      review_drafts: target.review_drafts === 0 ? 0 : 1,
    },
    effective: reviewSettingsPayload(effective),
    defaults: workspaceDefaultsPayload(defaults),
  };
}

const targetSettingsReadRoute = async (c: DashboardContext): Promise<Response> => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const store = createTargetsStore(member.db);
  const target = await store.getInWorkspace(member.scope.workspaceId, c.req.param("targetId") ?? "");
  if (!target) return c.json({ error: "unknown target" }, 404);
  return c.json(
    await targetSettingsPayload(
      member.db,
      target,
      await getWorkspaceReviewDefaults(member.db, member.scope.workspaceId),
    ),
  );
};

const workspaceDefaultsReadRoute = async (c: DashboardContext): Promise<Response> => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  return c.json({
    defaults: workspaceDefaultsPayload(await getWorkspaceReviewDefaults(member.db, member.scope.workspaceId)),
    target_count: await createTargetsStore(member.db).countLive(member.scope.workspaceId),
  });
};

type ReviewSettingsPatch = {
  triggerMode?: ReviewTriggerMode;
  level?: ReviewLevel | null;
  checkMinScore?: number;
  checkPassVerdicts?: PrVerdict[];
  follow?: 0 | 1;
  reviewEnabled?: boolean;
  reviewDrafts?: boolean;
};

type ReviewSettingsParse =
  | { ok: true; patch: ReviewSettingsPatch }
  | { ok: false; error: string; key?: DictionaryKey; params?: Record<string, string | number> };

function parseReviewSettingsBody(raw: unknown): ReviewSettingsParse {
  if (typeof raw !== "object" || raw === null) return { ok: false, error: "invalid body" };
  const body = raw as Record<string, unknown>;
  const patch: ReviewSettingsPatch = {};
  if ("trigger_mode" in body) {
    const mode = body.trigger_mode;
    if (!REVIEW_TRIGGER_MODES.includes(mode as ReviewTriggerMode)) {
      return {
        ok: false,
        error: "invalid trigger mode",
        key: SETTINGS_400_KEYS.triggerModeUnknown,
        params: { mode: typeof mode === "string" ? mode : "" },
      };
    }
    patch.triggerMode = mode as ReviewTriggerMode;
  }
  if ("review_level" in body) {
    const level = body.review_level;
    if (level !== null && !isReviewLevel(level)) {
      return {
        ok: false,
        error: "invalid review level",
        key: SETTINGS_400_KEYS.reviewLevelUnknown,
        params: { level: typeof level === "string" ? level : "" },
      };
    }
    patch.level = level;
  }
  if ("check_min_score" in body) {
    if (!isCheckMinScoreValue(body.check_min_score)) {
      return {
        ok: false,
        error: "invalid check min score",
        key: SETTINGS_400_KEYS.checkScoreInvalid,
        params: { min: CHECK_MIN_SCORE_MIN, max: CHECK_MIN_SCORE_MAX },
      };
    }
    patch.checkMinScore = body.check_min_score;
  }
  if ("check_pass_verdicts" in body) {
    const verdicts = body.check_pass_verdicts;
    const list = Array.isArray(verdicts) ? verdicts : [verdicts];
    const unknownVerdict = list.find((entry) => !PR_VERDICTS.includes(entry as PrVerdict));
    if (unknownVerdict !== undefined) {
      return {
        ok: false,
        error: "invalid check pass verdict",
        key: SETTINGS_400_KEYS.checkVerdictUnknown,
        params: {
          verdict: typeof unknownVerdict === "string" ? unknownVerdict : "",
          verdicts: PR_VERDICTS.join(", "),
        },
      };
    }
    patch.checkPassVerdicts = [...new Set(list as PrVerdict[])];
  }
  if ("review_drafts" in body) {
    if (typeof body.review_drafts !== "boolean") {
      return { ok: false, error: "invalid review_drafts" };
    }
    patch.reviewDrafts = body.review_drafts;
  }
  if ("follow" in body) {
    if (body.follow !== 0 && body.follow !== 1) return { ok: false, error: "invalid follow" };
    patch.follow = body.follow;
  }
  if ("review_enabled" in body) {
    const raw = body.review_enabled;
    const enabled =
      typeof raw === "boolean"
        ? raw
        : raw === 1 || raw === "1"
          ? true
          : raw === 0 || raw === "0"
            ? false
            : undefined;
    if (enabled === undefined) return { ok: false, error: "invalid review_enabled" };
    patch.reviewEnabled = enabled;
  }
  return { ok: true, patch };
}

const targetSettingsWriteRoute = async (c: DashboardContext): Promise<Response> => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  if (!canManageApp(member.scope)) return c.json({ error: "forbidden" }, 403);
  const store = createTargetsStore(member.db);
  const target = await store.getInWorkspace(member.scope.workspaceId, c.req.param("targetId") ?? "");
  if (!target) return c.json({ error: "unknown target" }, 404);
  let raw: unknown = null;
  try {
    raw = await c.req.json();
  } catch {
  }
  const parsed = parseReviewSettingsBody(raw);
  if (!parsed.ok) {
    return parsed.key === undefined
      ? c.json({ error: parsed.error }, 400)
      : keyed400(c, parsed.key, parsed.params);
  }
  const { patch } = parsed;
  const defaults = await getWorkspaceReviewDefaults(member.db, member.scope.workspaceId);
  const touchesPolicy =
    patch.triggerMode !== undefined ||
    patch.level !== undefined ||
    patch.checkMinScore !== undefined ||
    patch.checkPassVerdicts !== undefined;
  const follow: 0 | 1 | undefined =
    patch.follow ?? (touchesPolicy ? 0 : undefined);
  const current =
    touchesPolicy || patch.follow !== undefined ? effectiveTargetSettings(target, defaults) : null;
  if (current !== null && !current.checkPassVerdictsReadable) {
    return c.json({ error: "review_gate_unreadable" }, 400);
  }
  // The admission pair is answered by the DEFAULTS while the target inherits,
  // so a save that leaves it inheriting must not write the row's copies.
  const inheriting = (follow ?? target.follow_workspace_defaults) === 1;
  // Only a transition from inheriting to own-columns snapshots unnamed values;
  // an already-detached target writes an admission column only when the patch
  // names it, so a concurrent admission save is never reverted by a policy save.
  const detaching = target.follow_workspace_defaults === 1 && follow === 0;
  const config: TargetReviewConfig = {
    triggerMode: follow === 1 ? undefined : patch.triggerMode,
    level: follow === 1 ? undefined : patch.level,
    checkMinScore: follow === 1 ? undefined : patch.checkMinScore,
    checkPassVerdicts: follow === 1 ? undefined : patch.checkPassVerdicts,
    reviewDrafts: inheriting ? undefined : patch.reviewDrafts,
    reviewEnabled: inheriting ? undefined : patch.reviewEnabled,
    follow,
  };
  if (detaching && current !== null) {
    config.triggerMode ??= current.triggerMode;
    if (config.level === undefined) config.level = current.level;
    config.checkMinScore ??= current.checkMinScore;
    config.checkPassVerdicts ??= current.checkPassVerdicts;
    // Dropping inheritance must keep the target on the admission values it is
    // running with right now; the row's copies may be stale overrides. The
    // pause rides the same UPDATE as `follow`, so no read can see follow = 0
    // beside the row's old pause.
    config.reviewDrafts ??= current.reviewDrafts;
    config.reviewEnabled ??= current.reviewEnabled;
  }
  try {
    await store.setReviewConfig(member.scope.workspaceId, target.id, config);
  } catch (err) {
    logSettingsFailure("target_settings_save", target.id, err);
    return c.json({ error: "save failed" }, 500);
  }
  const saved = await store.getInWorkspace(member.scope.workspaceId, target.id);
  if (!saved) return c.json({ error: "unknown target" }, 404);
  return c.json(await targetSettingsPayload(member.db, saved, defaults));
};

const workspaceDefaultsWriteRoute = async (c: DashboardContext): Promise<Response> => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  if (!canManageApp(member.scope)) return c.json({ error: "forbidden" }, 403);
  let raw: unknown = null;
  try {
    raw = await c.req.json();
  } catch {
  }
  const parsed = parseReviewSettingsBody(raw);
  if (!parsed.ok) {
    return parsed.key === undefined
      ? c.json({ error: parsed.error }, 400)
      : keyed400(c, parsed.key, parsed.params);
  }
  const { patch } = parsed;
  try {
    await setWorkspaceReviewDefaults(
      member.db,
      member.scope.workspaceId,
      {
        triggerMode: patch.triggerMode,
        level: patch.level,
        checkPassVerdicts: patch.checkPassVerdicts,
        checkMinScore: patch.checkMinScore,
        reviewDrafts: patch.reviewDrafts,
        reviewEnabled: patch.reviewEnabled,
      },
      member.user.github_login,
    );
  } catch (err) {
    if (err instanceof UnknownWorkspaceError) return await tenantNotFound(c);
    logSettingsFailure("workspace_defaults_save", member.scope.workspaceId, err);
    return c.json({ error: "save failed" }, 500);
  }
  return c.json({
    defaults: workspaceDefaultsPayload(await getWorkspaceReviewDefaults(member.db, member.scope.workspaceId)),
  });
};

type AppRouteHandler = (c: DashboardContext) => Response | Promise<Response>;

type AppRoute = {
  method: "get" | "post" | "patch";
  path: string;
  handler: AppRouteHandler;
  access?: "read" | "write";
};

/**
 * Exported for the tests that must prove a page's request is a route this
 * table actually registers — a page and a route that each pin their own URL
 * string can drift apart while both stay green.
 */
export const APP_ROUTES: ReadonlyArray<AppRoute> = [
  { method: "get", path: "/api/provider-catalog", handler: providerCatalogRoute, access: "read" },
  { method: "get", path: "/apps/:appId/onboarding", handler: appOnboardingRoute, access: "write" },
  { method: "get", path: "/api/apps", handler: appListRoute, access: "write" },
  { method: "post", path: "/apps/:appId/disable", handler: (c) => appStatusAction(c, "disable"), access: "write" },
  { method: "post", path: "/apps/:appId/enable", handler: (c) => appStatusAction(c, "enable"), access: "write" },
  { method: "post", path: "/apps/:appId/delete", handler: (c) => appStatusAction(c, "delete"), access: "write" },
  { method: "get", path: "/api/targets", handler: targetListRoute, access: "read" },
  { method: "post", path: "/api/targets", handler: targetCreateRoute, access: "write" },
  { method: "get", path: "/api/targets/all", handler: workspaceDefaultsReadRoute, access: "read" },
  { method: "post", path: "/api/targets/defaults", handler: workspaceDefaultsWriteRoute, access: "write" },
  { method: "get", path: "/api/targets/:targetId", handler: targetSettingsReadRoute, access: "read" },
  { method: "post", path: "/api/targets/:targetId", handler: targetSettingsWriteRoute, access: "write" },
  {
    method: "get",
    path: "/api/apps/:appId/installation-repositories",
    handler: appInstallationRepositoriesRoute,
    access: "write",
  },
  { method: "get", path: "/api/review-bots", handler: usableBotsRoute, access: "write" },
  { method: "get", path: "/api/apps/:appId", handler: appDetailSettingsRoute, access: "write" },
  { method: "get", path: "/api/review-bots/:botId/settings", handler: appSettingsRoute, access: "write" },
  { method: "get", path: "/api/review-bots/:botId/bot", handler: appBotRoute, access: "write" },
  { method: "patch", path: "/api/apps/:appId/scope", handler: appScopeRoute, access: "write" },
  { method: "patch", path: "/api/review-bots/:botId/scope", handler: botScopeRoute, access: "write" },
  { method: "get", path: "/api/apps/:appId/deliveries", handler: appDeliveriesRoute, access: "write" },
  { method: "get", path: "/api/review-bots/:botId/models", handler: appModelsRoute, access: "write" },
  {
    method: "get",
    path: "/api/review-bots/:botId/provider-models/preview",
    handler: appProviderModelsPreviewRoute,
    access: "write",
  },
  { method: "post", path: "/api/apps/:appId/refresh-metadata", handler: appRefreshMetadataRoute, access: "write" },
  { method: "post", path: "/api/apps/:appId/bind-installation", handler: appBindInstallationRoute, access: "write" },
  { method: "post", path: "/api/review-bots/:botId/keys/verify", handler: appKeyVerifyRoute, access: "write" },
  { method: "post", path: "/api/review-bots/:botId/keys/usage", handler: appKeyUsageRoute, access: "write" },
  { method: "post", path: "/review-bots/:botId/settings", handler: appSettingsSaveRoute, access: "write" },
  { method: "post", path: "/review-bots/:botId/settings/key/delete", handler: appKeyDeleteRoute, access: "write" },
  { method: "get", path: "/api/targets/:targetId/insights/summary", handler: targetInsightsRoute, access: "write" },
  { method: "get", path: "/api/targets/:targetId/pull-requests", handler: targetPullRequestsRoute, access: "write" },
  { method: "get", path: "/api/targets/:targetId/token-usage", handler: targetTokenUsageRoute, access: "write" },
  { method: "get", path: "/api/targets/:targetId/pull-requests/:owner/:repo/:number", handler: (c) => pullRequestDetailRoute(c, () => requireTargetManagerJson(c)), access: "write" },
  { method: "get", path: "/api/targets/:targetId/pull-requests/:owner/:repo/:number/findings", handler: (c) => pullRequestRecordsRoute(c, () => requireTargetManagerJson(c), "findings"), access: "write" },
  { method: "get", path: "/api/targets/:targetId/pull-requests/:owner/:repo/:number/reviews", handler: (c) => pullRequestRecordsRoute(c, () => requireTargetManagerJson(c), "reviews"), access: "write" },
  { method: "get", path: "/api/targets/:targetId/pull-requests/:owner/:repo/:number/failures", handler: (c) => pullRequestRecordsRoute(c, () => requireTargetManagerJson(c), "failures"), access: "write" },
  { method: "get", path: "/api/insights/summary", handler: workspaceInsightsRoute, access: "write" },
  { method: "get", path: "/api/pull-requests", handler: workspacePullRequestsRoute, access: "write" },
  { method: "get", path: "/api/pull-requests/:owner/:repo/:number", handler: (c) => pullRequestDetailRoute(c, () => requireWorkspaceManagerJson(c)), access: "write" },
  { method: "get", path: "/api/pull-requests/:owner/:repo/:number/findings", handler: (c) => pullRequestRecordsRoute(c, () => requireWorkspaceManagerJson(c), "findings"), access: "write" },
  { method: "get", path: "/api/pull-requests/:owner/:repo/:number/reviews", handler: (c) => pullRequestRecordsRoute(c, () => requireWorkspaceManagerJson(c), "reviews"), access: "write" },
  { method: "get", path: "/api/pull-requests/:owner/:repo/:number/failures", handler: (c) => pullRequestRecordsRoute(c, () => requireWorkspaceManagerJson(c), "failures"), access: "write" },
  { method: "get", path: "/api/members", handler: memberListRoute, access: "read" },
  { method: "get", path: "/api/members/invites", handler: inviteListRoute, access: "write" },
  { method: "post", path: "/api/members/invites", handler: inviteCreateRoute, access: "write" },
  { method: "post", path: "/api/members/invites/:id/revoke", handler: inviteRevokeRoute, access: "write" },
  { method: "post", path: "/api/members/invites/:id/accept", handler: inviteAcceptRoute, access: "write" },
  { method: "post", path: "/members/role", handler: memberRoleRoute, access: "write" },
  { method: "post", path: "/members/remove", handler: memberRemoveRoute, access: "write" },
  { method: "post", path: "/api/workspace/delete", handler: workspaceDeleteRoute, access: "write" },
  { method: "get", path: "/api/support/workspace", handler: supportWorkspaceRoute, access: "read" },
  { method: "get", path: "/api/support/grants", handler: supportGrantsRoute, access: "read" },
  { method: "get", path: "/api/audit", handler: auditListRoute, access: "write" },
];

function workspaceOnly(
  handler: AppRouteHandler,
): Handler<{ Bindings: Env; Variables: DashboardVariables }> {
  return (c, next) => (c.get("tenant") ? handler(c) : next());
}

for (const route of APP_ROUTES) {
  const path = `/:workspaceRef${route.path}`;
  if (route.method === "get") dashboardApp.get(path, workspaceOnly(route.handler));
  else if (route.method === "patch") dashboardApp.patch(path, workspaceOnly(route.handler));
  else dashboardApp.post(path, workspaceOnly(route.handler));
}

dashboardApp.put("/:workspaceRef/api/settings/name", workspaceOnly(workspaceNameRoute));
dashboardApp.get(
  "/:workspaceRef/api/settings/concurrency",
  workspaceOnly(workspaceConcurrencyReadRoute),
);
dashboardApp.put(
  "/:workspaceRef/api/settings/concurrency",
  workspaceOnly(workspaceConcurrencyWriteRoute),
);
dashboardApp.get(
  "/:workspaceRef/api/settings/check-min-score",
  workspaceOnly(workspaceCheckMinScoreReadRoute),
);
dashboardApp.get(
  "/:workspaceRef/api/settings/review-usage",
  workspaceOnly(reviewUsageReadRoute),
);
dashboardApp.put(
  "/:workspaceRef/api/settings/check-min-score",
  workspaceOnly(workspaceCheckMinScoreWriteRoute),
);

/**
 * The bot-configuration paths the split deleted (task 4): they answer 404 —
 * deleted, never aliased — while every other unmatched POST keeps the
 * placeholder answer the SPA's form fallbacks rely on.
 */
const DELETED_BOT_CONFIG_PATH =
  /^\/[^/]+\/(?:api\/apps\/[^/]+\/(?:settings|models|keys\/(?:verify|usage)|provider-models\/preview|bot(?:\/scope)?)|apps\/[^/]+\/settings(?:\/key\/delete)?)\/?$/;

dashboardApp.post("*", async (c) => {
  const sessionSecret = c.env.DASHBOARD_SESSION_SECRET;
  if (!sessionSecret) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  if (DELETED_BOT_CONFIG_PATH.test(new URL(c.req.url).pathname.replace(/^\/dashboard/, ""))) {
    return c.text("unknown app", 404);
  }
  return c.text("placeholder actions are not implemented", 405);
});
