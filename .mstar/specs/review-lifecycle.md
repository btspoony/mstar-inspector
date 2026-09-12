# Review lifecycle (review-lifecycle)

> **Status:** Locked by PM, 2026-09-12, after product-manager review, architect review with correction continuation, and writing-specialist corpus hygiene. Product direction D1–D9 is preserved. This locks the contract; implementation remains unstarted under mode pause.
> **Cross-iteration authority:** This tracked file contains the normative schemas, APIs, state machines, ordering and recovery contracts. Plans 67/68 own assignments, current source anchors and scoped verification commands, not a second normative contract.
> **Related authority:** [github-review-comment-mapping.md](github-review-comment-mapping.md) owns COMMENT-only publication vocabulary. The harness `mstar.review/v1` envelope and engine verdict remain unchanged. The local compass records D1–D9 verbatim; no normative contract below requires an ignored plan to interpret it.

## 1. Scope and user value

M8 verifies retained earlier findings against current code and discussion, renders closure in the existing overall comment, automatically resolves positively verified Inspector-owned threads, and recovers publication/lifecycle/resolution work without rerunning a paid review. M7 subsequently adds advisory execution Checks. M8 is independently deliverable; M7 depends on its publication contracts. Neither the model nor the Sandbox gains code-write, push or merge authority.

## 2. Binding user decisions

- **D1:** Two serial business plans: M8 (67) before M7 (68).
- **D2:** Relevant discussion is untrusted evidence, not instructions or natural-language commands.
- **D3:** Normal review publication means Check success for every engine verdict; confirmed degraded publication means neutral; execution failure means failure. Check failure never blocks primary publication.
- **D4:** Closure belongs in the existing single overall-comment upsert, not another closure comment.
- **D5:** One fresh-App contract, no old-App migration/permission-acceptance UX, compatibility layer or rollout toggle. The user deletes old test Apps; agents do not delete Apps or data. Forward-only feature migrations are allowed.
- **D6:** Automatic resolution after evidence-backed verification is required. Only exactly mapped Inspector-owned threads; absence-only, unresolved concerns, unverifiable evidence, stale HEAD and failed API calls never authorize a resolve claim.
- **D7:** Worker-only contents:write is authorized for resolution. Sandbox tokens are explicitly repository-scoped and read-only; broad tokens never enter Sandbox, prompts, files or logs.
- **D8:** origin/main → iteration/021-review-lifecycle → final PR main; primary main checkout remains the local harness control directory. Feature worktrees belong to future implementation.
- **D9:** Pause after the sequential preparation chain and PM-owned lock/integration delivery. This architecture pass performs documentation changes only, not implementation, Git writes, deployment or live mutations.

## 3. Product requirements

- **RL-1:** Typed evidence, never prose parsing or fingerprint absence, determines addressed/dismissed/unverifiable. Conflicts and omissions remain conservative.
- **RL-2:** A stable lifecycle row and an exact App-owned original publication/thread association authorize lookup. Model/user thread IDs, generic Bot authorship and copied markers do not authorize mutation.
- **RL-3:** Verified HEAD and the discussion actually inspected must still match immediately before resolution. GitHub `isOutdated` is an anchor-rendering flag, not a stale verification; an owned outdated thread remains eligible after a real fix.
- **RL-4:** API failure, ambiguous response and retry exhaustion stay visible and durable. No false resolved/success claim; no paid review replay solely to repair side effects.
- **RL-5:** Unresolved concerns survive any number of rounds. Explicit recurrence reopens a closed concern, preserves history and supersedes old thread associations rather than mutating old resolved threads.
- **RL-6:** Sandbox read-only/repository restriction is checked against the returned grant. Every Worker client is explicitly purpose-scoped and routed by exact App and installation.
- **RL-7:** Discussions and findings are untrusted evidence. No command interpretation, arbitrary resolution or model-supplied credentials/remote identity.
- **RL-8:** Bounded closure in one overall comment distinguishes finding disposition from actual thread state. Repeat display/tally behavior and engine verdict/score authority are unchanged.
- **RL-9:** Publication precedes all **published result** writes and thread mutations. Record classes are disjoint: (a) execution attempts/leases contain no findings; (b) a **private pre-publication recovery journal** may hold a validated/redacted complete payload, but is not a published result and has no dashboard/insights/settings/HTTP/reporting read exposure; (c) `reviews`, `findings`, lifecycle rows and associations are applied only after positive publication proof. This explicit journal exception replaces the earlier comment-before-any-data formulation, which could not recover the publish→persist crash window. Check failure terminalization without publication remains allowed; it carries execution facts, not a fabricated result.
- **RL-10:** Eligible attempts show in-progress Checks at the authoritative SHA. Desired conclusion is derived from publication proof, separately from observed remote state; remote update failure never converts a proven publication into execution failure. Genuine skip paths create no new Check.
- **RL-11:** Fresh-App manifest/docs/test contracts agree; no legacy fallback, dual commit-status writes, annotations or rerun UI.
- **RL-12:** Local fencing is not external exactly-once. GitHub offers neither conditional thread resolve nor idempotent Check/comment creation. Remaining remote races and unknown outcomes are stated honestly. No invented details URL or live-verification claim.

## 4. Deferred candidates

| Candidate | Owner | Trigger | Done definition |
|---|---|---|---|
| Check rerequested, annotations, check-suite triggers | PM/product-manager | Explicit user demand after this delivery | Approved plan, implementation evidence and updated contract |
| `/review` command extensions | PM/product-manager | Explicit user demand revising RL-7 | Approved command/authorization contract and evidence |
| Fuzzy/alias thread re-anchoring | PM/product-manager | Explicit user demand revising exact mapping | Approved plan with detection/undo story and evidence; **not implemented here** |

Deferring fuzzy matching does **not** prohibit checking an existing row's original concern against current code or resolving its already-known thread. New-finding fingerprint drift alone never invalidates that association. Actual conflicting concern evidence stays unverifiable. Commit-status dual writing is a permanent non-goal.

## 5. Non-goals

No App/data deletion, old-App backfill, broad historical scans, code edits by reviewers, merge approval, natural-language commands, harness body/schema changes, new dashboard result pages, or unrequested live/E2E workflow. Existing review pause/kill-switch governs new work; recovery policy is explicit in §7.6.

## 6. Plan mapping

- **67 / M8:** RL-1–RL-9, RL-11/12; §7.0–§7.8, §7.10, §7.11.1 and its own cron composition.
- **68 / M7:** RL-10–RL-12; §7.9 and §7.11.2, extending the M8 credential/composition.
- Both: §7.12–§7.13. Cross-plan consumer/manifest writes are serial. No implementation task is complete in preparation.

## 7. Normative technical contract

### 7.0 Conventions and ownership

`appId` is the internal `github_apps.id`; `githubAppId` is its numeric `github_app_id`. They are not interchangeable. Installation and repository ownership are authenticated routing information, never model content. All new queries bind the complete scope `(appId, installationId, owner, repo, prNumber)`; owner/repo are canonicalized from authenticated repository metadata. Multiple Apps may legitimately access one repository. Reinstallation with a new installation ID is a new authorization scope, not permission to adopt old-App history.

New IDs are Worker-generated UUIDs. Fingerprints retain `computeFindingFingerprint` semantics, including arbitrary nonblank hints; they are not remote markers or authorization tokens. Timestamps below are integer Unix milliseconds from one supplied clock per transaction, avoiding mixed SQLite datetime/ISO comparison. Every multi-row local transition uses `D1Like.batch`; claims use conditional SQL and inspect `meta.changes`. No KV CAS assumption. All stored model/error text is redacted and bounded; journal payloads never contain credentials.

### 7.1 Storage schema

Plan 67 creates **`migrations/0020_finding_lifecycle.sql`**. Existing migrations are untouched.

