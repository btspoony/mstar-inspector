---
module: review-lifecycle
date: 2026-11-12
problem_type: best_practice
category: best-practices
severity: high
topic: review-thread discovery and identity matching across GitHub REST/GraphQL shapes
applies_when:
  - "a gate compares an external API value against an identity or anchor the code assumed rather than measured"
  - "one logical entity (user, comment, row) has different field shapes on two endpoints of the same provider"
  - "a durable state column (bound remote ids) can stay NULL on every row forever while the chain keeps 'working'"
  - "a fail-closed rejection path can be observationally identical to a healthy gate"
  - "fixtures are written from the implementation's assumption instead of a captured real response"
tags:
  - github-api
  - rest-vs-graphql
  - identity-matching
  - fail-closed-trap
  - fixture-realism
  - terminal-assertion
related_components:
  - src/pipeline/review-threads.ts
  - src/pipeline/comment.ts
  - src/worker/lifecycle-reconcile.ts
  - docs/specs/feature/review-lifecycle.md
---

# An assumed external shape deadlocks a whole chain: measure the response, pin the fixture, assert the terminal state

A review-thread resolution chain never ran — not "rarely failed", never once across thousands of attempts — because every gate compared against a *shape* of a GitHub response that the code assumed rather than measured. The failure was silent: the durable columns the chain exists to fill (`review_threads.review_id`/`comment_id`/`thread_id`) simply stayed NULL on every row, and each run reported a well-typed, perfectly ordinary `unknown`/`foreign` outcome.

## Context

The lifecycle reconcile (`discoverUncertainPublication` in `src/worker/lifecycle-reconcile.ts`) re-drives publications whose send response was lost. Discovery (`lookupThreadForIntent` in `src/pipeline/review-threads.ts`, spec `docs/specs/feature/review-lifecycle.md` §7.5) must prove a thread is ours before binding its remote ids: App-author identity, batch marker, original commit SHA, root-comment marker, path/range anchor, generated-body sha256, and the root review REST id. Two of those comparisons compared the *wrong shape*, and each was sufficient alone to return `unknown`/`foreign` on every real thread:

1. **The same identity has two shapes.** A GitHub App is `<slug>[bot]` over REST (`user.login`) but the bare `<slug>` in GraphQL (`author.login`). The code derived ``botLogin = `${slug}[bot]` `` from the JWT-authenticated `GET /app` slug, then compared it for exact equality against GraphQL-shaped `author.login` values in `isBotAuthor`/`isBotIdentity`. Every thread's author failed the comparison, so discovery classified every candidate as `unknown` or `foreign` — while every *other* gate on a real thread passed: the outdated-anchor fence accepted the `originalLine` anchor, the root body sha256 equalled the stored digest, and the root review's REST id (`fullDatabaseId`) equalled the review's. One wrong string comparison deadlocked a chain whose remaining five gates were all correct.
2. **The same rows have different fields on two endpoints.** After `pulls.createReview`, created comment ids are read back in `postLineCommentsWithOctokit` (`src/pipeline/comment.ts`) because the create response omits the comments array. The review-scoped list (`GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments`, `listCommentsForReview`) returns the created comments with `line`, `original_line` and `side` all null, while the PR-wide list (`GET /pulls/{pull_number}/comments`, `listReviewComments`) returns real anchors for the same comment ids. Matching on `path + line` against the review-scoped list could therefore never succeed, even with the identity fix in place.
3. **The fixture was written from the assumption.** The unit suite pinned ``BOT_LOGIN = `${SLUG}[bot]` `` — the REST shape — and fed it to GraphQL-shaped fixture authors (`author: { __typename, login }`), so every identity gate passed in tests exactly while production was dead. Green tests were not evidence of a working chain; they were evidence that the test shared the code's assumption.

The fix introduced one predicate, `sameAppBotLogin(login, botLogin)` in `src/pipeline/review-threads.ts`, true for both the canonical `<slug>[bot]` and its suffix-stripped GraphQL form (false for `null`, for a bare slug when the canonical form was expected, and for any other login); switched the comment read-back in `postLineCommentsWithOctokit` to key on the trusted per-comment thread marker (association id) with `path + (line ?? original_line)` only as a fallback for marker-less rows; and pinned both login shapes plus a marker-keyed capture test in the suite.

