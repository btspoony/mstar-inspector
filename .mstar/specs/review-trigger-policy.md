# Review Trigger Policy (review-trigger-policy)

> **Status:** DRAFT — authored 2026-09-17; technical contract verified against source and frozen 2026-09-17 after product and architect review; pending PM lock before integration.
> **SSOT:** This file — per-App review trigger modes, the bot-mention comment trigger, and their authorization/kill-switch semantics. GitHub publication face remains `github-review-comment-mapping.md`; review lifecycle remains `review-lifecycle.md`.
> **Authority:** Deferred row "`/review` command extensions" in `review-lifecycle.md` §Deferred (trigger = explicit user demand) — demand recorded 2026-09-17 and resolved in superseding form: the command is retired outright rather than extended, so this file — not that row — now governs the comment trigger. RL-7 itself is unchanged.

## 1. Product contract

Each App chooses when reviews start:

1. **`open`** — review a PR the first time it opens (the `opened` event only). New pushes and reopens never auto-trigger; a reviewer mentions the bot when they want another pass.
2. **`every_push`** (default) — review on `opened`, `synchronize`, and `reopened`. This is today's behavior; the default preserves it exactly.
3. **`manual`** — the App never auto-reviews. Only a bot mention starts a review.

In every mode, a comment that @mentions the App's bot can (re-)start a review — on-demand re-run for auto modes, the only trigger for `manual`.

The comment trigger is a **bare mention**: no slash command, no magic wording. `/review` is retired.

## 2. Trigger modes (normative)

