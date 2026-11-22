import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";
import { normalizeRfc3339 } from "../contracts/rfc3339";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { ReviewTriggerMode } from "../dashboard/targets-store";
import type { HandlerLog } from "./handlers";

export const PULL_REQUEST_ACTIONS = ["opened", "synchronize", "reopened", "ready_for_review"] as const;

/**
 * The install actions that carry the installing account's login
 * (`installation.account.login`). Both mean "this App is installed and
 * usable right now", which is when the settings table should stop reading
 * `未知`. `deleted` is classified by its own outcome (the installation's
 * removal), and the remaining lifecycle actions (`suspend`, `unsuspend`,
 * `added`, `removed`) stay ignored.
 */
export const INSTALLATION_ACTIONS = ["created", "new_permissions_accepted"] as const;

/**
 * The per-App trigger inputs classification branches on (spec
 * review-trigger-policy §2/§3 read path): the resolved target's
 * `review_trigger_mode` and the bot's GitHub slug (the mention target — one
 * App's mention never triggers another App). The mention login is GitHub's
 * mutable `github_slug`, never our local webhook path or the row id. The
 * per-App webhook route passes both from the rows it resolved — no second
 * lookup. An omitted context defaults to `every_push` with NO mention target
 * (empty slug never matches — fail-safe: no trigger rather than a spurious
 * one).
 */
export type ReviewTriggerContext = {
  mode: ReviewTriggerMode;
  appSlug: string;
  reviewDrafts?: boolean;
};

const DEFAULT_TRIGGER: ReviewTriggerContext = { mode: "every_push", appSlug: "" };

/**
 * The delivery's install identity and source repository, read from the
 * already-parsed body — the two facts a target resolves from (migration 0067:
 * a target is a repository, not an installation). This is GitHub's
 * installation number, not our row id, and `repository.id` is GitHub's numeric
 * repository identity (`null` when the payload omits it, which resolves by
 * owner/name).
 */
export type DeliveryIdentity = {
  installationId: number | null;
  repository: { id: number | null; owner: string; name: string } | null;
};

export type ReviewTriggerResolver = (delivery: DeliveryIdentity) => Promise<ReviewTriggerContext | null>;

/**
 * The classification of a delivery with no resolved review target. It is an
 * `ignore` — the delivery is verified and correctly refused, not rejected —
 * and the route logs it under this exact reason.
 */
export const NO_TARGET_REASON = "no review target resolves for this delivery";

const LOGIN_CONTINUATION = /[A-Za-z0-9-]/;

function asciiFoldEquals(a: string, b: string): boolean {
  if (a === b) {
    return true;
  }
  if (a.charCodeAt(0) > 127 || b.charCodeAt(0) > 127) {
    return false;
  }
  return a.toLowerCase() === b.toLowerCase();
}

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
    if (end > i + 1 && !LOGIN_CONTINUATION.test(i > 0 ? body[i - 1]! : "")) {
      return true;
    }
    i = body.indexOf("@", i + 1);
  }
  return false;
}

function autoTriggerAllows(mode: ReviewTriggerMode, action: string): boolean {
  if (mode === "manual") {
    return false;
  }
  return mode === "open" ? action === "opened" || action === "ready_for_review" : true;
}

const BOT_LOGIN = /\[bot\]$/i;

const BOT_PR_REASON = "PR authored by a bot account";

const MISSING_AUTHOR_REASON = "payload carried no PR author login";

/**
 * The classifier's ignore reason for a draft PR the target holds back
 * (migration 0070). An ORDINARY ignore — 200, delivery row `ignored`, PR
 * ledger row recorded, no queue send, no Check attach, no failure insert —
 * never a new failure stage.
 */
export const DRAFT_PULL_REQUEST_REASON = "draft pull request";

const BOT_AUTHOR_LABEL = "bot_author";
const MISSING_AUTHOR_LABEL = "missing_author";

function ignoredForAuthor(
  login: string | null | undefined,
  event: "pull_request" | "issue_comment",
  prNumber: number,
  log?: HandlerLog,
): WebhookOutcome | null {
  const isBot = login ? BOT_LOGIN.test(login) : false;
  if (login && !isBot) {
    return null;
  }
  log?.info(
    {
      event,
      reason: isBot ? BOT_AUTHOR_LABEL : MISSING_AUTHOR_LABEL,
      detail: `author=${login || "null"} pr=${prNumber}`,
    },
    "review skipped — PR author is not reviewable",
  );
  return { kind: "ignore", reason: isBot ? BOT_PR_REASON : MISSING_AUTHOR_REASON };
}