## Guidance

1. **Measure the real response shape before writing the comparison.** Capture one real response per endpoint (or verify against the provider's live behaviour) and record which surface each field comes from. Never derive the expected value from the other endpoint's convention: REST `user.login` and GraphQL `author.login` are different fields with different formats for the same identity, and either side can change independently.
2. **Normalize both shapes into one predicate at the comparison point.** A single `sameAppBotLogin(login, botLogin)`-style helper, unit-tested over the full matrix — canonical, suffix-stripped, `null`, empty, near-misses like `other-app[bot]` and the bare slug — beats N inline equality checks that each silently encode one assumed shape. Keep the predicate strict: matching is whitelisting, not substring forgiving.
3. **Key on a trusted marker the API cannot re-shape; treat anchors as fallback.** When one endpoint nulls the anchor fields another endpoint populates (review-scoped comment lists null `line`/`original_line`/`side` for freshly created comments), match on the durable marker embedded in the body, and use the positional anchor only for rows carrying no marker at all — an unknown or duplicated marker must never fall back to position.
4. **Pin fixtures to the measured shape, per endpoint.** A GraphQL-shaped fixture author must carry the GraphQL login shape (`<slug>`), a REST-shaped stub the REST shape (`<slug>[bot]`); the constant the production code derives is the *canonical* form, and the predicate under test is what bridges them. A fixture that reuses the production constant tests the assumption, not the integration.
5. **Assert the terminal observable, not the per-gate outcome.** Each gate returning a typed `unknown`/`foreign`/`found` proves nothing about the chain; the test that matters asserts the id is actually written or the state actually advanced (the association row ends with `review_id`/`comment_id`/`thread_id` bound, or a live read-back finds the posted comment). When a durable column can remain NULL on every row forever, "every gate returned a typed outcome" and "the chain works" are indistinguishable without that assertion.
6. **Instrument the NULL-steady state.** A column the chain exists to fill that never changes value across thousands of runs is a signal, not a stable steady state — alert on or periodically audit "fail-closed gate has never once passed", because that is precisely what a shape-mismatched gate looks like.

## Why This Matters

A fail-closed gate that rejects everything is observationally identical to a gate that is working: both produce typed, logged, retryable outcomes, neither throws, and the surrounding chain keeps running. The deadlock is invisible until someone notices the durable state never advances — here, a whole review-thread resolution chain that never executed a single resolution. The cost lands twice: the feature is silently dead in production, and the test suite is green the entire time because the fixture encoded the same wrong shape as the code. The discipline generalises beyond GitHub: any integration whose correctness rests on comparing external values must treat the external shape as data to be measured, not a convention to be assumed.

## When to Apply

- Matching identities or anchors across two endpoints or protocols of the same provider (REST vs GraphQL, list vs detail, create response vs read-back).
- Any gate whose rejection is fail-closed and whose "pass" writes a durable id or advances a state column.
- Writing fixtures for API-shaped predicates — ask "was this shape captured from a real response, or copied from the code's expectation?"
- A chain of gates where each step is individually typed and tested but no test observes the end state.

## Examples

- Identity predicate matrix: `sameAppBotLogin("<slug>[bot]", "<slug>[bot]") → true`, `sameAppBotLogin("<slug>", "<slug>[bot]") → true` (GraphQL shape), `sameAppBotLogin(null, …) → false`, `sameAppBotLogin("other-app[bot]", …) → false`, `sameAppBotLogin("<slug>", "<slug>") → false` (bare slug is never its own canonical form).
- Endpoint anchor trap: the same created comment id reads back with `line: null, original_line: null, side: null` from `GET /pulls/{n}/reviews/{id}/comments` but with real anchors from `GET /pulls/{n}/comments` — so a `path + line` match against the review-scoped list returns zero candidates for every intent, forever.
- Terminal assertion: after discovery runs on a lost-response publication, assert the association row's `review_id`/`comment_id`/`thread_id` are non-NULL — not that `lookupThreadForIntent` returned `{ kind: "found" }` against a fixture whose author login the test itself set.
