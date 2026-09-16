---
module: webhook face (src/worker/index.ts)
date: 2026-09-17
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 73-webhook-deploy-hardening
tags:
  - workerd
  - body-cap
  - streaming
  - hmac
  - request-body
---

# Streamed byte-authoritative body caps on workerd

## Context

The webhook face needs a hard request-body cap (413) before signature verification. The pre-buffer implementation trusted the client-supplied `content-length` header and called `c.req.text()` when the header was absent — chunked or lying-header requests buffered the full body before any cap applied. Registered as residual 61-R1 (2026-09-10) and closed by plan 73 (iteration 022-review-trigger-hardening, 2026-09-17).

## Guidance

Enforce the cap on **bytes actually read from the stream**, never on headers:

1. Read `c.req.raw.body` with a reader, accumulating `chunk.byteLength`; the moment `total > limit`, stop and cancel the reader (reject 413 immediately — the remainder is never consumed, and the runtime can drop the connection early).
2. Read exactly to `limit + 1` so "exactly at the cap" passes and "one byte over" rejects; compare with strict `>` after the read.
3. Concatenate accepted chunks into **one buffer and decode once** with a single `new TextDecoder().decode(buffer)`. Never decode per chunk: multi-byte UTF-8 characters split across chunk boundaries would corrupt, and the decoded string must be **byte-identical to `request.text()`** because the raw body feeds HMAC signature verification.
4. Keep a truthful-`content-length` fast path if it exists, but it may only reject early — a missing or lying header must never bypass the byte count.
5. Pin all four shapes in tests: truthful header over limit → 413; lying short header + oversized body → 413 (assert the structured warn's `detail` field, e.g. `read_bytes>N`, so the test proves which gate fired rather than just event/reason); headerless chunked oversized body → 413; **at-limit body accepted with a real HMAC over the exact limit bytes** — and make at least one at-limit body multi-byte UTF-8, computing length with `Buffer.byteLength` (`.length` is UTF-16 code units, not bytes).

A cheap companion pattern for deploy-time config checks: `wrangler secret list` only sees Worker **secrets**; dashboard-managed plain vars (e.g. `keep_vars` entries like `ADMIN_LOGINS`) are observable via the Cloudflare Workers settings API (`GET /accounts/.../workers/scripts/<name>/settings`) — bound the curl with `--max-time`/`--connect-timeout` and guard the jq parse so only a positively observed unset fires the warning.

## Why This Matters

- A header-trusting cap is not a cap: any client that omits or lies about `content-length` buffers memory past the limit before the check runs.
- Per-chunk decoding or `.length`-based sizing silently breaks HMAC verification and the exact-cap boundary — the failure appears only with multi-byte bodies at the boundary, which ASCII-shaped tests never catch.
- Unbounded curls in CI steps stall runs for hours (default 360 min job timeout) and starve `if: always()` artifact uploads.

## When to Apply

Any workerd/Hono request face that must bound body memory before parsing (webhooks, form posts, upload edges), and any CI deploy check that inspects deployed Worker configuration.

## Examples

- `src/worker/index.ts` `readBodyWithinLimit` (plan 73, commit `53e529e` + fix wave `b000091`): limit+1 accumulation, early cancel, single decode; tests in `tests/worker/webhook-routing.test.ts` pin gate attribution via the warn `detail` and a `"漢"`-padded byte-exact at-limit HMAC case.
- `.github/workflows/deploy.yml` post-deploy smoke: settings-API `ADMIN_LOGINS` presence check with `--max-time 30 --connect-timeout 5` and a `jq -e '.success == true'` guard (plan 73 task 2; the `ADMIN_LOGINS`-is-a-var-not-secret reconciliation is recorded in `docs/deploy.md` §6).
