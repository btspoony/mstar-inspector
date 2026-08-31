#!/usr/bin/env bash
#
# U-001 in-image models.yml synthesis verification (plan 25 Task 2, AL-25-1/25-3).
#
# Proves, inside the review-runner image, that a custom-provider declaration
# reaches the omp SDK through the runner's REAL synthesis path:
#   (a) writePerReviewModelsYaml (src/review/models-synthesis.ts) synthesizes
#       a COMPLETE per-review models.yml from a keyless declaration
#       (provider id u001-verify, baseUrl https://example.invalid/v1, model id
#       verify-model — reserved domains; the .invalid TLD structurally excludes
#       egress) and the file shape is asserted: quoted provider id / baseUrl,
#       apiKey = env-var-NAME reference (CUSTOM_U001_VERIFY_API_KEY), model ids
#       present, ZERO key literals anywhere in the file;
#   (b) the omp SDK ModelRegistry — the SAME eager loader createAgentSession
#       constructs internally (new ModelRegistry(authStorage,
#       <agentDir>/models.yml)) — resolves hasProvider("u001-verify") and
#       find("u001-verify", "verify-model") to the declared baseUrl;
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
# crypto.randomUUID) and they are removed before exit. Safe to re-run.
#
# Output: KEY=VALUE evidence lines on stdout; exit 0 = all three layers pass,
# non-zero = at least one layer failed (set -e aborts on the first failure).
#
# Replay: docker run --rm <image> /opt/verify-synthesis.sh
set -euo pipefail

cd /opt/runner

bun -e '
import { writePerReviewModelsYaml } from "/opt/runner/src/review/models-synthesis.ts";
import { ModelRegistry, discoverAuthStorage, createAgentSession } from "@oh-my-pi/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, rmSync } from "node:fs";

const DECL = {
  provider_id: "u001-verify",
  base_url: "https://example.invalid/v1",
  api: "openai-completions",
  model_ids: ["verify-model"],
};

let agentDir: string | undefined;
try {
  const assert = (cond: boolean, key: string): void => {
    if (!cond) throw new Error(`assertion failed: ${key}`);
    console.log(`${key}=pass`);
  };

  // Layer (a): real synthesis through the runner module.
  agentDir = await writePerReviewModelsYaml([DECL]);
  const yaml = readFileSync(join(agentDir, "models.yml"), "utf8");
  assert(yaml.includes("\"u001-verify\":"), "U001_LAYER_A_QUOTED_PROVIDER_ID");
  assert(yaml.includes("baseUrl: \"https://example.invalid/v1\""), "U001_LAYER_A_QUOTED_BASE_URL");
  assert(yaml.includes("apiKey: CUSTOM_U001_VERIFY_API_KEY"), "U001_LAYER_A_ENV_NAME_API_KEY");
  assert(yaml.includes("- id: \"verify-model\""), "U001_LAYER_A_MODEL_ID");
  // ZERO key literals: every apiKey value in the whole file (base + custom)
  // must be an env-var-NAME reference — uppercase start, [A-Z0-9_]+ body.
  const badApiKeyLines = yaml.split("\n").filter((line) => {
    const m = /^(\s*)apiKey:\s*(\S+)\s*$/.exec(line);
    return m !== null && !/^[A-Z][A-Z0-9_]*$/.test(m[2]);
  });
  assert(badApiKeyLines.length === 0, "U001_LAYER_A_ZERO_KEY_LITERALS");
  console.log("U001_LAYER_A_MODELS_YAML=" + join(agentDir, "models.yml"));

  // Layer (b): ModelRegistry — the same eager loader createAgentSession uses.
  const authStorage = await discoverAuthStorage(agentDir);
  const registry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
  assert(registry.hasProvider("u001-verify"), "U001_LAYER_B_HAS_PROVIDER");
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
  if (agentDir !== undefined) rmSync(agentDir, { recursive: true, force: true });
}
process.exit(0);
'