| Field | Contract |
|---|---|
| Storage | `github_apps.review_trigger_mode TEXT NOT NULL DEFAULT 'every_push' CHECK (review_trigger_mode IN ('open','every_push','manual'))` (migration `0022_*`) |
| Scope | Per App. No deployment-level override — `github_apps.review_enabled` is the only review control and governs every enqueue path |
| Default | `every_push` — new Apps inherit it via the column default; no old-App compatibility or migration UX |
| Write path | Dashboard App settings (same API surface as the `review_enabled` toggle); an unknown/invalid mode value fails closed with the existing structured-400 pattern and the stored row is left unchanged — no silent coercion to the default |
| Read path | The webhook face resolves the App row by `webhook_path` before classification and passes the mode (plus the row's cached `github_slug`) into classification — no second lookup, no TOCTOU window beyond the existing row read |

### 2.1 Auto-trigger classification matrix

| Event | `open` | `every_push` | `manual` |
|---|---|---|---|
| `pull_request.opened` | enqueue | enqueue | ignore |
| `pull_request.synchronize` | ignore | enqueue | ignore |
| `pull_request.reopened` | ignore | enqueue | ignore |
| other `pull_request` actions | ignore | ignore | ignore |
| `issue_comment.created` (allowed actor, bot mention, on a PR) | enqueue | enqueue | enqueue |
| `issue_comment.created` (disallowed actor / no mention / not a PR / bot sender) | ignore | ignore | ignore |

Ignored paths keep today's structured-log discipline; classification never rejects (4xx) an event for policy reasons — reject is reserved for malformed payloads, exactly as today.

## 3. Bot-mention comment trigger (normative)

- **Mention target:** the App's own bot identity, taken from the row's cached `github_slug` — GitHub's App slug, refreshed from `GET /app` at manifest conversion and on every metadata refresh (migration `0036`). The webhook face routes by `{webhookPath}` (the opaque local route key) and resolves the row before classification, so matching is keyed to the resolved row — one App's mention never triggers another App. A comment body matches when it contains `@{github_slug}` (ASCII case-insensitive compare against the cached slug, matched as a literal) as a **standalone token**: the character immediately before `@` and the character immediately after the match, when present, must both be outside the GitHub login continuation set `A-Z a-z 0-9 -`. GitHub logins may contain hyphens, so `-` continues a mention rather than ending it: `@{github_slug}-other` and `@{github_slug}bot` never match, and an email-shaped body (`name@{github_slug}.host`) never matches. `@{github_slug}`, the canonical `@{github_slug}[bot]`, `@{github_slug},`, `@{github_slug}.` and a match at either end of the body all match (`[` is not a continuation character, so the `[bot]` suffix needs no separate grammar).
- **No target before the first sync:** `github_slug` is NULL until the first successful metadata fetch, so a comment has nothing to match and no review starts — fail-safe, never a guessed slug. An App renamed on GitHub answers to the new slug from the next refresh (24h TTL, or immediately via the manager's manual refresh), never to the old one.
- **Bare mention:** any position in the body; no required wording. Presence of the mention is the entire grammar — no natural-language interpretation (RL-7 discipline of `review-lifecycle.md` is preserved).
- **Authorization gate (unchanged from the retired command):** `issue_comment.created` only; the comment must be on a PR thread; `sender.type === "Bot"` is ignored (self-comment loop guard); only the PR author or the repository owner may trigger; disallowed actors produce the existing structured warn.
- **Enqueue semantics:** identical to the retired `/review` path — `head_sha = null`, KV idempotency skip-by-design, per-App pause checked before enqueue. The enqueued payload's `triggered_by` is `"issue_comment"`: the `ReviewJobPayload.triggered_by` wire union becomes `"pull_request" | "issue_comment"` and the `"review_command"` member is removed together with the command; the pipeline-side `review_failures` event label retires `"review_command"` with it.
- **Retirement:** the `/review` prefix constant, its grammar, its tests, and any documentation of it are removed. No compatibility alias, no deprecation window (development-stage clean new-App contract).
- **Operator visibility:** the App settings page displays the exact mention string built from the cached `github_slug` (`@{github_slug}` / the canonical `[bot]` form), so operators know what to type; while the cache is NULL the page renders no mention at all rather than a placeholder. The authorization and grammar clauses above are unchanged by this cache — only the source of the slug name is.

## 4. Hardening closures delivered alongside this policy

- **Webhook body cap (61-R1):** the pre-buffer 413 cap is enforced on streamed bytes read, independent of the client-supplied `content-length` header. The cap applies while reading the request stream — reading past `WEBHOOK_BODY_LIMIT` bytes rejects 413 before the remainder is consumed — never after a full buffered read. The streamed read stays byte-authoritative for signature verification: the accumulated bytes are the exact request body, UTF-8-decoded identically to today's buffered read, so HMAC verification is unchanged. Same `WEBHOOK_BODY_LIMIT` value; a truthful over-limit header may still short-circuit early; headerless/chunked/lying-header requests can no longer buffer past the cap, and oversized requests reject 413 with the existing structured warn.
- **Admin bootstrap required input (61-R2):** `ADMIN_LOGINS` (the bootstrap allowlist var — not a Worker secret) is a **required** deploy input sourced from the GitHub Actions variable `ADMIN_LOGINS`. The deploy workflow fails closed **before the job's first `wrangler` invocation** (`wrangler secret bulk` publishes a Worker version of its own, so a gate placed after it would already have shipped one) when it is missing or parses to zero logins (both the gate and the post-deploy assertion import and call the runtime `parseAdminLogins` itself, rather than approximating it), injects the value into the Worker with `wrangler deploy --var`, and asserts the binding on the deployed Worker via the settings API — a failed read or a failed settings parse fails the job rather than passing. So the first-login-becomes-admin fallback is never silently armed. The fallback's semantics themselves are unchanged by this iteration. `ADMIN_LOGINS` is an **"at least one" bootstrap list**, not a membership-management surface: its purpose is to ensure the first admin can access the dashboard, and it is not ongoing membership management — the dashboard `users` table / Members page is the authorization SSOT, while a listed login with no `users` row remains eligible for admin bootstrap, and an existing row always wins without promotion. A removal recorded by an operator is likewise consulted before the allowlist branch — see the revocation closure below.

- **Admin removal is authoritative (revocation):** removing a member records the login in `removed_logins` (migration `0023`, NOCASE-keyed like `users.github_login`; `removed_at` required, `removed_by` = the acting admin) **in the same transaction** as the `users` row delete — ONE D1 `batch` with the last-admin guard carried by both statements — so a removal can never be recorded without the row actually being gone, a row can never be deleted without being recorded, and a refused (last-admin) removal records nothing. `bootstrapDashboardAccess` precedence is therefore: existing `users` row → recorded removal (deny, zero writes) → `ADMIN_LOGINS` → empty-table fallback → deny. An existing row still wins; the allowlist never resurrects a removed login; an explicit re-invite (`createUser`, which clears the record in the batch with its insert) restores normal bootstrap. The automatic path never clears removal state and its insert refuses **at the write boundary**: `bootstrapCreateAdmin` carries `WHERE NOT EXISTS (removal record for the login, NOCASE)` in the same statement as the insert, so a removal landing after the callback's reads still resolves to the ordinary deny (no read-then-insert window to lose). The deny shape (403 page, **zero Set-Cookie**, zero writes) is unchanged and the last-admin removal protection is untouched.

## 5. Non-goals

- Check rerequested trigger, Check annotations, check-suite triggers (still deferred in `review-lifecycle.md`).
- Natural-language comment interpretation, `/review`-family parsing, per-comment sub-commands.
- Old-App migration/compatibility UX for the mode column; implicit database resets.
- Per-repo or per-installation trigger overrides (per-App only, this iteration).
- Changes to `mstar.review/v1`, publication faces, or harness skill bodies.

## 6. Acceptance anchors

1. Mode matrix (§2.1) is pinned exhaustively by worker classification tests (mode × event × actor).
2. Mention grammar (§3) is pinned: canonical `[bot]` form, bare-slug form, trailing-boundary rejections (`@{appSlug}-other`, `@{appSlug}bot`), leading-boundary rejection (email-shaped `name@{appSlug}.host`), match at body start/middle/end, multi-App isolation, actor gate, bot-sender guard.
3. `every_push` default reproduces current behavior byte-for-byte at the classification layer (diff-to-current pin).
4. Body-cap tests cover: truthful header over limit, lying short header with oversized body, headerless chunked oversized body, at-limit body accepted.
5. Admin-required-input evidence recorded against `docs/deploy.md` § 6 + the deploy workflow's pre-deploy required check and post-deploy assertion.
6. The `triggered_by` wire union retires `"review_command"`: classification and pipeline tests pin `"issue_comment"` on the mention path and the updated `review_failures` event label.
