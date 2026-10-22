/**
 * /dashboard Hono sub-app: GitHub OAuth login + signed-cookie session
 * + GitHub App Manifest start/callback/commit (the
 * commit writes the encrypted github_apps D1 row, the Cloudflare secrets-bulk
 * path is retired) + per-App management UI (/dashboard/apps list,
 * POST …/disable|enable|delete — creator-or-admin) + per-App review
 * pause/resume (POST …/pause|/resume — the same action
 * pattern) + per-App AI config settings (GET/POST
 * /dashboard/apps/:slug/settings — BYOK provider keys, masked, + model chain
 * — and POST …/settings/key/delete, creator-or-admin; plus the
 * settings Review switch and the read-only install-health panel, and
 * the Role models editor on the same op-discriminated POST) behind a
 * per-request membership guard + admin-only members management.
 * Mounted by src/worker/index.ts as
 * `app.route("/dashboard", dashboardApp)`.
 *
 * Route isolation (architect decision Q2): this module MUST NOT import
 * pipeline/store/review code. Fail-closed everywhere: missing OAuth secrets
 * → 5xx; bad CSRF state → 4xx and the session cookie is never set; missing
 * DASHBOARD_ENCRYPTION_KEY → the encryption-dependent commit and settings
 * routes 5xx with the hold kept / nothing stored (spec § Crypto envelope).
 */
import { Hono, type Context, type Handler } from "hono";
import { getCookie } from "hono/cookie";
import type { Env } from "../worker/env";
import { tenantModeOf, type TenantMode } from "../worker/tenant-mode";
import { buildAuthorizeUrl, exchangeCodeForToken, fetchGitHubUser, logOAuthFailure } from "./oauth";
import {
  OAUTH_STATE_COOKIE,
  OAUTH_STATE_MAX_AGE_SEC,
  SESSION_COOKIE,
  SESSION_MAX_AGE_SEC,
  createSessionValue,
  createStateValue,
  expireCookie,
  readSessionValue,
  serializeCookie,
  verifyStateValue,
  type SessionPayload,
} from "./session";
import {
  MANIFEST_HOLD_COOKIE,
  MANIFEST_HOLD_MAX_AGE_SEC,
  MANIFEST_STATE_COOKIE,
  MANIFEST_STATE_MAX_AGE_SEC,
  buildAppSlug,
  buildHoldPayload,
  buildManifest,
  buildManifestCreateUrl,
  createManifestStateValue,
  encryptHoldValue,
  exchangeManifestCode,
  logManifestFailure,
  randomSlugSuffix,
  readHoldValue,
  readManifestStateValue,
  type ManifestHoldPayload,
} from "./manifest";
import { GITHUB_CODE_SHAPE } from "./github-code-shape";
import {
  createAppsStore,
  REVIEW_TRIGGER_MODES,
  type DeliverySummary,
  type GithubAppRow,
  type ReviewTriggerMode,
} from "./apps-store";
import {
  countMembershipsForLogin,
  createWorkspace,
  getMembership,
  getSoleWorkspace,
  getSoleWorkspaceAccess,
  getWorkspaceByRef,
  getWorkspaceMember,
  listWorkspaceMembers,
  listWorkspaceMembershipOptions,
  setWorkspaceSlug,
  type WorkspaceMembershipOption,
  type WorkspaceRole,
} from "./workspace-store";
import {
  InvitePendingExistsError,
  acceptInvite,
  createInvite,
  getInviteInWorkspace,
  getPendingInviteByLogin,
  listInviteDiscoveryForLogin,
  listPendingInvites,
  revokeInvite,
} from "./invite-store";
import { fetchAppMetadata, isGithubMetadataStale } from "./github-app-metadata";
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
  MAX_CUSTOM_PROVIDER_MODEL_IDS,
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
} from "./app-config-store";
// Display-only picker grouping (AD-547). Never a mechanics input —
// the runner BYOK allowlist stays PROVIDER_IDS_BUILTIN / PROVIDER_ENV_NAMES.
import { PROVIDER_IDS_COMMON } from "../contracts/provider-catalog.generated";
import { enabledSandboxImages, getSandboxImage, sandboxImageHostIds } from "../contracts/sandbox-images";
import { isCommandConfigKey } from "../contracts/credential-key";
import { composeModelOptions, findFailingSelector } from "./model-membership";
import { PROVIDER_VERIFY_ENDPOINTS, verifyProviderKey, type VerifyFailureReason } from "./provider-verify";
import {
  deleteWorkspaceMember,
  getUserByLogin,
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
import {
  errorPage,
  forbiddenPage,
  manifestConfirmPage,
  manifestErrorPage,
  manifestOnboardingPage,
  manifestStartPage,
  notFoundPage,
  removedPage,
} from "./views";
import { clampWindow, createInsightsStore } from "./insights-store";
import { isLocale, resolveLocale, serializeLocaleCookie, t, type DictionaryKey, type Locale } from "../i18n";
import { RESERVED_WORKSPACE_SLUGS, wantsHtml } from "../spa/routes";
import { SPA_POST_FORM_HEADER, SPA_POST_FORM_VALUE } from "../spa/post-form-headers";

/**
 * Principal classes of a workspace request (the request-path ordering
 * contract, step 3). `invitee` may reach ONLY the invite-accept route;
 * `operator-granted` may reach ONLY `read`-declared routes, and
 * `operator-denied` answers the outsider 404.
 */
type WorkspacePrincipal =
  | "member"
  | "invitee"
  | "operator-granted"
  | "operator-denied"
  | "outsider";

/**
 * Per-request values the workspace tenancy middleware attaches: `tenant`
 * exists only on a strict-mode workspace path (the workspace ref was classified
 * from the first path segment), so its absence IS the legacy `off` request
 * shape. The routing gate classifies WITHOUT a database read (an anonymous
 * request must not learn whether a workspace exists or pay a D1 round trip);
 * `workspaceScope` then resolves the live workspace and the caller's principal
 * after the session and user row are known.
 */
type DashboardVariables = {
  tenant?: {
    /** The workspace segment the request named: an id or a slug. */
    ref: string;
    /** null until the workspace-scope middleware resolves the live row. */
    workspaceId: string | null;
    /** null until the workspace-scope middleware classifies the principal. */
    role: WorkspaceRole | null;
    /** null until the workspace-scope middleware classifies the caller. */
    principal: WorkspacePrincipal | null;
  };
  /** The users row the session guard resolved; absent on exempt routes. */
  authUser?: DashboardUserRow;
  /**
   * The workspace-scope resolution of one request (ordering-contract step 3):
   * `undefined` = not classified yet, `null` = the caller is not a member.
   */
  workspaceScope?: WorkspaceScope | null;
};

type DashboardContext = Context<{ Bindings: Env; Variables: DashboardVariables }>;

/** The resolved workspace scope of one workspace path (strict mode only). */
type WorkspaceScope = { workspaceId: string; role: WorkspaceRole };

export const dashboardApp = new Hono<{ Bindings: Env; Variables: DashboardVariables }>();

/** SPA shell entry for members/apps list mutations (QC W-2, apps route). */
const DASHBOARD_SHELL_REDIRECT = "/dashboard";
const APPS_LIST_REDIRECT = "/dashboard/apps";

/**
 * A legacy App path on a workspace-scoped request (`/dashboard/apps…`) belongs
 * to that workspace's route family: under `strict` the legacy family answers
 * 404, so a response that redirected there would land on a dead URL. Legacy
 * requests and non-App paths are returned unchanged.
 */
function scopedAppPath(c: DashboardContext, path: string): string {
  const tenant = c.get("tenant");
  if (!tenant) return path;
  if (path === APPS_LIST_REDIRECT) return `/dashboard/${tenant.ref}/apps`;
  if (path.startsWith(`${APPS_LIST_REDIRECT}/`)) {
    return `/dashboard/${tenant.ref}${path.slice(DASHBOARD_MOUNT.length)}`;
  }
  return path;
}

/**
 * The deployment's sole live workspace slug under `strict`, otherwise null.
 * M1 is single-workspace; a deployment that does not carry exactly one live
 * workspace has no unambiguous workspace to name, so callers keep their own
 * legacy target instead of guessing a slug.
 */
export async function strictWorkspaceSlug(env: Env): Promise<string | null> {
  if (tenantModeOf(env.WORKSPACE_TENANT_MODE) !== "strict") return null;
  const db = dashboardD1(env);
  return db === null ? null : ((await getSoleWorkspace(db))?.slug ?? null);
}

/**
 * Operator signal for a strict landing that cannot name its workspace — a
 * dead end for the person being redirected. Shared by the two landing
 * producers that can reach it.
 */
function warnUnresolvableLanding(env: Env): void {
  console.warn(
    JSON.stringify({
      event: "dashboard_landing",
      reason: dashboardD1(env) === null ? "db_unbound" : "no_sole_workspace",
    }),
  );
}

/**
 * `/dashboard/<sole-workspace-slug>/apps` under `strict`, otherwise null, with
 * the operator warning for an unresolvable landing (the redirect owner).
 */
export async function strictWorkspaceAppsBase(env: Env): Promise<string | null> {
  const slug = await strictWorkspaceSlug(env);
  if (slug !== null) return `/dashboard/${slug}/apps`;
  // Null is also `off`'s normal answer; only a strict deployment that cannot
  // name its workspace reaches the operator warning (a dead-end landing).
  if (tenantModeOf(env.WORKSPACE_TENANT_MODE) !== "strict") return null;
  warnUnresolvableLanding(env);
  return null;
}

/**
 * The boot extras for one signed-in login: whether the login belongs to no
 * live workspace yet, the deployment's sole workspace slug (the shell's nav
 * targets under `strict`), and whether this login may run the App-creation
 * flow there. ONE membership count answers the first, and one workspace read
 * the other two.
 *
 * `needsWorkspace` is MODE-INDEPENDENT: workspace creation is the only way a
 * newcomer gets a first workspace, and the creation route itself is outside
 * the workspace gate, so a deployment that has not switched its route family
 * yet (`off`) still has to offer the form — otherwise that login can never
 * leave the legacy face. The workspace slug and the create decision stay
 * `strict`-only: under `off` the workspace plane is invisible, so there is no
 * slug to name and the legacy creator rule keeps the flow open.
 *
 * An unbound store answers nothing at all: storage is a configuration
 * failure, not a permission answer, and every caller already has its own
 * honest `db_unbound` outcome — `/manifest/start` 500s before minting a slug
 * or cookie, the callback parks the hold and serves the resumable confirm
 * link (QC F-005), and confirm keeps the hold. Reporting `canCreateApp:
 * false` here would 403 a storage outage and burn the only copy of the App
 * credentials.
 *
 * A `strict` deployment that does not carry exactly one live workspace cannot
 * attribute the App the flow would create, so creation is refused
 * (`canCreateApp: false`) rather than falling through to `createApp`'s guard
 * after the slug is minted.
 */
export async function strictWorkspaceBoot(
  env: Env,
  login: string,
): Promise<{ workspaceRef?: string; canCreateApp?: boolean; needsWorkspace?: boolean }> {
  const db = dashboardD1(env);
  if (db === null) return {};
  const strict = tenantModeOf(env.WORKSPACE_TENANT_MODE) === "strict";
  if (!strict) {
    return (await countMembershipsForLogin(db, login)) === 0 ? { needsWorkspace: true } : {};
  }
  const [access, memberships] = await Promise.all([
    getSoleWorkspaceAccess(db, login),
    countMembershipsForLogin(db, login),
  ]);
  // No live membership → no workspace to name: every workspace path 404s this
  // login, so the shell must offer creation instead.
  if (memberships === 0) return { canCreateApp: false, needsWorkspace: true };
  if (access === null) return { canCreateApp: false };
  return {
    workspaceRef: access.slug,
    // A new App lands in the sole workspace, where the scoped `canManageApp`
    // gives a plain member no rights — so creation is owner/admin there.
    canCreateApp: access.role === "owner" || access.role === "admin",
  };
}

/**
 * The workspace slug a platform operator is visiting under a live support
 * grant, or null when this login is not such a visitor: the shell asks the ONE
 * classifier the gate uses ({@link classifyWorkspacePrincipal}), so the boot
 * and the request can never disagree about who the caller is.
 *
 * `workspaceRef` is the path's workspace segment when there is one, else the
 * deployment's sole workspace. An unbound store, an unknown ref, a membership,
 * a live invite, no grant and a lapsed grant all answer null — and the shell
 * then behaves exactly as before.
 */
export async function operatorSupportWorkspace(
  env: Env,
  login: string,
  workspaceRef?: string,
): Promise<string | null> {
  // The support face lives in the workspace route family, which `off` does not
  // serve — a supportOnly boot there would be a page whose every read 404s.
  if (tenantModeOf(env.WORKSPACE_TENANT_MODE) !== "strict") return null;
  if (!isPlatformOperator(env, login)) return null;
  const db = dashboardD1(env);
  if (db === null) return null;
  const workspace =
    workspaceRef === undefined
      ? await getSoleWorkspace(db)
      : await getWorkspaceByRef(db, workspaceRef);
  if (workspace === null) return null;
  const user = await getUserByLogin(db, login);
  if (user === null) return null;
  const { principal } = await classifyWorkspacePrincipal(env, db, workspace, user, new Date().toISOString());
  return principal === "operator-granted" ? workspace.slug : null;
}

/**
 * The signed-in login's live workspace memberships as the SPA boot's switcher
 * rows (`{id, slug, name, role}`). `strict`-only: under `off` the workspace
 * route family answers 404, so a switch target would be a dead link and the
 * shell renders no switcher. An unbound store answers `[]` (nothing to list).
 */
export async function workspaceMembershipsForLogin(
  env: Env,
  login: string,
): Promise<WorkspaceMembershipOption[]> {
  if (tenantModeOf(env.WORKSPACE_TENANT_MODE) !== "strict") return [];
  const db = dashboardD1(env);
  if (db === null) return [];
  return listWorkspaceMembershipOptions(db, login);
}

/**
 * The signed-in login's live pending invitations — the invitee's discovery
 * surface in the SPA boot. Mode-independent: an invitation exists
 * in the workspace plane whether or not the deployment routes by workspace
 * yet, and presenting it is what makes acceptance reachable at all.
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

/**
 * Whether `login` may run the App-creation flow — the gate every manifest route
 * consults, because each one can write the row. `strict` resolves a decision
 * from the workspace role, except on an unbound store where no decision is
 * possible (see `strictWorkspaceBoot` — the routes' own `db_unbound` outcomes
 * answer there); `off` never gates, so its creator rule keeps the flow open
 * (the caller can manage what it creates there) and this function issues no
 * read at all.
 *
 * The SIDEBAR boot is a different caller: `strictWorkspaceBoot` reads one
 * membership count in every mode — `off` included, because `needsWorkspace`
 * is mode-independent — so one `workspace_members` read happens per
 * sidebar-bearing request regardless of mode. Migrations are forward-only, so
 * a database without that table is a schema fault, not a mode we answer for;
 * the count carries no fallback.
 */
export async function canCreateApp(env: Env, login: string): Promise<boolean> {
  if (tenantModeOf(env.WORKSPACE_TENANT_MODE) !== "strict") return true;
  return (await strictWorkspaceBoot(env, login)).canCreateApp ?? true;
}

/**
 * The post-authentication landing page. `/dashboard` (the root workbench) is
 * mode-independent, but its first data read derives the base from the
 * pathname — the retired legacy App family — so under `strict` it is a dead
 * end with no click path into the workspace UI. Every signed-in producer
 * (OAuth callback, the login bounce) names the workspace Apps page instead.
 *
 * A login with NO live membership never lands there: the workspace Apps page
 * would answer the outsider 404, so sign-in ends on `/dashboard`, whose shell
 * offers workspace creation (sign-in joins nobody to a
 * workspace, so a newcomer's first stop is making one). Unresolvable → today's
 * target.
 *
 * The boot read IS this decision: it resolves the sole workspace slug and the
 * login's membership count together, so the landing never re-queries either.
 */
export async function signedInLanding(env: Env, login: string): Promise<string> {
  const boot = await strictWorkspaceBoot(env, login);
  if (boot.workspaceRef !== undefined) return `/dashboard/${boot.workspaceRef}/apps`;
  // Only a strict deployment that still cannot name its workspace is the
  // operator-facing dead end. A newcomer (`needsWorkspace`) is the EXPECTED
  // landing on the creation surface, not a configuration fault.
  if (tenantModeOf(env.WORKSPACE_TENANT_MODE) === "strict" && boot.needsWorkspace !== true) {
    warnUnresolvableLanding(env);
  }
  return DASHBOARD_MOUNT;
}

/**
 * The post-commit landing page. The manifest flow's own request carries no
 * tenant scope (its routes are mode-independent), so `scopedAppPath` cannot
 * rewrite this target: under `strict` the legacy App family answers 404, and
 * the App's onboarding page is named by the sole workspace the commit just
 * mapped it into. `off` keeps today's target. A commit that succeeded always
 * minted an `app_workspaces` row, which `createApp` only does when exactly one
 * workspace exists, so the strict read always resolves.
 */
async function manifestSuccessTarget(c: DashboardContext, appSlug: string): Promise<string> {
  const legacy = `/dashboard/apps/${appSlug}/onboarding`;
  const base = await strictWorkspaceAppsBase(c.env);
  return base === null ? legacy : `${base}/${appSlug}/onboarding`;
}

function isSpaFetchPost(c: DashboardContext): boolean {
  return c.req.header(SPA_POST_FORM_HEADER) === SPA_POST_FORM_VALUE;
}

/** Native `<form method="post">` navigation — not the SPA's fetch `postForm`. */
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
  // Tenant invisibility is final on a workspace-scoped request: an unknown or
  // cross-workspace App answers a real 404 (rendered page on navigation),
  // never the legacy redirect — a redirect would confirm nothing but still
  // move the operator into a surface the request cannot see.
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

/**
 * The dashboard D1 binding's face: the users-store narrow face PLUS D1
 * `batch` (Phase 5 fix, PR #7 review) — the settings routes hand this
 * binding to the App-config store, whose setModelRoles full-map save is ONE
 * atomic batch. Truthful for the runtime binding (a real D1Database) and
 * the bun:sqlite test double, which both implement batch; the DashboardD1
 * face alone (a single-row store's view) just doesn't declare it.
 */
type DashboardDb = DashboardD1 & AppConfigBatchFace;

/**
 * D1 membership store binding. Runtime-real via wrangler.jsonc
 * `d1_databases` (binding DB), but the fetch-face Env deliberately does not
 * declare it — read through this local intersection and fail closed when
 * unbound, like every missing dashboard dependency.
 */
function dashboardD1(env: Env): DashboardDb | null {
  const db = (env as Env & { DB?: DashboardDb }).DB;
  return db ?? null;
}

// --- Webhook slug resolution + manifest commit helpers ---

/** Bounded suffix attempts before the INSERT's own UNIQUE error surfaces. */
const SLUG_SUFFIX_ATTEMPTS = 6;

function errorTypeName(err: unknown): string {
  return err instanceof Error ? err.name : String(err);
}

/** The sqlite UNIQUE violation for one github_apps column (slug retries). */
function isAppsUniqueViolation(err: unknown, column: "slug" | "github_app_id"): boolean {
  return err instanceof Error && err.message.includes(`github_apps.${column}`);
}

/**
 * First slug in `[base, base-<suffix>…]` not present in github_apps
 * (soft-deleted rows count — their UNIQUE slug still owns the namespace).
 * Minted at start and carried through the signed state — the first line of
 * defense against collisions. A commit-time race does NOT remap (the
 * manifest already registered the slug's webhook URL with GitHub): the hold
 * is burned with a 409 instead.
 */
async function resolveAvailableSlug(db: DashboardD1, base: string): Promise<string> {
  const apps = createAppsStore(db);
  let slug = base;
  for (let attempt = 0; attempt <= SLUG_SUFFIX_ATTEMPTS; attempt++) {
    if ((await apps.getAppBySlug(slug)) === null) return slug;
    slug = `${base}-${randomSlugSuffix()}`;
  }
  return slug;
}

// --- Workspace (tenant) routing gate (migration 0026, Deploy B) ---
//
// ONE middleware, mounted before the membership guard and every route, decides
// which route family a /dashboard path may address. `off` keeps the legacy App
// paths exactly as today and hides the workspace paths (404); `strict` hides
// the legacy App paths (404) and resolves the workspace named by the first path
// segment. Non-App paths (login, logout, oauth/callback, locale, members,
// manifest, healthz) are mode-independent and pass through in both modes.
// Both App route blocks register from ONE handler table (APP_ROUTES below), so
// no handler body exists twice.
const DASHBOARD_MOUNT = "/dashboard";

type DashboardPathClass =
  | { kind: "workspace"; ref: string }
  | { kind: "legacy-app" }
  | { kind: "other" };

/**
 * Classify a mount-pinned /dashboard path into the route family it addresses —
 * step 1 of the request-path ordering contract, mirrored by
 * `workspaceRefOf` in `src/spa/routes.ts`. A workspace path is
 * `/<ref>/{apps|members|api}…` with a non-reserved ref; the legacy App paths
 * are today's `/apps…` and `/api/apps…`. A reserved first segment is never a
 * workspace, so `:workspaceRef` cannot capture a real route (`/apps`,
 * `/api/apps`, `/login`, `/members`, …).
 */
const WORKSPACE_SEGMENTS: ReadonlySet<string> = new Set(["apps", "members", "api"]);

function classifyDashboardPath(pathname: string): DashboardPathClass {
  const relative =
    pathname === DASHBOARD_MOUNT || pathname.startsWith(`${DASHBOARD_MOUNT}/`)
      ? pathname.slice(DASHBOARD_MOUNT.length)
      : pathname;
  const [, first, second] = relative.split("/");
  if (first === "apps" || (first === "api" && second === "apps")) return { kind: "legacy-app" };
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

/**
 * Tenant invisibility 404, the ONE surface for every hidden path: HTML
 * navigation renders the console's styled page (the same surface the
 * pinned-POST 404 uses), a fetch keeps the bare status — the SPA's API reads
 * parse status only.
 */
async function tenantNotFound(c: DashboardContext): Promise<Response> {
  return wantsHtml(c.req.header("Accept") ?? null)
    ? c.html(notFoundPage(requestLocale(c)), 404)
    : await c.notFound();
}

/**
 * The tenant route-family gate. Mounted twice: by `src/worker/index.ts` on
 * `/dashboard/*` BEFORE SPA dispatch (so a strict legacy-App HTML request
 * cannot be served by the SPA shell before the 404 decision) and by
 * `dashboardApp` ahead of its routes. It only CLASSIFIES: it issues no D1 read,
 * and the workspace row plus the caller's membership are resolved by
 * `requireMember` after the session and user read. The first run wins — the
 * second returns on the `tenant` it already set.
 */
export const dashboardTenantGate: Handler<{
  Bindings: Env;
  Variables: DashboardVariables;
}> = async (c, next) => {
  if (c.get("tenant")) return next();
  let mode: TenantMode;
  try {
    mode = tenantModeOf(c.env.WORKSPACE_TENANT_MODE);
  } catch (error) {
    // A typo'd deploy var fails the whole face: no route is served from a
    // guessed `off`/`strict`. The message names the value, never a secret.
    return c.text((error as Error).message, 500);
  }
  const target = classifyDashboardPath(c.req.path);
  if (target.kind === "legacy-app") {
    // Deploy B retires the pre-workspace App face: the same 404 an unmatched
    // path answered with before the switch.
    return mode === "strict" ? tenantNotFound(c) : next();
  }
  if (target.kind !== "workspace") return next();
  // Deploy A: the workspace face does not exist yet.
  if (mode !== "strict") return tenantNotFound(c);
  // CLASSIFY ONLY — no D1 read. The workspace row and the caller's membership
  // are resolved by the member gate AFTER the session and user row are known,
  // so an anonymous request neither pays a pre-auth round trip nor learns from
  // the response whether the slug exists (both cases 302 to login).
  c.set("tenant", {
    ref: target.ref,
    workspaceId: null,
    role: null,
    principal: null,
  });
  return next();
};

dashboardApp.use("*", dashboardTenantGate);

// --- Per-request allowlist guard (spec § AuthZ, lock L5) ---
//
// ONE middleware mount before every route definition auto-covers all
// /dashboard routes (B1 manifest trio + the POST "*" catch-all today, plan
// 13/14 routes tomorrow) — no per-route guard copies. Membership is the
// users row: removal = row delete, so a removed member's stateless cookie
// fails here on every request. Exempt set is EXACTLY the two pre-session
// routes — a guard on /dashboard/login would loop the login page, and
// /dashboard/oauth/callback is the request that establishes the session.
// /logout stays guarded (L5 — NOT in the exempt set) but is SESSION-gated,
// not membership-gated (qc2 F-002): the owner of a valid-but-stale cookie
// (removed member) must be able to burn it, so a row-less session reaches
// the logout route; without a session it still 302s into the OAuth flow.
// Per-route readSessionValue handling (incl. B1 hold/state cookies) stays
// as-is below — the guard only ADDS the D1 membership check. Paths are the
// full mount-pinned form: dashboardApp is mounted once at /dashboard
// (src/worker/index.ts, L5 code-verified).
const GUARD_EXEMPT_PATHS = new Set(["/dashboard/login", "/dashboard/oauth/callback"]);

dashboardApp.use("*", async (c, next) => {
  if (GUARD_EXEMPT_PATHS.has(c.req.path)) return next();
  const sessionSecret = c.env.DASHBOARD_SESSION_SECRET;
  if (!sessionSecret) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), sessionSecret);
  // No session → the pre-guard behavior: 302 into the OAuth flow.
  // POST /dashboard/locale is session-optional: the login-page
  // language toggle must set mstar_locale without membership. Locale is not
  // a privileged action — the route writes only the language cookie.
  if (!session) {
    if (c.req.path === "/dashboard/locale") return next();
    return c.redirect("/dashboard/login", 302);
  }
  // Logout needs no membership row (qc2 F-002): any VALID session may burn
  // its own cookies. The route itself touches no membership data, so this
  // sits before the D1 check — storage misconfiguration cannot trap a
  // stale cookie on the browser either.
  // Locale follows the same L5 session-level exemption: a row-less (removed)
  // session may still set language preference.
  if (c.req.path === "/dashboard/logout" || c.req.path === "/dashboard/locale") return next();
  // Logged in → the only new check: an active user row (spec § AuthZ).
  // Fail closed on an unbound store, like every missing dashboard dependency.
  // Callback/confirm must still run so a retryable db_unbound can park the
  // hold and serve the resumable confirm link (QC F-005). Neither route needs
  // the membership row for that outcome: the callback reaches its own
  // `db_unbound` outcome, and confirm reads the hold cookie plus the creation
  // gate, which answers no decision on an unbound store (`strictWorkspaceBoot`)
  // so the hold survives instead of being burned on a configuration failure.
  const db = dashboardD1(c.env);
  if (!db) {
    if (c.req.path === "/dashboard/manifest/callback" || c.req.path === "/dashboard/manifest/confirm") {
      return next();
    }
    return c.text("dashboard storage is not configured", 500);
  }
  const user = await getUserByLogin(db, session.login);
  if (!user) {
    // Same structured-log convention as logOAuthFailure / logManifestFailure;
    // the login is public identity (it renders on the denial page).
    console.warn(
      JSON.stringify({
        event: "dashboard_access",
        stage: "guard",
        reason: "not_a_member",
        login: session.login,
      }),
    );
    // Actively invalidate the removed member's session. HTML
    // navigation → expire + 302 login; API/fetch → expire + 403 (a fetch
    // must not silently follow the 302 into the HTML login page).
    c.header("Set-Cookie", expireCookie(SESSION_COOKIE));
    if (wantsHtmlFormNavigation(c)) {
      return c.redirect("/dashboard/login", 302);
    }
    return c.html(removedPage(session.login, requestLocale(c)), 403);
  }
  // The resolved users row is a per-request fact every later gate reuses.
  c.set("authUser", user);
  return next();
});

