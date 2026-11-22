
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { CustomProviderDeclaration } from "../../packages/shared/src/runtime";
import {
  capabilityHostsYaml,
  synthesizeModelsYaml,
  writePerReviewModelsYaml,
} from "../../packages/runner/src/models-synthesis";
import type { CapabilityHost } from "../../packages/shared/src/runtime";
import { sk } from "../helpers/fake-secrets";

const ARK_PLAN_HOST = {
  id: "ark",
  catalogProviderId: "ark",
  apiKeyEnv: "ARK_API_KEY",
  baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
  api: "anthropic-messages",
  auth: "apiKey",
  models: [
    {
      id: "deepseek-v4-flash",
      name: "Deepseek v4 flash 0731",
      reasoning: true,
      input: ["text"],
      contextWindow: 1024000,
      maxTokens: 65536,
    },
  ],
} satisfies CapabilityHost;

const EXPECTED_OMP_BASE = `providers:
  ark:
    baseUrl: https://ark.cn-beijing.volces.com/api/plan
    api: anthropic-messages
    auth: oauth
    models:
      - id: deepseek-v4-flash
        name: Deepseek v4 flash 0731
        reasoning: true
        input: [text]
        contextWindow: 1024000
        maxTokens: 65536
`;

const BASE_YAML = capabilityHostsYaml([ARK_PLAN_HOST]);

const FIXTURE_KEY = sk("live-fixture-12345abcdef");

const CUSTOM: CustomProviderDeclaration = {
  provider_id: "my-provider",
  base_url: "https://my-provider.example.com/v1",
  api: "openai-completions",
  model_ids: ["my-model-1", "my-model-2"],
};

describe("capabilityHostsYaml (the registry-generated base)", () => {
  test("the omp registry entry generates EXACTLY the poolized capability base (byte-equivalence lock)", () => {
    expect(BASE_YAML).toBe(EXPECTED_OMP_BASE);
  });

  test("the base pins NO scalar apiKey — poolized blocks authenticate via the stored pool", () => {
    expect(BASE_YAML).not.toMatch(/^\s*apiKey:/m);
    expect(BASE_YAML).toContain("    auth: oauth");
    expect(BASE_YAML).not.toContain(FIXTURE_KEY);
    expect(BASE_YAML).not.toContain("sk-");
  });

  test("multiple hosts emit consecutive blocks under providers:, in host order", () => {
    const hosts = [
      ARK_PLAN_HOST,
      {
        id: "future-host",
        catalogProviderId: "ark",
        apiKeyEnv: "FUTURE_API_KEY",
        baseUrl: "https://future.example.com/v1",
        api: "openai-completions",
        auth: "apiKey",
        models: [
          {
            id: "future-model",
            name: "Future model",
            reasoning: false,
            input: ["text", "image"],
            contextWindow: 128000,
            maxTokens: 8192,
          },
        ],
      },
    ];
    const yaml = capabilityHostsYaml(hosts);
    expect(yaml).toContain("  future-host:");
    expect(yaml).not.toMatch(/^\s*apiKey:/m);
    expect(yaml.match(/^    auth: oauth$/gm)).toHaveLength(2);
    expect(yaml).toContain("input: [text, image]");
    expect(yaml).toContain("reasoning: false");
    expect(yaml.indexOf("ark:")).toBeLessThan(yaml.indexOf("future-host:"));
    expect(yaml).toStartWith("providers:\n");
  });
});

