/**
 * Webhook verification + event filtering (pure, testable).
 *
 * Fail-closed secret policy (compass S4, along M0): missing, empty, or the
 * Probot default "development" secret → reject with zero side effects.
 * Signature verification uses `@octokit/webhooks` (Web Crypto, workerd-safe).
 * Every reject path logs a structured warning (no secret material) so the
 * operator can spot bad configurations / probes (Phase 5 B6).
 *
 * Event whitelist (spec review-trigger-policy §2.1):
 * - `pull_request.{opened,synchronize,reopened}` filtered by the resolved
 *   App's `review_trigger_mode`: `open` auto-triggers `opened` only,
 *   `every_push` (the default) all three, `manual` none.
 * - `issue_comment.created` whose body contains the App's bot mention
 *   `@{github_slug}` as a standalone token (spec §3 grammar), on a pull request
 *   thread, sent by a non-bot whose login is the PR author or the repository
 *   owner (Phase 5 B5 actor allowlist — prevents quota abuse by arbitrary
 *   commenters on public installs).
 * - `installation.{created,new_permissions_accepted}` whose payload carries
 *   `installation.account.login` — recorded as the install's account; not
 *   review work, so it never enqueues.
 * Everything else returns 200 quickly — GitHub retries non-2xx, so
 * uninteresting events must not 4xx.
 */
import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { ReviewTriggerMode } from "../dashboard/apps-store";
import type { HandlerLog } from "./handlers";

export const PULL_REQUEST_ACTIONS = ["opened", "synchronize", "reopened"] as const;

/**
 * The install actions that carry the installing account's login
 * (`installation.account.login`). Both mean "this App is installed and
 * usable right now", which is when the settings table should stop reading
 * `未知`. Lifecycle-only actions (`deleted`, `suspend`, `unsuspend`, `added`,
 * `removed`) stay ignored — this whitelist records a login, it does not
 * track install state.
 */
export const INSTALLATION_ACTIONS = ["created", "new_permissions_accepted"] as const;

/**
 * The per-App trigger inputs classification branches on (spec
 * review-trigger-policy §2/§3 read path): the resolved row's
 * `review_trigger_mode` and its GitHub slug (the mention target — one App's
 * mention never triggers another App). The mention login is GitHub's mutable
 * `github_slug`, never our local webhook path or the row id. The per-App
 * webhook route passes both from the already-resolved row — no second lookup.
 * An omitted context defaults to `every_push` with NO mention target (empty
 * slug never matches — fail-safe: no trigger rather than a spurious one).
 */
export type ReviewTriggerContext = { mode: ReviewTriggerMode; appSlug: string };

/**
 * The GitHub login continuation set (spec §3): `A-Z a-z 0-9 -`. A mention
 * match is a standalone token only when the characters immediately before
 * `@` and immediately after the slug are BOTH outside this set (absent
 * counts as outside). Hyphens continue a login, so `@slug-other` /
 * `@slugbot` never match and an email-shaped `name@slug.host` never matches.
 * Always evaluated against the ORIGINAL body text, never a case-folded copy
 * (see bodyMentionsApp).
 */
const LOGIN_CONTINUATION = /[A-Za-z0-9-]/;

/**
 * ASCII-restricted case-insensitive equality for two single body characters:
 * identical, or both ASCII (code unit ≤ 127) with the same toLowerCase()
 * form. `String.toLowerCase()` alone is a Unicode SUPERSET of ASCII folding
 * (U+212A KELVIN SIGN folds to `k`, U+0130 folds to `i` + combining dot), so
 * it must never decide a match — a non-ASCII character never equals an ASCII
 * letter here (QC F-001/S-1).
 */
