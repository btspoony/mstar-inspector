import { describe, expect, test } from "bun:test";
import "../helpers/cloudflare-workers-mock";
import type { ReviewSandbox, SandboxBinding } from "../../src/pipeline/sandbox";
import { APP_VERSION } from "../../src/version";

// Dynamic: the entry imports `cloudflare:workers`, so the mock above must be registered first.
const { default: smokeEntry } = await import("../../src/pipeline/smoke-entry");

type SmokeEnv = Parameters<typeof smokeEntry.fetch>[1];

type Sink = { commands: string[]; destroyed: number; lookedUp: number };

/** A sandbox binding whose slot records what the entry actually asked it to run. */
function sandboxSink(): { binding: SandboxBinding; sink: Sink } {
  const sink: Sink = { commands: [], destroyed: 0, lookedUp: 0 };
  const sandbox: ReviewSandbox = {
    provision: async () => ({ kind: "provisioned" }),
    runCommand: async (command) => {
      sink.commands.push(command);
      return { stdout: "diff --git a/a b/a\n", stderr: "", exitCode: 0 };
    },
    runMarked: async () => ({ kind: "ran", stdout: "", stderr: "", exitCode: 0 }),
    destroyMarked: async () => "destroyed",
    destroy: async () => {
      sink.destroyed += 1;
    },
  };
  const binding = {
    getByName: () => {
      sink.lookedUp += 1;
      return sandbox;
    },
  } as unknown as SandboxBinding;
  return { binding, sink };
}

function makeEnv(overrides: Record<string, unknown> = {}): SmokeEnv {
  const { binding } = sandboxSink();
  return {
    SANDBOX: binding,
    GH_TOKEN: "ghs_test",
    GH_REPO: "acme/widgets",
    ...overrides,
  } as unknown as SmokeEnv;
}

function url(path: string): Request {
  return new Request(`https://smoke.local${path}`);
}

describe("smoke-entry healthz face", () => {
  test("answers the same shape as the worker healthz (ok + v-prefixed generated version)", async () => {
    const res = await smokeEntry.fetch(url("/healthz"), makeEnv());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, version: `v${APP_VERSION}` });
  });

  test("serves only the smoke routes", async () => {
    const res = await smokeEntry.fetch(url("/"), makeEnv());
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("not found");
  });
});

describe("smoke-entry smoke target configuration", () => {
  test("rejects a missing or template GH_REPO before the sandbox sink is touched", async () => {
    const templateValues = ["${repo}", "owner", "owner/repo/extra", "gh repo/x", "", undefined];
    for (const value of templateValues) {
      const { binding, sink } = sandboxSink();
      const res = await smokeEntry.fetch(url("/smoke"), makeEnv({ GH_REPO: value, SANDBOX: binding }));
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("GH_REPO must be owner/repo");
      expect(sink.lookedUp).toBe(0);
      expect(sink.commands).toEqual([]);
    }
  });

  test("targets the configured repository — two different configs, two different sinks", async () => {
    for (const repo of ["acme/widgets", "other/repo"]) {
      const { binding, sink } = sandboxSink();
      const res = await smokeEntry.fetch(url("/smoke"), makeEnv({ GH_REPO: repo, SANDBOX: binding }));
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, path: "gh" });
      expect(sink.commands[0]).toBe(`gh pr diff 1 --repo ${repo}`);
      expect(sink.destroyed).toBe(1);
    }
  });

  test("GH_PR stays the fixed seed PR — an env-supplied GH_PR is ignored", async () => {
    const { binding, sink } = sandboxSink();
    const res = await smokeEntry.fetch(
      url("/smoke"),
      makeEnv({ GH_PR: "7", SANDBOX: binding, GH_REPO: "acme/widgets" }),
    );
    expect(res.status).toBe(200);
    expect(sink.commands[0]).toBe("gh pr diff 1 --repo acme/widgets");
  });
});
