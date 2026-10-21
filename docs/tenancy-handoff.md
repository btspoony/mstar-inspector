# Tenancy foundation — handoff (workspace attribution, Phase 2 in progress)

**Status date:** 2026-10-21
**Last merged:** `300c841` on the integration branch
**State:** Phase 1 locked; Phase 2 started; the first task (workspace data plane + backfill) is delivered. Six tasks and Phase 3–6 remain. **The iteration is NOT delivered.**

This document is deliberately self-contained: it carries no local process identifiers. To read the live execution state, run the commands in §1 against the harness store in this checkout.

---

## 1. Where the truth lives

| What | How to read it |
|------|----------------|
| Live execution state (workflow, plan row, branch anchors) | `mstar status validate` |
| Workflow-entry gate (branch metadata, main residency, integration checkout) | `mstar worktree check --workflow "$(mstar status validate \| jq -r '.data.workflows[0].id')" --entry --harness .mstar` |
| Iteration compass (locked design + decisions) | the `delivery-compass.md` under the harness iteration directory for the current iteration |
| Main plan (locked, task list) | the plan file under the harness plans directory whose `plan_id` matches the active workflow id |
| Approved design prototype | `prototypes/tenant-foundation-r1.html` beside the compass |
| Project roadmap + milestones | `mstar roadmap show --project saas-tenant-platform --harness .mstar` / `mstar milestone list --project saas-tenant-platform --harness .mstar` |
| Issue contracts (authoritative acceptance) | `mstar issue list --project saas-tenant-platform --harness .mstar`, then `mstar issue show --id <id>` |

The harness directory is gitignored. This file is the cross-machine half; the harness copy is the detailed half.

## 2. Branch and worktree layout

| Role | Branch | Notes |
|------|--------|-------|
| Main checkout (control root) | `main` | Never switched, never edited for product code |
| Integration | `iteration/<iteration>` | Checked out in a dedicated worktree under `.worktrees/`, clean, pushed, at `300c841` |
| Plan feature | `feat/<plan>` | Separate worktree under `.worktrees/`, branched from the integration branch |

Resolution order for these anchors: workflow execution row → iteration compass frontmatter → ask the user. Never default to `main` because it exists.

## 3. Decisions already locked (do not re-litigate)

| # | Decision |
|---|----------|
| 1 | The tenant entity is `workspace` — tables `workspaces` / `workspace_members` / `app_workspaces`, column `workspace_id`. **Not** `org` (collides with GitHub Organization). |
| 2 | Attribution lives in a narrow mapping table `app_workspaces(app_id PK, workspace_id NOT NULL)`. Do **not** add a nullable column to `github_apps`: SQLite cannot add `NOT NULL` to an existing table, and rebuilding a table with five FK children is not worth it. |
| 3 | Routes are `/dashboard/:workspaceSlug/apps/...` and `/dashboard/:workspaceSlug/api/...` (the API stays under the `/dashboard` mount; there is no top-level `/api/*` today). Legacy paths are **removed outright (404)**, no redirect layer. |
| 4 | Release state is carried by ONE switch: `WORKSPACE_TENANT_MODE = off \| strict`, default `off`, illegal values fail loud. |
| 5 | Two deployments of the **same merged artifact**: A (`off`) then B (`strict`). A runs migrations and backfill before deploy, then re-runs the idempotent backfill and asserts zero orphans after deploy. B is abort-gated by the zero-orphan assertion placed **before** `wrangler deploy`, with a smoke re-assertion after. |
| 6 | The switch controls **four layers**: read SQL, route visibility, authz decisions, consumer missing-mapping behaviour. |
| 7 | `ADMIN_LOGINS` is being removed; any signed-in user may create a workspace. That removal and open registration belong to the NEXT milestone — this iteration only stops depending on it for workspace ownership. |
| 8 | Backfill derives workspace roles from `users.role` in pure SQL (`admin → owner`, `member → member`). No deployment-time owner injection, no `ADMIN_LOGINS` read. |
| 9 | **Nothing in this artifact deletes the `off` branch.** A/B are the same artifact, so deployment A still needs it; `strict` merely never calls it. Physical deletion is a separate follow-up plan. |
| 10 | The unique-reader invariant is scoped by FACE, not by file. Tenant-facing reads (dashboard routes, list/detail, webhook-slug resolution, consumer config resolution) must go through the app store. Maintenance reads (reconcile/cron, review threads, review checks) may query directly when keyed by `app_id`/`installation_id`, or when they are a bounded reconciliation scan selecting identifiers only; each such site carries a `shortcut: tenant-bypass — <reason>` comment and an allowlist test pins the set. |