function asciiFoldEquals(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (a.charCodeAt(0) > 127 || b.charCodeAt(0) > 127) {
    return false;
  }
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Whether `body` mentions the App's bot: contains `@{github_slug}` (ASCII
 * case-insensitive, literal) as a standalone token per the LOGIN_CONTINUATION
 * boundary rule. Any position in the body; the mention IS the entire
 * grammar (spec §3 — no wording, no commands).
 *
 * The scan runs over the ORIGINAL body: the case fold is applied
 * per-character via asciiFoldEquals (ASCII-only), and both boundary
 * characters are read from the original text. A whole-string
 * `toLowerCase()` copy would corrupt the grammar in both directions
 * (QC F-001/S-1): Unicode-only folds fabricate occurrences that do not
 * exist in the original (`@<KELVIN>-bot` lowering to `@k-bot`) and the
 * length change (U+0130 is one code unit lowering to two) shifts every
 * index after the fold, misreading both boundaries. An empty slug never
 * matches — fail-safe: no trigger rather than a spurious one.
 */
function bodyMentionsApp(body: string, appSlug: string): boolean {
  if (!appSlug) {
    return false;
  }
  const needle = `@${appSlug}`.toLowerCase();
  let i = body.indexOf("@");
  while (i !== -1) {
    const end = i + needle.length;
    if (end <= body.length) {
      let matched = true;
      for (let j = 1; j < needle.length; j++) {
        if (!asciiFoldEquals(body[i + j]!, needle[j]!)) {
          matched = false;
          break;
        }
      }
      if (matched) {
        const before = i > 0 ? body[i - 1]! : "";
        const after = end < body.length ? body[end]! : "";
        if (!LOGIN_CONTINUATION.test(before) && !LOGIN_CONTINUATION.test(after)) {
          return true;
        }
      }
    }
    i = body.indexOf("@", i + 1);
  }
  return false;
}

/**
 * The classifier's ignore reason for a comment that does not mention THIS App's
 * bot. Exported so the per-App route can distinguish that one miss (which may
 * be an UNSYNCED slug — see payloadMentionsALogin) from every other ignore,
 * without duplicating the literal.
 */
export const MENTION_MISS_REASON = "comment body does not mention the App bot";

/**
 * Diagnostic twin of the mention grammar for an App whose `github_slug` is
 * NOT cached yet (every row that predates its first metadata sync): does this
 * issue_comment delivery mention some login as a standalone `@token`?
 *
 * It is NOT a trigger and never decides an outcome — the per-App route uses it
 * only to explain an otherwise silent ignore, because with no slug
 * `bodyMentionsApp` can never match and the App looks healthy while its mention
 * trigger is dead.
 *
 * There is no target login here: the login run following each `@` IS the
 * candidate, so the grammar reduces to the LOGIN_CONTINUATION boundary pair
 * over the ORIGINAL body — the same rule bodyMentionsApp applies around its
 * slug (`@acme[bot]` yields the standalone run `acme`). Decided inline in one
 * pass: the runs never overlap, so the scan is linear in the body. Handing
 * each run to bodyMentionsApp would rescan from the first `@` per token
 * (quadratic — 17.6 s on a 160 KB body, reachable before the thread/bot/actor
 * gates while the App is unsynced).
 */
export function payloadMentionsALogin(rawBody: string): boolean {
  const parsed = parseBody(rawBody);
  if (parsed === null) return false;
  const result = issueCommentSchema.safeParse(parsed);
  if (!result.success) return false;
  const body = result.data.comment?.body ?? "";
  let i = body.indexOf("@");
  while (i !== -1) {
    let end = i + 1;
    while (end < body.length && LOGIN_CONTINUATION.test(body[end]!)) end++;
    // A non-empty login run whose leading boundary is outside the
    // continuation set (body start counts as outside) — this is what rejects
    // the email-shaped `name@host`. The trailing boundary needs no check: the
    // loop above only stops at a non-continuation character or the body end,
    // so the character after the run is outside the set by construction.
    if (end > i + 1 && !LOGIN_CONTINUATION.test(i > 0 ? body[i - 1]! : "")) {
      return true;
    }
    i = body.indexOf("@", i + 1);
  }
  return false;
}