```sql
CREATE TABLE review_publications (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES github_apps(id),
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('review','degraded')),
  phase TEXT NOT NULL CHECK(phase IN ('prepared','sending','confirmed','applied','failed','unknown','superseded')),
  payload_json TEXT NOT NULL,
  proof_json TEXT,
  holder TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER,
  recovery_state TEXT NOT NULL DEFAULT 'pending' CHECK(recovery_state IN ('pending','done','local-error','suspended')),
  last_error TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  confirmed_ms INTEGER, applied_ms INTEGER,
  UNIQUE(app_id, installation_id, owner, repo, pr_number, head_sha, kind)
);
CREATE INDEX idx_publication_recovery ON review_publications(recovery_state,next_attempt_ms,lease_until_ms);

CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES github_apps(id), installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
  finding_id TEXT NOT NULL, original_json TEXT NOT NULL,
  first_publication_id TEXT NOT NULL REFERENCES review_publications(id),
  last_publication_id TEXT NOT NULL REFERENCES review_publications(id),
  first_seen_sha TEXT NOT NULL, last_seen_sha TEXT NOT NULL,
  first_seen_round INTEGER NOT NULL, last_seen_round INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','addressed','dismissed')),
  last_assessment_json TEXT, reopen_count INTEGER NOT NULL DEFAULT 0,
  last_scheduled_ms INTEGER, last_assessed_ms INTEGER,
  created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  UNIQUE(app_id,installation_id,owner,repo,pr_number,finding_id)
);
CREATE INDEX idx_finding_rotation ON review_findings(app_id,installation_id,owner,repo,pr_number,state,last_scheduled_ms,id);

CREATE TABLE review_finding_rounds (
  id TEXT PRIMARY KEY, finding_row_id TEXT NOT NULL REFERENCES review_findings(id),
  publication_id TEXT NOT NULL REFERENCES review_publications(id),
  head_sha TEXT NOT NULL, round INTEGER NOT NULL,
  assessment_json TEXT NOT NULL, created_ms INTEGER NOT NULL,
  UNIQUE(finding_row_id,publication_id)
);

CREATE TABLE review_threads (
  id TEXT PRIMARY KEY,
  finding_row_id TEXT NOT NULL REFERENCES review_findings(id),
  publication_id TEXT NOT NULL REFERENCES review_publications(id),
  app_id TEXT NOT NULL REFERENCES github_apps(id), installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
  original_sha TEXT NOT NULL, round INTEGER NOT NULL,
  intent_json TEXT NOT NULL,
  review_id INTEGER, comment_id INTEGER, thread_id TEXT,
  resolution_state TEXT NOT NULL CHECK(resolution_state IN ('pending','retry','needs-recheck','resolved','abandoned','local-error','suspended')),
  verified_json TEXT,
  holder TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER,
  superseded_by_publication_id TEXT,
  resolved_ms INTEGER, late_change INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  UNIQUE(app_id,installation_id,comment_id)
);
CREATE INDEX idx_thread_recovery ON review_threads(resolution_state,next_attempt_ms,lease_until_ms);
```

`original_json` is the **original published finding**, not the latest title: body, original file/line range, title, class, category and fingerprint hint after the existing redaction/clamp. Recurrence does not overwrite it. Round assessments hold full validated evidence and the verified HEAD/discussion snapshot. Thread `id` is the preallocated association UUID in the journal; missing remote IDs denote a known intended association, not authority inferred from a marker. `verified_json` is non-null only for an accepted addressed assessment and contains §7.3 evidence plus §7.5 fences.

**Visibility:** the private journal is readable only by the consumer, M8 recovery and M7 publication-proof/conclusion reads. It is never joined by a reviewer-visible result API, even after apply. `listPublicationRecovery` belongs to M8 only; `readPublicationProof` may be used by consumer and M7. Result readers continue to query explicit public-result tables. This is verified with consumer-visible behavior, not a brittle source-text/exact-caller-count test. No inference that `applied_ms IS NULL` implies zero result rows: `store.put` may already have committed before a later lifecycle batch fails. Every such row still has confirmed publication proof.

Plan 68 creates **`migrations/0021_review_checks.sql`**:

```sql
CREATE TABLE review_checks (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES github_apps(id), github_app_id INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL, triggered_by TEXT NOT NULL, action TEXT NOT NULL,
  attempt_key TEXT NOT NULL, generation INTEGER NOT NULL,
  external_id TEXT NOT NULL UNIQUE, check_run_id INTEGER,
  create_state TEXT NOT NULL CHECK(create_state IN ('not-sent','sending','known','unknown')),
  holder TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER,
  execution_deadline_ms INTEGER NOT NULL,
  desired TEXT NOT NULL CHECK(desired IN ('in_progress','success','neutral','failure')),
  desired_title TEXT, desired_summary TEXT,
  observed TEXT NOT NULL CHECK(observed IN ('unknown','in_progress','success','neutral','failure')),
  recovery_state TEXT NOT NULL CHECK(recovery_state IN ('pending','done','remote-unconfirmed','local-error','suspended')),
  publication_id TEXT REFERENCES review_publications(id),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER,
  last_error TEXT, terminal_ms INTEGER,
  created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  UNIQUE(attempt_key,generation)
);
CREATE UNIQUE INDEX idx_check_one_open ON review_checks(attempt_key) WHERE terminal_ms IS NULL;
CREATE INDEX idx_check_recovery ON review_checks(recovery_state,next_attempt_ms,lease_until_ms);
```

The partial unique index, not merely `(key,generation)` uniqueness, prevents simultaneous active generations. A generation, `external_id` and known remote ID are never recycled. `terminal_ms` records local completion/give-up; remote observation remains separate. Terminal history is never silently overwritten by a fresh attempt.

### 7.2 Lifecycle state and fair scheduling

| Current state | New observation | Result |
|---|---|---|
| open | accepted addressed evidence, no conflict | addressed; resolution eligible only with complete matching fences |
| open | non-fix dismissal | dismissed; no automatic resolution |
| open | unverifiable, omitted, invalid, incomplete or capped | open |
| addressed or dismissed | a **later confirmed publication** reports the same fingerprint | open, increment reopen_count; retain original and assessment history |
| any | same publication replay | no duplicate round, scheduling update or reopen |

The current review's same-fingerprint recurrence takes precedence over recheck closure. Supersede **all** older associations for that concern; preserve their actual resolved/unresolved remote state and never unresolve/re-resolve them. A new round may create a fresh association, which alone is eligible after a later verification. Current-round recurrence is discovered after the runner, so it cannot be privileged in a pre-run query.

**Rotation:** query open rows only, ordered by `COALESCE(last_scheduled_ms,created_ms), id`, LIMIT `ASSESSMENT_TARGET_CAP` (25). All selected targets advance `last_scheduled_ms` when the confirmed publication applies, including invalid/omitted/timeout outputs; only truly assessed targets advance `last_assessed_ms`. Unselected rows do not change scheduling time and are represented by an aggregate cap count, not unbounded per-row inserts. New/reopened rows enter at current time behind already-waiting rows. There is no newest-updated or permanent never-assessed priority. For a finite stable backlog and completed rounds, every waiting row is visited within `ceil(backlog/25)` rounds; continuous unbounded arrivals or absence of new review rounds has no finite universal latency promise. Pre-publication crashes do not consume rotation. Pending confirmed journals are applied in original publication order before their scope's next lifecycle assessment; if local replay is unavailable, the normal review may publish with explicit context-unavailable coverage, but cannot close stale lifecycle state.

Fingerprint drift neither remaps a thread nor forces unverifiable. The reviewer receives the existing row's complete original concern. If it proves that concern fixed, the known association can resolve. A re-reported same concern under a changed hint, contradictory current finding or uncertain equivalence forces `unverifiable`/`identity-drift` or `conflict`, never false addressed. No fuzzy automatic alias/merge or transfer of remote thread identity.

### 7.3 Typed recheck and evidence contracts

