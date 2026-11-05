/**
 * The publication marker wire — the hidden HTML prefix that identifies the
 * Inspector's own PR-level issue comments: the review chain
 * (`<!-- mstar-inspector:review:v1 round=N -->`) and the degraded chain
 * (`<!-- mstar-inspector:review-degraded:v1 round=N -->`, a SEPARATE family:
 * neither prefix starts with the other, so the two scans and their round
 * counters stay independent).
 *
 * This is a LEAF module with no pipeline imports. The prefix is needed by
 * both the comment chains (`comment.ts`) and the discussion capture
 * (`review-threads.ts`) that excludes our own publication comments from the
 * digest domain; keeping it here is what lets the capture read the wire
 * without importing the whole comment module (which imports the thread
 * surface back — a cycle).
 */

/** Hidden HTML marker prefix — the first line of every review comment body. */
export const REVIEW_MARKER_PREFIX = "<!-- mstar-inspector:review:v1";

/** Full marker regex: `<!-- mstar-inspector:review:v1 round=N -->`. */
export const REVIEW_MARKER_RE = /^<!-- mstar-inspector:review:v1 round=(\d+) -->/;

/** Hidden HTML marker prefix — the first line of every degraded comment body. */
export const DEGRADED_MARKER_PREFIX = "<!-- mstar-inspector:review-degraded:v1";

/** Full marker regex: `<!-- mstar-inspector:review-degraded:v1 round=N -->`. */
export const DEGRADED_MARKER_RE = /^<!-- mstar-inspector:review-degraded:v1 round=(\d+) -->/;