/**
 * §2.1 matrix for the auto (pull_request) face: `open` enqueues `opened`
 * only; `every_push` enqueues all whitelisted actions; `manual` never
 * auto-triggers (a bot mention is the only trigger).
 */
function autoTriggerAllows(mode: ReviewTriggerMode, action: string): boolean {
  if (mode === "manual") {
    return false;
  }
  return mode === "open" ? action === "opened" : true;
}

/**
 * GitHub gives every bot account a login ending in `[bot]` (dependabot[bot],
 * github-actions[bot], an App's own `<slug>[bot]`). A PR opened by one of
 * them is machine-generated — release prep, dependency bumps, self-authored
 * PRs from another automation — and is never reviewed, on either trigger
 * face. Case-insensitive because GitHub logins are; the suffix is the whole
 * rule, so a login without it (whatever its account type) still triggers.
 */
const BOT_LOGIN = /\[bot\]$/i;

// Exported as test seams so the classifier tests assert the contract by
// symbol; no production branch keys on either string.
export const BOT_PR_REASON = "PR authored by a bot account";

export const MISSING_AUTHOR_REASON = "payload carried no PR author login";

/**
 * Both trigger faces share one author rule: a PR whose author is unknown is
 * ignored (GitHub always sends the login — a truncated payload cannot prove a
 * human authored it), and a `[bot]` login is never reviewed.
 */
function ignoredForAuthor(login: string | null | undefined): WebhookOutcome | null {
  if (!login) {
    return { kind: "ignore", reason: MISSING_AUTHOR_REASON };
  }
  if (BOT_LOGIN.test(login)) {
    return { kind: "ignore", reason: BOT_PR_REASON };
  }
  return null;
}

/** Webhook body size cap (B6): checked BEFORE the body is buffered (413). */
export const WEBHOOK_BODY_LIMIT = 1_000_000;

/**
 * Module-level verifier cache (QC F-005; the hardening item /
 * architect lock L1): the hot path constructed a `Webhooks` instance per
 * request only to call `verify`, which uses nothing but `options.secret`.
 * KEYED BY CACHEKEY, NOT the raw secret: each entry is `{ secret, webhooks }`
 * under the caller's cache key — each per-App
 * `POST /webhook/:workspaceId/:appId` route passes its `github_apps.id` — so per-App isolation holds AND a
 * cached entry whose `secret` differs from the caller's current secret
 * (credential rotation) is rebuilt and REPLACED: the rotated secret
 * verifies with the NEW secret only, and the old entry is evicted exactly
 * (no LRU wait). The bound is STRUCTURAL (≤ github_apps rows — keys are
 * drawn from the fixed universe of row ids), so no eviction policy is
 * tunable or needed; an entry outliving its row (soft-deleted App) is dead
 * weight only — that route 404s before classifyWebhook, so the entry can
 * never be hit again. `getWebhooks` stays exported as a test seam to lock
 * the reuse and rotation-replace behavior; the worker always passes an
 * explicit cacheKey, and direct callers that omit it fall back to the
 * legacy secret-keyed memoization.
 */
type VerifierCacheEntry = { secret: string; webhooks: Webhooks };

const webhooksCache = new Map<string, VerifierCacheEntry>();

export function getWebhooks(cacheKey: string, secret: string): Webhooks {
  const cached = webhooksCache.get(cacheKey);
  if (cached !== undefined && cached.secret === secret) {
    return cached.webhooks;
  }
  // First use for this cacheKey, or a SECRET MISMATCH (rotation): build and
  // REPLACE the entry — the old instance (and its old secret) is dropped
  // exactly, never retained alongside the new one.
  const webhooks = new Webhooks({ secret });
  webhooksCache.set(cacheKey, { secret, webhooks });
  return webhooks;
}