`src/contracts/recheck.ts` is a zero-runtime-dependency shared wire module (type-only imports permitted). `ReviewFinding` and `MstarReviewV1` below are aliases to the engine's existing envelope/finding types, not replacement schemas. `ReviewArtifactDoc` is the existing type in `src/store/artifact-store.ts`; `D1Like` is the existing store port.

```ts
export type Scope = { appId: string; installationId: number; owner: string; repo: string; prNumber: number };
export type Coverage = 'complete' | 'truncated' | 'unavailable';
export type OriginalFinding = {
  title: string; body: string; filePath: string | null;
  lineStart: number | null; lineEnd: number | null;
  mergeClass: 'must-fix' | 'should-fix' | 'nit'; category: string | null;
  fingerprintHint: string | null;
};
export type RecheckTarget = {
  rowId: string; findingId: string; original: OriginalFinding;
  firstSeenSha: string; lastAssessment: Assessment | null;
  associationIds: string[];
};
export type EvidenceSlice = {
  id: string; headSha: string; baseSha: string; path: string;
  oldPath: string | null; kind: 'hunk' | 'deleted-file';
  oldStart: number; oldLines: string[]; newStart: number; newLines: string[];
  oldBlobOid: string | null; headBlobOid: string | null;
  absentAtHead: boolean; complete: boolean;
};
export type Evidence = {
  kind: 'current-code' | 'removed-code' | 'replaced-code';
  sliceId: string; startLine: number; endLine: number; quote: string;
  explanation: string;
};
export type Assessment = {
  rowId: string;
  disposition: 'addressed' | 'dismissed' | 'unverifiable';
  reason: 'verified-fix' | 'non-fix-dismissal' | 'conflict' | 'identity-drift' |
    'no-evidence' | 'omitted' | 'invalid-output' | 'budget' | 'context-incomplete' | 'stale-head';
  evidence: Evidence | null;
  relatedCurrentFindingIndexes: number[];
};
export type ThreadSnapshot = {
  associationId: string; threadId: string; commentId: number;
  headSha: string; digest: string; commentCount: number;
  capturedMs: number; coverage: Coverage; modelCoverage: Coverage;
};
export type Discussion = {
  items: { source: 'issue' | 'thread'; associationId: string | null;
    id: string; author: string; createdAt: string; updatedAt: string; body: string }[];
  issueCoverage: Coverage; issueDigest: string; capturedMs: number;
  threads: ThreadSnapshot[];
};
export type RecheckInput = {
  schema: 'mstar.recheck-input/v1'; headSha: string;
  targets: RecheckTarget[]; evidence: EvidenceSlice[]; discussion: Discussion;
};
export type RecheckDoc = { schema: 'mstar.recheck/v1'; headSha: string; results: Assessment[] };
export const RECHECK_OUTPUT_PATH = '/tmp/mstar-recheck.json';
export const RECHECK_MAX_TARGETS = 25;
export const ASSESSMENT_TARGET_CAP = 25;
export const RECHECK_MAX_RUNTIME_MS = 180_000;
export const RECHECK_MIN_REMAINING_MS = 30_000;
export const RECHECK_FILE_MAX_BYTES = 262_144;
export function validateRecheckDoc(value: unknown, input: RecheckInput):
  { ok: true; doc: RecheckDoc } | { ok: false; error: string };
```

**Trusted evidence catalog:** Worker-controlled capture, never model output, assigns slice IDs to the actual unified diff and immutable blobs for the reviewed head/base. Verify fetched PR head before/after diff capture equals checkout SHA; reject changed snapshots. `current-code` cites exact contiguous new-side lines within a real hunk and byte-equal content at that SHA. `removed-code` cites exact old-side lines intersecting the original finding range, with authenticated complete tree/blob evidence that the file or relevant code was removed; `replaced-code` cites the replaced old range plus its current hunk. Deleted-file evidence uses the old path/range and a complete head tree proving absence, not changedPaths membership or an ambiguous HTTP 404. An absent file needs no fabricated positive current line. Missing blobs, truncated patches/tree, binary files, unmatched original range or unsupported structural proof produce no eligible slice. The read-only model supplies the semantic explanation tying the change to the original bug; the validator proves location/content, not mathematical correctness of that explanation.

The catalog is built with trusted git/object reads of pinned SHAs, not arbitrary model shell commands. Diff capture plus catalog is bounded to 256 KiB; at most 4 slices per target, 80 lines/8 KiB per slice. Unsupported/oversized evidence is incomplete, not silently complete. Original finding text is the existing published/clamped content, never reduced to a title; input cap 512 KiB, oversized whole targets excluded with coverage rather than silently truncating their concern. No arbitrary filesystem path interpolation; reuse ShellCommand allowlisting/base64 transport and pin object refs.

**Validation:** exact schema/HEAD, strict object shape and closed enums; at most 25 results; unique row IDs contained in input; no remote IDs in output. Addressed requires `verified-fix`, an eligible complete catalog slice, integer ordered range entirely inside the appropriate old/new hunk, exact quote match (1–4096 chars) and nonblank explanation ≤1200 chars. Removed/replaced proof must intersect the original concern's old range and demonstrate the relevant structural change; renamed code alone is not proof of removal. Dismissed requires non-fix rationale (`explanation` via evidence when available, or the original discussion in input); it never resolves. `relatedCurrentFindingIndexes` are validated against the final current envelope by the consumer, not blindly trusted. Unverifiable may have no evidence. Duplicate/foreign/stale/malformed documents fail closed as a whole; omitted selected rows become unverifiable. Runner and Worker both validate; Worker uses its own retained input/catalog, not a returned model echo. The final engine envelope remains the independent authority.

### 7.4 Evidence, conflict and coverage decisions

- **Addressed:** affirmative current-code fix evidence, including removed/replaced code that demonstrates the original bug impossible. Structural verification is not fingerprint-absence inference and may resolve an outdated original thread.
- **Dismissed:** non-fix scope/triage decision (for example an out-of-scope concern), distinct from a verified code fix. No automatic thread resolve, regardless of the author's request.
- **Unverifiable:** default on missing proof, true identity ambiguity, incomplete inspected context, stale snapshot, timeout, invalid document or same-round conflicting concern.
- Consumer checks same fingerprint in current findings, exact normalized original `(path,line bucket,title)` equality under a different fingerprint, and model-reported related current finding indexes. Any unresolved related concern wins over addressed. A changed fingerprint alone without a related unresolved concern is not a conflict. Ambiguous matches do not mint identity or close rows.
- Complete thread fetch is not sufficient if its body/items were truncated before the model saw them: `modelCoverage` must also be complete. Issue discussion is captured newest-first with explicit coverage (§7.8). Incomplete issue discussion is allowed as read-only context but blocks automatic resolution for this assessment; no partial-context result is labelled complete.
- Every round records `{totalOpen, selected, assessed, omitted, capped, contextCoverage}` in its private payload and published coverage line. Persist per-row history only for selected rows plus actual current findings, not the unbounded backlog. `identity-drift` is a conservative ambiguity annotation, never a blanket ban on row-keyed verification.

### 7.5 Exact association, App ownership and resolution

**Opaque markers** (generated after sanitizing/clamping untrusted text):

```ts
export type LineIntent = {
  associationId: string; findingRowId: string; publicationId: string;
  scope: Scope; originalSha: string; round: number;
  path: string; line: number; body: string; bodySha256: string;
};
export type LineMarker = { publicationId: string; associationId: string };
export function lineMarker(marker: LineMarker): string;
export function parseLineMarker(body: string): LineMarker | null;
export type ResolveOutcome =
  | { kind: 'resolved'; threadId: string; adopted: boolean; outdated: boolean; lateChange: boolean }
  | { kind: 'needs-recheck'; reason: 'head-changed' | 'conversation-changed' | 'context-incomplete' | 'concern-unresolved' }
  | { kind: 'abandoned'; reason: 'foreign' | 'superseded' | 'identity-mismatch' }
  | { kind: 'retry'; reason: 'api' | 'lookup-incomplete' };
export type VerifiedResolution = {
  assessment: Assessment; snapshot: ThreadSnapshot;
  issueDigest: string; issueCoverage: Coverage;
};
export function discoverThread(input: {
  scope: Scope; intent: LineIntent; reviewId: number | null;
}): Promise<{ kind: 'found'; reviewId: number; commentId: number; threadId: string } |
  { kind: 'unknown' | 'ambiguous' | 'foreign' }>;
export function resolveFindingThread(input: {
  scope: Scope; associationId: string; verified: VerifiedResolution;
}): Promise<ResolveOutcome>;
```