describe("synthesizeModelsYaml (AL-23-1 merged-complete file)", () => {
  test("preserves the capability base ark declaration AND appends the custom provider block", () => {
    const yaml = synthesizeModelsYaml(BASE_YAML, [CUSTOM]);
    expect(yaml).toContain("ark:");
    expect(yaml).toContain("baseUrl: https://ark.cn-beijing.volces.com/api/plan");
    expect(yaml).toContain("api: anthropic-messages");
    expect(yaml).toContain("id: deepseek-v4-flash");
    expect(yaml).toContain('"my-provider":');
    expect(yaml).toContain(`baseUrl: "${CUSTOM.base_url}"`);
    expect(yaml).toContain('api: "openai-completions"');
    expect(yaml).toContain(`- id: "my-model-1"`);
    expect(yaml).toContain(`- id: "my-model-2"`);
    expect(yaml).not.toMatch(/^\s*apiKey:/m);
    expect(yaml.match(/^    auth: oauth$/gm)).toHaveLength(2);
  });

  test("a declared model's metadata is emitted with the capability-host keys; an unstated fact is absent", () => {
    const withMeta: CustomProviderDeclaration = {
      ...CUSTOM,
      model_ids: ["full-model", "sizes-only", "id-only"],
      models_meta: {
        "full-model": {
          contextWindow: 128000,
          maxTokens: 8192,
          name: 'My "Model"',
          reasoning: true,
          input: ["text", "image"],
        },
        "sizes-only": { contextWindow: 32000, maxTokens: 4096 },
      },
    };
    const yaml = synthesizeModelsYaml(BASE_YAML, [withMeta]);
    expect(yaml).toContain(
      [
        '      - id: "full-model"',
        '        name: "My \\"Model\\""',
        "        reasoning: true",
        '        input: ["text", "image"]',
        "        contextWindow: 128000",
        "        maxTokens: 8192",
        '      - id: "sizes-only"',
        "        contextWindow: 32000",
        "        maxTokens: 4096",
        '      - id: "id-only"',
      ].join("\n"),
    );
    const tail = yaml.slice(yaml.indexOf('      - id: "id-only"'));
    expect(tail).not.toMatch(/contextWindow|maxTokens|name:|reasoning:|input:/);
  });

  test("a declared model with no metadata at all is emitted as a bare id — the legacy shape", () => {
    const yaml = synthesizeModelsYaml(BASE_YAML, [CUSTOM]);
    expect(yaml).toContain('      - id: "my-model-1"\n      - id: "my-model-2"');
    expect(yaml.slice(yaml.indexOf('"my-provider":'))).not.toMatch(/contextWindow/);
  });

  test("ZERO custom declarations → the base text unchanged (byte-identical zero-custom path)", () => {
    expect(synthesizeModelsYaml(BASE_YAML, [])).toBe(BASE_YAML);
  });

  test("ZERO key literals: the fixture secret never appears in the synthesized text", () => {
    const yaml = synthesizeModelsYaml(BASE_YAML, [CUSTOM]);
    expect(yaml).not.toContain(FIXTURE_KEY);
    expect(yaml).not.toContain(sk("live"));
  });

  test("multiple custom providers merge in declaration order", () => {
    const second: CustomProviderDeclaration = {
      provider_id: "second-one",
      base_url: "https://second.example.com/v1",
      api: "anthropic-messages",
      model_ids: ["b-model"],
    };
    const yaml = synthesizeModelsYaml(BASE_YAML, [CUSTOM, second]);
    expect(yaml.indexOf('"my-provider":')).toBeLessThan(yaml.indexOf('"second-one":'));
    expect(yaml).toContain('api: "anthropic-messages"');
    expect(yaml).not.toMatch(/^\s*apiKey:/m);
    expect(yaml).not.toContain(FIXTURE_KEY);
  });

  test("capability host ids win on collision — a custom id shadowing a capability host is skipped", () => {
    const clash: CustomProviderDeclaration = {
      ...CUSTOM,
      provider_id: "ark",
      base_url: "https://evil.example.com/",
    };
    const yaml = synthesizeModelsYaml(BASE_YAML, [clash]);
    expect(yaml.match(/^  ark:/gm)).toHaveLength(1);
    expect(yaml).not.toContain("https://evil.example.com/");
    expect(yaml).toContain("baseUrl: https://ark.cn-beijing.volces.com/api/plan");
  });
  test("colliding custom ids are reported through onCollision (capability/base wins, never silent)", () => {
    const clash: CustomProviderDeclaration = {
      ...CUSTOM,
      provider_id: "ark",
      base_url: "https://evil.example.com/",
    };
    const collisions: string[] = [];
    const yaml = synthesizeModelsYaml(BASE_YAML, [clash, CUSTOM], (id) => collisions.push(id));
    expect(collisions).toEqual(["ark"]);
    expect(yaml.match(/^  ark:/gm)).toHaveLength(1);
    expect(yaml).not.toContain("https://evil.example.com/");
    expect(yaml).toContain('"my-provider":');
  });

  test("YAML 1.1 boolean-like provider ids are quoted — `on` parses as a string key, never a boolean", () => {
    const pin: CustomProviderDeclaration = {
      ...CUSTOM,
      provider_id: "on",
      model_ids: ["pin-model"],
    };
    const yaml = synthesizeModelsYaml(BASE_YAML, [pin]);
    expect(yaml).toContain('  "on":');
    expect(yaml).not.toMatch(/^  on:/m);
    expect(yaml).not.toMatch(/^\s*apiKey:/m);
    expect(yaml).toContain(`- id: "pin-model"`);
  });

  test("a base without a top-level providers map fails loud (never a partial merge)", () => {
    expect(() => synthesizeModelsYaml("# no providers here\nother: 1\n", [CUSTOM])).toThrow(/providers/);
  });

  test("custom blocks insert inside providers: even when a later top-level section follows", () => {
    const baseWithTail = `${BASE_YAML}other:\n  stuff: true\n`;
    const yaml = synthesizeModelsYaml(baseWithTail, [CUSTOM]);
    expect(yaml).toContain("other:");
    expect(yaml).toContain("stuff: true");
    expect(yaml.indexOf('"my-provider":')).toBeLessThan(yaml.indexOf("other:"));
    expect(yaml.indexOf('"my-provider":')).toBeGreaterThan(yaml.indexOf("deepseek-v4-flash"));
  });

  test("the custom api value is quoted via yamlQuote — even when it equals the capability block's literal (QC wave-1 S-003 pin)", () => {
    const sameApiAsBase: CustomProviderDeclaration = {
      ...CUSTOM,
      provider_id: "ark-style-mirror",
      api: "anthropic-messages",
    };
    const yaml = synthesizeModelsYaml(BASE_YAML, [sameApiAsBase]);
    expect(yaml).toContain('    api: "anthropic-messages"');
    expect(yaml).toContain("    api: anthropic-messages");
    expect(yaml.match(/^    api: "anthropic-messages"$/gm)).toHaveLength(1);
    expect(yaml.match(/^    api: anthropic-messages$/gm)).toHaveLength(1);
  });

  test("quoted values with YAML-special characters are escaped, not emitted raw", () => {
    const weird: CustomProviderDeclaration = {
      ...CUSTOM,
      base_url: 'https://weird.example.com/v1?x="quoted"&y=z',
      model_ids: ['model "quoted"', "plain-model"],
    };
    const yaml = synthesizeModelsYaml(BASE_YAML, [weird]);
    expect(yaml).toContain(`baseUrl: "https://weird.example.com/v1?x=\\"quoted\\"&y=z"`);
    expect(yaml).toContain(`- id: "model \\"quoted\\""`);
    expect(yaml).toContain(`- id: "plain-model"`);
  });
});

