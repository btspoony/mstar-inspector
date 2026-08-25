/**
 * Unit tests for the Installation-Token diff fetcher (plan 01 Task 3).
 *
 * The octokit factory is injected and mocked — no real token, no network.
 * Contract under test (plan Module contracts):
 *   createDiffFetcher(getOctokit) → { fetchPrDiff(installationId, owner, repo, prNumber): Promise<string> }
 * Success value MUST be a non-empty string starting with "diff --git".
 * Errors from the octokit layer MUST reject (never swallowed).
 */

import { describe, expect, test } from "bun:test";
import {
  createInstallationAuth,
  type OctokitLike,
  type PullsGetParams,
} from "../../src/gateway/auth";
import { createDiffFetcher } from "../../src/gateway/diff";

const DIFF = `diff --git a/README.md b/README.md
index 0100000..0200000 100644
--- a/README.md
+++ b/README.md
@@ -1 +1,2 @@
 hello
+world
`;

/** Octokit mock whose `rest.pulls.get` resolves to the given response. */
function makeOctokit(response: { data: unknown }): OctokitLike {
  return {
    rest: {
      pulls: {
        get: async () => response,
      },
    },
  };
}

/** getOctokit factory mock: records the installation id, returns the octokit. */
function makeGetOctokit(octokit: OctokitLike) {
  const calls: number[] = [];
  const getOctokit = async (installationId: number): Promise<OctokitLike> => {
    calls.push(installationId);
    return octokit;
  };
  return { getOctokit, calls };
}

describe("createDiffFetcher", () => {
  test("returns the unified diff string when octokit data is already the diff", async () => {
    const { getOctokit } = makeGetOctokit(makeOctokit({ data: DIFF }));
    const { fetchPrDiff } = createDiffFetcher(getOctokit);

    const result = await fetchPrDiff(12345, "acme", "inspector", 42);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result.startsWith("diff --git")).toBe(true);
    expect(result).toBe(DIFF);
  });

  test("handles octokit responses where the diff is nested under data.data", async () => {
    const { getOctokit } = makeGetOctokit(makeOctokit({ data: { data: DIFF } }));
    const { fetchPrDiff } = createDiffFetcher(getOctokit);

    const result = await fetchPrDiff(12345, "acme", "inspector", 42);

    expect(typeof result).toBe("string");
    expect(result.length).toBeGreaterThan(0);
    expect(result.startsWith("diff --git")).toBe(true);
    expect(result).toBe(DIFF);
  });

  test("passes installationId to getOctokit and owner/repo/prNumber to pulls.get with diff media type", async () => {
    const octokit = makeOctokit({ data: DIFF });
    const { getOctokit, calls } = makeGetOctokit(octokit);
    const { fetchPrDiff } = createDiffFetcher(getOctokit);

    const getCalls: unknown[] = [];
    const originalGet = octokit.rest?.pulls?.get;
    octokit.rest = {
      pulls: {
        get: async (params: PullsGetParams) => {
          getCalls.push(params);
          return originalGet!(params);
        },
      },
    };

    await fetchPrDiff(12345, "acme", "inspector", 42);

    expect(calls).toEqual([12345]);
    expect(getCalls).toEqual([
      {
        owner: "acme",
        repo: "inspector",
        pull_number: 42,
        mediaType: { format: "diff" },
      },
    ]);
  });

  test("rejects when the octokit call throws (errors are not swallowed)", async () => {
    const octokit: OctokitLike = {
      rest: {
        pulls: {
          get: async () => {
            throw new Error("boom: rate limited");
          },
        },
      },
    };
    const { getOctokit } = makeGetOctokit(octokit);
    const { fetchPrDiff } = createDiffFetcher(getOctokit);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow(
      "boom: rate limited",
    );
  });

  test("rejects when getOctokit itself throws", async () => {
    const getOctokit = async (): Promise<OctokitLike> => {
      throw new Error("auth failed");
    };
    const { fetchPrDiff } = createDiffFetcher(getOctokit);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow("auth failed");
  });

  test("rejects a JSON patch response instead of treating it as success", async () => {
    const { getOctokit } = makeGetOctokit(makeOctokit({ data: { id: 1, title: "PR" } }));
    const { fetchPrDiff } = createDiffFetcher(getOctokit);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow(
      /unified diff/,
    );
  });

  test("rejects an HTML/error-page string that is not a unified diff", async () => {
    const { getOctokit } = makeGetOctokit(
      makeOctokit({ data: "<html><body>Not Found</body></html>" }),
    );
    const { fetchPrDiff } = createDiffFetcher(getOctokit);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow(
      /unified diff/,
    );
  });

  test("rejects an empty diff string", async () => {
    const { getOctokit } = makeGetOctokit(makeOctokit({ data: "" }));
    const { fetchPrDiff } = createDiffFetcher(getOctokit);

    await expect(fetchPrDiff(12345, "acme", "inspector", 42)).rejects.toThrow(
      /unified diff/,
    );
  });
});

describe("createInstallationAuth", () => {
  test("delegates to app.auth(installationId) — the Probot installation-token binding", async () => {
    const authCalls: number[] = [];
    const octokitMock: OctokitLike = {
      rest: { pulls: { get: async () => ({ data: "" }) } },
    };
    const app = {
      auth: async (installationId: number) => {
        authCalls.push(installationId);
        return octokitMock;
      },
    } as never;

    const getOctokit = createInstallationAuth(app);
    const octokit = await getOctokit(7);

    expect(authCalls).toEqual([7]);
    expect(octokit).toBe(octokitMock);
  });
});