/**
 * Verify a signature, treating any throw as invalid (QC F-001). On the
 * deployed Worker, wrangler resolves `@octokit/webhooks-methods` via the
 * `browser` condition → WebCrypto verify → `hexToUInt8Array` throws a
 * TypeError on malformed (non-hex) signatures, while Bun/node resolves the
 * `node` condition → `timingSafeEqual` → returns false. Both must fail
 * closed with 401; this wrapper unifies the two paths and logs the
 * malformed input structurally so the operator can spot it. `event` is the
 * real GitHub event when the caller knows it (log hygiene) — the
 * warn falls back to a stage label, never the literal "unknown".
 */
export async function verifySignature(
  verify: (rawBody: string, signature: string) => Promise<boolean>,
  rawBody: string,
  signature: string,
  log?: HandlerLog,
  event?: string,
): Promise<boolean> {
  try {
    return await verify(rawBody, signature);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.warn(
      { event: event ?? "signature_verification_error", reason: "signature verification threw", detail },
      "malformed signature rejected with 401",
    );
    return false;
  }
}

/**
 * Classifier outcome. The `job` payload NEVER carries `appRef`
 * (AL-24-2/4): the classifier is secret-parameterized only and never sees
 * the App identity — the ONLY production attach point is the per-App
 * `POST /webhook/:workspaceId/:appId` route, which adds `appRef: { appId }`
 * after classification, before enqueue.
 */
export type WebhookOutcome =
  | { kind: "reject"; status: 400 | 401 | 500; reason: string }
  | { kind: "ignore"; reason: string }
  /**
   * A review job. `installationAccount` is `installation.account.login`
   * when the payload carries it, falling back to `repository.owner.login` —
   * the installation's own account is authoritative and the repository
   * owner covers only payloads that omit it (the review path does NOT always
   * receive an owner-derived login). It is carried OUTSIDE
   * `payload` so it never enters the queue message (the consumer contract
   * `ReviewJobPayload` must not grow an account field) while the route can
   * still record it on `app_installations`.
   *
   * `accountAuthoritative` is always false here: a review payload is not an
   * install statement, so the store only lets this value FILL an empty login.
   */
  | {
      kind: "job";
      payload: Omit<ReviewJobPayload, "appRef">;
      installationAccount: string;
      accountAuthoritative: false;
    }
  /**
   * An install delivery is not review work: it names the installation whose
   * `account_login` the route records, and never carries a queue payload.
   * `accountLogin` is null only when GitHub omits `installation.account`
   * (the schema permits it) — the store's COALESCE then keeps whatever is
   * already stored. `accountAuthoritative` is always true: this payload IS
   * the installation's own statement, so it overwrites a stored login.
   */
  | {
      kind: "installation";
      installationId: number;
      accountLogin: string | null;
      accountAuthoritative: true;
    };

/**
 * Minimal webhook payload shapes — only the fields the gateway consumes.
 *
 * `account.login` is the installation's own account — the authority for
 * `app_installations.account_login`. `repository.owner.login` is only a
 * fallback: an install covers repositories owned by the installing account,
 * but the payload's own `installation.account` is the value GitHub states,
 * and it must win so it is never overwritten by an inferred owner.
 *
 * An empty login is rejected at the boundary (`min(1)`): `""` is not a login,
 * and treating it as an absent account is what keeps it from reaching the
 * store as a value.
 */
const installationAccountSchema = z.object({ login: z.string().min(1) }).nullable().optional();
const installationSchema = z
  .object({ id: z.number(), account: installationAccountSchema })
  .nullable()
  .optional();
const repositorySchema = z
  .object({ name: z.string(), owner: z.object({ login: z.string() }) })
  .nullable()
  .optional();

/**
 * The install's own account login, with the repository owner as the fallback a
 * delivery without `installation.account` allows — shared by both review
 * classifiers so the authority order is stated once.
 *
 * Two sources, one rule (`app_installations.account_login` is either
 * AUTHORITATIVE or INFERRED):
 * - authoritative = `installation.account.login` on an `installation.*` event
 *   (the installation's own statement) — overwrites a stored login;
 * - inferred = the login a review delivery (`pull_request` / `issue_comment`)
 *   carries, which is `installation.account.login` when the payload has it and
 *   `repository.owner.login` otherwise — only fills an EMPTY stored login.
 * The precedence is stated here once. They are never interchangeable: the store
 * picks its update expression from `accountAuthoritative`, not from which value
 * looks more specific.
 *
 * An empty-string login is treated as absent, so the owner covers it.
 */