Exact syntax: `<!-- mstar-inspector:thread:v1 publication=<uuid> association=<uuid> -->`. UUIDs use canonical lowercase UUID syntax; no fingerprint encoding, length assumption or parsing. The batch review body carries `<!-- mstar-inspector:line-batch:v1 publication=<uuid> -->`; its ID, intended bodies, paths, lines, SHA and round were durably prepared before sending. Model/user text cannot generate these markers: strip Inspector marker syntax from untrusted bodies before appending trusted markers. No legacy thread backfill.

**Discovery/adoption:** load the exact stored scope and publication payload; reject scope mismatch or unknown association before any API call. Require confirmed original primary publication, expected original line-review batch marker, original review commit SHA, App-author identity, root comment marker, exact original path/range and generated-body digest. A known returned `reviewId` must match exactly. If response loss left it unknown, inspect the known PR's bounded review batches and their root comments; accept only a unique complete match to the prepared batch intent. A copied marker at another review/round/SHA, a reply containing a marker, or a generic Bot author is insufficient. Incomplete pagination or multiple candidates is unknown/ambiguous, not authority. Persist discovered review/comment/thread IDs under the association's lease before resolving. An owned reply in somebody else's thread does not make the root ours.

**Authenticated identity:** select credentials by exact `(app_id,installation_id)` (§7.6). JWT-authenticated `GET /app` must return numeric ID equal to the row's `github_app_id` and nonblank slug. Derive the expected bot login `<authenticated slug>[bot]`; compare the root's author login and `__typename: Bot` (REST `user.type: Bot`) as well as the original publication provenance. Cache identity only per current App credential identity, not across Apps; slug disagreement fails closed. No installation-token `viewer.login` assumption.

**Capture/query contract:** first locate via `repository(owner,name).pullRequest(number).reviewThreads(first:100,after:cursor)` (max 5 pages), matching the root comment by its GraphQL `fullDatabaseId` against the stored REST comment id. Then query `node(id:threadId) { ... on PullRequestReviewThread { id isResolved isOutdated path line originalLine pullRequest { id number headRefOid repository { nameWithOwner } } comments(last:100,before:cursor) { totalCount pageInfo { hasPreviousPage startCursor } nodes { id fullDatabaseId body createdAt updatedAt author { __typename login } originalCommit { oid } pullRequestReview { id } } } } }`. `databaseId` (Int) is deprecated with removal on 2024-07-01 and is never selected; `fullDatabaseId` (BigInt, JSON string) is the supported primary-key bridge. Fetch at most 2 pages of the thread's own connection, not unrelated PR-wide review comments. Root identity is proven from the original batch/root mapping; absent root or incomplete connection blocks mutation. The query's PR identity and `headRefOid` are validated, not merely accepted from the input.

Digest = lowercase SHA-256 of UTF-8 JSON of `[threadId, rootCommentId, headSha, comments]`, with comments sorted by `(createdAt,id)` and each entry `[id,fullDatabaseId,authorType,authorLogin,createdAt,updatedAt,body]`. Use length-delimited JSON, not pipe concatenation or FNV on adversarial bodies. Hash complete raw bodies in memory before redaction; persist only the digest and redacted model-visible context. Counts/digest include deletions, edits, new replies, null/deleted authors and root text. Re-read the final page/count and PR HEAD after pagination; instability marks incomplete. There is no claim of a GitHub snapshot transaction.

**Resolve order:** acquire association lease; reload row (not superseded, finding still addressed by this exact verified publication); prove root ownership/provenance; require all recorded coverage complete; fetch current thread and issue-discussion snapshot; compare HEAD, full thread digest/count and issue digest with the snapshots actually sent to the reviewer; mismatch → needs-recheck. Never refresh the expected digest to bless new replies without model verification. Then, and only then, an already resolved thread is adopted as resolved; otherwise `isOutdated` is recorded but is **not** a veto. Immediately recheck local lease/fence, call `resolveReviewThread(input:{threadId})`, and require matching returned ID plus `isResolved === true` before storing resolved. No method accepts an arbitrary model thread ID.

**Unavoidable race:** GitHub has no conditional resolve CAS. HEAD/replies may change after the final read and before mutation. Post-read once after success; changed HEAD/digest or failed post-read is recorded as `lateChange`/unconfirmed post-observation, never claimed to cover the newer discussion. Do not automatically unresolve a human-visible thread. A lost local lease prohibits further writes/calls but cannot recall an already-sent request. This limitation applies honestly to remote Check/comment effects as well.

### 7.6 Credentials, repository scope and App lifecycle

```ts
export type TokenPurpose = 'sandbox-read' | 'review-write';
export type InstallationTokenGrant = {
  token: string; permissions: Record<string,string>;
  repositoryIds?: number[]; repositoryNames?: string[]; repositorySelection?: string;
};
export type TokenInput = { scope: Scope; purpose: TokenPurpose };
export function assertSandboxGrant(grant: InstallationTokenGrant, expectedRepo: string): void;
// ReviewCommenter.getInstallationToken(input: TokenInput): Promise<InstallationTokenGrant>
```

Retain the single `createAppAuth` construction point in `src/pipeline/comment.ts`. Mint with `auth({type:'installation',installationId,repositoryNames:[repo],permissions})`. `sandbox-read` explicitly requests `{contents:'read',metadata:'read'}`; `review-write` explicitly requests `{contents:'write',metadata:'read',pull_requests:'write',issues:'write'}`, with `checks:'write'` added by 68. Worker `getOctokit` receives scope/purpose, explicitly mints that scoped grant through the same auth object, then creates a token-authenticated `Octokit({auth:grant.token})`; do not rely on unrestricted factory auto-auth refresh. Each operation obtains a current cached grant and a client for the exact purpose/repository. Token cache belongs to that App auth object and includes installation/repository/permissions. A token client never leaves the Worker.

The installed auth-app 8.3.0 implementation maps returned `permissions`, `repository_selection`, `repositories[].id/name` into `permissions`, `repositorySelection`, `repositoryIds/Names`. The Sandbox guard requires nonempty token, contents/metadata read, all other returned permission values read, `repositorySelection === 'selected'`, and exactly one returned repository name equal to the requested repository. Missing repository list/selection or a broader grant fails closed. GitHub's token-create API contract additionally guarantees requested repository/permission scoping; the code must not present the **request** as proof of the **response**. No broad mint fallback or cross-purpose cache reuse.

Routing query binds **both** durable `app_id` and `installation_id` through `app_installations` into the matching `github_apps` row; validates `github_app_id` against `GET /app`. It does not scan all active Apps and choose the only one for a repository. Account/repository metadata must agree with the requested installation before mint/use. Missing mapping, disabled/deleted App, changed identity or token denial means no GitHub mutation and a durable suspended reason. No credential substitution by another App or reinstall.

**Recovery policy:** deleted App → suspend permanently pending operator inspection; disabled App → suspend and retry eligibility on later re-enable, no mutation while disabled. Review pause/kill-switch → no new reviews, Checks, primary publications or line-comment creation. Local apply of already-confirmed publications, read-only proof discovery, previously-authorized thread-resolution retry, and terminalization of already-created Checks may continue for an otherwise active App. A paused unknown Check create may be discovered but not recreated. Re-enable allows due suspended rows to resume with the same IDs and fresh fencing; payloads are not deleted. Operator recovery is explicit row-scoped retry (§7.11), not permission to replay a review.

