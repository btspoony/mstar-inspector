---
module: pipeline-comment
date: 2026-08-31
problem_type: best_practice
category: best-practices
severity: medium
applies_when:
  - "Posting per-line PR review comments via the GitHub pulls API"
  - "Anchoring machine-generated findings to diff line positions"
  - "Keeping a COMMENT-only event lock while adding line comments"
plan_id: 18-m3-review-quality
tags:
  - github-api
  - pull-requests
  - line-comments
  - create-review
  - diff-hunks
---

# GitHub PR line comments via createReview: atomicity, required body, hunk prefilter

## Context

Findings carry `file_path`/`line_start`/`line_end`, but issues-API comments cannot anchor to lines. The pulls API (`POST /repos/{o}/{r}/pulls/{pull_number}/reviews` with `comments[]`) anchors them — with three non-obvious constraints verified against the installed `@octokit/rest` 22.0.1 openapi types and live behavior (v0.7 / plan 18, AL-3).

## Guidance

1. **createReview is atomic per request**: one invalid line position (not in the commit's diff) rejects the WHOLE review with 422 — up to N−1 valid comments are lost. Pre-filter findings against the actual diff before calling: fetch the PR diff (`pulls.get` with `mediaType: { format: "diff" }` — the schema-recommended mode), parse right-side hunk ranges with a pure unified-diff parser (consume hunk bodies by header tallies so added `+++ …` content lines never masquerade as headers; rename binds `+++ b/<new>`; binary/deleted files carry no right ranges), then keep only findings whose `path`/`line` fall inside a hunk.
2. **Layer the fallback**: prefetch failure → attempt unfiltered (base-filter only); residual 422 or any Octokit error AFTER the overall comment succeeded → structured log + continue, never throw, never retry (the next round re-anchors). Empty qualifying set → zero API calls.
3. **Top-level `body` is REQUIRED** even for `event: "COMMENT"` ("Required when using REQUEST_CHANGES or COMMENT"). Keep it a marker short-line (e.g. hidden-marker + round) — never duplicate the overall comment content, so the overall comment remains the single round SSOT.
4. **Per-comment shape**: `{ path, side: "RIGHT", line, body }`; `path`+`body` required; `line` must be an integer in a right-side hunk. Multi-line needs `start_line` too — skip it unless both ends are verified in-diff.
5. **Old rounds stay**: review comments have no upsert; new round = new review; GitHub renders stale ones as outdated. The D4-style event lock (COMMENT, never APPROVE/REQUEST_CHANGES) is unaffected — `createReview` supports COMMENT as a first-class event.
6. **Quoted paths**: diff `b/<path>` tokens may be C-quoted; unquote best-effort (`JSON.parse`); unquotable → exact-match fails → excluded (safe).

## Why This Matters

Without the prefilter, model-emitted line numbers (often slightly outside hunks) make every multi-comment review fail wholesale — the feature silently degrades to overall-only with no per-line value. The required-body constraint is invisible until a 422 teaches you.

## When to Apply

- Bot reviewers anchoring findings to lines
- Any machine batch-posting of GitHub review comments
- Migrating an issues-comment-only reviewer to anchored comments

## Examples

- Layered delivery: base filter (fields non-empty) → diff prefetch (only when something qualifies) → hunk filter → one createReview → 422/network → log `line_comments_fallback=true` + proceed.
- Marker body: `<!-- mstar-inspector:line-comments:v1 round=N -->`-style short line satisfies the schema while staying grep-discoverable and duplication-free.