function installationAccountOf(
  installation: { account?: { login: string } | null } | null | undefined,
  owner: string,
): string {
  const login = installation?.account?.login;
  return login ? login : owner;
}

/**
 * The `installation` event's own shape (not the bare `installationSchema`,
 * which only supplies the id inside the review events): the account login is
 * the whole point, and it sits one level down under `account`.
 */
const installationEventSchema = z.object({
  action: z.string(),
  installation: z
    .object({ id: z.number().optional(), account: installationAccountSchema })
    .nullable()
    .optional(),
});

const pullRequestSchema = z.object({
  action: z.string(),
  number: z.number().optional(),
  installation: installationSchema,
  pull_request: z
    .object({
      number: z.number().optional(),
      // PR author — a bot-authored PR is never reviewed (either face).
      user: z.object({ login: z.string().optional() }).nullable().optional(),
      // Display fields for the per-App PR ledger (`pullRequestRecord`). All
      // optional *and* nullable: a delivery may omit them and every existing
      // classifier guard stays decided by `number` / `head.sha` alone.
      title: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      merged: z.boolean().nullable().optional(),
      // GitHub's own clock for the PR row — the ledger's ordering key.
      updated_at: z.string().nullable().optional(),
      head: z.object({ sha: z.string().nullable().optional() }).optional(),
    })
    .nullable()
    .optional(),
  repository: repositorySchema,
});

