
import { describe, expect, test } from "bun:test";

import {
  GITHUB_PRIMARY_RATE_LIMIT_PREFIX,
  GITHUB_RATE_LIMIT_PREFIX,
  classifyGithubRateLimit,
} from "../../src/contracts/failure-stages";

describe("rate-limit error prefixes", () => {
  test("each prefix equals its documented literal", () => {
    expect(GITHUB_RATE_LIMIT_PREFIX).toBe("github-secondary-rate-limit: ");
    expect(GITHUB_PRIMARY_RATE_LIMIT_PREFIX).toBe("github-primary-rate-limit: ");
  });

  test("neither prefix is a prefix of the other", () => {
    expect(GITHUB_PRIMARY_RATE_LIMIT_PREFIX.startsWith(GITHUB_RATE_LIMIT_PREFIX)).toBe(false);
    expect(GITHUB_RATE_LIMIT_PREFIX.startsWith(GITHUB_PRIMARY_RATE_LIMIT_PREFIX)).toBe(false);
  });
});

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

  test("403 with x-ratelimit-remaining: 0 is a PRIMARY limit", () => {
    expect(
      classifyGithubRateLimit({
        status: 403,
        message: "API rate limit exceeded for installation",
        response: { headers: { "x-ratelimit-remaining": "0" } },
      }),
    ).toBe("primary");
  });

  test("the secondary signals win over an exhausted budget on the same 403", () => {
    expect(
      classifyGithubRateLimit({
        status: 403,
        message: "You have exceeded a SECONDARY rate limit.",
        response: { headers: { "retry-after": "60", "x-ratelimit-remaining": "0" } },
      }),
    ).toBe("secondary");
  });

  test("a plain 403 with no limit header is unclassified", () => {
    expect(classifyGithubRateLimit({ status: 403, message: "Forbidden" })).toBeNull();
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
      { status: 403, message: "Forbidden", response: null },
      { status: 403, message: "Forbidden", response: { headers: "retry-after: 60" } },
    ];
    for (const value of values) expect(classifyGithubRateLimit(value)).toBeNull();
  });
});
