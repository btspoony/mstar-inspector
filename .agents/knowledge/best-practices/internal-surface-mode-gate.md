# Gating an internal surface by deployment mode and allowlist

A platform-operator console that must be invisible to everyone else needs three
independent decisions, and conflating them is how the surface leaks.

## 1. Registration-time mode gate

Decide "this deployment has no such surface" **when building the app**, not inside
each handler. Build the admin sub-app and mount it only for the mode that has it:

```
const adminApp = buildAdmin()          // module scope
const saasApp = new Hono().route('/', app).route('/_internal_admin', adminApp)
fetch = (req, env) => env.DEPLOYMENT_MODE === 'saas' ? saasApp.fetch(...) : app.fetch(...)
```

A runtime flag inside handlers works until one handler forgets it, and it also
means the routes still exist in the router (visible to route-table probes). With
registration gating, the self-hosted deployment has no route at all — a test can
assert an allowlisted login still gets 404 there.

## 2. Per-request authorization, not an upstream middleware

Every handler in the internal surface re-checks the allowlist itself. A gate
mounted ahead of a sub-app is one refactor away from being skipped for a route
added later; a per-handler check fails closed by construction. This is the same
reason the allowlist predicate must be **one exported function** shared by the
gate and by any visibility decision — a restated copy is a second source of truth
that drifts the moment the rule changes.

## 3. Opaque 404, not 403

A hidden surface should not confirm its own existence: return exactly the same
404 an unknown path produces — no redirect to login (that confirms the path), no
403 (that confirms the path and the denial), no distinguishing header. This also
gives "allowlist empty ⇒ surface invisible" for free.

## The second front-end entry

Serving a separate document from the same Worker is cheap when both entries share
the asset bucket: a second Vite `rollupOptions.input`, `base` unchanged, and the
document itself served **only after** the gate (`ASSETS.fetch('/admin.html')` in
the gated handler). Guard the asset path so the raw `.html` is not reachable
directly — otherwise the gate protects the API and leaks the shell.

## Consequences worth knowing

- The dashboard's own "operator read ceiling" is matched by path suffix; never put
  an admin path into that table, or you widen the ceiling for ordinary routes.
- A hidden entry needs no nav item: one plain anchor rendered only when the boot
  payload says the viewer is an operator in the right mode.
