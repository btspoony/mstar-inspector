
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type CapabilityHost, type CustomProviderDeclaration } from "../../shared/src/runtime";

const MODELS_YAML_NAME = "models.yml";

const TOP_LEVEL_KEY_RE = /^[A-Za-z0-9_-]+:\s*(?:#.*)?$/;

const PROVIDER_KEY_RE = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/;

function yamlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

function capabilityHostBlock(host: CapabilityHost): string {
  const lines = [`  ${host.id}:`];
  lines.push(`    baseUrl: ${host.baseUrl}`);
  lines.push(`    api: ${host.api}`);
  lines.push("    auth: oauth");
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

function providerBlock(decl: CustomProviderDeclaration): string {
  const lines = [`  ${yamlQuote(decl.provider_id)}:`];
  lines.push(`    baseUrl: ${yamlQuote(decl.base_url)}`);
  lines.push(`    api: ${yamlQuote(decl.api)}`);
  lines.push("    auth: oauth");
  lines.push("    models:");
  for (const id of decl.model_ids) {
    lines.push(`      - id: ${yamlQuote(id)}`);
    const meta = decl.models_meta?.[id];
    if (meta === undefined) continue;
    if (meta.name !== undefined) lines.push(`        name: ${yamlQuote(meta.name)}`);
    if (meta.reasoning !== undefined) lines.push(`        reasoning: ${meta.reasoning}`);
    if (meta.input !== undefined) {
      lines.push(`        input: [${meta.input.map((modality) => yamlQuote(modality)).join(", ")}]`);
    }
    if (meta.contextWindow !== undefined) lines.push(`        contextWindow: ${meta.contextWindow}`);
    if (meta.maxTokens !== undefined) lines.push(`        maxTokens: ${meta.maxTokens}`);
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

  const baseProviderIds = new Set<string>();
  for (let index = providersIndex + 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    const providerId = PROVIDER_KEY_RE.exec(line)?.[1];
    if (providerId !== undefined) {
      baseProviderIds.add(providerId);
    } else if (TOP_LEVEL_KEY_RE.test(line)) {
      break;
    }
  }

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
      onCollision?.(decl.provider_id);
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
 * the runner passes to createAgentSession). ALWAYS runs — the baked
 * in-image models.yml was removed, so every omp review synthesizes its own:
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
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return dir;
}