Delete the old `getInstallationToken(installationId)` contract and migrate consumer/test doubles and the operator smoke path. `scripts/sandbox-smoke.ts` must call the same purpose-scoped helper; `src/pipeline/smoke-entry.ts` accepts only the validated read grant. Clone credentials remain exec-scoped `GIT_CONFIG_*`/`GH_TOKEN`, never URL, `.git/config`, disk helper or prompt. Remove those env values before any model session (including the new sibling seat); preserve `withoutGitHubTokenEnv` isolation and read/grep/glob-only tools. No write token is available to trusted Sandbox exec either.

### 7.7 Publication journal, complete payload and crash recovery

```ts
export type Lease = { holder: string; epoch: number; untilMs: number };
export type PublicationProof = {
  publicationId: string; scope: Scope; headSha: string;
  kind: 'review' | 'degraded'; round: number; commentId: number;
  bodySha256: string; confirmedMs: number;
};
export type LifecycleRound = {
  selectedRowIds: string[]; assessments: Assessment[];
  seen: { rowId: string; findingId: string; original: OriginalFinding }[];
  resolutions: { associationId: string; verified: VerifiedResolution }[];
  coverage: { totalOpen: number; selected: number; assessed: number; omitted: number; capped: number; contextCoverage: Coverage };
};
export type PublicationPayload = {
  version: 1; scope: Scope; headSha: string; kind: 'review' | 'degraded';
  round: number; targetCommentId: number | null; body: string; bodySha256: string;
  artifact: ReviewArtifactDoc | null; lifecycle: LifecycleRound | null;
  lineIntents: LineIntent[];
};
export type PublicationRow = {
  id: string; payload: PublicationPayload; proof: PublicationProof | null;
  phase: 'prepared' | 'sending' | 'confirmed' | 'applied' | 'failed' | 'unknown' | 'superseded';
  lease: Lease | null; attempts: number; nextAttemptMs: number | null;
  recoveryState: 'pending' | 'done' | 'local-error' | 'suspended';
};
export function stagePublication(db: D1Like, input: { id: string; payload: PublicationPayload; nowMs: number }): Promise<PublicationRow>;
export function claimPublication(db: D1Like, id: string, holder: string, nowMs: number): Promise<Lease | null>;
export function recordPublicationProof(db: D1Like, id: string, lease: Lease, proof: PublicationProof): Promise<boolean>;
export function readPublicationProof(db: D1Like, input: { scope: Scope; headSha: string; publicationId?: string }): Promise<PublicationProof | null>;
export function applyPublishedLifecycle(db: D1Like, id: string, lease: Lease, nowMs: number): Promise<boolean>;
export type PublicationOutcome = { kind: 'confirmed'; proof: PublicationProof } |
  { kind: 'failed'; reason: string } | { kind: 'unknown'; reason: string };
export function publishPrepared(input: { row: PublicationRow; lease: Lease }): Promise<PublicationOutcome>;
```

`stagePublication` serializes the **entire** validated redacted `ReviewArtifactDoc` (including envelope, key, app/model/provider) and lifecycle/coverage/verified snapshots, final primary body, original concern records and line intents. Size ≤1 MiB UTF-8; reject oversize rather than truncate JSON or emit an unrecoverable publication. Degraded payload has `artifact:null`, `lifecycle:null`, empty line intents and the bounded final degraded body. No result row is written here. IDs for new findings/associations are preallocated in this private payload, reused on replay and become public lifecycle rows only after proof. An insert conflict returns the existing immutable payload; never overwrite a prepared/confirmed publication with a second model result.

**Publication identity:** `publicationId` UUID plus scope, SHA and kind uniquely identify a prepared body. Preserve the existing round marker and append `<!-- mstar-inspector:publication:v1 id=<uuid> sha=<sha> kind=<review|degraded> -->`. Calculate round/target from the authenticated App's current single comment before staging; `publishPrepared` never increments a round on retry. Before sending, read the target and require its expected previous version or an already-matching exact marker/body. A newer publication is never overwritten by an older recovery. Same-App existing marker adoption requires full author/provenance validation; foreign marker comments are not update targets.

**Frozen consumer order:**

1. Existing App/pause/config/guard gates; acquire Sandbox with the read grant; clone and establish authoritative SHA.
2. Existing KV/D1 idempotency acks remain. Also check a journal for this exact scope/SHA before model work: an existing prepared/unknown/confirmed row hands off to recovery and ACKs without another paid review. Pending recovery is never deleted by same-SHA `/review`.
3. Read/apply confirmed pending lifecycle work in order; capture targets, immutable diff evidence and discussions. Failure produces honest context-unavailable, not false first-round closure.
4. After authoritative SHA/dedup and before model work, optional M7 hook attempts a fenced Check claim; failure is isolated and cannot prevent step 5.
5. Execute normal review and concurrent bounded recheck (§7.8). Parse-degrade is typed and ACK-based, not normal envelope persistence or a queue retry of invalid model content.
6. Apply existing redaction/clamp/cap once; compute final fingerprints; validate recheck against trusted input and final current findings; compute closure and final primary body.
7. **Stage the complete private payload before any primary GitHub mutation.** If staging fails, no publication/line comments/result writes are allowed. Retry only the bounded D1 write in this invocation (3 attempts within 5s); if unavailable, report a pre-publication pipeline failure. This cannot promise preservation before a durable write succeeds; it is not a post-publication repair claim.
8. Claim publication lease (120s, epoch-fenced), record phase `sending`, then publish the exact prepared upsert. Validate response ID/body/App marker. Immediately persist proof before KV done. If response/proof write is lost, retain prepared body and `sending`/`unknown` for read-only discovery; never claim no publication simply because the proof write failed.
9. With positive persisted proof only: `store.put(artifact)` for a normal review, then one idempotent lifecycle batch, then mark applied; degraded proof creates no normal review/lifecycle rows. KV done follows durable confirmation (it is a fast hint, not the only recovery source). Local write failures do not undo publication and do not rerun the model.
10. Post/capture intended COMMENT-only line review after the result/lifecycle apply; persist exact returned review/comment IDs. Persist intent before send, so a lost response can be discovered against §7.5. Remote line failure is explicit fallback; never fabricate mappings. Newly-created threads are not resolved using a verification performed before their conversation existed.
11. Resolve prior addressed associations with saved evidence/fences; enqueue pending/retry rows **before** inline mutation so a crash before the first attempt remains discoverable. Refresh degraded cleanup best-effort only after normal publication proof. Cleanup must not delete the only unconfirmed degraded-publication evidence.
12. M7 terminal decision reads proof and persists desired intent before its bounded remote update. ACK; Sandbox/guard cleanup remains the existing finally behavior.

**Local apply:** `store.put` keeps its existing atomic reviews/findings batch. It is a separate idempotent step, not falsely described as part of a new all-encompassing transaction. `applyPublishedLifecycle` requires proof, uses publication-ID uniqueness and a single D1 batch for upsert/reopen, selected assessment history, pending association intents and scheduling updates, then marks applied under the publication lease. Replay after `store.put` but before lifecycle apply does not duplicate findings. Publication replay never increments reopen twice. Same-scope pending confirmed journals are ordered by prepared round/created time so an older assessment cannot override a newer recurrence; if order cannot be established, retain pending and require reconciliation rather than last-writer-wins.

**Remote unknowns:** after an interrupted send, inspect the exact target comment first, else traverse the PR's bounded newest comments for the exact App-owned publication marker **and body digest**. Match → persist proof and apply the saved payload without the model. An already-newer comment is not proof of the older one. Missing/incomplete/ambiguous evidence → phase unknown; retain payload and retry reads, never issue a blind second create. A known definitive rejection before any successful/unknown send is failed, not published; a confirmed no-send prepared row can be sent by M8 recovery if still current and enabled. SHA changed before first send → superseded, no publication or closure. Failure after staging never requires paid replay; uncertain externally-overwritten/deleted effects may remain unknown for operator inspection instead of an impossible exactly-once guarantee.