## 4. Delivered so far

Workspace data plane and idempotent backfill (`300c841`):

- `migrations/0026_workspaces.sql` — the three tables, `workspace_id NOT NULL`, `role CHECK (owner|admin|member)`, no `ON DELETE`, plus the single seeded `default` workspace.
- `migrations/0027_workspace_backfill.sql` — two `INSERT … SELECT … WHERE NOT EXISTS` statements: every `github_apps` row (including soft-deleted) gets an attribution; every `users` row gets a workspace role by the mapping above.
- `tests/store/workspace-migration.test.ts` — six tests: zero orphans, soft-deleted rows included, role mapping, re-runnable idempotency.
- `tests/store/helpers.ts` — the store test loader now walks the migrations directory instead of enumerating filenames by hand.
- `docs/deploy.md` — the migration range label lost its stale upper bound.

Independent task review: approve with nits (nit fixed before merge). Evidence recorded: store suite 244 pass, related worker/pipeline suites 471 pass, `tsc --noEmit` clean, and three mutations (soft-delete filter, role mapping, dropping `WHERE NOT EXISTS`) each made a test fail.

## 5. Remaining work

### Task sequence (each: implement → self-verify → independent review → merge to integration)

| Task | Deliverable | Hard constraint |
|------|-------------|-----------------|
| **Write gate** | `createApp` batches `github_apps` + `app_workspaces` in one `db.batch`; sole-workspace guard (`SELECT id FROM workspaces LIMIT 2`, must be exactly one row, else fail loud); the store's D1 face gains `batch` and the "never batches" comment is corrected | This is the only write-face owner. Reads, routes and authz are unchanged in this release. |
| **Read face** | Under `strict`, `getAppById` / `getAppBySlug` / list `INNER JOIN app_workspaces` and return `workspace_id` with explicit projection (`SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id`); SQL exported as constants so `off` can be snapshot-asserted | `app-config-store`'s sandbox-image read moves behind the store; a bounded suspended-pair scan in the checks reconciler is allowed with a `tenant-bypass` comment. Tenant-facing files must not contain `from github_apps`. |
| **Consumer gate** | Missing mapping detected in the row-level gate inside the commenter resolution (alongside not-found / soft-deleted), **not** in the pure sync config assertion | Four-layer switch applies; `strict` fails closed with a structured failure → retry → DLQ, zero sandbox exec, zero token mint, zero GitHub write. |
| **Routing + authz** | Both route blocks registered unconditionally; a pre-route middleware reads the mode env and answers 404 for the other shape; nine reserved slugs (`apps`/`api`/`oauth`/`members`/`login`/`logout`/`manifest`/`locale`/`healthz`); non-workspace paths stay reachable | Hono routes register at import time on a module-level singleton — a request cannot choose a block, so the switch must be a middleware decision, never a mount decision. |
| **Deploy gates** | BOTH staging and production workflows pass `--var WORKSPACE_TENANT_MODE` and record the deployed SHA; deploy B replays the same SHA/tag with `strict`; zero-orphan assertion before deploy, smoke after; env field, wrangler env-parity test and deploy doc wired; illegal value fails loud | Production currently passes no `--var` at all. Assertion failure must abort without deploying. |
| **Isolation matrix** | Cross-workspace 404, in-workspace 403, orphan invisibility, consumer fail-closed, deploy ordering, `off`/`strict` read-face differential | — |

