import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MstarReviewV1 } from "@mstar-harness/engine";
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

import type { AgentRuntime, AgentRuntimeRunInput, ReviewRunResult } from "../../packages/shared/src/runtime";
import {
  TOKEN_USAGE_MAX_BYTES,
  TOKEN_USAGE_PATH,
  validateTokenUsageDoc,
  type TokenUsageBucket,
  type TokenUsageDoc,
} from "../../packages/shared/src/token-usage-wire";
import { encodeCredentialPayload } from "../../packages/shared/src/credential-payload";
import {
  bucketFromSubagent,
  bucketsFromSession,
  mergeBuckets,
} from "../../packages/runner/src/token-usage";
import { main } from "../../packages/runner/src/runner";

type Bucket = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  requests: number;
  costUsd: number;
};

function usage(partial: Partial<Bucket>): Bucket {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    requests: 0,
    costUsd: 0,
    ...partial,
  };
}

function assistantEntry(id: string, provider: string, model: string, fields?: Partial<Bucket>): SessionEntry {
  return {
    type: "message",
    id,
    parentId: null,
    timestamp: "2026-11-25T00:00:00.000Z",
    message: {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider,
      model,
      stopReason: "stop",
      usage:
        fields === undefined
          ? (undefined as never)
          : { ...usage(fields), totalTokens: fields.total ?? 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: fields.costUsd ?? 0 } },
    } as never,
  };
}

function modelUsageEntry(id: string, provider: string, model: string, fields: Partial<Bucket>): SessionEntry {
  return {
    type: "model_usage",
    id,
    parentId: null,
    timestamp: "2026-11-25T00:00:00.000Z",
    purpose: "title",
    api: "openai-responses",
    provider,
    model,
    stopReason: "stop",
    usage: {
      ...usage(fields),
      totalTokens: fields.total ?? 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: fields.costUsd ?? 0 },
    },
  } as never;
}

function subagentResult(opts: {
  resolvedModel?: string;
  requests?: number;
  usage?: Partial<Bucket>;
}): Parameters<typeof bucketFromSubagent>[0] {
  return {
    resolvedModel: opts.resolvedModel,
    requests: opts.requests,
    ...(opts.usage === undefined
      ? {}
      : {
          usage: {
            ...usage(opts.usage),
            totalTokens: opts.usage.total ?? 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: opts.usage.costUsd ?? 0 },
          } as never,
        }),
  };
}

describe("bucketsFromSession", () => {
  test("folds assistant turns across two providers with exact buckets and one request each", () => {
    const buckets = bucketsFromSession([
      assistantEntry("e1", "ark", "deepseek-v4", { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, total: 155, costUsd: 0.5 }),
      assistantEntry("e2", "ark", "deepseek-v4", { input: 40, output: 10, total: 50, costUsd: 0.25 }),
      assistantEntry("e3", "opencode", "gpt-5.2", { input: 7, output: 3, cacheRead: 2, total: 12, costUsd: 0.01 }),
    ]);
    expect(buckets).toEqual([
      {
        provider: "ark",
        model: "deepseek-v4",
        input: 140,
        output: 30,
        cacheRead: 30,
        cacheWrite: 5,
        total: 205,
        requests: 2,
        costUsd: 0.75,
      },
      {
        provider: "opencode",
        model: "gpt-5.2",
        input: 7,
        output: 3,
        cacheRead: 2,
        cacheWrite: 0,
        total: 12,
        requests: 1,
        costUsd: 0.01,
      },
    ]);
  });

  test("counts a model_usage entry and a usage-less assistant turn once each", () => {
    const buckets = bucketsFromSession([
      assistantEntry("e1", "ark", "deepseek-v4", { input: 10, total: 10 }),
      modelUsageEntry("e2", "ark", "deepseek-v4", { input: 4, output: 1, total: 5, costUsd: 0.001 }),
      assistantEntry("e3", "ark", "deepseek-v4"),
    ]);
    expect(buckets).toEqual([
      {
        provider: "ark",
        model: "deepseek-v4",
        input: 14,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 15,
        requests: 3,
        costUsd: 0.001,
      },
    ]);
  });

  test("ignores non-assistant messages and non-usage entry types", () => {
    const entries = [
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: "2026-11-25T00:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
      },
      {
        type: "model_change",
        id: "m1",
        parentId: null,
        timestamp: "2026-11-25T00:00:00.000Z",
        provider: "ark",
        model: "deepseek-v4",
      },
      assistantEntry("e1", "ark", "deepseek-v4", { input: 3, total: 3 }),
    ] as SessionEntry[];
    expect(bucketsFromSession(entries)).toEqual([
      {
        provider: "ark",
        model: "deepseek-v4",
        input: 3,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        total: 3,
        requests: 1,
        costUsd: 0,
      },
    ]);
  });

  test("a session with no usage yields zero buckets", () => {
    expect(bucketsFromSession([])).toEqual([]);
  });
});

