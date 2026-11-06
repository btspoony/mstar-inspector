---
module: dashboard tenant writes, manifests, workspace settings
date: 2026-10-30
last_updated: 2026-11-06
problem_type: best_practice
category: best-practices
severity: medium
---

# Tenant write inputs and refusal copy

Three rules the inspector proved in production-shaped code, with the failure each one prevents.

## 1. Tenant ownership is a required input, never a lookup

A store function that creates a tenant-owned row must receive the tenant id from its caller. A fallback that infers "the deployment's only workspace" looks harmless while one tenant exists and becomes wrong the moment a second appears — and the failure is silent, because the row is written successfully into the wrong owner.

**Shape**

```ts
type CreateAppInput = {
  // required, not optional: no `?? soleLiveWorkspaceId(db)`
  workspaceId: string;
  // ...
};
```

The store still validates the target before writing (`SELECT ... WHERE id = ? AND deleted_at IS NULL`, refused with zero rows), but it never decides *which* tenant. Ownership resolution belongs to the route that already parsed the request scope.

**Cost, measured.** Making the field required broke 19 test call sites in one repo — every `createApp({...})` literal that had been relying on the fallback. That is the point: the compiler enumerates the callers, and each one has to say which tenant it means. Budget for that when planning the change, and run typecheck (not just tests) to find them.

**Do not** keep the old fallback behind an option, a deprecated overload or a mode flag. A compatibility path keeps the silent mis-homing alive for exactly the callers that forgot to migrate.

## 2. A refusal sentence may not name an action the product cannot perform

When a limit refuses a request, the message is read as instructions. If it says "Delete one of those before creating another", the product must offer a way to delete one. In this codebase it did not: `workspaces.deleted_at` existed and the count honoured it, but no route ever set it. The refusal was accurate about the limit and wrong about the escape.

**Rule.** Before shipping a refusal sentence, trace the action it names to a reachable route. If there is none, the sentence states the fact only:

```
You already have ${count} live workspaces you created; the limit is ${limit}. Creating another is not available, and nothing on this page frees a slot.
```

`count` is the observed count of live workspaces the actor created, not the cap; `limit` is the configured cap. Naming both keeps the sentence true when the count and the limit disagree.

**Corollary — the client may not show the server text.** This dashboard's workspace-create page renders a generic failure for every non-201, so the server sentence is effectively internal today. Write it as if a user will read it anyway: the client contract can change without anyone revisiting the string.

## 3. Counter checks need a cross-tenant case, not a single-actor one

Any predicate that counts per tenant (created workspaces, seats, review quota) passes a single-user test even when its query is wrong — "all live rows", "my memberships" and "rows I created" all return the same number for one actor.

The discriminating test is two actors: A creates up to the limit; B joins A's tenants as a member; B creates its first own row and succeeds. A deployment-wide count refuses B; a membership-based count refuses B at zero; only the per-creator count lets B through. Add that case in the same change that introduces the predicate, not in a later hardening pass.

## 4. A fail-closed branch may not borrow the generic failure outcome

Two faces of one mistake, both found in the same workspace-floor read.

**The operator face.** The App-connect path computed a distinct cause (`workspace_gate_unreadable`), logged it, and then returned the generic database-rejection outcome. Both routes sharing that commit rendered the transient-D1 page, whose only advice is "resubmit" — for a state resubmission cannot change. The repair lived on a settings card the page never named.

**The history face.** The same read answers the platform default with `degraded: true` for a value it does not trust, and the only consumer fails closed on `degraded`, so that default never took effect. The audit ledger nevertheless wrote it as `before`, attributing a threshold no workspace ever ran with.

**Rule.** When a branch fails closed on a value it refuses, the outcome it returns and the ledger row it writes must both describe the state that actually held, not the fallback the reader computed on the way there. A distinct computed cause needs a distinct outcome arm and a page that names a repair the product can perform; a value the reader refused records as absent, never as the default it degraded to.

**Shape.** One outcome arm; every route that shares the commit maps it; one shared repair-link helper so the copy and the href cannot drift; the hold kept, because the state is retryable after repair rather than permanently refused. Ledger side: the audit `before` mirrors the trust predicate — a trusted integer records itself, absent and untrusted record `NULL`.

**Why the shortcut survives review.** It is invisible to tests that assert only the status code: two different causes returning `500` satisfy the same assertion, and a ledger assertion that pins the degraded default passes too, because the code and the test encoded the same wrong mapping. Assert the distinguishing copy and the distinguishing ledger value, not the status.

## Evidence map

- `src/dashboard/apps-store.ts` — required `workspaceId`, live-row refusal, no fallback reader.
- `src/dashboard/workspace-limits.ts` — pure predicate over an injected limits object; the header records the non-atomic-reservation limit and its upgrade trigger.
- `src/dashboard/workspace-store.ts` — `countLiveWorkspacesCreatedBy` (`COUNT(*)` over `created_by = ? AND deleted_at IS NULL`), not a membership join.
- Tests that pin these: the apps-store create tests, the workspace-limit boundary tests, the two-actor creation test, and the invite/last-owner route tests.
- `src/dashboard/runtime-config-store.ts` — the floor audit's `before` CASE mirrors `isCheckMinScoreValue`; the reader's `degraded` flag is the runtime authority, the ledger's `NULL` is the history contract.
- `src/dashboard/index.ts` — `ManifestCommitOutcome.workspace_gate_unreadable` and its two route arms; `floorRepairLink` keeps copy and href together.
- Tests that pin these: the runtime-config-store audit cases (trusted / absent / unreadable), and the two manifest dashboard cases (commit route and callback route) that assert the repair copy, the settings href, the absent `dbRejected` lead, and the kept hold.
