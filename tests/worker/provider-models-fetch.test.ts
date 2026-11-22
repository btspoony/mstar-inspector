import { describe, expect, test } from "bun:test";
import { fetchDeclaredProviderModels, modelIdsForProtocol, protocolInferencePath } from "../../src/dashboard/provider-verify";

const ok = (body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

describe("declared-provider vocabulary fetch (I-000644)", () => {
  test("an unauthenticated GET stores the provider's verbatim ids and their endpoint hints", async () => {
    let seen: RequestInit | undefined;
    let url = "";
    const deps = {
      fetch: (async (u: string, init?: RequestInit) => {
        url = String(u);
        seen = init;
        return new Response(
          JSON.stringify({
            data: [
              { id: "deepseek/deepseek-v4-pro", supported_endpoints: ["/chat/completions", "/responses"] },
              { id: "claude-sonnet-5-5", supported_endpoints: ["/messages"] },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as unknown as typeof fetch,
    };
    const result = await fetchDeclaredProviderModels(deps, { baseUrl: "https://api.example.test/v1", api: "openai-completions" }, null);
    expect(url).toBe("https://api.example.test/v1/models");
    expect((seen?.headers as Record<string, string>).authorization).toBeUndefined();
    expect(result).toEqual({
      ok: true,
      entries: [
        { id: "deepseek/deepseek-v4-pro", endpoints: ["/chat/completions", "/responses"] },
        { id: "claude-sonnet-5-5", endpoints: ["/messages"] },
      ],
    });
  });

  test("ids are never normalized and the protocol filter keeps only what the declaration can run", async () => {
    const entries = [
      { id: "deepseek/deepseek-v4-pro", endpoints: ["/chat/completions"] },
      { id: "claude-sonnet-5-5", endpoints: ["/messages"] },
      { id: "unstated-model", endpoints: null },
    ];
    expect(modelIdsForProtocol(entries, "openai-completions")).toEqual(["deepseek/deepseek-v4-pro", "unstated-model"]);
    expect(modelIdsForProtocol(entries, "anthropic-messages")).toEqual(["claude-sonnet-5-5", "unstated-model"]);
    expect(modelIdsForProtocol(entries, "openai-responses")).toEqual(["unstated-model"]);
    expect(protocolInferencePath("typesafe")).toBeNull();
    expect(modelIdsForProtocol(entries, "typesafe")).toEqual([
      "deepseek/deepseek-v4-pro",
      "claude-sonnet-5-5",
      "unstated-model",
    ]);
  });

  test("an empty list is ok + [], and every failure carries whether a credential was sent", async () => {
    const empty = await fetchDeclaredProviderModels({ fetch: ok({ data: [] }) }, { baseUrl: "https://a.test/v1", api: "openai-completions" }, null);
    expect(empty).toEqual({ ok: true, entries: [] });

    const unauthorized = await fetchDeclaredProviderModels(
      { fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch },
      { baseUrl: "https://a.test/v1", api: "openai-completions" },
      null,
    );
    expect(unauthorized).toEqual({ ok: false, reason: "invalid_key", keyless: true });

    const unparseable = await fetchDeclaredProviderModels({ fetch: ok({ nothing: true }) }, { baseUrl: "https://a.test/v1", api: "openai-completions" }, null);
    expect(unparseable).toEqual({ ok: false, reason: "unexpected_response", keyless: true });
  });
});
