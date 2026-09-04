#!/usr/bin/env bash
#
# U-001 in-image models.yml synthesis verification (plan 25 Task 2,
# AL-25-1/25-3; plan 37 Task 3 — capability-host base, NO baked file).
#
# Proves, inside the review-runner image, that a COMPLETE models.yml reaches
# the omp SDK through the runner's REAL synthesis path — with no baked
# in-image models.yml (plan 37 deleted it; the image ships an EMPTY
# /opt/omp-agent):
#   (a) writePerReviewModelsYaml (src/review/models-synthesis.ts) synthesizes
#       a COMPLETE per-review models.yml from the CAPABILITY HOSTS (the omp
#       ark-plan host — the runner input `capabilityHosts`; declared inline
#       below because the in-image module graph cannot import
#       src/contracts/sandbox-images.ts: the image COPYs only src/review)
#       plus an OPTIONAL keyless custom declaration (provider id u001-verify,
#       baseUrl https://example.invalid/v1, model id verify-model — reserved
#       domains; the .invalid TLD structurally excludes egress). Asserted:
#       ark-plan is present WITHOUT any baked file (registry-trusted scalars
#       emitted bare, apiKey = the ARK_API_KEY env-var NAME), the custom
#       block is merged under the base (quoted provider id / baseUrl,
#       apiKey = env-var-NAME reference CUSTOM_U001_VERIFY_API_KEY, model ids
#       present), a zero-custom call yields the byte-identical capability
#       base, and ZERO key literals anywhere in the file;
#   (b) the omp SDK ModelRegistry — the SAME eager loader createAgentSession
#       constructs internally (new ModelRegistry(authStorage,
#       <agentDir>/models.yml)) — resolves hasProvider for BOTH the
#       capability host (ark-plan) and the custom declaration
#       (u001-verify) to their declared baseUrls;
#   (c) a minimal createAgentSession({ agentDir, modelRegistry }) accepts the
#       synthesized agentDir (the session path loads <agentDir>/models.yml).
#
# Load-level only: NO provider call, NO network. The registry from (b) is
# passed to createAgentSession explicitly so the SDK's background provider
# refresh (online-if-uncached) never fires — this verification must not depend
# on egress. Real provider calls are an operator-side extension (exec env key
# injection), never part of this script's pass/fail (AL-25-1).
#
# Zero secrets: the declaration is keyless; every apiKey line in the
# synthesized file is an env-var-NAME reference (CUSTOM_U001_VERIFY_API_KEY /
# ARK_API_KEY). No key material is read, written, or printed.
#
# Idempotent: the only writes are /tmp/omp-agent-<uuid>/ (fresh per run via
# crypto.randomUUID) and they are removed before exit on EVERY path — success,
# assertion failure, and mid-write throw (writePerReviewModelsYaml self-cleans
# its dir before rethrowing; the finally below covers the success path and any
# post-return failure). Safe to re-run.
#
# Output: KEY=VALUE evidence lines on stdout; exit 0 = all three layers pass,
# non-zero = at least one layer failed (set -e aborts on the first failure).
#
# Replay: docker run --rm --entrypoint /opt/verify-synthesis.sh <image>
set -euo pipefail

cd /opt/runner