const issueCommentSchema = z.object({
  action: z.string(),
  installation: installationSchema,
  comment: z.object({ body: z.string() }).nullable().optional(),
  issue: z
    .object({
      number: z.number(),
      // PR author (issue.user.login) — the actor allowlist (B5) and the
      // bot/missing-author guard. `login` is optional so a truncated payload
      // fails closed on the guard instead of rejecting 400.
      user: z.object({ login: z.string().optional() }).nullable().optional(),
      pull_request: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  repository: repositorySchema,
  // Commenter identity: type (bot guard) + login (actor allowlist, B5).
  sender: z.object({ type: z.string().optional(), login: z.string().optional() }).nullable().optional(),
});

/**
 * Verify the signature and map the event to a review job, an ignore, or a
 * reject. The fail-closed secret check runs first — no verification, no
 * side effects when the secret is missing/empty/"development". The
 * `Webhooks` verifier is constructed lazily only after the secret passes,
 * so an empty/default secret can never reach the crypto path. Each reject
 * path emits a structured warning with a machine reason and NO secret
 * material (Phase 5 B6).
 *
 * `log` is optional (defaults to no logging) so the pure classifier stays
 * testable without a sink; the fetch entry passes `defaultLog`.
 *
 * `cacheKey` (the hardening item / architect lock L1) is a
 * MEMOIZATION-ONLY parameter for the verifier cache — a per-App route
 * passes its `github_apps.id`; the classifier NEVER branches on it (same
 * secret + same payload classifies identically whichever key rides along).
 * Omitted → the verifier memoizes under the secret itself (the legacy
 * shape, for direct callers).
 *
 * Warn labels (log hygiene hardening item 3): every structured warn carries
 * the REAL GitHub event in `event` when the header is present, falling back
 * to the stage label (= the machine `reason`) when the header is absent —
 * never the literal "unknown", so log consumers can filter by event alone.
 *
 * `trigger` (spec review-trigger-policy §2 read path) is the resolved
 * App row's mode + slug, passed straight to classifyEvent — the classifier
 * branches on it but still never sees the App identity (no appId).
 */
export async function classifyWebhook(
  secret: string,
  rawBody: string,
  signature: string | null,
  eventName: string | null,
  log?: HandlerLog,
  cacheKey?: string,
  trigger: ReviewTriggerContext = { mode: "every_push", appSlug: "" },
): Promise<WebhookOutcome> {
  if (!secret || secret === "development") {
    log?.warn(
      { event: eventName ?? "secret_misconfigured", reason: "secret_misconfigured", detail: "secret missing, empty, or the default 'development'" },
      "webhook rejected with 500 — secret misconfigured",
    );
    return { kind: "reject", status: 500, reason: "webhook secret is missing, empty, or the default 'development'" };
  }
  if (!signature) {
    log?.warn(
      { event: eventName ?? "missing_signature", reason: "missing_signature", detail: "X-Hub-Signature-256 header absent" },
      "webhook rejected with 401 — missing signature",
    );
    return { kind: "reject", status: 401, reason: "missing X-Hub-Signature-256 header" };
  }
  const valid = await verifySignature(
    getWebhooks(cacheKey ?? secret, secret).verify,
    rawBody,
    signature,
    log,
    eventName ?? undefined,
  );
  if (!valid) {
    log?.warn(
      { event: eventName ?? "signature_verification_failed", reason: "signature_verification_failed", detail: "HMAC did not verify (or malformed)" },
      "webhook rejected with 401 — signature verification failed",
    );
    return { kind: "reject", status: 401, reason: "signature verification failed" };
  }
  return classifyEvent(eventName, rawBody, log, trigger);
}

/**
 * Event whitelist. Returns `ignore` for everything else.
 *
 * Outcomes are not review jobs only: `pull_request` / `issue_comment` map to a
 * `job` carrying `ReviewJobPayload`, while `installation` maps to the
 * `installation` outcome — the install-bookkeeping face that records
 * `account_login` without enqueuing anything.
 *
 * `trigger` is the per-App trigger context (spec review-trigger-policy §2):
 * `mode` gates the pull_request auto face (§2.1 matrix) and `appSlug` (the
 * row's GitHub slug) keys the issue_comment bot mention (§3). Defaults to
 * `every_push` with no mention target.
 */
export function classifyEvent(
  eventName: string | null,
  rawBody: string,
  log?: HandlerLog,
  trigger: ReviewTriggerContext = { mode: "every_push", appSlug: "" },
): WebhookOutcome {
  if (!eventName) {
    return { kind: "ignore", reason: "missing X-GitHub-Event header" };
  }
  if (eventName === "pull_request") {
    return classifyPullRequest(rawBody, trigger.mode);
  }
  if (eventName === "issue_comment") {
    return classifyIssueComment(rawBody, log, trigger.appSlug);
  }
  if (eventName === "installation") {
    return classifyInstallation(rawBody);
  }
  return { kind: "ignore", reason: `event ${eventName} is not whitelisted` };
}

/**
 * `installation.{created,new_permissions_accepted}` → the installing account's
 * login. This is the one path that observes a fresh install before any review
 * traffic exists, so it is the reason `app_installations.account_login` can be
 * filled at all.
 *
 * Every malformed case is a 400 reject, exactly like the sibling classifiers:
 * GitHub retries non-2xx, but a payload that cannot name an installation is
 * not something a retry fixes.
 */
function classifyInstallation(rawBody: string): WebhookOutcome {
  const parsed = parseBody(rawBody);
  if (parsed === null) {
    return { kind: "reject", status: 400, reason: "invalid JSON body" };
  }
  const result = installationEventSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: "reject", status: 400, reason: "installation payload failed validation" };
  }
  const { action, installation } = result.data;
  if (!(INSTALLATION_ACTIONS as readonly string[]).includes(action)) {
    return { kind: "ignore", reason: `installation action ${action} is not whitelisted` };
  }
  if (installation?.id === undefined) {
    return { kind: "reject", status: 400, reason: "installation payload missing required fields" };
  }
  return {
    kind: "installation",
    installationId: installation.id,
    accountLogin: installation.account?.login ?? null,
    accountAuthoritative: true,
  };
}

