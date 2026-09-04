/**
 * Per-review omp models.yml synthesis (plan 23 Task 3, AL-23-1; plan 37
 * Task 2 — capability-host base, always synthesize).
 *
 * omp 18.0.4 has NO include semantics: the SDK's ModelRegistry reads exactly
 * ONE models.yml — `path.join(getAgentDir(), "models.yml")` unless
 * `createAgentSession({ agentDir })` overrides the directory. Since plan 37
 * removed the baked in-image models.yml, EVERY omp review synthesizes its own
 * COMPLETE per-review file:
 *
 *   1. generate the BASE from the App's selected image's CAPABILITY HOSTS
 *      (the runner input carries the hosts the consumer resolved from
 *      src/contracts/sandbox-images.ts — this module cannot import the
 *      contract: the in-image runner module graph stays inside src/review,
 *      tests/review/runtime-boundary);
 *   2. merge the declared custom-provider blocks under `providers:` —
 *      capability/base provider ids WIN on collision, a custom id never
 *      shadows a capability declaration (the store already refuses
 *      custom ids colliding with the selected image's host ids);
 *   3. write /tmp/omp-agent-<uuid>/models.yml and hand the directory to the
 *      runner input as `agentDir` (createAgentSession public option).
 *
 * ZERO secret material: `apiKey:` is always an env-var-name reference —
 * the capability host's `apiKeyEnv` (e.g. ARK_API_KEY) or the
 * CUSTOM_<UPPER_SNAKE(id)>_API_KEY form (consumer injects the decrypted key
 * under that exact name); key literals never enter this module, the
 * synthesized text, or any log line. No environment mutation, no in-image
 * file reads or writes outside the per-review /tmp directory.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  customProviderEnvName,
  type CapabilityHost,
  type CustomProviderDeclaration,
} from "./runtime";

/** File name the SDK loads from the agentDir (model-registry single-file). */
const MODELS_YAML_NAME = "models.yml";

