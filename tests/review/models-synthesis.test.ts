/**
 * Per-review omp models.yml synthesis tests (plan 23 Task 3, AL-23-1).
 *
 * The omp SDK (18.0.4) has NO include semantics: the ModelRegistry reads ONE
 * models.yml — `path.join(getAgentDir(), "models.yml")` (or the
 * createAgentSession `agentDir` override) — so a custom provider can only
 * reach the runtime through a COMPLETE synthesized file. Contracts:
 *   - the base ark-plan declaration (the in-image /opt/omp-agent/models.yml
 *     fixture below mirrors sandbox-image/omp-models.yml) is preserved
 *     verbatim in the synthesized text;
 *   - custom provider blocks carry baseUrl + `apiKey: CUSTOM_<ID>_API_KEY`
 *     (env-var-name reference form) + api + auth + the declared model ids;
 *   - provider KEYS and the api value are double-quoted (yamlQuote — every
 *     user-derived scalar carries the same defensive quoting);
 *   - ZERO key literals: the fixture secret never appears in the text (the
 *     key rides ONLY the exec env, never the declaration shape);
 *   - base provider ids win on collision (a custom id shadowing a base
 *     provider is skipped — the store already rejects the 18 built-ins) and
 *     every skip is reported through the onCollision callback (never silent);
 *   - no declarations → no synthesis (agentDir omitted = today's behavior);
 *   - the write helper targets /tmp/omp-agent-<uuid>/models.yml and reads
 *     the base from $PI_CODING_AGENT_DIR/models.yml (mirror of the SDK's
 *     getAgentDir() resolution) with the in-image absolute fallback.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomProviderDeclaration } from "../../src/review/runtime";
import {
  BASE_MODELS_YAML_PATH,
  resolveModelsBasePath,
  synthesizeModelsYaml,
  writePerReviewModelsYaml,
} from "../../src/review/models-synthesis";

/** Mirrors sandbox-image/omp-models.yml — the base the merge must preserve. */
const BASE_YAML = `# omp agent models.yml provisioned inside the review-runner image.
providers:
  ark-plan:
    baseUrl: https://ark.cn-beijing.volces.com/api/plan
    apiKey: ARK_API_KEY
    api: anthropic-messages
    auth: apiKey
    models:
      - id: deepseek-v4-flash
        name: Deepseek v4 flash 0731
        reasoning: true
        input: [text]
        contextWindow: 1024000
        maxTokens: 65536
`;

/** Fixture secret that must never appear in any synthesized text. */
const FIXTURE_KEY = "sk-live-fixture-12345abcdef";

const CUSTOM: CustomProviderDeclaration = {
  provider_id: "my-provider",
  base_url: "https://my-provider.example.com/v1",
  api: "openai-completions",
  model_ids: ["my-model-1", "my-model-2"],
};

afterEach(() => {
  delete process.env.PI_CODING_AGENT_DIR;
});

