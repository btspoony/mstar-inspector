
/** Hidden HTML marker prefix — the first line of every review comment body. */
export const REVIEW_MARKER_PREFIX = "<!-- mstar-inspector:review:v1";

/** Full marker regex: `<!-- mstar-inspector:review:v1 round=N -->`. */
export const REVIEW_MARKER_RE = /^<!-- mstar-inspector:review:v1 round=(\d+) -->/;

/** Hidden HTML marker prefix — the first line of every degraded comment body. */
export const DEGRADED_MARKER_PREFIX = "<!-- mstar-inspector:review-degraded:v1";

/** Full marker regex: `<!-- mstar-inspector:review-degraded:v1 round=N -->`. */
export const DEGRADED_MARKER_RE = /^<!-- mstar-inspector:review-degraded:v1 round=(\d+) -->/;