/**
 * The ONE principal classifier of a workspace request, shared by the gate
 * (which acts on the verdict) and the SPA shell boot (which only asks whether
 * the caller is a granted operator). Ordering is the contract, not an
 * implementation detail: member wins, then a live pending invite, and only
 * then the operator allowlist — so an operator who is a member (or holds an
 * invite here) keeps that ordinary standing (AC1), and the shell can never
 * hand a listed operator an invitee's landing page.
 */
async function classifyWorkspacePrincipal(
  env: Env,
  db: DashboardDb,
  workspace: { id: string },
  user: DashboardUserRow,
  now: string,
): Promise<{ principal: WorkspacePrincipal; role: WorkspaceRole | null }> {
  const role = await getMembership(db, workspace.id, user.id);
  if (role !== null) return { principal: "member", role };
  const invited = await getPendingInviteByLogin(db, workspace.id, user.github_login, now);
  if (invited !== null) return { principal: "invitee", role: null };
  if (!isPlatformOperator(env, user.github_login)) return { principal: "outsider", role: null };
  const granted = await hasValidGrant(db, workspace.id, user.github_login, now);
  return { principal: granted ? "operator-granted" : "operator-denied", role: null };
}

/**
 * Workspace-scope resolution — ordering-contract step 3, ONE middleware for
 * every workspace route. It runs after the session guard (so `authUser` is the
 * verified caller) and classifies the principal in order:
 *
 *   member → invitee → operator-granted → operator-denied → outsider
 *
 * `member` gets the workspace scope with its `workspace_members.role`;
 * `invitee` (a live pending invite for this workspace matches the login) may
 * reach ONLY the accept route; everything else is `outsider`, which the routes
 * answer with the byte-identical tenant 404.
 *
 * The operator classes come LAST, after membership and the invite check: an
 * operator who is a member keeps ordinary membership rights (AC1), so
 * `PLATFORM_OPERATORS` is not even parsed until neither applies. A listed
 * operator without a live `support_grants` row on THIS workspace is
 * `operator-denied` (the outsider 404, including an expired grant); one with a
 * live row is `operator-granted`, and the ceiling admits only the routes
 * declared `access: "read"` — everything else answers 403.
 *
 * Every operator decision writes exactly ONE `audit_events` row here, before
 * dispatch: `support.read` for a granted read-route dispatch,
 * `support.forbidden` for a granted request the ceiling refuses, and
 * `support.denied` for an operator without a grant. A route handler therefore
 * cannot skip the audit — classification and the write happen before `next()`,
 * and mounting a workspace route at all requires the route table that declares
 * its access. HTML shell loads are dispatch, not workspace routes: they are
 * classified by the same function but write no row (see `docs/deploy.md`).
 */
dashboardApp.use("*", async (c, next) => {
  if (c.get("workspaceScope") !== undefined) return next();
  const tenant = c.get("tenant");
  const db = dashboardD1(c.env);
  if (!tenant || !db) {
    c.set("workspaceScope", null);
    return next();
  }
  const workspace = await getWorkspaceByRef(db, tenant.ref);
  if (!workspace) {
    c.set("workspaceScope", null);
    return next();
  }
  const user = c.get("authUser");
  const now = new Date().toISOString();
  const { principal, role } = user
    ? await classifyWorkspacePrincipal(c.env, db, workspace, user, now)
    : { principal: "outsider" as const, role: null };
  if (role !== null && user) {
    c.set("tenant", { ref: tenant.ref, workspaceId: workspace.id, role, principal });
    c.set("workspaceScope", { workspaceId: workspace.id, role });
    return next();
  }
  if (principal === "operator-denied" && user) {
    // Expired and absent grants are the same answer — the outsider 404 — so
    // the response never reveals the grant state.
    await insertAuditEvent(db, {
      workspaceId: workspace.id,
      actorLogin: user.github_login,
      action: "support.denied",
      now,
    });
    c.set("tenant", { ref: tenant.ref, workspaceId: workspace.id, role: null, principal });
    c.set("workspaceScope", null);
    return await tenantNotFound(c);
  }
  if (principal === "operator-granted" && user) {
    // The audit row records the ATTEMPT, before dispatch: it is written here,
    // so no route handler can skip it and none can change what was decided.
    const read = isOperatorReadPath(c.req.path, c.req.method);
    await insertAuditEvent(db, {
      workspaceId: workspace.id,
      actorLogin: user.github_login,
      action: read ? "support.read" : "support.forbidden",
      now,
    });
    c.set("tenant", { ref: tenant.ref, workspaceId: workspace.id, role: null, principal });
    c.set("workspaceScope", null);
    if (!read) return c.json({ error: "forbidden" }, 403);
    return next();
  }
  c.set("tenant", {
    ref: tenant.ref,
    workspaceId: workspace.id,
    role: null,
    principal,
  });
  c.set("workspaceScope", null);
  return next();
});

/** Platform-operator allowlist membership — NOCASE, same parser as every login list. */
function isPlatformOperator(env: Env, login: string): boolean {
  return parseLoginList(env.PLATFORM_OPERATORS).some(
    (entry) => entry.toLowerCase() === login.toLowerCase(),
  );
}

/**
 * The operator read ceiling: the routes declared `access: "read"` in the
 * workspace route table, for the method the request actually uses — a future
 * non-GET handler mounted at a read path is `write` by default rather than
 * admitted by its path alone. Everything else — every App read, credentials,
 * settings, role change, invites, the audit list — is write-classified and
 * answers 403, and an UNDECLARED route is `write` too, so a route added later
 * cannot widen the surface by omission. Declared paths are literals (no
 * `:param`), which is what makes the suffix match exact.
 *
 * Hono dispatches a HEAD request through the GET route table, so HEAD is
 * compared as `get` — the ceiling follows the handler that actually runs.
 */
function isOperatorReadPath(path: string, method: string): boolean {
  const routeMethod = method === "HEAD" ? "get" : method.toLowerCase();
  return APP_ROUTES.some(
    (route) => route.access === "read" && route.method === routeMethod && path.endsWith(route.path),
  );
}

async function startOAuthLogin(c: DashboardContext): Promise<Response> {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  // Already signed in → bounce back to the shell (IA routing table).
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (session) return c.redirect(await signedInLanding(c.env, session.login), 302);
  const state = await createStateValue(secrets.sessionSecret);
  c.header("Set-Cookie", serializeCookie(OAUTH_STATE_COOKIE, state, OAUTH_STATE_MAX_AGE_SEC));
  const callbackUri = `${new URL(c.req.url).origin}/dashboard/oauth/callback`;
  return c.redirect(buildAuthorizeUrl(secrets.clientId, callbackUri, state), 302);
}

// GET starts OAuth for non-HTML clients. SPA login (Accept: text/html) is
// served by spa-dispatch; its "Sign in with GitHub" form POSTs here so the
// browser does not loop on the SPA GET.
dashboardApp.get("/login", startOAuthLogin);
dashboardApp.post("/login", startOAuthLogin);

dashboardApp.get("/oauth/callback", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  // The state cookie is single-use: invalidated on every callback outcome.
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
  // Entry-level shape gate, symmetric with the manifest callback: only
  // URL-safe opaque codes reach the exchange (the code travels in the POST
  // body to the fixed github.com token endpoint — never in a fetched URL).
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
  // Sign-in decision BEFORE any session is minted. A recorded removal denies
  // (migration 0023 — an operator's removal is authoritative) and is cleared
  // only by a deliberate re-admission; every other GitHub-verified login gets
  // a `users` row (there is no deployment allowlist). The invite
  // path is NOT consulted here: sign-in never joins a workspace (acceptance is
  // the explicit POST). Deny = 403 page with ZERO Set-Cookie
  // (spec: 零 cookie、零写入) — the single-use state-expiry header set above is
  // withdrawn here — and zero D1 writes (the deny branch never inserts).
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  const decision = await signInDashboardUser(db, user.login);
  if (decision.outcome === "deny") {
    // The only deny is a recorded removal, so the deny face is the removal
    // face: sign-in no longer denies for any other reason.
    logOAuthFailure("sign_in", "removed", { login: user.login });
    c.header("Set-Cookie", undefined);
    return c.html(removedPage(user.login, requestLocale(c)), 403);
  }
  const session = await createSessionValue(user.login, user.name, secrets.sessionSecret);
  c.header("Set-Cookie", serializeCookie(SESSION_COOKIE, session, SESSION_MAX_AGE_SEC), {
    append: true,
  });
  return c.redirect(await signedInLanding(c.env, user.login), 302);
});