describe("synthesizeModelsYaml (plan 23 Task 3, AL-23-1 merged-complete file)", () => {
  test("preserves the base ark-plan declaration AND appends the custom provider block", () => {
    const yaml = synthesizeModelsYaml(BASE_YAML, [CUSTOM]);
    // Base preserved verbatim (the merge must be complete, not destructive).
    expect(yaml).toContain("ark-plan:");
    expect(yaml).toContain("baseUrl: https://ark.cn-beijing.volces.com/api/plan");
    expect(yaml).toContain("apiKey: ARK_API_KEY");
    expect(yaml).toContain("api: anthropic-messages");
    expect(yaml).toContain("auth: apiKey");
    expect(yaml).toContain("id: deepseek-v4-flash");
    // Custom provider block: quoted id key, baseUrl, env-var-name reference,
    // api, auth, declared model ids.
    expect(yaml).toContain('"my-provider":');
    expect(yaml).toContain(`baseUrl: "${CUSTOM.base_url}"`);
    expect(yaml).toContain("apiKey: CUSTOM_MY_PROVIDER_API_KEY");
    expect(yaml).toContain('api: "openai-completions"');
    expect(yaml).toContain("auth: apiKey");
    expect(yaml).toContain(`- id: "my-model-1"`);
    expect(yaml).toContain(`- id: "my-model-2"`);
  });

  test("ZERO key literals: the fixture secret never appears in the synthesized text", () => {
    const yaml = synthesizeModelsYaml(BASE_YAML, [CUSTOM]);
    expect(yaml).not.toContain(FIXTURE_KEY);
    expect(yaml).not.toContain("sk-live");
  });

  test("multiple custom providers merge in declaration order, each with its own env reference", () => {
    const second: CustomProviderDeclaration = {
      provider_id: "second-one",
      base_url: "https://second.example.com/v1",
      api: "anthropic-messages",
      model_ids: ["b-model"],
    };
    const yaml = synthesizeModelsYaml(BASE_YAML, [CUSTOM, second]);
    expect(yaml.indexOf('"my-provider":')).toBeLessThan(yaml.indexOf('"second-one":'));
    expect(yaml).toContain("apiKey: CUSTOM_MY_PROVIDER_API_KEY");
    expect(yaml).toContain("apiKey: CUSTOM_SECOND_ONE_API_KEY");
    expect(yaml).toContain('api: "anthropic-messages"'); // the second custom block, quoted form
    expect(yaml).not.toContain(FIXTURE_KEY);
  });

  test("base provider ids win on collision — a custom id shadowing a base provider is skipped", () => {
    const clash: CustomProviderDeclaration = {
      ...CUSTOM,
      provider_id: "ark-plan",
      base_url: "https://evil.example.com/",
    };
    const yaml = synthesizeModelsYaml(BASE_YAML, [clash]);
    // Exactly ONE ark-plan block, and it is the BASE one (its baseUrl, not
    // the custom's) — the merge never shadows a base declaration.
    expect(yaml.match(/^  ark-plan:/gm)).toHaveLength(1);
    expect(yaml).not.toContain("https://evil.example.com/");
    expect(yaml).toContain("baseUrl: https://ark.cn-beijing.volces.com/api/plan");
  });
  test("colliding custom ids are reported through onCollision (base wins, never silent)", () => {
    const clash: CustomProviderDeclaration = {
      ...CUSTOM,
      provider_id: "ark-plan",
      base_url: "https://evil.example.com/",
    };
    const collisions: string[] = [];
    const yaml = synthesizeModelsYaml(BASE_YAML, [clash, CUSTOM], (id) => collisions.push(id));
    // The skip is reported (id only — zero key material) and the merge still
    // keeps the BASE ark-plan block while appending the non-colliding custom.
    expect(collisions).toEqual(["ark-plan"]);
    expect(yaml.match(/^  ark-plan:/gm)).toHaveLength(1);
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
    // The key is double-quoted (a bare `on:` would parse as boolean true in
    // YAML 1.1 — a strict parser then rejects the providers map shape).
    expect(yaml).toContain('  "on":');
    expect(yaml).not.toMatch(/^  on:/m);
    expect(yaml).toContain("apiKey: CUSTOM_ON_API_KEY");
    expect(yaml).toContain(`- id: "pin-model"`);
  });

  test("a base file without a top-level providers map fails loud (never a partial merge)", () => {
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

  test("the custom api value is quoted via yamlQuote — even when it equals the base block's literal (QC wave-1 S-003 pin)", () => {
    const sameApiAsBase: CustomProviderDeclaration = {
      ...CUSTOM,
      provider_id: "ark-style-mirror",
      api: "anthropic-messages", // the SAME literal the base ark-plan block carries bare
    };
    const yaml = synthesizeModelsYaml(BASE_YAML, [sameApiAsBase]);
    // The custom block emits the QUOTED form (yamlQuote, like baseUrl and
    // model ids) — a raw `api: ${decl.api}` splice would be the one
    // user-derived scalar escaping the file's defensive posture.
    expect(yaml).toContain('    api: "anthropic-messages"');
    // The base ark-plan block stays BARE — the merge never rewrites the base.
    expect(yaml).toContain("    api: anthropic-messages");
    // Exactly one quoted and one bare api line: the two forms never blur.
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
    // The double-quoted scalar escapes the inner quotes; the parsed value
    // round-trips — and the raw `"quoted"` splice can never break the block.
    expect(yaml).toContain(`baseUrl: "https://weird.example.com/v1?x=\\"quoted\\"&y=z"`);
    expect(yaml).toContain(`- id: "model \\"quoted\\""`);
    expect(yaml).toContain(`- id: "plain-model"`);
  });
});

describe("models base path resolution and per-review write (AL-23-1)", () => {
  test("BASE_MODELS_YAML_PATH is the in-image absolute fallback", () => {
    expect(BASE_MODELS_YAML_PATH).toBe("/opt/omp-agent/models.yml");
  });

  test("resolveModelsBasePath mirrors getAgentDir(): PI_CODING_AGENT_DIR first, absolute fallback", () => {
    expect(resolveModelsBasePath({ PI_CODING_AGENT_DIR: "/opt/omp-agent" })).toBe("/opt/omp-agent/models.yml");
    expect(resolveModelsBasePath({ PI_CODING_AGENT_DIR: "/custom/dir" })).toBe("/custom/dir/models.yml");
    expect(resolveModelsBasePath({ PI_CODING_AGENT_DIR: "" })).toBe(BASE_MODELS_YAML_PATH);
    expect(resolveModelsBasePath({})).toBe(BASE_MODELS_YAML_PATH);
  });

  test("writePerReviewModelsYaml reads the base via PI_CODING_AGENT_DIR and writes /tmp/omp-agent-<uuid>/models.yml", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "omp-models-fixture-"));
    writeFileSync(join(fixtureDir, "models.yml"), BASE_YAML);
    process.env.PI_CODING_AGENT_DIR = fixtureDir;
    try {
      const agentDir = await writePerReviewModelsYaml([CUSTOM]);
      expect(agentDir).toMatch(/^\/tmp\/omp-agent-/);
      const written = readFileSync(join(agentDir, "models.yml"), "utf8");
      // Complete merged file: base + custom, zero key material.
      expect(written).toContain("ark-plan:");
      expect(written).toContain("apiKey: CUSTOM_MY_PROVIDER_API_KEY");
      expect(written).not.toContain(FIXTURE_KEY);
      expect(existsSync(join(agentDir, "models.yml"))).toBe(true);
      rmSync(agentDir, { recursive: true, force: true });
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });

  test("writePerReviewModelsYaml fails loud when the base models.yml is unreadable", async () => {
    const fixtureDir = mkdtempSync(join(tmpdir(), "omp-models-missing-"));
    process.env.PI_CODING_AGENT_DIR = join(fixtureDir, "nope");
    try {
      await expect(writePerReviewModelsYaml([CUSTOM])).rejects.toThrow();
    } finally {
      delete process.env.PI_CODING_AGENT_DIR;
      rmSync(fixtureDir, { recursive: true, force: true });
    }
  });
});
