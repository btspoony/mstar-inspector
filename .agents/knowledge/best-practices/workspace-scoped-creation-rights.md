---
module: dashboard tenant routing and App creation
date: 2026-10-22
problem_type: architecture_pattern
category: best-practices
severity: high
applies_when:
  - an authorization or routing rule is expressed in terms of "the deployment's workspace"
  - a multi-step flow persists a tenant across requests
tags:
  - multi-workspace
  - authorization
  - tenant-binding
  - manifest-flow
last_updated: 2026-10-22
---

# Workspace-scoped creation rights

## Context

The first tenant iteration made every resource belong to exactly one workspace, and deliberately kept a
single-workspace assumption in the creation path: the deployment had one workspace, so "may this user
create an App" was answered by "is this user an owner/admin **of the deployment's only workspace**".
The membership work later made a second workspace reachable (invite, create, switch). From that moment the
assumption was false, and the creation path answered **no** for everyone — including the owner of the
workspace the URL named. Nothing crashed; the Create action simply disappeared and the API answered 403.

## Guidance

1. **Judge the right in the workspace the request addresses.** `canCreateApp` must resolve the caller's role
   in the workspace named by the request path, not in the deployment. A "sole workspace" helper may remain as
   a fallback for a request that names none, but it must never be the primary rule.
2. **A multi-step flow binds the stable id, not the slug.** Renaming a workspace changes its slug; a flow that
   stored the slug will map the finished resource into whatever workspace holds that slug at commit time.
   Persist `workspaces.id` in the flow state/hold and resolve id → current slug only when building the
   post-commit redirect.
3. **When the target cannot be determined, say so.** A multi-workspace deployment answering a bare 403 teaches
   the user nothing. Answer a named conflict (`409 {"code":"workspace_required"}`) and let the UI render the
   reason next to a disabled control instead of hiding it.
4. **Landing pages must not assume a sole workspace.** `/dashboard` may redirect to the only workspace; with
   several, it must land on a real route (workspace list or first membership), never a retired path.

## Why This Matters

The failure mode is silent and total: the invariant looks satisfied (authorization is "correct"), every route
still answers, and yet nobody in a multi-tenant deployment can create a resource. It also fails closed in the
worst possible place — the first action a new customer takes.

## When to Apply

- Any rule phrased as "the workspace" rather than "this workspace".
- Any flow that stores a tenant identifier between requests (manifest creation, OAuth state, holds, jobs).
- When adding a second-workspace capability to a system that was built single-tenant.

## Examples

- Sole-workspace predicate (`rows.length === 1`) as the creation gate → replace with the addressed workspace's
  role; keep the sole-workspace case only as the no-ref fallback.
- Flow state `{workspace: "acme"}` → `{workspaceId: "ws_acme"}`; redirect target resolved from the id at the end.
- Hidden Create button → disabled button plus "choose a workspace first" copy.

## Prevention

- A two-workspace fixture in the authorization matrix: owner of W2 creates in W2, member does not, and a
  no-ref start answers the named conflict.
- A mid-flow rename test: rename the workspace, plant a squatter on the freed slug, commit — the resource must
  land in the original workspace.