dashboardApp.get("/logout", (c) => {
  c.header("Set-Cookie", expireCookie(SESSION_COOKIE));
  // Any parked manifest credentials die with the session (spec L7).
  c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
  c.header("Set-Cookie", expireCookie(MANIFEST_STATE_COOKIE), { append: true });
  return c.redirect("/dashboard/login", 302);
});

// --- Workspace creation ---
//
// The ONLY membership write outside the invite path (Global Constraints): a
// signed-in login with no workspace creates one and becomes its `owner`.
// Deliberately OUTSIDE the workspace gate — the caller has no workspace yet, so
// there is no `:workspaceRef` to scope it to. The session guard already
// requires a `users` row; nothing here reads a role.
//
// The id is `ws_` + 22 chars of lowercase base32 (`a-z2-7`, all inside the
// `[a-z0-9]` alphabet) drawn from `crypto.getRandomValues`. Lowercase-only is
// load-bearing: `slug = id` then keeps the BINARY `workspaces.slug` UNIQUE
// equivalent to case-insensitive uniqueness (the workspace-ref routing depends on it).
const WORKSPACE_ID_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
/** Bounded retries for the (astronomically unlikely) slug collision. */
const WORKSPACE_ID_ATTEMPTS = 6;
export const WORKSPACE_NAME_MAX_LENGTH = 80;

/** A fresh workspace id; 256 is divisible by 32, so the sampling is unbiased. */
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
  const createdAt = new Date().toISOString();
  for (let attempt = 0; attempt < WORKSPACE_ID_ATTEMPTS; attempt++) {
    const id = createWorkspaceId();
    if (await createWorkspace(db, { id, name, userId: user.id, createdAt })) {
      // The client cannot derive the post-creation landing: it does not know
      // the deployment's tenant read mode, and a second live workspace defeats
      // the sole-workspace resolver, so `/dashboard` would strand the creator
      // on a slug-less shell. `strict` serves the new workspace's own App
      // list; `off` has no workspace routes at all, so the legacy list is the
      // only surface that exists there.
      const appsPath =
        tenantModeOf(c.env.WORKSPACE_TENANT_MODE) === "strict"
          ? `/dashboard/${id}/apps`
          : APPS_LIST_REDIRECT;
      return c.json({ id, slug: id, name, role: "owner" as const, appsPath }, 201);
    }
  }
  return c.text("Could not allocate a workspace id — try again.", 500);
});

// --- Locale preference (i18n) ---
//
// POST /dashboard/locale — the navbar [EN/中文] toggle target. Body is
// JSON or form-encoded `{ locale }`; valid ids are the two Locale values.
// Writes the mstar_locale cookie (HttpOnly, SameSite=Lax, Path=/dashboard
// — the session.ts attribute set scoped to the dashboard) and 302s back to
// a Referer-derived target sanitized by safeLocaleRedirect (anything
// off-origin, protocol-relative, empty, or missing → /dashboard). Invalid
// locale → 400, no cookie.
// The mount-level guard treats POST /dashboard/locale as
// session-optional and membership-exempt (same L5 family as logout). A
// logged-out login-page toggle and a row-less session may both set the
// cookie. Every other /dashboard route stays membership-enforcing.

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
    // unparseable referer → /dashboard
  }
  return "/dashboard";
}

/** JSON or form body `{ locale }` → valid Locale, or null (invalid/malformed). */
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

// --- GitHub App Manifest start + callback (no secret write) ---
// --- Per-App slug mints here and rides the signed state ---

// Start: logged-in only. Mints the webhook slug (login-derived, DB
// pre-resolved against existing slugs), the single-use CSRF state cookie
// CARRYING it (createManifestStateValue — same createStateValue HMAC
// discipline), and renders the zero-JS form POST to
// https://github.com/settings/apps/new (state rides the form-action query).
// The manifest's webhook URL is the App's own route /webhook/{slug}.
// Logged out → 302 to login (IA routing table).
dashboardApp.post("/manifest/start", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  // I-000082: the App this flow creates belongs to the sole workspace, where a
  // plain member has no manage rights — offering the flow would end in a 403 on
  // the App it just created. Checked BEFORE the slug mint / state cookie.
  if (!(await canCreateApp(c.env, session.login))) {
    return c.html(forbiddenPage(session.login, requestLocale(c)), 403);
  }
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  const slug = await resolveAvailableSlug(db, buildAppSlug(session.login));
  const state = await createManifestStateValue(secrets.sessionSecret, slug);
  c.header("Set-Cookie", serializeCookie(MANIFEST_STATE_COOKIE, state, MANIFEST_STATE_MAX_AGE_SEC));
  const manifest = buildManifest(new URL(c.req.url).origin, session.login, slug);
  return c.html(
    manifestStartPage(session, manifest.name, JSON.stringify(manifest), buildManifestCreateUrl(state), requestLocale(c)),
  );
});

// Callback: GitHub redirects here with ?code=…&state=…. Bad/missing state →
// 4xx with ZERO secret-API calls (the conversion fetch never runs). On
// success the code is exchanged and — AC4b — the App is committed
// immediately (no second click): the shared commit path (commitManifestApp,
// the same write the POST /manifest/commit recovery route uses) encrypts
// the credentials with DASHBOARD_ENCRYPTION_KEY and writes one github_apps
// row. Success → 302 to the App's onboarding page; non-retryable conflicts
// (409) burn the hold like the commit route; retryable outcomes (500) park
// the hold cookie so /manifest/confirm stays the resume path. The response
// never carries PEM or webhook_secret.
dashboardApp.get("/manifest/callback", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  // The state cookie is single-use: invalidated on every callback outcome.
  c.header("Set-Cookie", expireCookie(MANIFEST_STATE_COOKIE));
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  // Creation capability is re-checked HERE, not only at start: a flow that
  // began as owner/admin must not complete after a mid-flight demotion, and the
  // callback writes the row itself (same rule as the start/commit routes). The
  // state cookie is already expired above, so the flow is burned either way.
  if (!(await canCreateApp(c.env, session.login))) {
    logManifestFailure("callback", "not_a_creator");
    return c.html(forbiddenPage(session.login, requestLocale(c)), 403);
  }
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
  const code = c.req.query("code");
  if (!code) {
    logManifestFailure("callback", "missing_code");
    return c.html(manifestErrorPage(t(requestLocale(c), "manifest.error.missingCode"), false, requestLocale(c)), 400);
  }
  // Entry-level shape gate (mirrors the in-function gate): only URL-safe
  // opaque codes ever reach the conversion call — the request-derived value
  // can influence nothing but one encoded path segment on the fixed
  // api.github.com host.
  if (!GITHUB_CODE_SHAPE.test(code)) {
    logManifestFailure("callback", "unsafe_code_shape");
    return c.html(manifestErrorPage(t(requestLocale(c), "manifest.error.codeRejected"), false, requestLocale(c)), 400);
  }
  const conversion = await exchangeManifestCode(code);
  if (!conversion) {
    return c.html(manifestErrorPage(t(requestLocale(c), "manifest.error.codeRejected"), false, requestLocale(c)), 502);
  }
  const locale = requestLocale(c);
  // The payload feeds the shared commit path; the cookie string is parked on
  // retryable outcomes so /manifest/confirm can resume.
  const holdPayload = buildHoldPayload(conversion, session.login, state.slug);
  const hold = await encryptHoldValue(holdPayload, secrets.sessionSecret);
  const outcome = await commitManifestApp({
    db: dashboardD1(c.env),
    encryptionKey: c.env.DASHBOARD_ENCRYPTION_KEY,
    hold: holdPayload,
    login: session.login,
  });
  // Retryable outcomes (db_unbound / encrypt_failed / db_rejected) keep the
  // hold: park the cookie so the operator can resume via /manifest/confirm.
  const parkHold = () =>
    c.header("Set-Cookie", serializeCookie(MANIFEST_HOLD_COOKIE, hold, MANIFEST_HOLD_MAX_AGE_SEC), {
      append: true,
    });
  // Every burn/park header APPENDS: the state-cookie expiry from the top of
  // the handler must reach the browser beside it (Hono replaces same-name
  // headers unless `append: true`).
  switch (outcome.kind) {
    case "success": {
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
      return c.redirect(await manifestSuccessTarget(c, outcome.row.slug), 302);
    }
    case "login_mismatch": {
      // Unreachable here (the hold is minted for this session) — same burn
      // semantics as the commit route for the shared contract.
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
      return c.html(manifestErrorPage(t(locale, "manifest.error.loginMismatch"), false, locale), 403);
    }
    case "db_unbound":
      parkHold();
      return c.html(manifestErrorPage(t(locale, "manifest.error.dbUnbound"), true, locale), 500);
    case "encrypt_failed":
      parkHold();
      return c.html(manifestErrorPage(t(locale, "manifest.error.noEncryptionKey"), true, locale), 500);
    case "slug_conflict":
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
      return c.html(manifestErrorPage(t(locale, "manifest.error.slugConflict"), false, locale), 409);
    case "already_connected":
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE), { append: true });
      return c.html(manifestErrorPage(t(locale, "manifest.error.alreadyConnected"), false, locale), 409);
    case "db_rejected":
      parkHold();
      return c.html(manifestErrorPage(t(locale, "manifest.error.dbRejected"), true, locale), 500);
  }
});

// Commit (spec § Multi-App 契约 — replaces the retired Cloudflare
// secrets-bulk write; `confirm=overwrite` is gone because nothing shared is
// overwritten). The hold cookie is bound to the committing session and
// survives RETRYABLE outcomes (500 encrypt/DB failures) so the operator can
// retry without creating a second GitHub App; it is burned on success,
// login mismatch, undecryptable/expired hold, the non-retryable
// already-connected conflict, and the non-retryable slug-conflict race (the
// manifest already registered the webhook URL — remapping would desync it).
// Missing/undecryptable/expired hold = flow expired → 302 back to the start,
// zero writes. The write is delegated to commitManifestApp — the
// SAME path the callback auto-commit runs — so a native resubmit after a
// retryable callback failure is an idempotent recovery resubmit, and success
// lands on the same onboarding page as the auto-commit.
dashboardApp.post("/manifest/commit", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  // Same creation capability as the start route (I-000082): the recovery
  // resubmit must not become the bypass. The hold is left untouched — the op
  // never ran, and demoting the operator mid-flow is the only way in.
  if (!(await canCreateApp(c.env, session.login))) {
    return c.html(forbiddenPage(session.login, requestLocale(c)), 403);
  }
  const hold = await readHoldValue(getCookie(c, MANIFEST_HOLD_COOKIE), secrets.sessionSecret);
  if (!hold) {
    logManifestFailure("commit", "hold_missing_or_expired");
    // Bad hold: burn the cookie so no stale credential lingers.
    c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
    return c.redirect("/dashboard", 302);
  }
  const locale = requestLocale(c);
  const outcome = await commitManifestApp({
    db: dashboardD1(c.env),
    encryptionKey: c.env.DASHBOARD_ENCRYPTION_KEY,
    hold,
    login: session.login,
  });
  switch (outcome.kind) {
    case "success": {
      // Success: the hold is single-success — burned now that the row exists;
      // the operator lands on the App's onboarding page.
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      return c.redirect(await manifestSuccessTarget(c, outcome.row.slug), 302);
    }
    case "login_mismatch": {
      // The hold is bound to the login that ran the callback: a different
      // operator must restart the flow (zero writes, hold burned).
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      return c.html(manifestErrorPage(t(locale, "manifest.error.loginMismatch"), false, locale), 403);
    }
    case "db_unbound":
      return c.text("dashboard storage is not configured", 500);
    case "encrypt_failed":
      return c.html(manifestErrorPage(t(locale, "manifest.error.noEncryptionKey"), true, locale), 500);
    case "slug_conflict":
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      return c.html(manifestErrorPage(t(locale, "manifest.error.slugConflict"), false, locale), 409);
    case "already_connected":
      c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
      return c.html(manifestErrorPage(t(locale, "manifest.error.alreadyConnected"), false, locale), 409);
    case "db_rejected":
      return c.html(manifestErrorPage(t(locale, "manifest.error.dbRejected"), true, locale), 500);
  }
});

// --- Shared manifest commit (callback auto-commit + POST
// /manifest/commit recovery run the same write path, spec § 5) ---

type ManifestCommitOutcome =
  | { kind: "success"; row: GithubAppRow }
  | { kind: "login_mismatch" }
  | { kind: "db_unbound" }
  | { kind: "encrypt_failed" }
  | { kind: "slug_conflict" }
  | { kind: "already_connected" }
  | { kind: "db_rejected" };

/**
 * The manifest commit body, shared by the callback auto-commit (AC4b — no
 * second click) and the POST /manifest/commit recovery route. The decrypted
 * hold payload + the acting session login are passed in; the hold's login
 * binding is re-checked here on EVERY call. Outcomes mirror the route's long-standing
 * semantics: success = ONE github_apps row (secretbox AAD rowKey = the
 * caller-generated row PK, decided BEFORE encryption — review pin);
 * login_mismatch / slug_conflict / already_connected = non-retryable (the
 * caller burns the hold); db_unbound / encrypt_failed / db_rejected =
 * retryable (the caller keeps the hold so /manifest/confirm can resume).
 * Zero upstream calls: encryption + a local D1 write only.
 */
async function commitManifestApp(args: {
  db: DashboardDb | null;
  encryptionKey: string | undefined;
  hold: ManifestHoldPayload;
  login: string;
}): Promise<ManifestCommitOutcome> {
  const { db, encryptionKey, hold, login } = args;
  if (hold.login !== login) {
    logManifestFailure("commit", "login_mismatch");
    return { kind: "login_mismatch" };
  }
  if (!db) return { kind: "db_unbound" };
  // Review pin: the row id exists BEFORE encryption so the secretbox AAD
  // rowKey (github_apps.<column>:<id>) equals the row's primary key.
  const appId = crypto.randomUUID();
  let privateKeyEnc: string;
  let webhookSecretEnc: string;
  try {
    const box = createSecretbox(encryptionKey);
    privateKeyEnc = await box.encryptSecret(hold.pem, `github_apps.private_key_enc:${appId}`);
    webhookSecretEnc = await box.encryptSecret(
      hold.webhook_secret,
      `github_apps.webhook_secret_enc:${appId}`,
    );
  } catch (err) {
    // SecretboxKeyError (missing/malformed DASHBOARD_ENCRYPTION_KEY) and any
    // other encrypt failure are equally fail-closed: 500, zero writes, hold
    // KEPT — fixing the env makes the retry succeed.
    logManifestFailure("commit", "encrypt_failed", {
      error_type: errorTypeName(err),
      key_error: err instanceof SecretboxKeyError,
    });
    return { kind: "encrypt_failed" };
  }
  // Slug: pre-resolved at start and carried through the hold. A commit-time
  // UNIQUE conflict means the slug was taken between start and commit — the
  // manifest already registered {origin}/webhook/{hold.slug} with GitHub, so
  // remapping the row to a fresh suffix would desync the webhook URL (the
  // App would look connected yet never receive events, Bugbot F-1). The hold
  // is burned instead: zero rows written, 409, and the operator restarts the
  // flow with a fresh slug.
  const apps = createAppsStore(db);
  try {
    const row = await apps.createApp({
      id: appId,
      slug: hold.slug,
      githubAppId: hold.id,
      name: hold.name,
      privateKeyEnc,
      webhookSecretEnc,
      createdBy: login,
    });
    return { kind: "success", row };
  } catch (err) {
    if (isAppsUniqueViolation(err, "slug")) {
      // The GitHub App WAS created on GitHub, but its webhook slug was
      // claimed before the row could land. Storing the row under any other
      // slug would advertise a URL GitHub never posts to — burn the hold
      // and make the operator start a fresh creation flow.
      logManifestFailure("commit", "slug_conflict", { slug: hold.slug });
      return { kind: "slug_conflict" };
    }
    if (isAppsUniqueViolation(err, "github_app_id")) {
      // The same GitHub App is already connected — retrying cannot help.
      logManifestFailure("commit", "github_app_id_conflict", { github_app_id: hold.id });
      return { kind: "already_connected" };
    }
    // Retryable (missing migrations, transient D1 failure, …): hold kept.
    logManifestFailure("commit", "db_error", { error_type: errorTypeName(err) });
    return { kind: "db_rejected" };
  }
}

// Confirm resume (Bugbot: the hold survives retryable commit outcomes, so a
// refresh / error-page link must re-render the confirm gate, not a dead
// shell). Hold decrypts + hold.login === session.login → summary page with
// id/name/slug/webhook URL (PEM/webhook_secret never render); anything else
// → 302 shell.
dashboardApp.get("/manifest/confirm", async (c) => {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  const hold = await readHoldValue(getCookie(c, MANIFEST_HOLD_COOKIE), secrets.sessionSecret);
  if (!hold || hold.login !== session.login) return c.redirect("/dashboard", 302);
  // This page is the resume gate for the commit that /manifest/commit performs,
  // so it applies the same creation capability (see the callback): a member
  // demoted mid-flight must not be handed the commit affordance.
  if (!(await canCreateApp(c.env, session.login))) {
    c.header("Set-Cookie", expireCookie(MANIFEST_HOLD_COOKIE));
    logManifestFailure("confirm", "not_a_creator");
    return c.html(forbiddenPage(session.login, requestLocale(c)), 403);
  }
  return c.html(
    manifestConfirmPage(
      session,
      {
        id: hold.id,
        name: hold.name,
        slug: hold.slug,
        webhookUrl: `${new URL(c.req.url).origin}/webhook/${hold.slug}`,
      },
      requestLocale(c),
    ),
  );
});

