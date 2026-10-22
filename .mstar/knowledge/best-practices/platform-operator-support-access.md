---
module: dashboard workspace gate and support access
date: 2026-10-22
problem_type: best_practice
category: best-practices
severity: high
applies_when:
  - a deployment operator needs to read tenant data for support
  - an authorization surface has more than one principal class
tags:
  - authorization
  - support-access
  - audit
  - operator
  - least-privilege
last_updated: 2026-10-22
---

# Platform operator support access

## Context

A deployment operator and a tenant administrator were the same identity: one allowlist both admitted the
operator and granted an administrator row, so supporting a tenant meant being one of its members. The goal was
to separate the two while still allowing bounded support work, and to make every exception attributable.

## Guidance

1. **Operator identity is an allowlist, not a role.** Parse a comma-separated, case-insensitive env list and
   compare the signed-in login. It grants nothing by itself.
2. **Membership wins.** Classify in this order: `member → invitee → operator-granted → operator-denied →
   outsider`. An operator who is a member has ordinary rights; the allowlist is never consulted first.
3. **A grant is time-boxed and workspace-scoped.** `support_grants(workspace_id, operator_login, expires_at,
   reason, granted_by)`; expiry is evaluated per request from `expires_at`, with no background job. A grant on
   W1 grants nothing on W2.
4. **Derive the ceiling from the route table, not handler discipline.** Every workspace route declares
   `access: read | write`; an undeclared route defaults to **write**, so a later route cannot silently widen the
   operator surface. Read means metadata plus the member list; everything else answers 403.
5. **Filter a grant list to the caller's own grant.** A read-classified endpoint that returns "the active
   grants of the workspace" hands one operator another operator's login and free-text reason. The tenant-facing
   notice keeps the full set; operator-facing reads return at most their own row.
6. **Audit in the gate, before dispatch.** One append-only row per operator request (`support.read`,
   `support.forbidden`, `support.denied`), written by the classification step. A handler cannot forget it
   because it runs before the handler exists in the call path.
7. **Denial looks like non-existence.** An operator without a valid grant gets the same 404 as any outsider —
   no oracle that a workspace exists.

## Why This Matters

The tempting shortcut — "operators are admins" — makes every support action unbounded and unattributable, and
it turns the deployment identity into the largest privilege in the system. A grant table plus a gate-level
audit converts that into a bounded, reviewable, expiring exception.

The subtle failure is the *read* whose response is broader than the caller's own situation: a support view that
lists every active grant leaks other operators' free-text reasons, which is tenant data by accident.

## When to Apply

- Adding any cross-tenant read path for support, incident response, or migration.
- Reviewing an authorization surface that has both business roles and infrastructure identities.
- Any "temporarily allow this person into that tenant" request.

## Examples

- Classification helper shared by the gate and the shell boot — two implementations drift (one forgets the
  invite step, one writes no audit row).
- Method-aware read ceiling: `HEAD` normalises to `GET`; a POST at a read path is still write.
- Audit insertion before `next()`, not inside handlers.

## Prevention

- A matrix over `{member, operator-granted, operator-denied, outsider} × {metadata, members, app list,
  credentials, model chains, settings read, settings write, role change, audit list}` asserting status **and**
  the audit-row delta per cell.
- A no-writer source assertion on the audit store (insert/list only) plus a store-level test that a hard delete
  of the workspace is refused.