### Then

Iteration close (compound + roadmap), PR from the integration branch to the target branch, merge-ready loop, post-merge close. Route details live in the harness iteration skill's phase map.

## 6. Environment traps

### 6.1 The coordinator seat must be re-acquired per write

The host MCP bridge does not forward a session id, so writes that need coordinator identity (milestone assignment, plan progress, plan prepare) must run inside a launched coordinator session and re-acquire the seat over the current holder. Reusable shape:

```bash
# Write this once. It resolves its own workflow id, so nothing is hard-coded.
cat > /tmp/coord.sh <<'SH'
set -u
cd /absolute/path/to/repo
WF=$(mstar status validate | jq -r '.data.workflows[0].id')
TOKEN=$(mstar status validate | jq -r '.data.workflows[0].token')
HOLDER=$(sqlite3 .mstar/store.db "select session_id from execution_sessions where workflow_id='$WF' and state='active' order by bound_at desc limit 1;")
python3 - "$HOLDER" <<'PY'
import json,sys
p='/tmp/recover-attestation.json'; d=json.load(open(p))
d['stoppedSessions']=[{'sessionId':sys.argv[1],'host':'your-host-id','state':'stopped'}]
json.dump(d,open(p,'w'),indent=2)
PY
mstar session recover --workflow "$WF" --prior-session "$HOLDER" --reason "re-acquire seat" --attestation /tmp/recover-attestation.json --expect "$TOKEN" --operation "$(uuidgen | tr 'A-Z' 'a-z')" --harness .mstar >/dev/null
# === the real coordinator write goes here ===
SH
mstar session run --workflow "$(mstar status validate | jq -r '.data.workflows[0].id')" --role coordinator --harness .mstar -- sh /tmp/coord.sh
```

The attestation object needs `version`, `attestedAt`, `operator{actor,authorizationRef}`, at least one consumer with `disposition` among `reloaded|upgraded|excluded:*`, and `stoppedSessions[].{sessionId,host,state}` where state is `stopped` or `reloaded`.

### 6.2 `plan progress` status is a case-sensitive enum

Only `InProgress` / `InReview` / `Blocked`. Passing `in_progress` yields a misleading `coordination.invalid-input: Stored workflow is invalid`; the real reason sits in `.details.violation_messages`. Keep `summary` short and pass `evidence_paths: []`.

### 6.3 Plan title drift is an UNVERIFIED risk

The stored plan title predates the rename to `workspace`. Workflow registration is create-only (`execution.not-empty` refuses a rebuild), so there is no supported way to rewrite it.

Verified safe: prepare, progress, worktree check.
**Not verified: plan completion.** Check this before attempting to close the plan. If it refuses, the options are (a) revert the plan's H1 to the stored string and accept the terminology regression, or (b) adopt-terminal the current workflow and register a fresh one (expensive, loses the row's history).

### 6.4 Migration loaders in tests

The store helper now walks the directory, but roughly ten other suites still enumerate migration subsets by hand on purpose. The moment product code starts reading the workspace tables, those suites fail for a missing table — append the two new filenames per suite, or switch them to directory-driven loading after confirming their seed-ordering intent.

### 6.5 Never

- Edit product code in the main checkout or develop inside the integration worktree.
- Put harness plan or iteration identifiers into tracked files, commit messages, PR titles or PR bodies.
- Run the full test suite locally; CI owns that. Run only affected files.
- Hand-edit the harness store.
- Delete the `off` branch or the mode switch inside this iteration.
- Trust issue *titles* where they conflict with the plan's task map — three issue titles still carry older stage labels.

## 7. Next action

Read the active plan's remaining task, implement it in the plan feature worktree, verify only the affected tests, obtain an independent review with a bounded budget, merge into the integration worktree, push, and record progress. Then repeat.