**Failure matrix:**

| Boundary | Durable source | Recovery / visible outcome |
|---|---|---|
| Before staging succeeds | No publication allowed | Pre-publication failure; no fabricated proof |
| Staged, before send | Full payload, phase prepared | M8 sends once with same identity when enabled/current |
| Sent, response or proof persistence lost | Full payload, sending/unknown | Read-only exact-marker/body discovery; unknown if unprovable |
| Proof saved, store/apply not complete | Proof + complete payload | Idempotent store/apply; no model |
| Line create/capture interrupted | Confirmed publication + line intents | Exact batch/root discovery; unknown/ambiguous stays unmapped |
| Crash before/after resolve API | Pending association + verified snapshot | M8 retries original fences; already resolved adopted only after ownership proof |
| Same-SHA ack | Existing journal/association/check rows | Scheduled recovery remains due; no force rerun |
| Persistent API/D1 recovery failure | Retained payload/IDs + last_error | Bounded retries, explicit local-error/unknown, operator-scoped retry |

### 7.8 Bounded discussion and model execution

**Newest-first capture:** use `repository.pullRequest.comments(last:100,before:cursor)` for issue comments (2 pages maximum) and each known `PullRequestReviewThread.comments(last:100,before:cursor)` (2 pages). Page backward with `pageInfo.startCursor/hasPreviousPage`, starting at the newest page; sort the collected nodes chronologically only for presentation/digests. This deliberately avoids the first pages of oldest-first REST `issues.listComments`. `totalCount`, exhausted cursors and a final newest-page/count recheck distinguish complete, changing and truncated captures. At >200 issue comments or >200 replies in a target thread, coverage is explicitly truncated; newest replies are still included, but auto-resolution is blocked for the incomplete assessment. API failure is unavailable, not empty/complete.

Model context caps: 50 items, 1200 chars per item, 8000 total chars, oldest items dropped first. Any omission/body truncation changes relevant modelCoverage to truncated even if fetch completed. Per-target original concern is never silently truncated. All text is wrapped as untrusted evidence with bounded escaped metadata; neutralize delimiters/Inspector marker syntax and control characters. No thread IDs are sourced from model text. Raw complete bodies are used only in-memory for SHA-256 snapshot hashing, not logged. A block describes its exact coverage and capture time.

**Budget:** existing outer runner caps remain quick/default 600,000ms and deep 840,000ms. Start recheck concurrently at the beginning of model work, with `maxRuntimeMs = min(180000, outerDeadline-now-5000)`, skip if <30,000ms. The SDK already exposes `runStructuredSubagent({outputSchema,schemaMode:'strict',maxRuntimeMs,signal,enableLsp:false,enableIrc:false})`; use its abort signal, not a Promise.race that leaves work running. When normal review finishes, use an already-completed recheck or abort the unfinished seat and publish with budget coverage; **never start or await a fresh 180s after normal review**. On normal-review failure abort recheck too. Teardown stays inside the existing outer deadline; no guard/queue budget increases.

Quick/default: a separate structured child on the existing read-only ToolSession alongside normal seat calls, separate result slot. Deep: a dedicated read-only recheck AgentSession/ToolSession, not a second prompt/subagent yield stream on the deep parent's session (its listener captures terminal yields). Create/install the read-only seat definition once before concurrent work and remove it once both sessions settle; never concurrent agent-file writes/cleanup. Both sessions share only the immutable clone/evidence and remain inside the same token-removal boundary; no harness skill modifications. Recheck uses the existing review-seat model selection; engine synthesis/deep parent yield remain untouched.

```ts
export type ReviewRunResult = { envelope: MstarReviewV1; recheck: RecheckDoc | null };
// AgentRuntimeRunInput gains optional recheck: RecheckInput; other fields unchanged.
// AgentRuntime.runReview(input: AgentRuntimeRunInput): Promise<ReviewRunResult>
export function recheckBudget(outerDeadlineMs: number, nowMs: number): number; // 0 = skip
```

Runner stdout remains envelope JSON only, exit codes unchanged. Optional `--recheck-out` emits the separate validated JSON file; no targets/invalid output emits no file. Worker reads it through an audited fixed-path bounded read (262144 bytes plus overflow detection), not arbitrary model file paths. Existing callers/runtime doubles unwrap `envelope`; no envelope field/category/hint overloading.

### 7.9 App-owned Check attempt fencing and conclusions

`attempt_key = JSON.stringify([appId,installationId,owner,repo,prNumber,headSha,triggeredBy,action])` with canonical scope strings. `id` is a UUID; `external_id = 'mstar-check:v1:' + id + ':' + generation`. The UUID row binds the entire attempt identity; external IDs never get cleared/reused. GitHub's run name is `mstar-inspector review`; omit details_url entirely.

```ts
export type CheckDesired = 'in_progress' | 'success' | 'neutral' | 'failure';
export type CheckObserved = 'unknown' | CheckDesired;
export type CheckIdentity = {
  attemptId: string; generation: number; externalId: string;
  scope: Scope; githubAppId: number; headSha: string;
};
export type CheckAttempt = {
  identity: CheckIdentity; lease: Lease | null; checkRunId: number | null;
  createState: 'not-sent' | 'sending' | 'known' | 'unknown';
  desired: CheckDesired; observed: CheckObserved;
  recoveryState: 'pending' | 'done' | 'remote-unconfirmed' | 'local-error' | 'suspended';
  executionDeadlineMs: number; attempts: number; terminalMs: number | null;
};
export type CheckRemote = {
  id: number; name: string; head_sha: string; external_id: string | null;
  app: { id: number } | null; status: string; conclusion: string | null;
};
export type CheckConclusion = { desired: Exclude<CheckDesired,'in_progress'>; title: string; summary: string };
export function claimAttempt(db: D1Like, input: {
  scope: Scope; githubAppId: number; headSha: string; triggeredBy: string; action: string;
  holder: string; nowMs: number; executionDeadlineMs: number;
}): Promise<{ kind: 'claimed'; attempt: CheckAttempt; lease: Lease } |
  { kind: 'busy' | 'terminal'; attempt: CheckAttempt }>;
export function claimCheckRecovery(db: D1Like, id: string, holder: string, nowMs: number): Promise<Lease | null>;
export function setCheckDesired(db: D1Like, id: string, lease: Lease, conclusion: CheckConclusion, publicationId: string | null): Promise<boolean>;
export function recordCheckObservation(db: D1Like, id: string, lease: Lease, remote: CheckRemote): Promise<boolean>;
export function beginCheck(input: { identity: CheckIdentity; lease: Lease }): Promise<
  { kind: 'ready'; remote: CheckRemote } | { kind: 'unavailable'; reason: string }>;
export function adoptCheckRun(input: { identity: CheckIdentity }): Promise<
  { kind: 'found'; remote: CheckRemote } | { kind: 'absent' | 'incomplete' | 'ambiguous' }>;
export function completeCheck(input: {
  identity: CheckIdentity; lease: Lease; checkRunId: number; conclusion: CheckConclusion;
}): Promise<{ kind: 'completed'; remote: CheckRemote } | { kind: 'unavailable'; reason: string }>;
export function decideConclusion(input: {
  proof: PublicationProof | null;
  outcome: 'pre-publication-failure' | 'degraded-not-posted' | 'publication-unknown' | 'expired' | 'local-error';
}): CheckConclusion;
```

Adapters use the existing Octokit's typed `rest.checks.create/update/get/listForRef` responses; no `Record<string,unknown>` return surface that omits App/status/conclusion evidence. `beginCheck` and `completeCheck` validate identity and current lease immediately before any send; they never mutate a caller-supplied run without its persisted ownership record.