// --- Post-commit onboarding page (AC4b) ---
//
// The landing page after a successful manifest commit: App name / GitHub
// id / slug / webhook URL + the provider-first next-step CTA into Settings.
// Authorization = the same membership + owner-or-admin rule as the settings
// family (plan Interfaces: "membership + manage 规则与 settings 相同"); the
// settings family's DASHBOARD_ENCRYPTION_KEY fail-closed is NOT inherited —
// this page reads plaintext columns only. Unknown / soft-deleted App =
// the settings-family 404 shape. Rendered by the SSR manifest page family
// (no chrome beyond shellHeader), so no SPA shell is served.
const appOnboardingRoute = async (c: DashboardContext) => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  const app = await resolveScopedApp(
    requestAppsStore(member.db, member.scope),
    c.req.param("slug") ?? "",
    member.scope,
  );
  if (!app) {
    return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404);
  }
  if (!canManageApp(member.user, app, member.scope)) {
    return c.html(forbiddenPage(member.session.login, requestLocale(c)), 403);
  }
  const origin = new URL(c.req.url).origin;
  return c.html(
    manifestOnboardingPage(
      member.session,
      {
        id: app.github_app_id,
        name: app.name,
        slug: app.slug,
        webhookUrl: `${origin}/webhook/${app.slug}`,
      },
      requestLocale(c),
      // Set only on a workspace-scoped request; the view never reads env.
      c.get("tenant")?.ref ?? null,
    ),
  );
};

// --- Workspace members + invitations ---
//
// Authority is workspace-scoped: the routing gate classified the ref, the
// route-local member gate below resolves the workspace + the caller's row, and
// each handler applies its own role check. The pre-workspace root faces
// (`GET /api/members`, `POST /members/{invite,remove,role}`) are retired — a
// deployment-level membership list has no meaning once authority is per
// workspace. Pending invites are `owner`/`admin` only; the member list is
// visible to every member.

type AdminGate =
  | {
      ok: true;
      session: SessionPayload;
      db: DashboardDb;
      user: DashboardUserRow;
      scope: WorkspaceScope;
    }
  | { ok: false; response: Response };

// GitHub login syntax (qc1/qc2 F-003): letters, digits, hyphens — 1–39
// chars. Anything else can never match a real GitHub login and would sit in
// the table as a dead row nobody can claim.
const GITHUB_LOGIN_PATTERN = /^[a-zA-Z0-9-]{1,39}$/;

/** Invitations live for 7 days — long enough to survive a weekend sign-up. */
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Route-local workspace-manager gate: a resolved workspace scope whose role is
 * `owner` or `admin`. A plain `member` gets the members-family 403 page; a
 * non-member never reaches here (`requireMember` answered the outsider 404).
 */
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

/**
 * The plain-text body of a members-family refusal. The SPA's `postForm`
 * branches on the status only, so the text is for operators and tests; the
 * plan pins `invite.pending_exists` / `invite.expired` as stable codes.
 */
function inviteMutationResponse(
  c: DashboardContext,
  message: string,
  status: 200 | 400 | 403 | 404 | 409 | 410,
): Response {
  return c.text(message, status);
}

/**
 * The workspace's member list — every member sees it (AC4), and the route is
 * declared `read`, so a granted platform operator reaches it too. The operator
 * response carries ONLY the two AC2 fields (login + role): no row ids, no join
 * stamps, no viewer role, since an operator holds no workspace role and can
 * act on nothing here. For a member the payload is unchanged.
 */
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
  if (member.scope === null) return c.json({ error: "not_found" }, 404);
  const members = await listWorkspaceMembers(member.db, member.scope.workspaceId);
  return c.json({
    viewer: { login: member.user.github_login, role: member.scope.role },
    members: members.map((row) => ({
      id: row.id,
      github_login: row.github_login,
      role: row.role,
      created_at: row.created_at,
    })),
  });
};

/** The workspace's live pending invites — `owner`/`admin` only (AC4). */
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

/**
 * Create one pending invite (AC2). `owner` or `admin` only; inviting an
 * existing member or a login that already has a live pending invite is 409 and
 * writes nothing. A lapsed pending row is flipped terminal by the store before
 * the insert, so re-inviting after expiry is legal.
 */
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
  // Already a member → 409, zero writes (AC2). Resolution is on the
  // WORKSPACE row, not the users row: a signed-in outsider is not a member.
  const now = new Date();
  const members = await listWorkspaceMembers(gate.db, gate.scope.workspaceId);
  if (members.some((row) => row.github_login.toLowerCase() === login.toLowerCase())) {
    return inviteMutationResponse(c, "Already a member.", 409);
  }
  try {
    await createInvite(gate.db, {
      workspaceId: gate.scope.workspaceId,
      login,
      role,
      invitedBy: gate.user.id,
      now: now.toISOString(),
      expiresAt: new Date(now.getTime() + INVITE_TTL_MS).toISOString(),
    });
  } catch (err) {
    if (err instanceof InvitePendingExistsError) {
      // A live pending invite already exists (sequential pre-state or a lost
      // concurrent race) — the first row is untouched.
      return inviteMutationResponse(c, "invite.pending_exists", 409);
    }
    throw err;
  }
  return inviteMutationResponse(c, "ok", 200);
};

/**
 * Revoke a live pending invite (AC6). Workspace-scoped in the store's
 * WHERE clause, so a foreign invite id is indistinguishable from an unknown
 * one; both are 404, and a later accept of the revoked row is 410.
 */
const inviteRevokeRoute = async (c: DashboardContext) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const revoked = await revokeInvite(gate.db, gate.scope.workspaceId, c.req.param("id") ?? "");
  if (!revoked) return inviteMutationResponse(c, "unknown invite", 404);
  return inviteMutationResponse(c, "ok", 200);
};

/**
 * Accept an invite as the signed-in login (AC3). This is the ONLY write
 * that creates a membership from outside. It is reachable by an `invitee`
 * principal (a signed-in login holding a live pending invite in this
 * workspace) as well as by a member, so it gates on the workspace + session
 * instead of `requireMember`.
 *
 * Outcomes follow the plan's failure table exactly: login mismatch or unknown
 * invite → 404; terminal (revoked/expired) → 410; lapsed-but-pending → 409
 * `invite.expired` (the store flips the row in the same request, so a repeat is
 * 410); success → 200.
 */
const inviteAcceptRoute = async (c: DashboardContext) => {
  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);
  const tenant = c.get("tenant");
  if (!tenant || tenant.workspaceId === null) return await tenantNotFound(c);
  const user = c.get("authUser");
  if (!user) return await tenantNotFound(c);
  const inviteId = c.req.param("id") ?? "";
  // Workspace-scoped pre-read: an invite id from another workspace answers the
  // same 404 as an unknown one, and the accept cannot be replayed across refs.
  // The pre-read deliberately ignores expiry: a LAPSED pending invite must still
  // reach `acceptInvite` so the plan's 409 `invite.expired` (and its terminal
  // flip) answers instead of a 404. `acceptInvite` owns the rest of the
  // classification — login mismatch → not_found (404), terminal → 410.
  const invite = await getInviteInWorkspace(db, tenant.workspaceId, inviteId);
  if (!invite) return await tenantNotFound(c);

  const outcome = await acceptInvite(db, inviteId, user.github_login, new Date().toISOString());
  switch (outcome.kind) {
    case "accepted":
      return inviteMutationResponse(c, `ok ${outcome.role}`, 200);
    case "expired":
      return inviteMutationResponse(c, "invite.expired", 409);
    case "gone":
      return inviteMutationResponse(c, "invite is no longer pending", 410);
    case "not_found":
      return await tenantNotFound(c);
  }
};

/**
 * Remove a member from this workspace (`owner`/`admin`; AC5 table).
 * The role boundary is checked on the TARGET's workspace role: an `admin` may
 * only remove a plain `member` — an `owner` or another `admin` is 403, even
 * when that owner is the last one (the 403 answers before any 409 could).
 * Removing a non-member of this workspace is 404 — the same answer an unknown
 * id gets.
 *
 * Self-removal is refused (400: a manager must not lock themselves out), but
 * the last-owner conflict answers FIRST — the plan pins 409 for an `owner`
 * removing or demoting the last owner, and the sole owner is exactly the actor
 * who reaches themselves. Both refusals write nothing; the store's conditional
 * delete still owns the peer case (409, zero writes).
 */
const memberRemoveRoute = async (c: DashboardContext) => {
  const gate = await requireAdmin(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const userId = typeof form.userId === "string" ? form.userId : "";
  const target = await getWorkspaceMember(gate.db, gate.scope.workspaceId, userId);
  if (!target) {
    return inviteMutationResponse(c, "unknown member", 404);
  }
  // The sole-owner conflict answers FIRST. An `owner` removing the last owner
  // is necessarily removing themselves, so without this order the generic
  // self-removal 400 would make the plan's 409 unreachable. An `admin` never
  // reaches this branch: the role boundary below answers 403 for any owner
  // target, the last one included.
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
  // An `admin` may not remove an `owner` or another `admin`. An `owner` may
  // remove an `owner` only when they are not the sole one — that is the store's
  // 409, so the role boundary here stops at the admin case.
  if (gate.scope.role === "admin" && target.role !== "member") {
    return c.html(forbiddenPage(gate.session.login, requestLocale(c)), 403);
  }
  if (!(await deleteWorkspaceMember(gate.db, gate.scope.workspaceId, target.id))) {
    return inviteMutationResponse(c, "Cannot remove the last owner.", 409);
  }
  return inviteMutationResponse(c, "ok", 200);
};

/**
 * Change a member's workspace role (`owner`-only; AC5 table), including
 * promotion to `owner` — that promotion IS the ownership-transfer path, so
 * there is no separate transfer route.
 *
 * An `admin` may not change any role (403, including a target that is the last
 * owner: the role boundary answers 403, never the 409). The sole-owner demotion
 * refusal is the store's 0-row update (409, zero writes) for a peer owner and,
 * at this level, for the actor demoting THEMSELVES while sole owner — the store
 * predicate cannot tell who the actor is.
 */
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
    // Self-demotion, refused only while the actor is the sole owner. The store
    // predicate cannot see WHO is acting — it refuses a sole-owner demotion
    // whoever asks — so the actor-aware answer lives here, and its body is what
    // pins this check (a store refusal answers the generic last-owner text).
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

// --- Support reads (plan 99) ---
//
// Two faces, both `read` in the route table so a granted platform operator
// reaches them and nothing else:
//   - `/api/support/workspace` — the operator's read-only view: the four
//     `workspaces` fields, each member's login + role, and the active grants.
//     Operators ONLY: a member reads the same facts through the ordinary
//     members face, so this one refuses them (AC2 fixes its exact field set).
//   - `/api/support/grants` — the members' undismissable notice data (operator
//     login, `reason`, `expires_at`). Every member sees the whole set; a
//     granted operator reading this same path sees only their own grant.
// A granted operator never reaches a member-only handler: the gate refuses
// every write-classified route before any body runs (AC3).
//
// A grant on this workspace can belong to another operator, so the grant list
// is projected to the CALLER's own row on both operator-reachable faces: AC2
// describes the single grant that opened this window, not the workspace's
// other operators' logins and reasons.

/**
 * An operator sees only their own grant (AC2); the member notice keeps the
 * whole set (AC4). The grant row's compare is NOCASE, so match it the same way.
 */
const onlyOwnGrant = <T extends { operator_login: string }>(rows: T[], login: string): T[] =>
  rows.filter((row) => row.operator_login.toLowerCase() === login.toLowerCase());

const supportWorkspaceRoute = async (c: DashboardContext) => {
  const tenant = c.get("tenant");
  const db = dashboardD1(c.env);
  if (!tenant || tenant.workspaceId === null || !db) return await tenantNotFound(c);
  if (tenant.principal !== "operator-granted") {
    // A member has the ordinary member/App faces for this data, so this one is
    // not theirs; everyone the gate did not classify as a member gets the same
    // 404 an outsider does (no grant state leaks either way).
    return tenant.principal === "member"
      ? c.json({ error: "forbidden" }, 403)
      : await tenantNotFound(c);
  }
  const workspace = await getWorkspaceByRef(db, tenant.ref);
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

/**
 * The active grants on this workspace — the member notice, and the same fact
 * for a granted operator (the read ceiling admits this path). Every member
 * reads it; an outsider is the tenant 404. It answers an empty list rather
 * than 404 for a member, so the shell renders no notice.
 */
const supportGrantsRoute = async (c: DashboardContext) => {
  const tenant = c.get("tenant");
  const db = dashboardD1(c.env);
  if (!tenant || !db) return await tenantNotFound(c);
  let workspaceId: string | null;
  /** Set for the operator face: only their own grant is theirs to see. */
  let ownLogin: string | null = null;
  if (tenant.principal === "operator-granted") {
    workspaceId = tenant.workspaceId;
    ownLogin = c.get("authUser")?.github_login ?? null;
  } else {
    const member = await requireMember(c);
    if (!member.ok) return member.response;
    workspaceId = member.scope?.workspaceId ?? null;
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

/** Rows per audit read when the caller names no `limit`. */
const AUDIT_DEFAULT_LIMIT = 50;
const AUDIT_MAX_LIMIT = 200;

/**
 * The workspace's audit rows — `owner`/`admin` only (a plain `member` gets the
 * members-family 403, an outsider the tenant 404, and a granted operator the
 * gate's 403). Read-only by construction: the store exports no update or
 * delete path, so no caller can rewrite history.
 */
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

// --- Workspace settings: the owner-editable slug ---
//
// The path segment IS the workspace's public identity, so only the OWNER may
// rewrite it (owner-only, unlike the App settings family's owner-or-admin): a
// slug change kills every shared link that used the old value — there is no
// redirect (plan 98 D8), so this is a workspace-wide decision.
const WORKSPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;

/** English faces for the store's two 409 guards; the SPA keys its copy on `code`. */
const SLUG_CONFLICT_KEYS = {
  slug_taken: "workspace.slugTaken",
  slug_is_workspace_id: "workspace.slugIsWorkspaceId",
} as const;

/**
 * `PUT /:workspaceRef/api/settings/slug` — validate, then the store's single
 * guarded UPDATE. The shape gate and the reserved set run BEFORE the write
 * (they need no row read); the store answers the two 409 conflicts, and a
 * concurrent write that slips past its guards lands on the slug UNIQUE index,
 * which the store maps to the same 409 rather than a 500. A target row that
 * vanished between the member gate and the UPDATE is the same 404 an unknown
 * ref gets — never a mislabelled conflict.
 */
const workspaceSlugRoute = async (c: DashboardContext) => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;
  // `workspaceOnly` guarantees a tenant, but a request whose ref did not
  // resolve has no workspace to rename — the same 404 as an unknown ref.
  if (!member.scope) return await tenantNotFound(c);
  if (member.scope.role !== "owner") {
    // Same split as the members family: a navigation gets the rendered denial,
    // a fetch the bare status the SPA parses.
    return wantsHtml(c.req.header("Accept") ?? null)
      ? c.html(forbiddenPage(member.session.login, requestLocale(c)), 403)
      : c.json({ error: "forbidden" }, 403);
  }
  let slug = "";
  try {
    const body = (await c.req.json()) as { slug?: unknown };
    slug = typeof body.slug === "string" ? body.slug : "";
  } catch {
    // malformed body → the shape gate's 400, never a 500
  }
  if (!WORKSPACE_SLUG_PATTERN.test(slug)) {
    return c.json(
      { key: "workspace.slugInvalid", message: t("en", "workspace.slugInvalid") },
      400,
    );
  }
  if (RESERVED_WORKSPACE_SLUGS.has(slug)) {
    return c.json(
      { code: "slug_reserved", message: t("en", "workspace.slugReserved") },
      409,
    );
  }
  const conflict = await setWorkspaceSlug(member.db, member.scope.workspaceId, slug);
  if (conflict === "workspace_not_found") return await tenantNotFound(c);
  if (conflict !== null) {
    return c.json({ code: conflict, message: t("en", SLUG_CONFLICT_KEYS[conflict]) }, 409);
  }
  return c.json({ slug });
};

// --- Apps list + per-App management (spec § Multi-App 契约,
// Clarify #6, architect-pinned POST action paths) ---
//
// The per-request guard above has already verified membership on every route
// here; the route-local gate re-resolves the acting row per request (same
// pattern as the members routes). List = every member; disable/enable/
// soft-delete = the App creator or any admin (invite-only team trust model).
// POSTs ride the existing session cookie (same discipline as the members
// routes) — no new token scheme. Routes are the pinned action-path POSTs:
// the zero-JS `<form method="post">` convention cannot emit a DELETE verb.

/** Route-local member gate shared by the /dashboard/apps routes. */
async function requireMember(c: DashboardContext): Promise<
  | {
      ok: true;
      session: SessionPayload;
      db: DashboardDb;
      user: DashboardUserRow;
      /** Workspace scope on a strict workspace path; null on the legacy face. */
      scope: WorkspaceScope | null;
    }
  | { ok: false; response: Response }
> {
  const secrets = dashboardSecrets(c.env);
  if (!secrets) return { ok: false, response: c.text("dashboard OAuth is not configured", 500) };
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secrets.sessionSecret);
  if (!session) return { ok: false, response: c.redirect("/dashboard/login", 302) };
  const db = dashboardD1(c.env);
  if (!db) return { ok: false, response: c.text("dashboard storage is not configured", 500) };
  const user = await getUserByLogin(db, session.login);
  // Fail closed: no row (removed between guard and here) → 403, the 403 view
  // carries zero membership data.
  if (!user) return { ok: false, response: c.html(forbiddenPage(session.login, requestLocale(c)), 403) };
  // The workspace resolution itself is the workspace-scope middleware's job
  // (ordering-contract step 3). This gate only turns its verdict into the
  // route shape: no scope on a workspace path IS the outsider 404 — the same
  // surface an unknown workspace answers, so there is no existence oracle.
  const tenant = c.get("tenant");
  if (!tenant) return { ok: true, session, db, user, scope: null };
  const scope = c.get("workspaceScope") ?? null;
  if (scope === null || tenant.principal !== "member") {
    return { ok: false, response: await tenantNotFound(c) };
  }
  return { ok: true, session, db, user, scope };
}

/**
 * Manage = workspace owner/admin on a scoped request; without a scope the
 * pre-workspace rule stands (any admin, or the App's creator, case-insensitive)
 * so the `off` face keeps today's decision exactly.
 */
function canManageApp(
  user: DashboardUserRow,
  app: GithubAppRow,
  scope: WorkspaceScope | null = null,
): boolean {
  if (scope) return scope.role === "owner" || scope.role === "admin";
  return user.role === "admin" || app.created_by.toLowerCase() === user.github_login.toLowerCase();
}

/**
 * The App store for one request: a workspace path reads through the strict
 * tenant face (an orphan App is invisible), the legacy path keeps `off`
 * byte-identical.
 */
function requestAppsStore(db: DashboardDb, scope: WorkspaceScope | null) {
  return createAppsStore(db, scope === null ? "off" : "strict");
}

/**
 * Resolve the App addressed by an App route. A workspace path requires the
 * App's own workspace to match the request's: an App from another workspace is
 * exactly as invisible as an unknown slug (404), and a soft-deleted row stays
 * invisible on both faces.
 */
async function resolveScopedApp(
  apps: ReturnType<typeof createAppsStore>,
  slug: string,
  scope: WorkspaceScope | null,
): Promise<GithubAppRow | null> {
  const app = await apps.getAppBySlug(slug);
  if (!app || app.deleted_at !== null) return null;
  if (scope && app.workspace_id !== scope.workspaceId) return null;
  return app;
}

/**
 * The Apps list with the health column data (AL-20-2): every row
 * carries its deliverySummary (the App's LATEST webhook_deliveries row +
 * the 24h rejected count). The health column reads webhook_deliveries —
 * NOT the github_apps.last_webhook_at column, which stays the L5 "last
 * verified delivery" stamp (display-only, no computed health).
 *
 * The summaries come from the store's BATCHED deliverySummaries face
 * (QC wave 1, W-1): exactly TWO D1 statements for any N instead
 * of the per-App 2N fan-out — this helper runs on GET /api/apps (the SPA
 * JSON face), so the statement count must not scale with the App count.
 * A workspace path lists only its own workspace's Apps.
 * shortcut: tenant filter runs over the strict list in memory (single-tenant
 * scale today); upgrade to a workspace-filtered store query when a workspace
 * can hold enough Apps for the scan to matter.
 */
async function appsListWithHealth(
  apps: ReturnType<typeof createAppsStore>,
  scope: WorkspaceScope | null,
): Promise<Array<GithubAppRow & { health: DeliverySummary }>> {
  const rows = (await apps.listApps()).filter(
    (app) => scope === null || app.workspace_id === scope.workspaceId,
  );
  const summaries = await apps.deliverySummaries(rows.map((app) => app.id));
  return rows.map((app) => ({ ...app, health: summaries[app.id]! }));
}

/** SPA JSON face — same requireMember gate and appsListWithHealth assembly as the retired GET /apps. Encrypted columns and row PKs stay off the payload. */
const appListRoute = async (c: DashboardContext) => {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const rows = await appsListWithHealth(requestAppsStore(gate.db, gate.scope), gate.scope);
  return c.json({
    viewer: { login: gate.user.github_login, role: gate.user.role },
    apps: rows.map((app) => ({
      slug: app.slug,
      github_app_id: app.github_app_id,
      status: app.status,
      review_enabled: app.review_enabled,
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
    })),
  });
};

/**
 * One handler for the three pinned action routes. Unknown and soft-deleted
 * apps are equally invisible (the list never shows them) → 404, zero writes.
 * The Apps list is SPA-owned, so the response is a plain 2xx the
 * SPA's postForm treats as success (it refetches the JSON face); the
 * re-rendered HTML page is retired. The store write still happens exactly
 * once; the `changed` result only shaped the retired notice copy.
 */
async function appStatusAction(
  c: DashboardContext,
  action: "disable" | "enable" | "delete",
): Promise<Response> {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const apps = requestAppsStore(gate.db, gate.scope);
  const app = await resolveScopedApp(apps, c.req.param("slug") ?? "", gate.scope);
  if (!app) return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404);
  if (!canManageApp(gate.user, app, gate.scope)) return c.html(forbiddenPage(gate.session.login, requestLocale(c)), 403);
  if (action === "delete") {
    await apps.softDeleteApp(app.id);
  } else {
    await apps.setAppStatus(app.id, action === "disable" ? "disabled" : "active");
  }
  return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "ok");
}