describe("bucketFromSubagent", () => {
  test("attributes usage and requests to resolvedModel, stripping a :<thinking> suffix", () => {
    const bucket = bucketFromSubagent(
      subagentResult({
        resolvedModel: "ark/deepseek-v4:high",
        requests: 4,
        usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 40, total: 1540, costUsd: 1.25 },
      }),
    );
    expect(bucket).toEqual({
      provider: "ark",
      model: "deepseek-v4",
      input: 1000,
      output: 200,
      cacheRead: 300,
      cacheWrite: 40,
      total: 1540,
      requests: 4,
      costUsd: 1.25,
    });
  });

  test("keeps a model id whose trailing colon segment is not a thinking level", () => {
    const bucket = bucketFromSubagent(
      subagentResult({ resolvedModel: "ollama/llama3.1:latest", requests: 1, usage: { input: 5, total: 5 } }),
    );
    expect(bucket).toMatchObject({ provider: "ollama", model: "llama3.1:latest", requests: 1 });
  });

  test("an absent, blank or malformed resolvedModel yields no bucket", () => {
    expect(bucketFromSubagent(subagentResult({ resolvedModel: undefined, requests: 3, usage: { input: 1, total: 1 } }))).toBeUndefined();
    expect(bucketFromSubagent(subagentResult({ resolvedModel: "", requests: 3, usage: { input: 1, total: 1 } }))).toBeUndefined();
    expect(bucketFromSubagent(subagentResult({ resolvedModel: "no-slash", requests: 3, usage: { input: 1, total: 1 } }))).toBeUndefined();
    expect(bucketFromSubagent(subagentResult({ resolvedModel: "/model", requests: 3, usage: { input: 1, total: 1 } }))).toBeUndefined();
    expect(bucketFromSubagent(undefined)).toBeUndefined();
  });

  test("a missing usage object still counts its requests", () => {
    const bucket = bucketFromSubagent(subagentResult({ resolvedModel: "ark/deepseek-v4", requests: 2 }));
    expect(bucket).toMatchObject({ provider: "ark", model: "deepseek-v4", requests: 2, input: 0, total: 0 });
  });
});

describe("mergeBuckets", () => {
  test("sums equal pairs across sources and emits sorted output", () => {
    const session = bucketsFromSession([
      assistantEntry("e1", "ark", "deepseek-v4", { input: 10, output: 2, total: 12, costUsd: 0.1 }),
    ]);
    const seat = bucketFromSubagent(
      subagentResult({
        resolvedModel: "ark/deepseek-v4",
        requests: 3,
        usage: { input: 90, output: 8, total: 98, costUsd: 0.4 },
      }),
    )!;
    const other = bucketFromSubagent(
      subagentResult({
        resolvedModel: "beta/model-x",
        requests: 1,
        usage: { input: 5, output: 1, total: 6, costUsd: 0.01 },
      }),
    )!;
    expect(mergeBuckets([other], session, [seat])).toEqual([
      {
        provider: "ark",
        model: "deepseek-v4",
        input: 100,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        total: 110,
        requests: 4,
        costUsd: 0.5,
      },
      {
        provider: "beta",
        model: "model-x",
        input: 5,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        total: 6,
        requests: 1,
        costUsd: 0.01,
      },
    ]);
  });
});

function validBucket(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: "ark",
    model: "deepseek-v4",
    input: 10,
    output: 2,
    cacheRead: 0,
    cacheWrite: 0,
    total: 12,
    requests: 1,
    costUsd: 0.05,
    ...overrides,
  };
}

describe("validateTokenUsageDoc", () => {
  const valid = { version: 1, buckets: [validBucket()] } as unknown as TokenUsageDoc;

  test("accepts a valid document and returns the typed buckets", () => {
    const gate = validateTokenUsageDoc(valid);
    expect(gate.ok).toBe(true);
    if (gate.ok) expect(gate.doc).toEqual(valid);
  });

  test("accepts a document with an empty buckets list", () => {
    expect(validateTokenUsageDoc({ version: 1, buckets: [] }).ok).toBe(true);
  });

  test("rejects an extra document key and an extra bucket key", () => {
    expect(validateTokenUsageDoc({ ...valid, extra: true }).ok).toBe(false);
    expect(validateTokenUsageDoc({ version: 1, buckets: [validBucket({ note: "x" })] }).ok).toBe(false);
  });

  test("rejects a negative count, a non-integer count and a negative costUsd", () => {
    for (const field of ["input", "output", "cacheRead", "cacheWrite", "total", "requests"] as const) {
      expect(validateTokenUsageDoc({ version: 1, buckets: [validBucket({ [field]: -1 })] }).ok).toBe(false);
      expect(validateTokenUsageDoc({ version: 1, buckets: [validBucket({ [field]: 1.5 })] }).ok).toBe(false);
    }
    expect(validateTokenUsageDoc({ version: 1, buckets: [validBucket({ costUsd: -0.1 })] }).ok).toBe(false);
    expect(validateTokenUsageDoc({ version: 1, buckets: [validBucket({ costUsd: Number.NaN })] }).ok).toBe(false);
  });

  test("rejects a blank or over-long provider/model", () => {
    for (const field of ["provider", "model"] as const) {
      expect(validateTokenUsageDoc({ version: 1, buckets: [validBucket({ [field]: "   " })] }).ok).toBe(false);
      expect(validateTokenUsageDoc({ version: 1, buckets: [validBucket({ [field]: "x".repeat(129) })] }).ok).toBe(false);
      expect(validateTokenUsageDoc({ version: 1, buckets: [validBucket({ [field]: 7 })] }).ok).toBe(false);
    }
  });

  test("rejects a wrong version, a non-array buckets field and over-bound bucket count", () => {
    expect(validateTokenUsageDoc({ version: 2, buckets: [] }).ok).toBe(false);
    expect(validateTokenUsageDoc({ version: 1, buckets: "x" }).ok).toBe(false);
    expect(
      validateTokenUsageDoc({
        version: 1,
        buckets: Array.from({ length: 65 }, (_, index) => validBucket({ model: `m-${index}` })),
      }).ok,
    ).toBe(false);
  });

  test("a valid document stays inside the wire byte bound", () => {
    expect(new TextEncoder().encode(JSON.stringify(valid)).byteLength).toBeLessThan(TOKEN_USAGE_MAX_BYTES);
  });
});