**Claim protocol:** in one serialized D1 batch, read latest attempt logically via SQL subqueries and attempt `INSERT ... SELECT` with generation `COALESCE(MAX(generation),0)+1` **only if no nonterminal row exists for attempt_key**. The partial unique index backstops concurrent inserts. An existing nonterminal attempt returns busy regardless of its generation; expired work belongs to recovery, not a concurrent paid-review claim. Insert includes holder, epoch=1 and lease_until equal to the immutable execution deadline (claim time + 900,000ms); no unowned-row window. A terminal successfully published attempt returns terminal/dedup. A normal queue retry after definitive execution failure may create N+1 with a distinct UUID/external ID; an exhausted unknown publication does not authorize a paid replay. A losing concurrent INSERT rereads the active row, not the latest MAX+1 unconditionally.

All local updates require `(id,holder,lease_epoch,lease_until_ms > now)`; remote sends require the same check. Recovery claims expired/released leases with a single conditional UPDATE that increments epoch; it never acquires a live holder. Execution deadline is never extended by bookkeeping. Recovery lease is 120,000ms and does not modify execution_deadline. Release after a terminal-intent API failure allows due recovery without waiting for the old execution deadline. Active normal invocation, stale catch and old reconciler cannot change a newer lease's D1 state. Check unavailability does not abort the review, and duplicate Check ownership alone is not authority to publish twice; the private publication identity handles publication replay.

**Create/adopt:** persist create_state=sending before create, with the already-persisted external ID. On known response validate name, SHA, external ID and `app.id === githubAppId`, then attach ID under lease. Response loss sets unknown; first adopt using `listForRef({owner,repo,ref:headSha,check_name:CHECK_NAME,app_id:githubAppId,filter:'all',per_page:100,page})`, max 2 pages. Still verify each candidate's App ID, SHA, exact external ID/name; never infer ownership from PR association or name alone. Multiple/incomplete candidates remain unknown. A known terminal remote ID is retained, never cleared to create a lookalike. If create was possibly sent but no match is observable, do not blindly create again: read-only recovery/inspection is honest about external non-idempotency. A definitive no-send/rejection can retry create only while allowed; paused recovery cannot create a new Check. The API additionally caps `listForRef` results to the 1000 most recent check suites on a reference; when that bound (or the 2-page bound) is hit without an exact match, the result is incomplete/unknown, never absence.

**Desired versus observed:** save immutable terminal intent (conclusion/title/summary and publication proof link) **before** update. Mark observed only when the response (or a subsequent GET) has matching identity, status=completed and the intended conclusion. `unavailable` changes recovery status/error/backoff only, never observed or desired. Terminal intent is monotonic except that newly discovered positive publication proof may correct a previously unknown failure into success/neutral on the **same owned run**; record that correction, do not create another run. Check request failure is not execution failure.

| Persisted proof / execution knowledge | Desired conclusion | Frozen truthful summary |
|---|---|---|
| Confirmed normal publication, even if result/thread/Check side effects fail | success | `Review published for <sha7> (round N). Execution completion only; not code approval or a merge gate.` |
| Confirmed degraded publication | neutral | `Review output was invalid; a degraded summary comment was published.` |
| Definitive failure before any publication send | failure | `Review execution failed before publication: <reason>. No review was published.` |
| Definitive degraded send rejection and no earlier unknown send | failure | `Review output was invalid and the degraded notice was not published.` |
| Any publication send with unconfirmed result, or expired attempt without proof | failure | `Review attempt could not be confirmed complete; publication status is unknown.` |
| Recovery exhausted | Preserve proof-derived desired; if none, failure | `Finalization could not be confirmed. Manual inspection may be required.` |
| Paused/guard-held/idempotent ACK before claim | no Check | No remote or attempt row |

Titles/summary are redacted; summary ≤2000 chars, error ≤300. No verdict text is needed in proof to derive success. Read proof by **exact App/scope/SHA**, preferring this attempt's publication ID; a normal proof takes precedence over degraded only within that exact scope/SHA. Prepared payload is never publication proof.

### 7.10 Closure and consumer Check handoff

`buildReviewBody` gains optional closure; final assembled body passes the existing size limit. Show ≤25 selected prior rows plus coverage/overflow count; columns are finding, disposition, evidence and thread. A pending resolve renders not-yet-resolved, not a prediction. Remote outcomes discovered after primary publication appear in the next round's single upsert; no second closure-only upsert. Superseded old thread state never stands in for the new occurrence.

Plan 67 exposes the following optional ProcessDeps seam; 68 supplies it. An absent dependency produces **no Checks**, while the M8 behavior remains fully operational. It does not claim the entire changed M8 pipeline is byte-identical to pre-M8.

```ts
export type CheckHandle = { attemptId: string; scope: Scope; githubAppId: number; headSha: string; lease: Lease };
export type CheckLifecycleHooks = {
  begin(input: { scope: Scope; githubAppId: number; headSha: string; triggeredBy: string; action: string; executionDeadlineMs: number }): Promise<CheckHandle | null>;
  terminalize(input: { handle: CheckHandle; publicationId: string | null;
    outcome: 'pre-publication-failure' | 'degraded-not-posted' | 'publication-unknown' | 'expired' | 'local-error' }): Promise<void>;
};
```

Plan 67 declares this seam using only §7.7 types (`Scope`, `Lease`); it never imports a §7.9 type, so M8 is deliverable without plan 68. Plan 68 owns the implementation and maps these fields onto its own `CheckIdentity`/`CheckAttempt` rows. Hook exceptions/timeouts are caught by the consumer; the handle is invocation-local, not ambient mutable singleton state. Each inline hook has ≤2 requests / 2 seconds total, and no publication path waits for hook retries; durable recovery owns longer adoption work. A same-SHA ignored job may signal recovery but never creates a new Check or discards existing pending work.

### 7.11 Independent bounded recovery

Existing cron stays unchanged. `src/worker/index.ts` composes `runSweep` → `reconcileReviewLifecycle` (67) → `reconcileReviewChecks` (68), each caught independently. `src/worker/sweep.ts` remains read-only. `ScheduledEnv` gains the already-used App-decryption secret binding; no new cron or dashboard surface.

#### 7.11.1 M8 publication and thread recovery

```ts
export type LifecycleReconcileSummary = { examined: number; applied: number; resolved: number; unknown: number; suspended: number; errors: number };
export function reconcileReviewLifecycle(env: ScheduledEnv, deps?: { now?: () => number }): Promise<LifecycleReconcileSummary>;
export function listPublicationRecovery(db: D1Like, nowMs: number, limit: number): Promise<PublicationRow[]>;
export function listResolutionRecovery(db: D1Like, nowMs: number, limit: number): Promise<{ associationId: string; scope: Scope }[]>;
export function retryLifecycleWork(db: D1Like, input: { scope: Scope; publicationId?: string; associationId?: string; nowMs: number }): Promise<boolean>;
```

Publication selection: recovery pending, due `(next_attempt_ms IS NULL OR next_attempt_ms<=now)`, lease null/expired, attempts<5; order by next due/created/id, LIMIT 10. Prepared older than 60s can be sent after a conditional lease claim; sending/unknown is discovered read-only; confirmed/applied-with-pending-line-intents is replayed from its complete payload. No `store.put` from assessments-only data and no reconstruction from prose comments. After proof, local apply may proceed even if GitHub is unavailable. Suspended rows are checked for exact-App re-enable before returning to pending. Never send a stale initial publication over a newer round.

Thread selection: `(resolution_state IN ('pending','retry')) AND verified_json IS NOT NULL AND superseded_by_publication_id IS NULL AND due AND lease-null-or-expired AND attempts<5`, LIMIT 10, oldest due/id. This includes a crash **before the first resolve**, not just failed rows. Acquire lease/epoch; re-read finding state and stored verified snapshot; run §7.5 without replacing expected fences. HEAD/conversation mismatch → needs-recheck (next real review, no blind retry at a new snapshot); foreign/superseded → abandoned; API failure → retry; confirmed → resolved. A current round supplies fresh verified_json and resets attempts only for a genuinely new assessment, never for bookkeeping.