// --- Per-App review pause/resume (spec § IA, pinned action
// paths) ---
//
// The per-App pause switch (migration 0008 review_enabled) surfaced on the
// pinned zero-JS action paths — both the settings-page Review switch and the
// Apps-list actions POST here (spec § IA). Gate/order mirror appStatusAction
// exactly: the per-request guard has verified membership, then unknown and
// soft-deleted apps are equally invisible (→ 404, zero writes), then
// creator-or-admin (→ 403 forbiddenPage, zero writes). Confirm-free and
// reversible (pause ≠ disable — the webhook face stays healthy while
// paused). The response is plain 200 "ok"; the SPA refetches
// the JSON face rather than re-rendering HTML.

/**
 * HTML-nav 302 target for pause/resume. Settings is the only native-form
 * caller (`<form method="post">` on the Review card); Apps-list uses fetch
 * `postForm`. Origin is a sanitized Referer pathname — never echoed as
 * Location. Settings-origin → `/dashboard/apps/:slug/settings` (DB slug);
 * apps-list origin → `/dashboard/apps`; anything else → `/dashboard`. On a
 * workspace-scoped request both App targets carry that workspace's prefix
 * (`scopedAppPath`), because the legacy App family 404s under `strict`.
 */
function reviewActionRedirect(c: DashboardContext, slug: string): string {
  const settingsPath = scopedAppPath(c, `/dashboard/apps/${slug}/settings`);
  const listPath = scopedAppPath(c, APPS_LIST_REDIRECT);
  const origin = new URL(c.req.raw.url).origin;
  const refererPath = new URL(safeLocaleRedirect(c.req.header("Referer"), origin), origin).pathname;
  if (refererPath === settingsPath) return settingsPath;
  if (refererPath === listPath) return listPath;
  return DASHBOARD_SHELL_REDIRECT;
}

/**
 * One handler for the two pinned review-action routes. The idempotent no-op
 * case is short-circuited BEFORE the store write — pausing a paused App /
 * resuming an active one never touches the row (setReviewEnabled would
 * count a same-value UPDATE as changed and would churn updated_at, the
 * operator-mutation timestamp). The response is a plain 2xx the
 * SPA's postForm treats as success (it refetches the JSON face); the
 * re-rendered HTML page is retired. QC round 2: HTML-nav 302 target
 * depends on origin (settings vs apps list); fetch is unchanged.
 */
async function appReviewAction(
  c: DashboardContext,
  action: "pause" | "resume",
): Promise<Response> {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const apps = requestAppsStore(gate.db, gate.scope);
  const app = await resolveScopedApp(apps, c.req.param("slug") ?? "", gate.scope);
  if (!app) return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404);
  if (!canManageApp(gate.user, app, gate.scope)) return c.html(forbiddenPage(gate.session.login, requestLocale(c)), 403);
  const htmlRedirect = reviewActionRedirect(c, app.slug);
  const paused = app.review_enabled === 0;
  if (action === "pause" ? paused : !paused) return pinnedPostMutationResponse(c, htmlRedirect, "ok"); // idempotent no-op — never touch the row
  await apps.setReviewEnabled(app.id, action === "resume");
  return pinnedPostMutationResponse(c, htmlRedirect, "ok");
}


// --- Per-App review trigger mode (spec review-trigger-policy §2, pinned
// action path beside pause/resume) ---
//
// The App's auto-trigger selection: 'open' (first open only) |
// 'every_push' (opened + synchronize + reopened — today's behavior, the DDL
// default) | 'manual' (never auto-review). The bot-mention comment trigger
// is orthogonal and works in every mode (spec §3). Gate/order mirror
// appReviewAction exactly: the per-request guard has verified membership,
// then unknown and soft-deleted apps are equally invisible (→ 404, zero
// writes), then creator-or-admin (→ 403 forbiddenPage, zero writes). The
// mode is validated BEFORE any write — an unknown/invalid value fails
// closed with the keyed settings 400 and the stored row is left unchanged
// (no silent coercion to the default, spec §2); the store setter throws as
// the backstop for direct callers. Success is the plain 2xx "ok" the SPA's
// postForm treats as success (it refetches the JSON face); HTML-nav keeps
// the pinned 302 to the settings page via settingsPostResponse — this
// control lives on the settings page only, so unlike pause/resume the
// target is fixed, not referer-derived.

/** True exactly when `value` is a migration 0022 vocabulary mode. */
function isReviewTriggerMode(value: string): value is ReviewTriggerMode {
  return (REVIEW_TRIGGER_MODES as readonly string[]).includes(value);
}

/**
 * One handler for the pinned review-trigger-mode route. The idempotent
 * no-op case is short-circuited BEFORE the store write — selecting the
 * already-stored mode never touches the row (a same-value UPDATE would
 * churn updated_at, the operator-mutation timestamp — the appReviewAction
 * discipline).
 */
async function appReviewTriggerModeAction(c: DashboardContext): Promise<Response> {
  const gate = await requireMember(c);
  if (!gate.ok) return gate.response;
  const apps = requestAppsStore(gate.db, gate.scope);
  const app = await resolveScopedApp(apps, c.req.param("slug") ?? "", gate.scope);
  if (!app) return pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404);
  if (!canManageApp(gate.user, app, gate.scope)) return c.html(forbiddenPage(gate.session.login, requestLocale(c)), 403);
  const form = await c.req.parseBody();
  const mode = typeof form["mode"] === "string" ? form["mode"] : "";
  if (!isReviewTriggerMode(mode)) {
    return settings400Response(c, app.slug, SETTINGS_400_KEYS.triggerModeUnknown, { mode });
  }
  if (app.review_trigger_mode !== mode) {
    await apps.setReviewTriggerMode(app.id, mode);
  }
  return settingsPostResponse(c, app.slug, "ok");
}

// --- Per-App AI configuration settings (spec § Per-App BYOK) ---
//
// The settings family for one App: provider API keys (BYOK, masked list) and
// the model chain. Authorization = the same canManageApp rule as the status
// actions above (owner-or-admin, Clarify #6); unknown/soft-deleted App → 404;
// the per-request guard has already verified membership. POSTs ride the
// session cookie (same discipline as the members and apps action routes — no
// new token scheme). Route shapes per the plan brief: GET/POST
// /dashboard/apps/:slug/settings — the POST carries an explicit `op`
// discriminator (add-key | save-chain | save-roles) because the zero-JS page
// has three forms on one action path — and the delete-key action path
// …/settings/key/delete (the HTML-form convention cannot emit a DELETE verb).
//
// Encryption-dependent reads AND writes: masking needs plaintext (the last-4
// tail), so a missing/malformed DASHBOARD_ENCRYPTION_KEY fails the whole
// family closed with 5xx (spec § Crypto envelope) — never a partial page,
// never a stored key. The settings page is SPA-owned (the JSON
// face below serves the SPA); the DESIGN-token appSettingsPage view in
// src/dashboard/views.ts is retired.

type AppSettingsGate =
  | {
      ok: true;
      session: SessionPayload;
      db: DashboardDb;
      app: GithubAppRow;
      user: DashboardUserRow;
      scope: WorkspaceScope | null;
    }
  | { ok: false; response: Response };

/**
 * (spec §2 read face): any member may load the App detail data face — the
 * non-manager payload is the identity-only set; the full base+health and
 * settings payloads (masked keys, chains, providers) stay creator-or-admin
 * via the GET handler's canManageApp branch below; writes go through
 * requireAppSettings.
 */
async function requireAppVisible(c: DashboardContext): Promise<AppSettingsGate> {
  const member = await requireMember(c);
  if (!member.ok) return member;
  const app = await resolveScopedApp(
    requestAppsStore(member.db, member.scope),
    c.req.param("slug") ?? "",
    member.scope,
  );
  if (!app) return { ok: false, response: pinnedPostMutationResponse(c, DASHBOARD_SHELL_REDIRECT, "unknown app", 404) };
  return { ok: true, session: member.session, db: member.db, app, user: member.user, scope: member.scope };
}

/**
 * Route-local owner-or-admin gate shared by the settings WRITE family.
 * Encryption-dependent because masking needs plaintext — a missing master key
 * still fails closed with 5xx (spec § Crypto envelope).
 */