function classifyPullRequest(rawBody: string, mode: ReviewTriggerMode): WebhookOutcome {
  const parsed = parseBody(rawBody);
  if (parsed === null) {
    return { kind: "reject", status: 400, reason: "invalid JSON body" };
  }
  const result = pullRequestSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: "reject", status: 400, reason: "pull_request payload failed validation" };
  }
  const { action, installation, pull_request, repository } = result.data;
  if (!(PULL_REQUEST_ACTIONS as readonly string[]).includes(action)) {
    return { kind: "ignore", reason: `pull_request action ${action} is not whitelisted` };
  }
  const installationId = installation?.id;
  const owner = repository?.owner.login;
  const repo = repository?.name;
  const prNumber = pull_request?.number ?? result.data.number;
  const headSha = pull_request?.head?.sha ?? null;
  // Malformed-payload reject BEFORE the mode gate: reject stays reserved for
  // malformed payloads in EVERY mode (spec §2.1 — exactly as today).
  if (installationId === undefined || owner === undefined || repo === undefined || prNumber === undefined) {
    return { kind: "reject", status: 400, reason: "pull_request payload missing required fields" };
  }
  const authorIgnore = ignoredForAuthor(pull_request?.user?.login);
  if (authorIgnore) {
    return authorIgnore;
  }
  // The install's own account wins: the payload states it, whereas the owner
  // is only the inference a delivery without `installation.account` allows.
  // Whichever source supplied it, a review delivery is INFERRED for the store.
  const installationAccount = installationAccountOf(installation, owner);
  // §2.1 matrix: the mode gates the auto face (manual never auto-triggers;
  // open is opened-only). The bot-mention comment face is orthogonal.
  if (!autoTriggerAllows(mode, action)) {
    return { kind: "ignore", reason: `pull_request action ${action} does not auto-trigger in ${mode} mode` };
  }
  return {
    kind: "job",
    payload: {
      installation_id: installationId,
      owner,
      repo,
      pr_number: prNumber,
      head_sha: headSha,
      action,
      triggered_by: "pull_request",
    },
    installationAccount,
    accountAuthoritative: false,
  };
}

