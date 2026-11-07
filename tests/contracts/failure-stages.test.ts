/**
 * GitHub rate-limit classification (the pure half of the consumer tagging
 * point). The classifier answers ONE question — which GitHub limit rejected
 * this call — because the persisted `review_failures.error` prefix and the
 * store's 24 h count are derived from it; a second interpretation of the same
 * rejection is what would let the page and the rows disagree.
 *
 * The shapes below are the octokit request-error shape the pipeline actually
 * throws (`{status, message, response: {headers}}`), the `Headers` instance a
 * transport may expose instead of a plain header map, and the non-request
 * values a decode can produce.
 */

import { describe, expect, test } from "bun:test";

import { classifyGithubRateLimit } from "../../src/contracts/failure-stages";

describe("classifyGithubRateLimit", () => {
  test("429 is a primary limit", () => {
    expect(
      classifyGithubRateLimit({
        status: 429,
        message: "API rate limit exceeded for installation",
        response: { headers: { "x-ratelimit-remaining": "0" } },
      }),
    ).toBe("primary");
  });

  test("403 with retry-after is a secondary limit (plain header map)", () => {
    expect(
      classifyGithubRateLimit({ status: 403, message: "Forbidden", response: { headers: { "retry-after": "60" } } }),
    ).toBe("secondary");
  });

  test("403 with retry-after is a secondary limit (Headers instance, header casing ignored)", () => {
    expect(
      classifyGithubRateLimit({ status: 403, message: "Forbidden", response: { headers: new Headers({ "Retry-After": "60" }) } }),
    ).toBe("secondary");
  });

  test("403 with x-ratelimit-remaining: 0 is a secondary limit", () => {
    expect(
      classifyGithubRateLimit({
        status: 403,
        message: "Forbidden",
        response: { headers: { "x-ratelimit-remaining": "0" } },
      }),
    ).toBe("secondary");
  });

  test("403 whose message names a secondary rate limit is a secondary limit", () => {
    expect(
      classifyGithubRateLimit({
        status: 403,
        message: "You have exceeded a SECONDARY rate limit. Please wait before retrying.",
        response: { headers: {} },
      }),
    ).toBe("secondary");
  });

  test("a plain 403, a 5xx and a retry-after on a non-403 are unclassified", () => {
    // A permission/not-found 403 keeps some remaining budget: not a limit.
    expect(
      classifyGithubRateLimit({
        status: 403,
        message: "Resource not accessible by integration",
        response: { headers: { "x-ratelimit-remaining": "42" } },
      }),
    ).toBeNull();
    expect(classifyGithubRateLimit({ status: 500, message: "server error" })).toBeNull();
    expect(classifyGithubRateLimit({ status: 502, message: "bad gateway", response: { headers: { "retry-after": "5" } } })).toBeNull();
  });

  test("non-request values are unclassified and never throw", () => {
    const values: unknown[] = [
      undefined,
      null,
      "403 Forbidden",
      403,
      {},
      { message: "boom" },
      { status: "403" },
      [],
      () => undefined,
      // Malformed envelopes: a transport that answered without response/headers.
      { status: 403, message: "Forbidden", response: null },
      { status: 403, message: "Forbidden", response: { headers: "retry-after: 60" } },
    ];
    for (const value of values) expect(classifyGithubRateLimit(value)).toBeNull();
  });
});