describe("runner token-usage side document", () => {
  const ENVELOPE = { schema: "mstar.review/v1", verdict: "blocked", summary_md: "s", findings: [] } as MstarReviewV1;

  function writeInput(): string {
    const dir = mkdtempSync(join(tmpdir(), "token-usage-input-"));
    const path = join(dir, "input.json");
    writeFileSync(path, JSON.stringify({ capabilityHosts: [], worktreePath: "/workspace/clone" }));
    return path;
  }

  function runtimeWith(buckets: TokenUsageBucket[] | undefined): AgentRuntime {
    return {
      runReview: async (_input: AgentRuntimeRunInput): Promise<ReviewRunResult> => ({
        envelope: ENVELOPE,
        recheck: null,
        report: null,
        ...(buckets === undefined ? {} : { tokenUsage: buckets }),
      }),
    };
  }
  async function runCli(argv: string[], runtime: AgentRuntime, tokenUsagePath: string) {
    const logs: string[] = [];
    const errors: string[] = [];
    const statusDir = mkdtempSync(join(tmpdir(), "token-usage-status-"));
    const originalLog = console.log;
    const originalError = console.error;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      const code = await main(
        argv,
        runtime,
        async () => encodeCredentialPayload({}),
        join(statusDir, "status.json"),
        join(statusDir, "applied-model.json"),
        tokenUsagePath,
      );
      return { code, stdout: logs.join("\n"), stderr: errors.join("\n") };
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
  }

  test("a completed run writes the document with its buckets", async () => {
    const dir = mkdtempSync(join(tmpdir(), "token-usage-out-"));
    const path = join(dir, "review-token-usage.json");
    const buckets: TokenUsageBucket[] = [
      {
        provider: "ark",
        model: "deepseek-v4",
        input: 10,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        total: 12,
        requests: 1,
        costUsd: 0.05,
      },
    ];
    const { code, stderr } = await runCli(
      ["--level", "quick", "--input", writeInput()],
      runtimeWith(buckets),
      path,
    );
    expect(code).toBe(0);
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc).toEqual({ version: 1, buckets });
    const gate = validateTokenUsageDoc(doc);
    expect(gate.ok).toBe(true);
    expect(stderr).not.toContain("token_usage");
  });

  test("an empty fold removes a stale document", async () => {
    const dir = mkdtempSync(join(tmpdir(), "token-usage-out-"));
    const path = join(dir, "review-token-usage.json");
    writeFileSync(path, JSON.stringify({ version: 1, buckets: [] }));
    const { code } = await runCli(
      ["--level", "quick", "--input", writeInput()],
      runtimeWith([]),
      path,
    );
    expect(code).toBe(0);
    expect(existsSync(path)).toBe(false);
  });

  test("a write failure is logged, never thrown — the review still completes", async () => {
    // A path under a directory that does not exist: the stale-file rmSync
    // (force) swallows the ENOENT, the writeFileSync fails with it.
    const dir = mkdtempSync(join(tmpdir(), "token-usage-out-"));
    const { code, stdout, stderr } = await runCli(
      ["--level", "quick", "--input", writeInput()],
      runtimeWith([
        {
          provider: "ark",
          model: "deepseek-v4",
          input: 1,
          output: 1,
          cacheRead: 0,
          cacheWrite: 0,
          total: 2,
          requests: 1,
          costUsd: 0,
        },
      ]),
      join(dir, "no-such-dir", "review-token-usage.json"),
    );
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual(ENVELOPE);
    expect(stderr).toContain("token_usage_write_failed");
  });

  test("the fixed wire path is the applied-model sibling", () => {
    expect(TOKEN_USAGE_PATH).toBe("/workspace/review-token-usage.json");
  });
});
