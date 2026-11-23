# Security model — mstar-inspector

Facts marked **(owner)** are decisions of the repository owner; everything else describes the code as of 2026-11-23.

## System overview
Cloudflare-hosted GitHub App platform for automated PR reviews. One Worker (`src/worker/entry.ts`, Hono) serves the dashboard SPA and API, receives per-App GitHub webhooks, runs a queue consumer + Cloudflare Workflow per review attempt, and crons (failure sweep, Check lane). Reviews run in one-shot Cloudflare Sandbox containers (`sandbox-image/`, `packages/runner/`). State lives in D1 (`migrations/`, `src/store/`, `src/dashboard/*-store.ts`) and KV (idempotency). Infrastructure is in-repo: `wrangler.jsonc`, `sandbox-image/Dockerfile`, `.github/workflows/`.

Deployment shape that matters: **SaaS multi-tenant (`DEPLOYMENT_MODE=saas`)** **(owner)**. Self-hosted shares the code but is secondary.

## Components
| Component | Code | Trust boundary |
|---|---|---|
| Dashboard API | `src/dashboard/**`, `src/worker/index.ts`, `src/worker/spa-dispatch.ts`, `src/worker/handlers.ts` | Internet ↔ signed-in users; workspace isolation; Worker → App-declared custom provider `base_url` (model listing in `loadDeclaredVocabulary`, `src/dashboard/index.ts`, can send a stored BYOK key from the Worker, outside the sandbox) |
| Dashboard SPA | `src/spa/**`, `src/design-system/**`, `src/i18n/**` | Browser |
| Auth | `src/dashboard/oauth.ts`, `src/dashboard/session.ts`, `src/dashboard/users.ts`, `src/dashboard/invite-store.ts` | GitHub OAuth ↔ session cookie |
| Webhooks | `src/worker/webhooks.ts`, `POST /webhook/:workspaceId/:appId` in `src/worker/index.ts` | GitHub (and anyone on the internet) ↔ Worker |
| Review pipeline | `src/pipeline/**`, `src/workflow/**`, `src/review/**`, `src/store/**`, `src/worker/{sweep,check-reconcile,lifecycle-reconcile}.ts` | Worker ↔ GitHub API (installation tokens) ↔ sandbox |
| Sandbox runner | `packages/runner/**`, `packages/shared/**`, `sandbox-image/**` | Untrusted PR content + coding agent ↔ credentials |
| Operator admin | `src/admin/**` (`/_internal_admin`, saas only) | Platform operators ↔ all tenants |
| Infrastructure | `wrangler.jsonc`, `.github/workflows/**`, `migrations/**` | Deploy pipeline |

## Entry points and who reaches them
- `/dashboard/*` and its API: anyone who signs in with GitHub; existing users can always sign in; while the `signup_open` flag is on, any new GitHub login can create an account **(owner: anyone with a GitHub login can sign up)**, except logins removed from the platform, which are refused at sign-in; a user without memberships lands on the workspace-creation screen, and creating a workspace is a separate request gated by the `workspace_creation_open` flag. Roles per workspace: owner, admin, member; invitees; outsiders get 404.
- `POST /webhook/:workspaceId/:appId`: internet-reachable; authenticated by HMAC with the App's decrypted webhook secret.
- PR content (diff, titles, comments, @mentions) from authors on repos where an App is installed reaches the review agent inside the sandbox.
- `/_internal_admin/*`: only logins in `PLATFORM_OPERATORS` (`src/admin/gate.ts`); others get an indistinguishable 404.
- Cron and queue handlers: internal.

## Assets (all named critical by the owner)
- **BYOK provider API keys, GitHub App private keys (PEM) and webhook secrets** **(owner)** — AES-GCM secretbox with per-field AAD (`src/dashboard/secretbox.ts`), key `DASHBOARD_ENCRYPTION_KEY`.
- **Cross-workspace data isolation** — Apps, targets, review findings, insights, members, invites **(owner)**.
- **Source code of reviewed repositories / installation tokens** **(owner)** — tokens passed to git via `GIT_CONFIG_*` env (`src/pipeline/gitops.ts`).
- **Integrity of review results and Check Runs**, including prompt injection from PR content **(owner)** — `src/pipeline/checks.ts`, `comment.ts`, `review-threads.ts`, publication proof.
- **Operator admin surface and support grants** **(owner)** — `src/admin/support-grants.ts`, audit_events.
- Session secret `DASHBOARD_SESSION_SECRET`, OAuth client secret.

## Attacker profiles that matter
1. **Signed-in user of another workspace** (anyone with a GitHub account can become one) **(owner)** — primary attacker for IDOR, privilege escalation (member→admin/owner), cross-tenant reads/writes.
2. **Unauthenticated internet caller** — webhook endpoint, OAuth callback, healthz, static assets.
3. **PR author / commenter** on a repo with an installed App — prompt injection, shell injection via branch names/paths, trigger abuse, attempts to exfiltrate provider keys or installation tokens from the sandbox, or forge Check/approval/thread resolution.
4. **Lower-privileged member inside a workspace** escalating to admin/owner actions (BYOK keys, App settings, members).

## Existing controls (from code)
- Per-App webhook HMAC verification, body size limit, soft-deleted/disabled App 404, maintenance 503.
- Secretbox AES-GCM with AAD binding ciphertext to `table.column:rowId`.
- Credential payload to runner only over stdin; never env/argv/logs (`packages/shared/src/credential-payload.ts`); secret-shape and exact-value redaction (`src/pipeline/redact.ts`).
- Workspace gate classifies principal (member / invitee / outsider / operator-granted / operator-denied) before dispatch; support grants are time-boxed and read-only; the workspace gate records audit events for operator access (`support.read`, `support.forbidden`, `support.denied`), not for ordinary member requests; but SPA shell loads (`serveSpaIndex`, `src/worker/spa-dispatch.ts`) check support access without recording an audit event.
- Fail-closed when bindings or secrets are missing; safe same-origin Referer redirects.
- One-shot sandbox per attempt, no secrets baked into the image.

## Out of scope / accepted risk
- **Users listed in `PLATFORM_OPERATORS` are fully trusted** **(owner)**: issues that require operator status are accepted. Non-operators reaching operator functions, or a support grant exceeding read-only scope, remain in scope.
- **Cloudflare and GitHub platform weaknesses** **(owner)**.
- In scope (not ruled out by the user): DoS / provider-cost abuse, prompt injection that only changes review wording or verdict.

## Finding tags
- `Component`: one of the components above.
- `Deployment mode`: `saas`, `self-hosted` or `both`.
- `CWE`: e.g. `CWE-639`.

## Code facts relevant to the sandbox
- Sandbox egress is open: `container.start({ enableInternet: true })` (`src/pipeline/sandbox.ts`); the allowlist in `sandbox-image/Dockerfile` is documented, not enforced. An injected agent can reach arbitrary hosts, so anything in the sandbox (provider keys in the runner's memory, the read-only token) is exfiltratable if the agent can read it.
- GitHub App permissions (docs/deploy.md, fresh-App contract): Contents/Pull requests/Issues/Checks **write** for the Worker only; sandbox tokens are repository-scoped **read-only** (`contents`, `metadata`, `pull_requests: read`). A write-scoped token reaching the sandbox would be a boundary break.

## Open questions
- Is open sandbox egress an accepted risk for provider keys exposed to the review agent by design?