async function requireAppSettings(c: DashboardContext): Promise<AppSettingsGate> {
  const gate = await requireAppVisible(c);
  if (!gate.ok) return gate;
  if (!canManageApp(gate.user, gate.app, gate.scope)) {
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

/** Same structured-log convention as logOAuthFailure / logManifestFailure. */
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

/** 500 fail-closed message: key misconfiguration vs storage rejection (commit-route copy style). */
function settingsFailureNotice(err: unknown): string {
  return err instanceof SecretboxKeyError
    ? "This deployment has no valid DASHBOARD_ENCRYPTION_KEY for its stored keys — ask the operator to configure it, then resubmit."
    : "The dashboard database rejected the change — nothing was stored. You can resubmit.";
}

/**
 * The App-selected-image eligibility gate — ONE derivation shared
 * by the settings display face (provider_catalog eligibility stamping) and
 * the add-key/verify POST prechecks, so the UI and the server-side precheck
 * can never disagree. Fail-closed: an unknown image id yields an undefined
 * runtime → not omp → every provider row unavailable / every provider
 * ineligible. Deliberately mirrors the display predicate only — `enabled` is
 * the save-sandbox-image route's value domain and stays outside this gate.
 */
function isOmpRuntimeImage(sandboxImageId: string): boolean {
  return getSandboxImage(sandboxImageId)?.runtime === "omp";
}

/**
 * Plain-text settings POST response (the settings page is
 * SPA-owned and read-only today — its forms POST here; the pinned POST
 * paths keep their full validation and mutation, and answer the SPA's
 * postForm contract: 2xx → refetch the JSON face, 4xx/5xx → client error).
 * The family's 400s moved to settings400Response (keyed JSON),
 * so this helper now carries only the 2xx faces and the
 * settingsFailureNotice 500s.
 */
function settingsPostResponse(
  c: DashboardContext,
  slug: string,
  message: string,
  status: 200 | 500 = 200,
): Response {
  return pinnedPostMutationResponse(c, `/dashboard/apps/${slug}/settings`, message, status);
}

/**
 * A REMOVE route's 2xx face. Native form navigation keeps the pinned 302;
 * every other caller gets `{ changed, message }`, because the tolerant no-op
 * (nothing matched — a stale dialog's row was already gone) and a real removal
 * are both 2xx and the SPA must not render "Changes saved." for the former.
 * `message` keeps the English face the plain-text assertions pin.
 */
function settingsRemoveResponse(
  c: DashboardContext,
  slug: string,
  changed: boolean,
  message: string,
): Response {
  if (wantsHtmlFormNavigation(c)) {
    return c.redirect(scopedAppPath(c, `/dashboard/apps/${slug}/settings`), 302);
  }
  return c.json({ changed, message }, 200);
}

/**
 * (audit UI-45-03): machine-readable 400 keys for the settings
 * POST family — ONE inventory of the site→key mapping. Values are
 * `settings.error.*` dictionary paths; settings400Response interpolates the
 * English face from the same dictionary entry, so a mapped 400 body is
 * `{ key, message, params? }` — `message` keeps the English face (the
 * existing English-substring pins and any non-resolving consumer),
 * `params` carries the interpolation data the SPA replays via t() in the
 * operator's locale.
 */
const SETTINGS_400_KEYS = {
  providerRequired: "settings.error.providerRequired",
  providerUnknown: "settings.error.providerUnknown",
  providerUnavailableOnImage: "settings.error.providerUnavailableOnImage",
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
  sandboxImageUnknown: "settings.error.sandboxImageUnknown",
  triggerModeUnknown: "settings.error.triggerModeUnknown",
  unknownOperation: "settings.error.unknownOperation",
} as const satisfies Record<string, DictionaryKey>;

/**
 * Keyed 400 for the settings POST family: native `<form>`
 * navigation keeps the pinned-POST contract — 302 to the settings page, the
 * body is never seen; the SPA's postForm fetch gets the keyed JSON face
 * (`message` = the en dictionary face, so existing English-substring pins
 * keep passing; `params` = the interpolation data for the SPA's t()).
 */
function settings400Response(
  c: DashboardContext,
  slug: string,
  key: DictionaryKey,
  params?: Record<string, string | number>,
): Response {
  if (wantsHtmlFormNavigation(c)) {
    return c.redirect(scopedAppPath(c, `/dashboard/apps/${slug}/settings`), 302);
  }
  return c.json({ key, message: t("en", key, params), ...(params ? { params } : {}) }, 400);
}

/**
 * The pool-bound rejection (`MAX_KEYS_PER_PROVIDER`, thrown by the store when a
 * NEW key would exceed the (App, provider) pool) as the keyed 400 the SPA
 * replays in the operator's locale. ONE mapping shared by every settings path
 * that stores a key, so the cap can never surface as a generic 500.
 */
function settingsKeyLimitResponse(
  c: DashboardContext,
  slug: string,
  provider: string,
): Response {
  return settings400Response(c, slug, SETTINGS_400_KEYS.providerKeyLimit, {
    provider,
    limit: MAX_KEYS_PER_PROVIDER,
  });
}

function mapVerifyReason(
  reason: VerifyFailureReason,
): "invalid_key" | "unreachable" | "unexpected" | "unsupported_provider" {
  if (reason === "invalid_key" || reason === "unreachable" || reason === "unsupported_provider") return reason;
  return "unexpected";
}
function verifyFailCopy(reason: ReturnType<typeof mapVerifyReason>): string {
  if (reason === "invalid_key") return "That API key was rejected by the provider — nothing was stored.";
  if (reason === "unreachable") return "The provider could not be reached — nothing was stored.";
  if (reason === "unsupported_provider") {
    return "This provider can't be verified here — manage the key in the provider console. Nothing was stored.";
  }
  return "The provider returned an unexpected response — nothing was stored.";
}

/** 400 for a verify miss: JSON `{ ok, reason, message }` so the SPA maps `reason` via t(); `message` keeps the English face for native posts. */
function settingsVerifyFailResponse(
  c: DashboardContext,
  slug: string,
  reason: VerifyFailureReason,
): Response {
  const mapped = mapVerifyReason(reason);
  const message = verifyFailCopy(mapped);
  if (wantsHtmlFormNavigation(c)) {
    return c.redirect(scopedAppPath(c, `/dashboard/apps/${slug}/settings`), 302);
  }
  return c.json({ ok: false, reason: mapped, message }, 400);
}

function membershipFailCopy(selector: string): string {
  return `Selector ${selector} is not in this App's verified models.`;
}

const MEMBERSHIP_FAIL_CODE = "not_in_verified_models" as const;

/** 400 for a membership miss: JSON `{ code, message, selector }` so the SPA maps `code` via t(); `message` keeps the English face for native posts. */
function settingsMembershipFailResponse(
  c: DashboardContext,
  slug: string,
  selector: string,
): Response {
  const message = membershipFailCopy(selector);
  if (wantsHtmlFormNavigation(c)) {
    return c.redirect(scopedAppPath(c, `/dashboard/apps/${slug}/settings`), 302);
  }
  return c.json({ code: MEMBERSHIP_FAIL_CODE, message, selector }, 400);
}

/**
 * (AD-531): the settings read path's lazy GitHub-metadata refresh —
 * the ONLY writer of the migration-0019 profile columns (via the single store
 * entry saveGithubMetadata). Runs at most once per request and only when the
 * cached profile is missing or outside the 24h TTL; the leg is
 * decrypt (the per-App secretbox envelope, AAD = the createApp convention) →
 * mint App JWT → GET /app → persist, with every failure mode optional:
 *   - a missing DASHBOARD_ENCRYPTION_KEY skips the refresh silently (the
 *     architect watch item: the cached profile is a read-path extra, so the
 *     non-manager face must never 500 for its sake — the manage branch keeps
 *     its existing fail-closed 500 for its OWN decryption needs below);
 *   - `{ok:false}` from the fetch (network, timeout, bad key format, non-200)
 *     keeps the cached columns untouched and emits one secret-free structured
 *     warn (stage + app id — the fetch collapses failure reasons by design);
 *   - a decrypt throw (corrupt envelope / SecretboxKeyError) or a store
 *     rejection is swallowed by the leg's own catch-all and logged via the
 *     logSettingsFailure convention (error type only — never the PEM, JWT,
 *     or any header material).
 * Fail-open BY STRUCTURE: this function never throws and returns the row to
 * serve — re-read fresh after a SUCCESSFUL persist so the payload carries the
 * values actually in D1, the caller's row otherwise (a failed refresh wrote
 * nothing, so the re-read is skipped) — so the refresh can never enter the
 * route's outer 500 face (AD-531).
 */
async function refreshGithubMetadataForRead(
  app: GithubAppRow,
  apps: ReturnType<typeof createAppsStore>,
  encryptionKey: string | undefined,
): Promise<GithubAppRow> {
  try {
    if (!isGithubMetadataStale(app.github_metadata_synced_at)) return app;
    if (!encryptionKey) return app;
    const decryptedPem = await createSecretbox(encryptionKey).decryptSecret(
      app.private_key_enc,
      `github_apps.private_key_enc:${app.id}`,
    );
    const result = await fetchAppMetadata(app.github_app_id, decryptedPem);
    if (result.ok) {
      await apps.saveGithubMetadata(app.id, result.metadata);
      const fresh = await apps.getAppById(app.id);
      if (fresh) return fresh;
    } else {
      // Secret-free structured warn (the logSettingsFailure shape): no error
      // object exists here — fetchAppMetadata collapses every failure class
      // into the reason-less `{ok:false}` on purpose.
      console.warn(
        JSON.stringify({ event: "dashboard_settings", stage: "github_metadata_fetch", app_id: app.id }),
      );
    }
  } catch (err) {
    // Fail-open: the cached columns serve as-is (metadata is display-only) —
    // but the failure stays observable, secret-free.
    logSettingsFailure("github_metadata_refresh", app.id, err);
  }
  return app;
}

/** SPA JSON face (spec §2 read face): any member can load the face, but the
 * payload splits on `canManageApp` — a non-manager gets the identity-only
 * set (list-face fields + created_at + the cached public GitHub profile)
 * with `can_manage: false`; a manager gets the full base+health payload
 * (app meta, installations, deliveries) plus the settings payload (masked
 * keys, chains, providers). Writes stay behind requireAppSettings. Both
 * faces are served from D1 after the lazy 24h-TTL refresh above. */
const appSettingsRoute = async (c: DashboardContext) => {
  const gate = await requireAppVisible(c);
  if (!gate.ok) return gate.response;
  const apps = requestAppsStore(gate.db, gate.scope);
  // Outside the render try on purpose: the refresh leg carries its own
  // catch-all, so no metadata failure can reach this route's 500 face
  // (AD-531 fail-open by structure).
  const app = await refreshGithubMetadataForRead(gate.app, apps, c.env.DASHBOARD_ENCRYPTION_KEY);
  try {
    c.header("Cache-Control", "private, no-store");
    if (!canManageApp(gate.user, gate.app, gate.scope)) {
      // Identity-only non-manager face: the D4 identity set — the fields the
      // GET /api/apps list rows already expose (slug, github_app_id, status,
      // review_enabled, created_by) plus created_at and the cached public
      // GitHub profile. Everything from the ops stores (installations,
      // deliveries, sandbox_image_id, review-trigger runtime config) stays
      // behind the canManageApp branch below. `can_manage: false` is the
      // discrimination the SPA's detail-face parse keys on.
      return c.json({
        can_manage: false,
        app: {
          slug: app.slug,
          github_app_id: app.github_app_id,
          status: app.status,
          review_enabled: app.review_enabled !== 0,
          created_by: app.created_by,
          created_at: app.created_at,
          github_name: app.github_name ?? null,
          github_description: app.github_description ?? null,
          github_html_url: app.github_html_url ?? null,
          github_avatar_url: app.github_avatar_url ?? null,
          github_metadata_synced_at: app.github_metadata_synced_at ?? null,
        },
      });
    }
    const installations = await apps.listInstallations(app.id);
    const deliveries = await apps.listRecentDeliveries(app.id, 5);
    const deliverySummary = await apps.deliverySummary(app.id);
    const base = {
      app: {
        slug: app.slug,
        github_app_id: app.github_app_id,
        status: app.status,
        review_enabled: app.review_enabled !== 0,
        created_by: app.created_by,
        last_webhook_at: app.last_webhook_at ?? null,
        // (spec § Technical interfaces): the App's selected sandbox
        // runtime image — read-only on BOTH faces (registry id only, never
        // image-local configuration or secrets).
        sandbox_image_id: app.sandbox_image_id,
        // The App's review trigger mode (spec review-trigger-policy §2,
        // read face the SPA's mode control consumes) — vocabulary-checked
        // by the column's CHECK enum, so the wire value is always one of
        // open | every_push | manual.
        review_trigger_mode: app.review_trigger_mode,
        // The cached public GitHub profile (migration 0019) —
        // every field nullable (NULL = never synced / absent upstream, the
        // old-row degradation) and present on BOTH faces (AC3: the
        // non-manager payload carries them too). Public profile fields only —
        // the PEM / webhook-secret envelopes never leave the row.
        github_name: app.github_name ?? null,
        github_description: app.github_description ?? null,
        github_html_url: app.github_html_url ?? null,
        github_avatar_url: app.github_avatar_url ?? null,
        github_metadata_synced_at: app.github_metadata_synced_at ?? null,
      },
      installations,
      deliveries: deliveries.map((d) => ({
        event_name: d.event_name,
        outcome: d.outcome,
        status_code: d.status_code,
        created_at: d.created_at,
      })),
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
    };
    if (!c.env.DASHBOARD_ENCRYPTION_KEY) {
      return c.text("the app settings need a configured DASHBOARD_ENCRYPTION_KEY", 500);
    }
    const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
    const maskedKeys = await store.listProviderKeys(gate.app.id);
    const modelChain = await store.getModelChain(gate.app.id);
    const modelChainSeats = await store.getModelChainSeats(gate.app.id);
    const modelChains = await store.getModelChains(gate.app.id);
    const customProviders = await store.listCustomProviders(gate.app.id);
    // The custom/template pools' own masked rows — the declaration list above
    // carries no key material, so without this read a custom provider rendered
    // one declaration row whatever its pool size: no key identity, mask or
    // per-key verification state, and no way to drop one key instead of the
    // whole pool.
    const customKeys = await store.listCustomProviderKeys(gate.app.id);
    const keyRows = [...maskedKeys, ...customKeys];
    // (spec § Provider configuration contract): eligibility is judged
    // against the App's SELECTED runtime image, never an inferred filter. The
    // registry entry's runtime kind is the contract: an omp-selected App
    // consumes builtin entries via env names and materializes templates
    // through the custom-provider machinery; any other runtime would leave
    // every row unavailable (zero such rows today — omp is the only
    // registry entry, and the persisted id is store-validated against it).
    const ompRuntime = isOmpRuntimeImage(gate.app.sandbox_image_id);
    return c.json({
      can_manage: true,
      ...base,
      // Every stored key row of the App — built-in and custom pools alike:
      // the add flow lists a selected provider's rows from this face (a
      // materialized template's pool included), so a custom pool's rows must
      // ride it too.
      keys: keyRows,
      model_chain: modelChain,
      // (spec §4.4): the role editor's data is now seat → chain
      // reference (blank = default chain); the chains list carries every
      // chain (default + named) for the chains management UI.
      model_roles: modelChainSeats,
      model_chains: modelChains,
      // The declaration face of the settings payload keeps its existing shape:
      // `has_keys` is a membership-gate input for the models / chain faces, not
      // a UI field, so it never rides this response (the store read is shared).
      custom_providers: customProviders.map(({ provider_id, base_url, api, model_ids }) => ({
        provider_id,
        base_url,
        api,
        model_ids: [...model_ids],
      })),
      // Clean cutover: the App's PERSISTED provider state only — a stored
      // key (masked tail) or a saved custom-provider declaration. No
      // plaintext keys, and catalog rows never appear here; an empty array is
      // the valid unconfigured-App state. Key rows cover BOTH pools: a custom
      // or template provider's rows are here, each with its own identity, so
      // one key can be removed without removing the declaration.
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
      // Discovery metadata (the retired `providers` dump) plus
      // eligibility vs the App's selected image. Builtin ids in PROVIDER_IDS
      // order, then the template tier (the hand-curated workers-ai entry
      // followed by the snapshot breadth — the catalog's own key order).
      // `verifiable: false` marks the console-only providers (azure-openai /
      // ai-gateway — the old addKeyProviderIds filter); templates verify via
      // the custom probe, so always verifiable.
      // (AD-547): every entry also carries a display-only
      // `display_group` ("common" = the 5-entry 常用提供方 tier, "catalog" =
      // everything else, in both tiers). Array order is unchanged and the
      // field drives ONLY picker grouping — the add/verify/save mechanics
      // keep branching on `tier`/`eligibility`, never on `display_group`.
      provider_catalog: [
        ...PROVIDER_IDS.map((id) => {
          const meta = PROVIDER_META[id];
          if (!meta) throw new Error(`PROVIDER_META missing ${id}`);
          return {
            id,
            label: meta.label,
            tier: meta.tier,
            base_url: meta.baseUrl,
            api: meta.api,
            models: [...meta.models],
            verifiable: PROVIDER_VERIFY_ENDPOINTS[id]?.kind !== "unsupported",
            eligibility: ompRuntime ? meta.tier : "unavailable",
            display_group: PROVIDER_IDS_COMMON.includes(id) ? ("common" as const) : ("catalog" as const),
          };
        }),
        ...Object.entries(PROVIDER_META)
          .filter(([id, meta]) => meta.tier === "template" && !PROVIDER_IDS.includes(id))
          .map(([id, meta]) => ({
            id,
            label: meta.label,
            tier: meta.tier,
            base_url: meta.baseUrl,
            api: meta.api,
            models: [...meta.models],
            verifiable: true,
            eligibility: ompRuntime ? meta.tier : "unavailable",
            display_group: PROVIDER_IDS_COMMON.includes(id) ? ("common" as const) : ("catalog" as const),
          })),
      ],
      model_role_ids: MODEL_ROLE_IDS,
      custom_provider_api_ids: CUSTOM_PROVIDER_API_IDS,
      // (spec § Technical interfaces): the manage face's selector
      // choices — enabled registry entries only, as { id, enabled } rows.
      sandbox_images: enabledSandboxImages().map((image) => ({ id: image.id, enabled: image.enabled })),
    });
  } catch (err) {
    logSettingsFailure("api_render", gate.app.id, err);
    return c.text("the app settings could not be read from encrypted storage", 500);
  }
};

const appModelsRoute = async (c: DashboardContext) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  try {
    const verified = await store.getVerifiedModels(gate.app.id);
    const custom = await store.listCustomProviders(gate.app.id);
    c.header("Cache-Control", "private, no-store");
    return c.json({ groups: composeModelOptions(verified, custom) });
  } catch (err) {
    logSettingsFailure("api_models", gate.app.id, err);
    return c.text("the app models could not be read", 500);
  }
};

/**
 * SPA add-key path: verify the as-typed key, then store. Failure
 * is 400 JSON with a structured reason (invalid_key / unreachable / unexpected /
 * unsupported_provider) and ZERO writes. The key is never logged or returned.
 * An App whose selected runtime image is not omp (unknown id
 * included — fail-closed) is refused with unsupported_provider before any
 * probe, mirroring the display face's eligibility gate.
 */
const appKeyVerifyRoute = async (c: DashboardContext) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const provider = typeof form.provider === "string" ? form.provider.trim() : "";
  const plainKey = typeof form.key === "string" ? form.key.trim() : "";
  if (!PROVIDER_IDS.includes(provider) || plainKey === "" || plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
    return c.json({ ok: false, reason: "unexpected" as const }, 400);
  }
  // A `!`-prefixed key would be run as a shell command by the review
  // runtime's config-value resolver (../contracts/credential-key.ts) — the
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
  // Fail-closed server-side precheck: the App's selected runtime
  // image must carry an omp runtime for ANY provider key to be eligible —
  // the same gate the settings display face stamps into provider_catalog
  // (isOmpRuntimeImage). Unknown image id → not omp → 400. The precheck
  // reuses the existing closed reason enum (no new value;
  // CARRY-2 adds the optional keyed face so the SPA renders the
  // runtime-image copy in the operator's locale); zero writes.
  if (!isOmpRuntimeImage(gate.app.sandbox_image_id)) {
    return c.json(
      {
        ok: false,
        reason: "unsupported_provider" as const,
        key: SETTINGS_400_KEYS.providerUnavailableOnImage,
        message: t("en", SETTINGS_400_KEYS.providerUnavailableOnImage, {
          provider,
          image: gate.app.sandbox_image_id,
        }),
        params: { provider, image: gate.app.sandbox_image_id },
      },
      400,
    );
  }
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  try {
    const verified = await verifyProviderKey({ fetch: globalThis.fetch }, provider, plainKey);
    if (!verified.ok) {
      return c.json({ ok: false, reason: mapVerifyReason(verified.reason) }, 400);
    }
    await store.saveVerifiedKey(gate.app.id, provider, plainKey, verified.models);
    return c.json({ ok: true, provider, models: verified.models });
  } catch (err) {
    logSettingsFailure("verify_key", gate.app.id, err);
    // The pool cap (MAX_KEYS_PER_PROVIDER) is a client-side precondition, not a
    // provider failure: the reason enum stays closed, the keyed face carries
    // the clear message the SPA resolves in the operator's locale.
    if (err instanceof ProviderKeyLimitError) {
      const params = { provider, limit: MAX_KEYS_PER_PROVIDER };
      return c.json(
        {
          ok: false,
          reason: "unexpected" as const,
          key: SETTINGS_400_KEYS.providerKeyLimit,
          message: t("en", SETTINGS_400_KEYS.providerKeyLimit, params),
          params,
        },
        400,
      );
    }
    return c.json({ ok: false, reason: "unexpected" as const }, 500);
  }
};

/**
 * The settings POST: the operations on the pinned action path, discriminated
 * by the forms' hidden `op` field. add-key = provider allowlist (400 on any
 * other id — the allowlist is the plan's Global Constraint) + the
 * selected-image eligibility precheck (a selected image whose
 * runtime is not omp — unknown id included, fail-closed — is a 400 with zero
 * writes, the same gate the display face stamps into provider_catalog) +
 * non-empty key
 * of at most MAX_PROVIDER_KEY_LENGTH characters (input bounds — an
 * oversized key is a 400 with zero writes; the store guard beneath
 * is the backstop), then the store encrypts inside. save-chain = empty →
 * clear the default chain (an unconfigured chain fails that App's reviews
 * closed in the consumer — AL-24-5: no deployment-level
 * chain exists to fall back to), otherwise ≥1 comma-separated selector
 * required and the chain is stored VERBATIM as the 'default' chain row
 * (a `:thinking`-style suffix is legal omp syntax; full selector
 * validation stays omp-side). save-roles (the seat → chain rework) =
 * the Role models editor's full map — one `role_<role>` field per audit
 * seat, blanks = the seat uses the default chain, content = a chain NAME
 * reference, saved through the validate-all-first setModelChainSeats (zero
 * partial writes on any validation failure). add-chain / remove-chain =
 * the named-chains management section: add-chain validates
 * the name grammar (the reserved "default" is rejected) and the selector
 * chain exactly like save-chain; remove-chain deletes the named chain and
 * its seat references atomically (seats fall back to the default chain).
 * add-custom-provider / remove-custom-provider = the
 * custom-provider declarations section: every AL-23-1/AL-23-2 bound (id
 * grammar, https-only baseUrl, three-form api enum, model_ids 1..32 × ≤128,
 * key required ≤4096) is a 400 with zero writes; the key is encrypted
 * inside the store and never echoed. save-sandbox-image = the
 * App's sandbox runtime-image selection: only ENABLED
 * src/contracts/sandbox-images.ts registry ids are storable (unknown or
 * disabled → 400, nothing stored). The settings page is
 * SPA-owned — 2xx = the SPA refetches the JSON face, 4xx/5xx = the reason
 * (400s are keyed JSON via settings400Response — native form
 * posts keep the 302); the re-rendered HTML page is retired.
 */