/** Webhook body size cap (B6): checked BEFORE the body is buffered (413). */
export const WEBHOOK_BODY_LIMIT = 1_000_000;

type VerifierCacheEntry = { secret: string; webhooks: Webhooks };

const webhooksCache = new Map<string, VerifierCacheEntry>();

export function getWebhooks(cacheKey: string, secret: string): Webhooks {
  const cached = webhooksCache.get(cacheKey);
  if (cached !== undefined && cached.secret === secret) {
    return cached.webhooks;
  }
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
 * Classifier outcome. The `job` payload NEVER carries `botRef` or `targetId`
 * (AL-24-2/4): the classifier is secret-parameterized only and never sees the
 * bot or target identity — the ONLY production attach point is the per-App
 * `POST /webhook/:workspaceId/:appId` route, which adds both after
 * classification, before enqueue.
 */
export type WebhookOutcome =
  | { kind: "reject"; status: 400 | 401 | 500; reason: string }
  | { kind: "ignore"; reason: string }
  | {
      kind: "job";
      payload: Omit<ReviewJobPayload, "botRef" | "targetId">;
      installationAccount: string;
      accountAuthoritative: false;
    }
  | {
      kind: "installation";
      installationId: number;
      accountLogin: string | null;
      accountAuthoritative: true;
    }
  | { kind: "installation_removed"; installationId: number };

const installationAccountSchema = z.object({ login: z.string().min(1) }).nullable().optional();
const installationSchema = z
  .object({ id: z.number(), account: installationAccountSchema })
  .nullable()
  .optional();
const repositorySchema = z
  .object({
    name: z.string(),
    owner: z.object({ login: z.string() }),
    full_name: z.string().min(1).optional(),
    id: z.number().int().optional(),
  })
  .nullable()
  .optional();

function installationAccountOf(
  installation: { account?: { login: string } | null } | null | undefined,
  owner: string,
): string {
  const login = installation?.account?.login;
  return login ? login : owner;
}

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
      user: z.object({ login: z.string().optional() }).nullable().optional(),
      draft: z.boolean().optional(),
      title: z.string().nullable().optional(),
      state: z.string().nullable().optional(),
      merged: z.boolean().nullable().optional(),
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
  comment: z.object({ body: z.string(), id: z.number().int().positive().optional() }).nullable().optional(),
  issue: z
    .object({
      number: z.number(),
      user: z.object({ login: z.string().optional() }).nullable().optional(),
      pull_request: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  repository: repositorySchema,
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
 * passes its `review_bots.id`; the classifier NEVER branches on it (same
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
 * target's mode + the bot's slug, passed straight to the classifier — the
 * classifier branches on it but still never sees a bot or target id.
 *
 * …or a RESOLVER, for the route that can only know a delivery's installation
 * after the body is parsed: it is called BETWEEN signature verification and
 * classification, so a target is never selected from a body nobody has
 * authenticated. `null` from it means no target resolves, and the delivery
 * classifies as the `NO_TARGET_REASON` ignore — no trigger mode is invented
 * for a delivery that has no review configuration.
 */
export async function classifyWebhook(
  secret: string,
  rawBody: string,
  signature: string | null,
  eventName: string | null,
  log?: HandlerLog,
  cacheKey?: string,
  trigger: ReviewTriggerContext | ReviewTriggerResolver = DEFAULT_TRIGGER,
  onParsed?: (parsed: unknown) => void,
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
  const parsed = parseBody(rawBody);
  onParsed?.(parsed);
  if (typeof trigger === "function" && (eventName === "pull_request" || eventName === "issue_comment")) {
    const identity = deliveryIdentityOf(parsed);
    if (identity.installationId !== null && identity.repository !== null) {
      const resolved = await trigger(identity);
      if (resolved === null) return { kind: "ignore", reason: NO_TARGET_REASON };
      return classifyParsed(eventName, parsed, log, resolved);
    }
  }
  return classifyParsed(eventName, parsed, log, typeof trigger === "function" ? DEFAULT_TRIGGER : trigger);
}

function deliveryIdentityOf(parsed: unknown): DeliveryIdentity {
  if (typeof parsed !== "object" || parsed === null) return { installationId: null, repository: null };
  const installation = "installation" in parsed ? parsed.installation : null;
  const installationId =
    typeof installation === "object" &&
    installation !== null &&
    "id" in installation &&
    typeof installation.id === "number"
      ? installation.id
      : null;
  const result = repositorySchema.safeParse("repository" in parsed ? parsed.repository : null);
  const repository = result.success ? result.data : null;
  return {
    installationId,
    repository:
      repository === null || repository === undefined
        ? null
        : { id: repository.id ?? null, owner: repository.owner.login, name: repository.name },
  };
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
 * bot's GitHub slug) keys the issue_comment bot mention (§3). Defaults to
 * `every_push` with no mention target.
 */
export function classifyEvent(
  eventName: string | null,
  rawBody: string,
  log?: HandlerLog,
  trigger: ReviewTriggerContext = DEFAULT_TRIGGER,
  onParsed?: (parsed: unknown) => void,
): WebhookOutcome {
  const parsed = parseBody(rawBody);
  onParsed?.(parsed);
  return classifyParsed(eventName, parsed, log, trigger);
}

function classifyParsed(
  eventName: string | null,
  parsed: unknown,
  log: HandlerLog | undefined,
  trigger: ReviewTriggerContext,
): WebhookOutcome {
  if (!eventName) {
    return { kind: "ignore", reason: "missing X-GitHub-Event header" };
  }
  if (eventName === "pull_request") {
    return classifyPullRequest(parsed, trigger.mode, log, trigger.reviewDrafts);
  }
  if (eventName === "issue_comment") {
    return classifyIssueComment(parsed, log, trigger.appSlug);
  }
  if (eventName === "installation") {
    return classifyInstallation(parsed);
  }
  return { kind: "ignore", reason: `event ${eventName} is not whitelisted` };
}

function classifyInstallation(parsed: unknown): WebhookOutcome {
  if (parsed === null) {
    return { kind: "reject", status: 400, reason: "invalid JSON body" };
  }
  const result = installationEventSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: "reject", status: 400, reason: "installation payload failed validation" };
  }
  const { action, installation } = result.data;
  const removed = action === "deleted";
  if (!removed && !(INSTALLATION_ACTIONS as readonly string[]).includes(action)) {
    return { kind: "ignore", reason: `installation action ${action} is not whitelisted` };
  }
  if (installation?.id === undefined) {
    return { kind: "reject", status: 400, reason: "installation payload missing required fields" };
  }
  if (removed) {
    return { kind: "installation_removed", installationId: installation.id };
  }
  return {
    kind: "installation",
    installationId: installation.id,
    accountLogin: installation.account?.login ?? null,
    accountAuthoritative: true,
  };
}

function classifyPullRequest(
  parsed: unknown,
  mode: ReviewTriggerMode,
  log?: HandlerLog,
  reviewDrafts?: boolean,
): WebhookOutcome {
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
  const headAt = normalizeRfc3339(pull_request?.updated_at);
  if (installationId === undefined || owner === undefined || repo === undefined || prNumber === undefined) {
    return { kind: "reject", status: 400, reason: "pull_request payload missing required fields" };
  }
  const authorIgnore = ignoredForAuthor(pull_request?.user?.login, "pull_request", prNumber, log);
  if (authorIgnore) {
    return authorIgnore;
  }
  if (pull_request?.draft === true && reviewDrafts === false && action !== "ready_for_review") {
    return { kind: "ignore", reason: DRAFT_PULL_REQUEST_REASON };
  }
  const installationAccount = installationAccountOf(installation, owner);
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
      ...(headAt === undefined ? {} : { head_at: headAt }),
      action,
      triggered_by: "pull_request",
    },
    installationAccount,
    accountAuthoritative: false,
  };
}

function classifyIssueComment(parsed: unknown, log: HandlerLog | undefined, appSlug: string): WebhookOutcome {
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
  const installationId = installation?.id;
  const owner = repository?.owner.login;
  const repo = repository?.name;
  const prNumber = issue?.number;
  if (installationId === undefined || owner === undefined || repo === undefined || prNumber === undefined) {
    return { kind: "reject", status: 400, reason: "issue_comment payload missing required fields" };
  }
  if (issue?.pull_request == null) {
    return { kind: "ignore", reason: "comment is not on a pull request thread" };
  }
  const authorIgnore = ignoredForAuthor(issue?.user?.login, "issue_comment", prNumber, log);
  if (authorIgnore) {
    return authorIgnore;
  }
  const body = comment?.body ?? "";
  if (!bodyMentionsApp(body, appSlug)) {
    return { kind: "ignore", reason: MENTION_MISS_REASON };
  }
  if (sender?.type === "Bot") {
    return { kind: "ignore", reason: "comment sent by a bot (self-comment loop guard)" };
  }
  const actorLogin = sender?.login ?? null;
  const authorLogin = issue?.user?.login ?? null;
  const ownerLogin = repository?.owner?.login ?? null;
  if (actorLogin === null || (actorLogin !== authorLogin && actorLogin !== ownerLogin)) {
    log?.warn(
      {
        event: "issue_comment",
        reason: "actor_not_allowed",
        detail: `actor=${actorLogin ?? "null"} author=${authorLogin ?? "null"} owner=${ownerLogin ?? "null"}`,
      },
      "bot mention ignored — commenter is not the PR author or repo owner",
    );
    return { kind: "ignore", reason: "comment actor is not the PR author or repo owner" };
  }
  const installationAccount = installationAccountOf(installation, owner);
  return {
    kind: "job",
    payload: {
      installation_id: installationId,
      owner,
      repo,
      pr_number: prNumber,
      head_sha: null,
      ...(comment?.id === undefined ? {} : { comment_id: comment.id }),
      action: "created",
      triggered_by: "issue_comment",
    },
    installationAccount,
    accountAuthoritative: false,
  };
}

/**
 * The per-App PR ledger record for one `pull_request` delivery (migration
 * 0039) — the fields the dashboard reads, never a classification. `null` when
 * the payload cannot supply the ledger's identity (owner / repo / number) or
 * its state, so an unrecordable delivery records nothing rather than inventing
 * a value: the ledger's `state` domain is GitHub's own ('open' | 'closed'),
 * promoted to 'merged' when the payload says so.
 *
 * Takes the ALREADY PARSED body (the one `classifyEvent` read), never the raw
 * text: the ledger must also record the `ignore` outcomes — a non-whitelisted
 * action, a mode that does not auto-trigger — which the classifier's outcome
 * does not carry, so it reads the same document instead of parsing it again.
 */
export function pullRequestRecord(parsed: unknown): {
  owner: string;
  repo: string;
  prNumber: number;
  title: string | null;
  state: string;
  headSha: string | null;
  updatedAt: string | null;
} | null {
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
    updatedAt: normalizeRfc3339(pull_request?.updated_at) ?? null,
  };
}