/** Top-level YAML mapping-key line (`name:` at column 0, optional trailing comment). */
const TOP_LEVEL_KEY_RE = /^[A-Za-z0-9_-]+:\s*(?:#.*)?$/;

/** Provider-entry line under `providers:` (2-space indent). */
const PROVIDER_KEY_RE = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/;

/** Double-quoted YAML scalar with the standard escapes (safe for any value). */
function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

/**
 * One capability-host block, 2-space-indented under `providers:` — byte-shape
 * identical to the baked in-image models.yml body this generator replaced
 * (plan 37 equivalence: a defaulted App's synthesized file is
 * runner-consumable-equivalent to the old base+custom merge). Registry values
 * are source-controlled trusted scalars and emit BARE (like the old baked
 * file); only user-derived custom blocks carry the defensive yamlQuote form.
 */
function capabilityHostBlock(host: CapabilityHost): string {
  const lines = [`  ${host.id}:`];
  lines.push(`    baseUrl: ${host.baseUrl}`);
  lines.push(`    apiKey: ${host.apiKeyEnv}`);
  lines.push(`    api: ${host.api}`);
  lines.push(`    auth: ${host.auth}`);
  lines.push("    models:");
  for (const model of host.models) {
    lines.push(`      - id: ${model.id}`);
    lines.push(`        name: ${model.name}`);
    lines.push(`        reasoning: ${model.reasoning}`);
    lines.push(`        input: [${[...model.input].join(", ")}]`);
    lines.push(`        contextWindow: ${model.contextWindow}`);
    lines.push(`        maxTokens: ${model.maxTokens}`);
  }
  return lines.join("\n");
}

/**
 * Generate the COMPLETE base models.yml from the selected image's capability
 * hosts: a top-level `providers:` map with one entry per host, in host order.
 * Deterministic bytes (pure function of the registry data). This is the base
 * the custom-provider merge lands in — capability hosts are runtime
 * capabilities of the image, never App configuration.
 */
export function capabilityHostsYaml(hosts: readonly CapabilityHost[]): string {
  const blocks = hosts.map(capabilityHostBlock);
  return ["providers:", ...blocks].join("\n") + "\n";
}

/** One custom provider block, 2-space-indented under `providers:`. */
function providerBlock(decl: CustomProviderDeclaration): string {
  // The provider KEY is double-quoted too: YAML 1.1 parses bare `on:`/`yes:`/
  // `true:` keys as booleans, which a strict parser then rejects inside the
  // providers map (values are already quoted via yamlQuote).
  const lines = [`  ${yamlQuote(decl.provider_id)}:`];
  lines.push(`    baseUrl: ${yamlQuote(decl.base_url)}`);
  lines.push(`    apiKey: ${customProviderEnvName(decl.provider_id)}`);
  // The api enum value is quoted like every other user-derived scalar (QC
  // wave-1 S-003): the runner input is the in-image trust edge, and a hostile
  // `api` carrying a newline would otherwise break the YAML shape.
  lines.push(`    api: ${yamlQuote(decl.api)}`);
  lines.push("    auth: apiKey");
  lines.push("    models:");
  for (const id of decl.model_ids) {
    lines.push(`      - id: ${yamlQuote(id)}`);
  }
  return lines.join("\n");
}

/**
 * Merge the custom-provider blocks into the base models.yml text: the base
 * declaration set is preserved verbatim and the custom blocks land INSIDE
 * the `providers:` map (a second top-level `providers:` key would be a
 * duplicate-key error in the strict YAML parser). Deterministic line-based
 * merge — the capability-host base has a fixed top-level shape; a base
 * WITHOUT a top-level `providers:` map is a deployment bug and fails loud
 * (never a partial merge). Colliding custom ids are skipped (capability/base
 * wins, AL-23-1) and reported through `onCollision` (the runner emits a
 * structured warn — a colliding declaration is never silently dead); no
 * declarations → base text unchanged (byte-identical).
 */
export function synthesizeModelsYaml(
  baseYaml: string,
  customProviders: readonly CustomProviderDeclaration[],
  onCollision?: (providerId: string) => void,
): string {
  const lines = baseYaml.split("\n");
  const providersIndex = lines.findIndex((line) => /^providers:\s*(?:#.*)?$/.test(line));
  if (providersIndex === -1) {
    throw new Error(
      `synthesizeModelsYaml: base models.yml has no top-level \`providers:\` map (${lines.length} lines)`,
    );
  }

  // Existing base provider ids under `providers:` — base wins on collision.
  const baseProviderIds = new Set<string>();
  for (let index = providersIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const providerId = PROVIDER_KEY_RE.exec(line)?.[1];
    if (providerId !== undefined) {
      baseProviderIds.add(providerId);
    } else if (TOP_LEVEL_KEY_RE.test(line)) {
      break; // left the providers block
    }
  }

  // Insert point: the next top-level key after the providers block (or EOF).
  let insertAt = lines.length;
  for (let index = providersIndex + 1; index < lines.length; index++) {
    if (TOP_LEVEL_KEY_RE.test(lines[index] ?? "")) {
      insertAt = index;
      break;
    }
  }

  const blocks: string[] = [];
  for (const decl of customProviders) {
    if (baseProviderIds.has(decl.provider_id)) {
      onCollision?.(decl.provider_id); // base wins (AL-23-1) — never silent
      continue;
    }
    blocks.push(providerBlock(decl));
  }
  if (blocks.length === 0) return baseYaml;

  const insertion: string[] = [];
  if ((lines[insertAt - 1] ?? "").trim() !== "") insertion.push("");
  for (const block of blocks) {
    insertion.push(block);
  }
  if ((lines[insertAt] ?? "").trim() !== "") insertion.push("");
  lines.splice(insertAt, 0, ...insertion);
  return lines.join("\n");
}

/**
 * Synthesize the COMPLETE per-review models.yml under a fresh
 * /tmp/omp-agent-<uuid>/ directory and return that directory (the `agentDir`
 * the runner passes to createAgentSession). ALWAYS runs — plan 37 removed the
 * baked in-image models.yml, so every omp review synthesizes its own:
 * capability hosts are the base, `customProviders` (OPTIONAL — zero
 * declarations yield the byte-identical capability base) merge under it.
 * Fail-loud on any generation/merge/write problem — a review must never run
 * against a partial or missing models.yml. The /tmp directory belongs to the
 * per-attempt container and dies with it. Self-cleaning: a throw between
 * mkdir and writeFile removes the dir before rethrowing, so no exit path
 * leaks /tmp/omp-agent-<uuid>.
 */
export async function writePerReviewModelsYaml(
  capabilityHosts: readonly CapabilityHost[],
  customProviders: readonly CustomProviderDeclaration[] = [],
  onCollision?: (providerId: string) => void,
): Promise<string> {
  const baseYaml = capabilityHostsYaml(capabilityHosts);
  const dir = join("/tmp", `omp-agent-${crypto.randomUUID()}`);
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, MODELS_YAML_NAME), synthesizeModelsYaml(baseYaml, customProviders, onCollision));
  } catch (err) {
    // A throw between mkdir and writeFile must not leak the fresh
    // /tmp/omp-agent-<uuid> dir: remove it before rethrowing so every caller
    // (runner, verify-synthesis.sh) keeps fail-loud semantics with no residue.
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}