const appSettingsSaveRoute = async (c: DashboardContext) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  // AL-23-2 (save-roles duplicate fields): parseBody({ all: true }) makes
  // duplicate keys VISIBLE as string[] (Hono 4.13.4 aggregates; the default
  // all=false silently last-wins) — the save-roles branch rejects any
  // array-valued role_* field with 400, and single-value fields keep their
  // exact current behavior.
  const form = await c.req.parseBody({ all: true });
  const op = typeof form.op === "string" ? form.op : "";
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  if (op === "add-key") {
    const provider = typeof form.provider === "string" ? form.provider.trim() : "";
    const plainKey = typeof form.key === "string" ? form.key.trim() : "";
    if (!PROVIDER_IDS.includes(provider)) {
      return provider === ""
        ? settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.providerRequired)
        : settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.providerUnknown, { provider });
    }
    // Fail-closed server-side precheck: the App's selected
    // runtime image must carry an omp runtime for ANY provider key to be
    // eligible — the same gate the settings display face stamps into
    // provider_catalog (isOmpRuntimeImage). Unknown image id → not omp →
    // 400, zero writes. Plain-text family (native/legacy surface only — the
    // SPA's add-key path is verify-first via /keys/verify).
    if (!isOmpRuntimeImage(gate.app.sandbox_image_id)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.providerUnavailableOnImage, {
        provider,
        image: gate.app.sandbox_image_id,
      });
    }
    if (plainKey === "") {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiKeyRequired);
    }
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiKeyTooLong, {
        count: plainKey.length,
        limit: MAX_PROVIDER_KEY_LENGTH,
      });
    }
    // A `!`-prefixed key would be run as a shell command by the review
    // runtime's config-value resolver (../contracts/credential-key.ts) — the
    // same rule the runner's payload decoder enforces fail-closed.
    if (isCommandConfigKey(plainKey)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiKeyCommandPrefix);
    }
    try {
      const verified = await verifyProviderKey({ fetch: globalThis.fetch }, provider, plainKey);
      if (!verified.ok) {
        return settingsVerifyFailResponse(c, gate.app.slug, verified.reason);
      }
      await store.saveVerifiedKey(gate.app.id, provider, plainKey, verified.models);
    } catch (err) {
      logSettingsFailure("add_key", gate.app.id, err);
      if (err instanceof ProviderKeyLimitError) {
        return settingsKeyLimitResponse(c, gate.app.slug, provider);
      }
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Stored the ${provider} key for ${gate.app.slug} — it is only ever shown masked.`,
    );
  }
  if (op === "save-chain") {
    // AL-23-2: a duplicate model_chain field (parseBody all:true aggregates
    // it into an array) must be rejected — never treated as the empty-clear
    // path, which would silently wipe the stored chain.
    if (Array.isArray(form.model_chain)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.chainFieldDuplicated);
    }
    const raw = typeof form.model_chain === "string" ? form.model_chain : "";
    try {
      if (raw.trim() === "") {
        await store.setModelChain(gate.app.id, null);
        return settingsPostResponse(c, gate.app.slug, `Cleared the model chain for ${gate.app.slug} — reviews fail closed until a chain + provider keys are configured (per-App only).`,
        );
      }
      if (raw.length > MAX_MODEL_SELECTOR_LENGTH) {
        return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.chainTooLong, {
          count: raw.length,
          limit: MAX_MODEL_SELECTOR_LENGTH,
        });
      }
      const selectors = parseModelChain(raw);
      if (selectors.length === 0) {
        return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.chainEmpty);
      }
      const failing = findFailingSelector(
        selectors,
        await store.getVerifiedModels(gate.app.id),
        await store.listCustomProviders(gate.app.id),
      );
      if (failing) {
        return settingsMembershipFailResponse(c, gate.app.slug, failing);
      }
      await store.setModelChain(gate.app.id, raw);
    } catch (err) {
      logSettingsFailure("save_chain", gate.app.id, err);
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Saved the model chain for ${gate.app.slug}.`);
  }
  if (op === "save-roles") {
    // The seat → chain editor rework (spec §4.4), F-002 (QC wave):
    // the Role models editor posts one `role_<role>` field per audit seat
    // (the page always renders all four rows, blank inputs included), so
    // the submitted map is FULL — a save MISSING any seat key is a stale
    // or tampered client (omitted seats would silently keep their old
    // reference rows = drift) → 400 naming the absent roles, zero writes.
    // Blanks = the seat uses the default chain (the reference row is
    // cleared), content = a chain NAME reference, all through the
    // validate-all-first setModelChainSeats bulk face. Any `role_`-prefixed
    // field naming a role outside MODEL_ROLE_IDS is client tampering → 400,
    // zero writes; a save with NO role fields at all is equally malformed
    // (it could not come from this page, and an empty map must never
    // masquerade as a successful save).
    const refs: Record<string, string> = {};
    for (const [field, value] of Object.entries(form)) {
      if (!field.startsWith("role_")) continue;
      // AL-23-2: with parseBody({ all: true }) a duplicate role_* field
      // arrives as an ARRAY — explicit 400 rejection (zero
      // writes), never the silent last-wins the default parseBody had.
      if (Array.isArray(value)) {
        return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.roleFieldDuplicated, { field });
      }
      if (typeof value !== "string") continue;
      const role = field.slice("role_".length);
      if (!MODEL_ROLE_IDS.includes(role)) {
        return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.roleUnknown, { role });
      }
      // F-001 (QC): canonicalize BEFORE bind — the known-chain check below
      // and the store's upsert must see the SAME trimmed name, or a crafted
      // `"fast "` would pass validation and land a dangling reference row
      // (the per-message consumer read then fails closed for every review
      // of the App). The store re-canonicalizes as the backstop.
      refs[role] = value.trim();
    }
    // F-002 (QC): enforce the FULL-map contract — every MODEL_ROLE_IDS
    // seat key must be present. All missing keeps the original "no role
    // fields" guard; a strict subset names exactly what is absent.
    const missingSeats = MODEL_ROLE_IDS.filter((role) => !(role in refs));
    if (missingSeats.length === MODEL_ROLE_IDS.length) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.roleFieldsMissingAll);
    }
    if (missingSeats.length > 0) {
      return settings400Response(
        c,
        gate.app.slug,
        missingSeats.length === 1 ? SETTINGS_400_KEYS.roleFieldMissing : SETTINGS_400_KEYS.roleFieldsMissing,
        { roles: missingSeats.join(", ") },
      );
    }
    try {
      // Chain-name validation, role-named for the 4-row form: blank (or the
      // reserved "default" name) = the seat uses the default chain; content
      // must name a chain the App actually has (the store re-validates as
      // the backstop). Zero writes on any failure. The getModelChains read
      // lives INSIDE the try so a D1 failure gets the same structured
      // logSettingsFailure 500 as every other settings op (QC wave, seat3).
      const chains = await store.getModelChains(gate.app.id);
      const knownChains = new Set(chains.map((chain) => chain.name));
      for (const [role, chainName] of Object.entries(refs)) {
        if (chainName === "" || chainName === DEFAULT_CHAIN_NAME) continue;
        if (!knownChains.has(chainName)) {
          return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.roleChainUnknown, { role });
        }
      }
      await store.setModelChainSeats(gate.app.id, refs);
    } catch (err) {
      logSettingsFailure("save_roles", gate.app.id, err);
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Saved the role models for ${gate.app.slug}.`);
  }
  if (op === "add-chain") {
    // (spec §4.4): create or replace one NAMED chain. The name
    // must be a valid chain name (MODEL_CHAIN_NAME_PATTERN) and NOT the
    // reserved "default"; the chain value is a selector chain validated
    // exactly like save-chain (grammar + verified-models membership).
    const name = typeof form.name === "string" ? form.name.trim() : "";
    const chain = typeof form.chain === "string" ? form.chain : "";
    if (name === "" || name === DEFAULT_CHAIN_NAME || !MODEL_CHAIN_NAME_PATTERN.test(name)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.chainNameInvalid, {
        limit: MAX_MODEL_CHAIN_NAME_LENGTH,
      });
    }
    if (chain.trim() === "") {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.chainValueRequired);
    }
    if (chain.length > MAX_MODEL_SELECTOR_LENGTH) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.chainTooLong, {
        count: chain.length,
        limit: MAX_MODEL_SELECTOR_LENGTH,
      });
    }
    const selectors = parseModelChain(chain);
    if (selectors.length === 0) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.chainEmpty);
    }
    const failing = findFailingSelector(
      selectors,
      await store.getVerifiedModels(gate.app.id),
      await store.listCustomProviders(gate.app.id),
    );
    if (failing) {
      return settingsMembershipFailResponse(c, gate.app.slug, failing);
    }
    try {
      await store.upsertModelChain(gate.app.id, name, chain);
    } catch (err) {
      logSettingsFailure("add_chain", gate.app.id, err);
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Saved the ${name} model chain for ${gate.app.slug}.`);
  }
  if (op === "remove-chain") {
    // (spec §4.4): delete one NAMED chain — seats referencing
    // it fall back to the default chain (the store cleans the reference
    // rows in the same atomic batch). The reserved "default" row cannot be
    // removed here (clear it via save-chain instead).
    const name = typeof form.name === "string" ? form.name.trim() : "";
    if (name === "" || name === DEFAULT_CHAIN_NAME) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.defaultChainRemoveProtected);
    }
    try {
      await store.removeModelChain(gate.app.id, name);
    } catch (err) {
      logSettingsFailure("remove_chain", gate.app.id, err);
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Removed the ${name} model chain for ${gate.app.slug} — seats using it fall back to the default chain.`);
  }
  if (op === "add-custom-provider") {
    // Declare a NON-built-in model provider for the App. Every
    // AL-23-1/AL-23-2 bound is checked here (400, zero writes —
    // the store re-validates as the backstop): provider id grammar
    // `[a-z0-9][a-z0-9-]{0,63}` (uppercased into the consumer's pool env
    // prefix), no collision with a built-in OR in-image base provider id
    // (QC wave-1 W-1 — ark-plan would be silently dead at synthesis), at
    // most MAX_CUSTOM_PROVIDER_COUNT declarations per App (QC wave-1 W-2,
    // growth-only — updating an existing id always proceeds), baseUrl
    // https-only ≤2048, api one of the three-form enum, model_ids 1..32
    // entries × ≤128 chars, key required and ≤ the existing 4096 cap. The
    // key is encrypted inside the store and never echoed back.
    const providerId = typeof form.provider_id === "string" ? form.provider_id.trim() : "";
    const baseUrl = typeof form.base_url === "string" ? form.base_url.trim() : "";
    const api = typeof form.api === "string" ? form.api.trim() : "";
    const modelIds = parseModelChain(typeof form.model_ids === "string" ? form.model_ids : "");
    const plainKey = typeof form.key === "string" ? form.key.trim() : "";
    if (providerId === "") {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.providerIdRequired);
    }
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(providerId)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.providerIdInvalid);
    }
    if (PROVIDER_IDS.includes(providerId)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.providerIdBuiltin, { provider: providerId });
    }
    // save-sandbox-image (QC wave-1 W-1's successor): an id the App's SELECTED sandbox
    // image already declares as a capability host (omp: ark-plan) would be
    // skipped by the base-wins synthesis merge on every review while its key
    // still got injected, so the declaration is refused up front (the store's
    // upsertCustomProvider re-checks against the same registry host ids).
    if (sandboxImageHostIds(gate.app.sandbox_image_id).includes(providerId)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.providerIdBaseConfig, { provider: providerId });
    }
    // QC wave-1 W-2: declarations per App are capped (growth-only — an
    // update of an already-declared id never counts against the cap). The
    // store re-checks the same bound as its backstop.
    const declaredCustomProviders = await store.listCustomProviders(gate.app.id);
    if (
      !declaredCustomProviders.some((p) => p.provider_id === providerId) &&
      declaredCustomProviders.length >= MAX_CUSTOM_PROVIDER_COUNT
    ) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.customProviderMax, {
        limit: MAX_CUSTOM_PROVIDER_COUNT,
      });
    }
    if (baseUrl === "") {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.baseUrlRequired);
    }
    if (!isValidCustomProviderBaseUrl(baseUrl)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.baseUrlInvalid);
    }
    if (baseUrl.length > MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.baseUrlTooLong, {
        count: baseUrl.length,
        limit: MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH,
      });
    }
    if (api === "") {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiProtocolRequired);
    }
    if (!CUSTOM_PROVIDER_API_IDS.includes(api as (typeof CUSTOM_PROVIDER_API_IDS)[number])) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiProtocolUnknown, { api });
    }
    if (modelIds.length === 0) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.modelIdsRequired);
    }
    if (modelIds.length > MAX_CUSTOM_PROVIDER_MODEL_IDS) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.modelIdsTooMany, {
        count: modelIds.length,
        limit: MAX_CUSTOM_PROVIDER_MODEL_IDS,
      });
    }
    if (modelIds.some((id) => id.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.modelIdTooLong, {
        limit: MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH,
      });
    }
    if (plainKey === "") {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiKeyRequired);
    }
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiKeyTooLong, {
        count: plainKey.length,
        limit: MAX_PROVIDER_KEY_LENGTH,
      });
    }
    // A `!`-prefixed key would be run as a shell command by the review
    // runtime's config-value resolver (../contracts/credential-key.ts) — the
    // same rule the runner's payload decoder enforces fail-closed.
    if (isCommandConfigKey(plainKey)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiKeyCommandPrefix);
    }
    try {
      const verified = await verifyProviderKey(
        { fetch: globalThis.fetch },
        providerId,
        plainKey,
        {
          baseUrl,
          api: api as (typeof CUSTOM_PROVIDER_API_IDS)[number],
          modelIds,
        },
      );
      if (!verified.ok) {
        return settingsVerifyFailResponse(c, gate.app.slug, verified.reason);
      }
      await store.upsertCustomProvider(
        gate.app.id,
        { provider_id: providerId, base_url: baseUrl, api: api as (typeof CUSTOM_PROVIDER_API_IDS)[number], model_ids: modelIds },
        plainKey,
      );
    } catch (err) {
      logSettingsFailure("add_custom_provider", gate.app.id, err);
      // A1: an endpoint change while the pool still holds keys verified for the
      // current endpoint is refused by the store — the keyed 400 the SPA
      // replays in the operator's locale (nothing was written).
      if (err instanceof ProviderEndpointLockedError) {
        return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.providerEndpointLocked, {
          provider: providerId,
        });
      }
      // PR #10 cap-race fix: the store's atomic cap check can legitimately
      // throw InvalidCustomProviderError AFTER the route pre-check passed
      // (a concurrent save won the last slot) — that is a 400, not a 500.
      if (err instanceof InvalidCustomProviderError) {
        return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.customProviderDeclRejected);
      }
      // The declaration's key POOL can be full (the cap is per (App, provider)).
      if (err instanceof ProviderKeyLimitError) {
        return settingsKeyLimitResponse(c, gate.app.slug, providerId);
      }
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Declared custom provider ${providerId} for ${gate.app.slug} — its key is stored encrypted and injected by environment variable name.`,
    );
  }
  if (op === "add-template-provider") {
    // (spec §5), generalized for catalog breadth (spec § Providers
    // contract 1b): materialize a template-tier catalog
    // entry into the EXISTING custom-provider mechanism — zero models.yml /
    // env injection / selector-grammar changes. The base URL the template
    // materializes with is the form's `base_url` override when provided,
    // else the entry's catalog prefill; the account id is demanded only
    // when the effective base URL carries the {account_id} placeholder
    // (Workers-AI-shaped URLs) and is substituted into it. The save flow
    // pins the template's api protocol, prefills model_ids from the
    // template's representative models, and stores the key under the
    // provider's credential-payload pool (under its provider id)
    // via the same upsertCustomProvider path as add-custom-provider
    // (verify-first custom probe — every bound below mirrors the
    // add-custom-provider checks).
    const templateId = typeof form.template_id === "string" ? form.template_id.trim() : "";
    const accountId = typeof form.account_id === "string" ? form.account_id.trim() : "";
    const formBaseUrl = typeof form.base_url === "string" ? form.base_url.trim() : "";
    const plainKey = typeof form.key === "string" ? form.key.trim() : "";
    const template = PROVIDER_META[templateId];
    if (template === undefined || template.tier !== "template") {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.templateUnknown);
    }
    const baseUrlTemplate = formBaseUrl !== "" ? formBaseUrl : template.baseUrl;
    if (baseUrlTemplate === null || baseUrlTemplate === "") {
      // Only a template whose catalog base URL is absent AND whose form
      // override is empty is unmaterializable (breadth rows may ship with a
      // null snapshot base URL — the editable override covers them).
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.templateIncomplete);
    }
    // The account id demand is conditional on the effective base URL's
    // {account_id} placeholder — a no-placeholder template materializes
    // without one.
    if (baseUrlTemplate.includes("{account_id}")) {
      if (accountId === "") {
        return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.accountIdRequired);
      }
      if (!CLOUDFLARE_ACCOUNT_ID_PATTERN.test(accountId)) {
        return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.accountIdInvalid);
      }
    }
    // The template id must not collide with a built-in or with a capability
    // host of the App's selected sandbox image (defensive — the catalog's
    // template tier is disjoint from both today, but a future template must
    // not silently shadow one).
    if (PROVIDER_IDS.includes(templateId)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.templateIdBuiltin, { template: templateId });
    }
    if (sandboxImageHostIds(gate.app.sandbox_image_id).includes(templateId)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.templateIdBaseConfig, { template: templateId });
    }
    const baseUrl = baseUrlTemplate.replace("{account_id}", accountId);
    if (!isValidCustomProviderBaseUrl(baseUrl)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.materializedBaseUrlInvalid);
    }
    if (baseUrl.length > MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.baseUrlTooLong, {
        count: baseUrl.length,
        limit: MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH,
      });
    }
    if (!CUSTOM_PROVIDER_API_IDS.includes(template.api as (typeof CUSTOM_PROVIDER_API_IDS)[number])) {
      // template.api is `string | null` (catalog snapshot shape) — String()
      // keeps the former `${template.api}` face for the null case verbatim.
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.templateApiUnsupported, {
        api: String(template.api),
      });
    }
    const modelIds = [...template.models];
    if (modelIds.length === 0) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.templateNoModels);
    }
    if (modelIds.length > MAX_CUSTOM_PROVIDER_MODEL_IDS) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.modelIdsTooMany, {
        count: modelIds.length,
        limit: MAX_CUSTOM_PROVIDER_MODEL_IDS,
      });
    }
    if (modelIds.some((id) => id.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.modelIdTooLong, {
        limit: MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH,
      });
    }
    if (plainKey === "") {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiKeyRequired);
    }
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiKeyTooLong, {
        count: plainKey.length,
        limit: MAX_PROVIDER_KEY_LENGTH,
      });
    }
    // A `!`-prefixed key would be run as a shell command by the review
    // runtime's config-value resolver (../contracts/credential-key.ts) — the
    // same rule the runner's payload decoder enforces fail-closed.
    if (isCommandConfigKey(plainKey)) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.apiKeyCommandPrefix);
    }
    const declaredCustomProviders = await store.listCustomProviders(gate.app.id);
    const storedDeclaration = declaredCustomProviders.find((p) => p.provider_id === templateId);
    if (
      storedDeclaration === undefined &&
      declaredCustomProviders.length >= MAX_CUSTOM_PROVIDER_COUNT
    ) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.templateMaterializeMax, {
        limit: MAX_CUSTOM_PROVIDER_COUNT,
      });
    }
    // Append against an EXISTING declaration: the stored api/model_ids are
    // what the already-held keys were verified against and what saved chains
    // reference, so the submit persists THEM — a catalog template id may
    // legitimately hold a declaration with different values (only built-in and
    // capability-host ids are refused at declaration). Re-materializing the
    // catalog's values here would rewrite the declaration under the operator
    // (chains referencing the stored ids then fail membership), and a stored
    // protocol differing from the catalog's would trip the endpoint lock on a
    // form that displays no protocol control at all. The first-time CREATE
    // path keeps the catalog materialization.
    const declApi = storedDeclaration?.api ?? (template.api as (typeof CUSTOM_PROVIDER_API_IDS)[number]);
    const declModelIds = storedDeclaration?.model_ids ?? modelIds;
    try {
      const verified = await verifyProviderKey(
        { fetch: globalThis.fetch },
        templateId,
        plainKey,
        {
          baseUrl,
          api: declApi,
          modelIds: declModelIds,
        },
      );
      if (!verified.ok) {
        return settingsVerifyFailResponse(c, gate.app.slug, verified.reason);
      }
      await store.upsertCustomProvider(
        gate.app.id,
        { provider_id: templateId, base_url: baseUrl, api: declApi, model_ids: declModelIds },
        plainKey,
      );
    } catch (err) {
      logSettingsFailure("add_template_provider", gate.app.id, err);
      // A1: the template save path materializes the SAME custom-provider
      // declaration, so it carries the same endpoint lock.
      if (err instanceof ProviderEndpointLockedError) {
        return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.providerEndpointLocked, {
          provider: templateId,
        });
      }
      if (err instanceof InvalidCustomProviderError) {
        return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.customProviderDeclRejected);
      }
      if (err instanceof ProviderKeyLimitError) {
        return settingsKeyLimitResponse(c, gate.app.slug, templateId);
      }
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Materialized the ${template.label} template as custom provider ${templateId} for ${gate.app.slug} — its key is stored encrypted and injected by environment variable name.`,
    );
  }
  if (op === "remove-custom-provider") {
    const providerId = typeof form.provider_id === "string" ? form.provider_id.trim() : "";
    let removed: boolean;
    try {
      removed = await store.removeCustomProvider(gate.app.id, providerId);
    } catch (err) {
      logSettingsFailure("remove_custom_provider", gate.app.id, err);
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    // Tolerant no-op (the id grammar already bounds what can ever be
    // stored): an unknown provider id simply has no row — a 2xx, not a 400.
    // The declaration and every key of its pool go together (removeCustomProvider).
    return settingsRemoveResponse(
      c,
      gate.app.slug,
      removed,
      removed
        ? `Removed the custom provider ${providerId} from ${gate.app.slug}.`
        : `No custom provider ${providerId === "" ? "(unspecified)" : providerId} on ${gate.app.slug} — nothing changed.`,
    );
  }
  if (op === "save-sandbox-image") {
    // (spec § Technical interfaces): save the App's sandbox runtime
    // image. Only ENABLED registry ids are storable — an unknown or disabled
    // id is a 400 with zero writes (getSandboxImage distinguishes nothing
    // user-visible here; both refuse identically). The store re-validates
    // against the same registry as the backstop (setSandboxImage), refuses
    // soft-deleted rows, and stamps updated_at (operator mutation). This
    // whole POST family already runs behind requireAppSettings — the
    // canManageApp (creator-or-admin) gate.
    const imageId = typeof form.sandbox_image_id === "string" ? form.sandbox_image_id.trim() : "";
    const image = getSandboxImage(imageId);
    if (!image || !image.enabled) {
      return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.sandboxImageUnknown);
    }
    try {
      await createAppsStore(gate.db).setSandboxImage(gate.app.id, image.id);
    } catch (err) {
      logSettingsFailure("save_sandbox_image", gate.app.id, err);
      return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
    }
    return settingsPostResponse(c, gate.app.slug, `Saved the ${image.id} runtime image for ${gate.app.slug}.`);
  }
  // Review fold-in: an unknown op is a validation failure like any
  // other — 400 with the reason.
  return settings400Response(c, gate.app.slug, SETTINGS_400_KEYS.unknownOperation);
};

const appKeyDeleteRoute = async (c: DashboardContext) => {
  const gate = await requireAppSettings(c);
  if (!gate.ok) return gate.response;
  const form = await c.req.parseBody();
  const provider = typeof form.provider === "string" ? form.provider.trim() : "";
  // The key identity is the delete target: the (App, provider) pool holds one
  // row per key, so a provider-only delete would take the sibling keys with it.
  const keyId = typeof form.key_id === "string" ? form.key_id.trim() : "";
  const store = createAppConfigStore(gate.db, c.env.DASHBOARD_ENCRYPTION_KEY);
  let removed: boolean;
  try {
    // The pool owner picks the table: a declared custom/template provider's
    // rows live in the custom pool, every other provider id in the built-in
    // one. The two id spaces are disjoint by construction (a declaration
    // colliding with a built-in id or an in-image capability host is refused),
    // so the declaration is an exact discriminator, never a guess.
    const declaredCustom = (await store.listCustomProviders(gate.app.id)).some(
      (row) => row.provider_id === provider,
    );
    removed = declaredCustom
      ? await store.deleteCustomProviderKey(gate.app.id, provider, keyId)
      : await store.deleteProviderKey(gate.app.id, provider, keyId);
  } catch (err) {
    logSettingsFailure("remove_key", gate.app.id, err);
    return settingsPostResponse(c, gate.app.slug, settingsFailureNotice(err), 500);
  }
  // Tolerant no-op (the allowlist already bounds what can ever be stored):
  // an unknown provider — or a key id no row matches, including an absent one —
  // simply has no row: a 2xx, not a 400.
  return settingsRemoveResponse(
    c,
    gate.app.slug,
    removed,
    removed
      ? `Removed the stored ${provider} key for ${gate.app.slug}.`
      : `No stored ${provider === "" ? "(unspecified)" : provider} key on ${gate.app.slug} — nothing changed.`,
  );
};

// The legacy SSR home (`dashboardApp.get("/")` →
// dashboardPage) is retired. GET /dashboard — every Accept variant — is the
// SPA workbench, served by spa-dispatch before this app is reached. The
// manifest-hold resume gate lives on its dedicated route
// /dashboard/manifest/confirm (the retryable-error page links there).
// --- Review Health insights summary API -------------------------
//
// JSON read face for the insights aggregation (src/dashboard/insights-store.ts
// — the module-boundary leaf, zero store/pipeline/review imports), scoped to a
// single App: GET /api/apps/:slug/insights/summary. The former cross-App
// global endpoint (GET /api/insights/summary) is REMOVED — insights are an
// App-owned surface, and the store's `appId` filter composes the app row PK
// into EVERY aggregation (including the opt-in repos query), so one App's
// reader can never see another App's reviews.
// Gate (JSON-only face — never an HTML page):
//   - membership: requireMember (session + live member row);
//   - app lookup by slug, same rule as requireAppVisible: unknown and
//     soft-deleted apps are equally invisible → 404;
//   - creator-or-admin via canManageApp → 403.
//   All deny bodies are `{ error }` JSON.
// Params (same parse + 400 semantics the global face had):
//   - window: pure integer days, default 30. Non-integer (incl. negative and
//     empty) → 400. Values > 90 are NOT rejected — the single clamp point
//     caps them at 90, and the response echoes the EFFECTIVE window so
//     clients see what the aggregation actually used.
//   - repo: optional owner/repo filter, malformed → 400.
// Response = the store return plus the two echoed params (snake_case keys).
const INSIGHTS_REPO_PATTERN = /^[^/\s]+\/[^/\s]+$/;
/** The only supported `include` extra (QC F-001). */
const INSIGHTS_INCLUDE_VALUES = ["repos"] as const;

/**
 * Query-param parse for the per-App insights JSON face: window (integer
 * days, default 30) + optional repo owner/repo filter + optional
 * comma-separated `include` extras (`repos` — the window-scoped distinct
 * repo aggregation, opt-in so only consumers that need it pay for it).
 * Returns
 * the parsed values or the 400 reason; the route answers 400 with a JSON
 * error body. The >90 clamp stays in the store — the single clamp point —
 * and the route echoes the EFFECTIVE window.
 */
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

const appInsightsRoute = async (c: DashboardContext) => {
  const member = await requireMember(c);
  if (!member.ok) return member.response;

  // Same slug-resolution rule as requireAppVisible: unknown, soft-deleted and
  // cross-workspace apps are equally invisible → 404. JSON body — this face
  // never renders HTML (no forbiddenPage on either deny path).
  const app = await resolveScopedApp(
    requestAppsStore(member.db, member.scope),
    c.req.param("slug") ?? "",
    member.scope,
  );
  if (!app) return c.json({ error: "unknown app" }, 404);
  if (!canManageApp(member.user, app, member.scope)) return c.json({ error: "forbidden" }, 403);

  const db = dashboardD1(c.env);
  if (!db) return c.text("dashboard storage is not configured", 500);

  const params = parseInsightsParams({
    window: c.req.query("window"),
    repo: c.req.query("repo"),
    include: c.req.query("include"),
  });
  if (!params.ok) return c.json({ error: params.reason }, 400);

  const insights = await createInsightsStore(db, {
    windowDays: params.windowDays,
    repo: params.repoFilter,
    includeRepos: params.includeRepos,
    // The App row PK (never empty — the slug lookup resolved a real row),
    // composed into every aggregation by the store's appId filter.
    appId: app.id,
  });
  return c.json({
    window_days: clampWindow(params.windowDays),
    ...(params.repoFilter !== undefined ? { repo: params.rawRepo } : {}),
    reviews_total: insights.reviewsTotal,
    findings_by_severity: insights.findingsBySeverity,
    findings_by_category: insights.findingsByCategory,
    verdict_distribution: insights.verdictDistribution,
    weekly_trend: insights.weeklyTrend,
    // Additive day-bucketed trend (window-bucketing contract, 2026-09-20):
    // [] on week windows — the frozen weekly_trend key above is untouched.
    daily_trend: insights.dailyTrend,
    // (AD-652): additive per-bucket findings distribution for the
    // stacked charts. Existing fields are untouched — the only change on
    // this face is the new key.
    findings_distribution: insights.findingsDistribution,
    recurring_top: insights.recurringTop,
    repos: insights.repos,
  });
};

// The insights HTML panel and the cross-App global JSON endpoint are both
// retired — /dashboard/insights is SPA-owned (spa-dispatch serves the shell;
// the SPA reads the per-App JSON face above). The legacy GET handlers are
// gone; the global URL answers 404.

// --- App + member route table (Deploy B dual registration) -----------------
//
// ONE table, ONE registration loop: every route is reachable on the legacy
// prefix (today's paths, live under `off`) and on the workspace prefix
// (live under `strict`) — except the ones flagged `root: false`, which exist
// ONLY under a workspace ref. The members/invite family is workspace-only: a
// deployment-level member list or invitation has no meaning once authority is
// per workspace, so no legacy copy is registered and the retired root paths
// (`/api/members`, `/members/{invite,remove,role}`) fall through to the
// catch-all 404.
// Handlers read the workspace from the request context, so no handler body
// exists twice. The workspace copy is gated by `workspaceOnly`: the routing
// middleware attaches a scope only for a resolvable, non-reserved ref, so a
// request that matched `:workspaceRef` without one (`/login/apps…`,
// `/login/members…`) is a 404 and never falls back to the legacy face.
type AppRouteHandler = (c: DashboardContext) => Response | Promise<Response>;

type AppRoute = {
  method: "get" | "post";
  path: string;
  handler: AppRouteHandler;
  /** `false` = workspace-only: no legacy copy is registered. Defaults to both. */
  root?: boolean;
  /**
   * The operator ceiling's ONE input: `read` admits a granted platform
   * operator, `write` (the default, so an omission fails closed) answers 403.
   * Declaring a route here is the only way to mount a workspace face.
   */
  access?: "read" | "write";
};

const APP_ROUTES: ReadonlyArray<AppRoute> = [
  { method: "get", path: "/apps/:slug/onboarding", handler: appOnboardingRoute, access: "write" },
  { method: "get", path: "/api/apps", handler: appListRoute, access: "write" },
  { method: "post", path: "/apps/:slug/disable", handler: (c) => appStatusAction(c, "disable"), access: "write" },
  { method: "post", path: "/apps/:slug/enable", handler: (c) => appStatusAction(c, "enable"), access: "write" },
  { method: "post", path: "/apps/:slug/delete", handler: (c) => appStatusAction(c, "delete"), access: "write" },
  { method: "post", path: "/apps/:slug/pause", handler: (c) => appReviewAction(c, "pause"), access: "write" },
  { method: "post", path: "/apps/:slug/resume", handler: (c) => appReviewAction(c, "resume"), access: "write" },
  { method: "post", path: "/apps/:slug/review-trigger-mode", handler: appReviewTriggerModeAction, access: "write" },
  { method: "get", path: "/api/apps/:slug/settings", handler: appSettingsRoute, access: "write" },
  { method: "get", path: "/api/apps/:slug/models", handler: appModelsRoute, access: "write" },
  { method: "post", path: "/api/apps/:slug/keys/verify", handler: appKeyVerifyRoute, access: "write" },
  { method: "post", path: "/apps/:slug/settings", handler: appSettingsSaveRoute, access: "write" },
  { method: "post", path: "/apps/:slug/settings/key/delete", handler: appKeyDeleteRoute, access: "write" },
  { method: "get", path: "/api/apps/:slug/insights/summary", handler: appInsightsRoute, access: "write" },
  // Members + invitations: workspace-only. The member list is `read` (every
  // member sees it, and the operator's AC2 field set is this same list); every
  // App/settings read and invite face is `write` (AC3).
  { method: "get", path: "/api/members", handler: memberListRoute, root: false, access: "read" },
  { method: "get", path: "/api/members/invites", handler: inviteListRoute, root: false, access: "write" },
  { method: "post", path: "/api/members/invites", handler: inviteCreateRoute, root: false, access: "write" },
  { method: "post", path: "/api/members/invites/:id/revoke", handler: inviteRevokeRoute, root: false, access: "write" },
  { method: "post", path: "/api/members/invites/:id/accept", handler: inviteAcceptRoute, root: false, access: "write" },
  { method: "post", path: "/members/role", handler: memberRoleRoute, root: false, access: "write" },
  { method: "post", path: "/members/remove", handler: memberRemoveRoute, root: false, access: "write" },
  // Support + audit (plan 99): the granted operator's read-only face, the
  // members' undismissable notice, and the owner/admin audit read.
  { method: "get", path: "/api/support/workspace", handler: supportWorkspaceRoute, root: false, access: "read" },
  { method: "get", path: "/api/support/grants", handler: supportGrantsRoute, root: false, access: "read" },
  { method: "get", path: "/api/audit", handler: auditListRoute, root: false, access: "write" },
];

/**
 * Registration wrapper for the workspace copy of a route. Hono matches
 * `:workspaceRef` without knowing the reserved set, so a request that reached
 * this registration without a tenant scope (`/login/apps/...`, or any path the
 * gate classified `other`) falls through to the ORIGINAL handling — the legacy
 * route or the placeholder catch-all — exactly as before the workspace block
 * existed. A real workspace route always carries a scope.
 */
function workspaceOnly(
  handler: AppRouteHandler,
): Handler<{ Bindings: Env; Variables: DashboardVariables }> {
  return (c, next) => (c.get("tenant") ? handler(c) : next());
}

for (const route of APP_ROUTES) {
  if (route.method === "get") {
    if (route.root !== false) dashboardApp.get(route.path, route.handler);
    dashboardApp.get(`/:workspaceRef${route.path}`, workspaceOnly(route.handler));
  } else {
    if (route.root !== false) dashboardApp.post(route.path, route.handler);
    dashboardApp.post(`/:workspaceRef${route.path}`, workspaceOnly(route.handler));
  }
}

// The workspace settings family is workspace-only and PUT-shaped (the table
// above carries GET/POST only): the slug is the workspace's own identity, so
// there is no deployment-level copy to register.
dashboardApp.put("/:workspaceRef/api/settings/slug", workspaceOnly(workspaceSlugRoute));

// Placeholder actions (IA routing table): every POST under /dashboard that is
// not a wired route above is a placeholder submit and must never succeed —
// logged out → 302 to login; logged in → 405 (the shell exists, the method
// does not). Zero secret writes, zero REVIEW_ENABLED changes on this path.
dashboardApp.post("*", async (c) => {
  const sessionSecret = c.env.DASHBOARD_SESSION_SECRET;
  if (!sessionSecret) return c.text("dashboard OAuth is not configured", 500);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), sessionSecret);
  if (!session) return c.redirect("/dashboard/login", 302);
  return c.text("placeholder actions are not implemented", 405);
});