/**
 * The delivery's SOURCE repository (`owner/name`) — the diagnostics face's
 * "which repo did this delivery come from?" answer, which the delivery row
 * could not give before migration 0043. `repository.full_name` wins when
 * GitHub states it; the same block's `owner.login` + `name` pair is the
 * fallback. `null` when the document carries no `repository`, or states
 * neither form.
 *
 * Takes the ALREADY PARSED body (the one `classifyEvent` read), never the raw
 * text: a delivery record must not re-parse the payload the classifier just
 * parsed. That document is also why the field is trusted: `classifyEvent` runs
 * only after `verifySignature` succeeds, so `null` (no classification ran) or
 * a document both mean an HMAC-verified body — never an unauthenticated one.
 * The store still truncates the value as defence-in-depth against GitHub's own
 * name ceilings; unlike `event_name` (an x-github-event HEADER, which the
 * unauthenticated reject path does reach), that bound is not a payload bound.
 *
 * The preferred source is read on its own: a delivery that states only
 * `full_name`, or states it beside a malformed `owner`/`name`, still has the
 * authoritative name. Each field degrades to absent (`.catch`) instead of
 * failing the whole read, so junk in one component cannot discard another.
 *
 * Never throws: this rides the best-effort delivery-recording path, so a
 * malformed body degrades to "unknown source" rather than costing the row.
 */
export function webhookRepositoryFullName(parsed: unknown): string | null {
  if (parsed === null) return null;
  const result = z
    .object({
      repository: z
        .object({
          full_name: z.string().min(1).nullish().catch(null),
          name: z.string().nullish().catch(null),
          owner: z.object({ login: z.string() }).nullish().catch(null),
        })
        .nullish()
        .catch(null),
    })
    .safeParse(parsed);
  if (!result.success) return null;
  const repository = result.data.repository;
  if (!repository) return null;
  if (repository.full_name) return repository.full_name;
  const login = repository.owner?.login ?? "";
  const name = repository.name ?? "";
  return login === "" || name === "" ? null : `${login}/${name}`;
}

function parseBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