bun -e '
import { capabilityHostsYaml, writePerReviewModelsYaml } from "/opt/runner/src/review/models-synthesis.ts";
import { ModelRegistry, discoverAuthStorage, createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";

// The omp capability host — the runner input `capabilityHosts` entry for the
// deployed image. Declared inline (NOT imported from
// src/contracts/sandbox-images.ts): the image COPYs only src/review, so the
// in-image module graph cannot see the registry; this literal mirrors the
// source-controlled omp entry (ark-plan, keyless ARK_API_KEY reference).
const ARK_PLAN_HOST = {
  id: "ark-plan",
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
};

const DECL = {
  provider_id: "u001-verify",
  base_url: "https://example.invalid/v1",
  api: "openai-completions",
  model_ids: ["verify-model"],
};

let agentDir: string | undefined;
let zeroCustomDir: string | undefined;
try {
  const assert = (cond: boolean, key: string): void => {
    if (!cond) throw new Error(`assertion failed: ${key}`);
    console.log(`${key}=pass`);
  };

  // Layer (a): real synthesis through the runner module — capability hosts
  // are the ALWAYS-present base, the optional custom declaration merges
  // under it. NO baked file participates (plan 37: the baked models.yml is
  // gone and /opt/omp-agent is empty).
  agentDir = await writePerReviewModelsYaml([ARK_PLAN_HOST], [DECL]);
  const yaml = readFileSync(join(agentDir, "models.yml"), "utf8");
  // The ark-plan capability host is synthesized WITHOUT a baked file
  // (registry-trusted scalars emit bare, like the old baked body).
  assert(yaml.includes("  ark-plan:"), "U001_LAYER_A_CAPABILITY_HOST_ARK_PLAN");
  assert(yaml.includes("baseUrl: https://ark.cn-beijing.volces.com/api/plan"), "U001_LAYER_A_ARK_BASE_URL");
  assert(yaml.includes("apiKey: ARK_API_KEY"), "U001_LAYER_A_ARK_ENV_NAME_API_KEY");
  assert(yaml.includes("- id: deepseek-v4-flash"), "U001_LAYER_A_ARK_MODEL_ID");
  // The custom-provider layer still merges under the capability base.
  assert(yaml.includes("\"u001-verify\":"), "U001_LAYER_A_QUOTED_PROVIDER_ID");
  assert(yaml.includes("baseUrl: \"https://example.invalid/v1\""), "U001_LAYER_A_QUOTED_BASE_URL");
  assert(yaml.includes("apiKey: CUSTOM_U001_VERIFY_API_KEY"), "U001_LAYER_A_ENV_NAME_API_KEY");
  assert(yaml.includes("- id: \"verify-model\""), "U001_LAYER_A_MODEL_ID");
  // ZERO key literals: every apiKey value in the whole file (capability
  // hosts + custom) must be an env-var-NAME reference — uppercase start,
  // [A-Z0-9_]+ body.
  const badApiKeyLines = yaml.split("\n").filter((line) => {
    const m = /^(\s*)apiKey:\s*(\S+)\s*$/.exec(line);
    return m !== null && !/^[A-Z][A-Z0-9_]*$/.test(m[2]);
  });
  assert(badApiKeyLines.length === 0, "U001_LAYER_A_ZERO_KEY_LITERALS");
  // Zero-custom path: custom providers are OPTIONAL — zero declarations
  // yield the byte-identical capability base (ark-plan, no custom block).
  zeroCustomDir = await writePerReviewModelsYaml([ARK_PLAN_HOST]);
  const zeroYaml = readFileSync(join(zeroCustomDir, "models.yml"), "utf8");
  assert(zeroYaml === capabilityHostsYaml([ARK_PLAN_HOST]), "U001_LAYER_A_ZERO_CUSTOM_BASE_BYTES");
  assert(!zeroYaml.includes("u001-verify"), "U001_LAYER_A_ZERO_CUSTOM_NO_CUSTOM");
  console.log("U001_LAYER_A_MODELS_YAML=" + join(agentDir, "models.yml"));

  // Layer (b): ModelRegistry — the same eager loader createAgentSession uses.
  const authStorage = await discoverAuthStorage(agentDir);
  const registry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
  assert(registry.hasProvider("ark-plan"), "U001_LAYER_B_HAS_CAPABILITY_HOST");
  assert(registry.hasProvider("u001-verify"), "U001_LAYER_B_HAS_PROVIDER");
  const arkModel = registry.find("ark-plan", "deepseek-v4-flash");
  assert(
    arkModel !== undefined && arkModel.baseUrl === "https://ark.cn-beijing.volces.com/api/plan",
    "U001_LAYER_B_ARK_FIND_BASE_URL",
  );
  const model = registry.find("u001-verify", "verify-model");
  assert(model !== undefined && model.baseUrl === "https://example.invalid/v1", "U001_LAYER_B_FIND_BASE_URL");
  assert(registry.getProviderBaseUrl("u001-verify") === "https://example.invalid/v1", "U001_LAYER_B_GET_PROVIDER_BASE_URL");

  // Layer (c): minimal createAgentSession accepts the synthesized agentDir.
  const { session } = await createAgentSession({ agentDir, modelRegistry: registry });
  assert(
    session !== undefined && typeof session.sessionId === "string" && session.sessionId.length > 0,
    "U001_LAYER_C_CREATE_AGENT_SESSION",
  );
  console.log("U001_LAYER_C_SESSION_ID=" + session.sessionId);
  console.log("U001_VERIFY=pass");
} finally {
  // writePerReviewModelsYaml self-cleans its /tmp/omp-agent-<uuid> dir on a
  // mid-write throw (models-synthesis.ts), so this finally only removes the
  // dirs on the success path / post-return failures — a throw cannot leak.
  if (agentDir !== undefined) rmSync(agentDir, { recursive: true, force: true });
  if (zeroCustomDir !== undefined) rmSync(zeroCustomDir, { recursive: true, force: true });
}
process.exit(0);
'