function classifyIssueComment(rawBody: string, log: HandlerLog | undefined, appSlug: string): WebhookOutcome {
  const parsed = parseBody(rawBody);
  if (parsed === null) {
    return { kind: "reject", status: 400, reason: "invalid JSON body" };
  }
  const result = issueCommentSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: "reject", status: 400, reason: "issue_comment payload failed validation" };
  }
  const { action, installation, comment, issue, repository, sender } = result.data;
  if (action !== "created") {
    return { kind: "ignore", reason: `issue_comment action ${action} is not whitelisted` };
  }
  // Malformed payloads reject before any policy gate, exactly as on the
  // pull_request face: 400 stays reserved for what a retry cannot repair.
  const installationId = installation?.id;
  const owner = repository?.owner.login;
  const repo = repository?.name;
  const prNumber = issue?.number;
  if (installationId === undefined || owner === undefined || repo === undefined || prNumber === undefined) {
    return { kind: "reject", status: 400, reason: "issue_comment payload missing required fields" };
  }
  // Bot authorship outranks the mention grammar: a PR opened by a bot is
  // ignored whatever the comment says, and reaching the mention check first
  // would report MENTION_MISS_REASON on an unsynced App — a false
  // `mention_unresolved` warn whose remedy cannot change the outcome.
  if (issue?.pull_request == null) {
    return { kind: "ignore", reason: "comment is not on a pull request thread" };
  }
  const authorIgnore = ignoredForAuthor(issue?.user?.login);
  if (authorIgnore) {
    return authorIgnore;
  }
  // Bare mention (spec review-trigger-policy §3): the body must contain the
  // resolved App's `@{appSlug}` as a standalone token — any position, no
  // required wording. Keyed to the route-resolved slug, so one App's mention
  // never triggers another App.
  const body = comment?.body ?? "";
  if (!bodyMentionsApp(body, appSlug)) {
    return { kind: "ignore", reason: MENTION_MISS_REASON };
  }
  if (sender?.type === "Bot") {
    return { kind: "ignore", reason: "comment sent by a bot (self-comment loop guard)" };
  }
  // Actor allowlist (B5): only the PR author or the repository owner may
  // trigger a review. Ignore + structured log otherwise (quota abuse guard).
  const actorLogin = sender?.login ?? null;
  const authorLogin = issue?.user?.login ?? null;
  const ownerLogin = repository?.owner?.login ?? null;
  if (actorLogin === null || (actorLogin !== authorLogin && actorLogin !== ownerLogin)) {
    log?.warn(
      {
        // Log hygiene: this warn is only reachable via
        // classifyEvent("issue_comment", …), so `event` carries the REAL
        // GitHub event — filterable, never the literal "unknown".
        event: "issue_comment",
        reason: "actor_not_allowed",
        detail: `actor=${actorLogin ?? "null"} author=${authorLogin ?? "null"} owner=${ownerLogin ?? "null"}`,
      },
      "bot mention ignored — commenter is not the PR author or repo owner",
    );
    return { kind: "ignore", reason: "comment actor is not the PR author or repo owner" };
  }
  // Same authority as the pull_request face: the payload's own
  // `installation.account.login`, with the repository owner as the fallback —
  // and inferred either way, since this is not an install statement.
  const installationAccount = installationAccountOf(installation, owner);
  return {
    kind: "job",
    payload: {
      installation_id: installationId,
      owner,
      repo,
      pr_number: prNumber,
      head_sha: null,
      action: "created",
      triggered_by: "issue_comment",
    },
    installationAccount,
    accountAuthoritative: false,
  };
}

/**
 * RFC 3339 (what GitHub stamps) — the ledger's `last_seen_at` input. A value
 * that fails this is treated as ABSENT by the caller rather than handed to
 * SQLite's `datetime()`, which silently returns NULL for junk and would let
 * the store's "no timestamp" fallback masquerade as a real clock.
 */
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * The per-App PR ledger record for one `pull_request` delivery (migration
 * 0039) — the fields the dashboard reads, never a classification. `null` when
 * the payload cannot supply the ledger's identity (owner / repo / number) or
 * its state, so an unrecordable delivery records nothing rather than inventing
 * a value: the ledger's `state` domain is GitHub's own ('open' | 'closed'),
 * promoted to 'merged' when the payload says so.
 *
 * Deliberately a SECOND parse of the same body: `classifyEvent` returns the
 * identity only on a `job`, and the ledger must also record the `ignore`
 * outcomes (a non-whitelisted action, a mode that does not auto-trigger).
 */
export function pullRequestRecord(rawBody: string): {
  owner: string;
  repo: string;
  prNumber: number;
  title: string | null;
  state: string;
  headSha: string | null;
  updatedAt: string | null;
} | null {
  const parsed = parseBody(rawBody);
  if (parsed === null) return null;
  const result = pullRequestSchema.safeParse(parsed);
  if (!result.success) return null;
  const { pull_request, repository } = result.data;
  const owner = repository?.owner.login;
  const repo = repository?.name;
  const prNumber = pull_request?.number ?? result.data.number;
  const state = pull_request?.merged === true ? "merged" : pull_request?.state;
  if (owner === undefined || repo === undefined || prNumber === undefined) return null;
  if (state === undefined || state === null || state === "") return null;
  return {
    owner,
    repo,
    prNumber,
    title: pull_request?.title ?? null,
    state,
    headSha: pull_request?.head?.sha ?? null,
    // Only a well-formed stamp rides through; junk degrades to "no stamp",
    // which the store resolves to now EXPLICITLY.
    updatedAt: RFC3339.test(pull_request?.updated_at ?? "") ? (pull_request?.updated_at ?? null) : null,
  };
}

function parseBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