Backoff after an actual failed recovery attempt: 1,2,4,8,16 minutes; at 5 failures → local-error/unknown retained with structured warning containing App/scope/work ID and reason, no payload/secret. Needs-recheck retains the old concern as open for scheduling when closure proof is invalidated before remote resolution. A resolved remote thread is never silently re-opened merely due to a post-read race; record lateChange instead.

Budgets: ≤15 GitHub requests per thread operation (lookup pages + two conversation snapshots + issue fence + mutate/post-observe), ≤80 requests/45s for the whole M8 run; each request ≤5s and additionally capped by remaining run deadline. Publication lane gets at most half the run budget before the thread lane; unfinished pagination persists cursor work or remains due with no mutation, and budget exhaustion is not a failed attempt. Local apply batches ≤25 row transitions each; a larger payload is resumed idempotently with applied-publication/association IDs, never marks complete early. Do not claim every remote thread must close during persistent API failure.

`retryLifecycleWork` is an internal operator-only store helper (no new HTTP/command surface): require exactly one work ID and matching complete scope, no live lease; reset attempts/due/error state while retaining payload, proof, remote IDs, verified snapshot and epochs. It cannot waive ownership/HEAD/conversation gates. New `/review` remains no-force; the cron and this explicit recovery path never rerun the paid review.

#### 7.11.2 M7 Check recovery

```ts
export type CheckReconcileSummary = { examined: number; completed: number; unconfirmed: number; suspended: number; gaveUp: number; errors: number };
export function reconcileReviewChecks(env: ScheduledEnv, deps?: { now?: () => number }): Promise<CheckReconcileSummary>;
export function retryCheckRecovery(db: D1Like, input: { scope: Scope; attemptId: string; nowMs: number }): Promise<boolean>;
```

Candidate predicate (bind one nowMs; maxAttempts=5, limit=25):

```sql
SELECT * FROM review_checks
WHERE terminal_ms IS NULL
  AND recovery_state IN ('pending','remote-unconfirmed')
  AND attempts < ?
  AND (next_attempt_ms IS NULL OR next_attempt_ms <= ?)
  AND (lease_until_ms IS NULL OR lease_until_ms <= ?)
  AND (desired <> 'in_progress' OR execution_deadline_ms <= ?)
ORDER BY COALESCE(next_attempt_ms,created_ms),id
LIMIT ?;
```

1. Reacquire with a conditional UPDATE repeating eligibility and incrementing epoch. Selection alone grants no ownership. If another invocation owns a live lease, skip without updating timestamps or attempts.
2. Read exact-scope persisted proof; if publication sending/unknown, ask M8's read-only proof discovery (not paid replay). An expired `desired=in_progress` becomes a **terminal** conclusion from §7.9; persist it before calling `completeCheck`. Never pass in_progress into that API. Expiry uses execution_deadline, never updated_ms or newly renewed recovery lease.
3. If ID unknown, adopt exact App/external ID/SHA with `filter:'all'`. Create only if known never sent/definitively rejected and the App is enabled; uncertain create remains remote-unconfirmed. If ID known, GET/validate ownership before update. Remote terminal success/failure is not blindly accepted: it must match the persisted desired intent and proof.
4. Execute terminal update; only a validated response/GET advances observed. On mismatch/unavailable preserve desired and actual observed, set remote-unconfirmed and backoff, release lease. A late returned call from an old epoch cannot persist observations. At fifth failure set local-error/terminal_ms under the current fence and log `ops_check_reconcile_gave_up`; do not drop row, clear ID, or pretend remote completion.
5. Budget ≤6 requests/row, ≤100 requests/60s/run, ≤5s/request with remaining-deadline clamp. If complete pagination/adoption cannot fit, stop without mutation and leave due. Budget deferral does not spend an attempt. Structured counts distinguish completed, unconfirmed and gave-up.
6. Operator-only `retryCheckRecovery` reopens **recovery of the same historical ID**, never clears generation/external ID/check ID or restarts model work. It refuses a live lease or conflicting newer active generation, retaining the old row for inspection until safe. Re-enable resumes suspended work with fresh claims. Persistent GitHub outage may leave an external run pending; GitHub's own stale handling is not our proof of closure.

### 7.12 Fresh-App surfaces

67 updates contents:write; 68 adds checks:write. Final manifest permissions: contents write, metadata read, pull_requests write, issues write, checks write. Events remain pull_request and issue_comment only. Direct surfaces: `src/dashboard/manifest.ts`, `.env.example`, `README.md`, `docs/deploy.md`, operator smoke documentation and the publication companion spec. No old-App acceptance branch. Documentation explains Worker-only writes, read-only Sandbox, success-not-approval, branch protection user control, and historical same-name Check generations (newest applicable attempt, not universal cross-App authority).

### 7.13 Verification caliber and source basis

Implementation requires scoped behavioral unit evidence for identity/domain boundaries, recurrence, actual evidence range/content validation, capture truncation, every crash boundary, private-result invisibility, lease races, proof/observed separation and both independent reconcilers. No source-text/exact-call-count tests in lieu of behavior. No tests/build/lint/formatters or runtime/live mutations run in this documentation pass. QA consumes scoped evidence; **live/E2E is not an iteration gate**. Actual remote behavior remains unverified unless the user explicitly authorizes a separate scoped run.

Source/API basis (read-only evidence, not live behavior):

- `src/store/fingerprint.ts:113-120`: arbitrary nonblank hint is returned verbatim; opaque UUID markers avoid changing that domain.
- `src/store/artifact-store.ts:218-321`: `put` validates the complete envelope and atomically inserts reviews/findings; it cannot be recreated from assessments alone or claimed atomic with an external lifecycle batch.
- `src/pipeline/consumer.ts:1620-1753`: current primary post precedes KV done, line comments and store; §7.7 explicitly changes that unsafe persistence window.
- `src/pipeline/comment.ts:669-725,1101-1148`: current upsert increments on every invocation and discards response IDs; current auth factory is unrestricted. Prepared identity/typed outcomes/purpose minting replace those behaviors.
- `node_modules/@octokit/auth-app/dist-src/get-installation-authentication.js:76-105`: request restrictions and returned grant fields; [official installation token API](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app) documents restrictions. [GET /app](https://docs.github.com/en/rest/apps/apps#get-the-authenticated-app) requires JWT and returns authenticated App identity.
- [GraphQL Pulls reference](https://docs.github.com/en/graphql/reference/pulls): `PullRequest.headRefOid`, `reviewThreads`, thread `isResolved`/`isOutdated`/`line`/`originalLine`, `comments` connections with `before`/`last`/`totalCount`, comment `fullDatabaseId`, `originalCommit`, `pullRequestReview`, and the `resolveReviewThread` mutation returning the thread. `databaseId` is documented as deprecated with removal on 2024-07-01, hence §7.5's `fullDatabaseId` bridge. The reference does not promise atomic read→mutation fencing.
- [Checks Runs API](https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference): external_id, app.id, head_sha, filter=all, app_id and status/conclusion support exact adoption/observation; external_id is correlation, not server idempotency.
- `src/review/runtime-omp.ts:720-821,899-930` and installed `dist/types/task/structured-subagent.d.ts:34-68`: deep parent yield capture differs from independent structured children; maxRuntimeMs/signal are available. Separate deep recheck session avoids contaminating the envelope capture.
- `migrations/0004_github_apps.sql:20-41`: internal/numeric App IDs and exact App-installation join; no one-App-per-repository constraint.
- contents:write for resolveReviewThread rests on [GitHub-maintained issue 35726](https://github.com/github/gh-aw/issues/35726) and its [maintainer explanation](https://github.com/github/gh-aw/issues/35726#issuecomment-4693962674), not an official per-mutation permission table. The user accepted the Worker-only boundary. No live permission success is claimed or required without separate authorization.