describe("writePerReviewModelsYaml (always synthesizes from capability hosts)", () => {
  test("ZERO-custom (defaulted App): the written file is byte-identical to the poolized capability base — ark equivalence", async () => {
    const agentDir = await writePerReviewModelsYaml([ARK_PLAN_HOST]);
    expect(agentDir).toMatch(/^\/tmp\/omp-agent-/);
    const written = readFileSync(join(agentDir, "models.yml"), "utf8");
    expect(written).toBe(EXPECTED_OMP_BASE);
    expect(written).toContain("ark:");
    expect(written).not.toMatch(/^\s*apiKey:/m);
    expect(existsSync(join(agentDir, "models.yml"))).toBe(true);
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("custom providers merge into the capability base inside the per-review /tmp dir", async () => {
    const agentDir = await writePerReviewModelsYaml([ARK_PLAN_HOST], [CUSTOM]);
    const written = readFileSync(join(agentDir, "models.yml"), "utf8");
    expect(written).toContain("ark:");
    expect(written).toContain('"my-provider":');
    expect(written).not.toMatch(/^\s*apiKey:/m);
    expect(written).not.toContain(FIXTURE_KEY);
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("custom ids colliding with a capability host are skipped with onCollision reported", async () => {
    const collisions: string[] = [];
    const agentDir = await writePerReviewModelsYaml(
      [ARK_PLAN_HOST],
      [{ ...CUSTOM, provider_id: "ark", base_url: "https://evil.example.com/" }],
      (id) => collisions.push(id),
    );
    const written = readFileSync(join(agentDir, "models.yml"), "utf8");
    expect(collisions).toEqual(["ark"]);
    expect(written.match(/^  ark:/gm)).toHaveLength(1);
    expect(written).not.toContain("https://evil.example.com/");
    rmSync(agentDir, { recursive: true, force: true });
  });
});
