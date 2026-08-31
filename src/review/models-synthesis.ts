/**
 * Per-review omp models.yml synthesis (plan 23 Task 3, AL-23-1).
 *
 * omp 18.0.4 has NO include semantics: the SDK's ModelRegistry reads exactly
 * ONE models.yml — `path.join(getAgentDir(), "models.yml")` unless
 * `createAgentSession({ agentDir })` overrides the directory. An
 * "incremental fragment" is therefore impossible; a custom provider only
 * reaches the runtime through a COMPLETE synthesized per-review file:
 *
 *   1. read the image base (/opt/omp-agent/models.yml — Dockerfile COPY;
 *      resolveModelsBasePath mirrors getAgentDir(): $PI_CODING_AGENT_DIR
 *      first, absolute fallback);
 *   2. merge the declared custom-provider blocks under `providers:` — base
 *      provider ids WIN on collision, a custom id never shadows a base
 *      declaration (the store already rejects the 18 built-in ids);
 *   3. write /tmp/omp-agent-<uuid>/models.yml and hand the directory to the
 *      runner input as `agentDir` (createAgentSession public option);
 *
 * ZERO secret material: `apiKey:` is always the env-var-name reference form
 * CUSTOM_<UPPER_SNAKE(id)>_API_KEY (consumer injects the decrypted key under
 * that exact name); key literals never enter this module, the synthesized
 * text, or any log line. No environment mutation, no in-image file writes,
 * no PI_CODING_AGENT_DIR changes — each attempt owns its /tmp directory.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { customProviderEnvName, type CustomProviderDeclaration } from "./runtime";

/** In-image base models.yml (sandbox-image Dockerfile COPY target). */
export const BASE_MODELS_YAML_PATH = "/opt/omp-agent/models.yml";

/** File name the SDK loads from the agentDir (model-registry single-file). */
const MODELS_YAML_NAME = "models.yml";

/** Top-level YAML mapping-key line (`name:` at column 0, optional trailing comment). */
const TOP_LEVEL_KEY_RE = /^[A-Za-z0-9_-]+:\s*(?:#.*)?$/;

/** Provider-entry line under `providers:` (2-space indent). */
const PROVIDER_KEY_RE = /^  ([A-Za-z0-9_-]+):\s*(?:#.*)?$/;

/**
 * Mirror of the SDK's getAgentDir() models.yml resolution (AL-23-1): the
 * PI_CODING_AGENT_DIR override at CALL time (not module-load snapshot), else
 * the in-image absolute path. The runner reads the base file from here.
 */
export function resolveModelsBasePath(env: Record<string, string | undefined> = process.env): string {
  const agentDir = env.PI_CODING_AGENT_DIR;
  return agentDir !== undefined && agentDir !== "" ? join(agentDir, MODELS_YAML_NAME) : BASE_MODELS_YAML_PATH;
}

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
 * merge — the base file is repo-owned (sandbox-image/omp-models.yml), so its
 * top-level shape is fixed; a base WITHOUT a top-level `providers:` map is a
 * deployment bug and fails loud (never a partial merge). Colliding custom
 * ids are skipped (base wins, AL-23-1) and reported through `onCollision`
 * (the runner emits a structured warn — a colliding declaration is never
 * silently dead); no declarations → base text unchanged (byte-identical).
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
 * Read the base models.yml, synthesize the COMPLETE per-review file under a
 * fresh /tmp/omp-agent-<uuid>/ directory and return that directory (the
 * `agentDir` the runner passes to createAgentSession). Fail-loud on any I/O
 * or merge problem — custom providers must never be silently dropped. The
 * /tmp directory belongs to the per-attempt container and dies with it.
 */
export async function writePerReviewModelsYaml(
  customProviders: readonly CustomProviderDeclaration[],
  basePath = resolveModelsBasePath(),
  onCollision?: (providerId: string) => void,
): Promise<string> {
  if (customProviders.length === 0) {
    throw new Error("writePerReviewModelsYaml requires at least one custom-provider declaration");
  }
  const baseYaml = await readFile(basePath, "utf8");
  const dir = join("/tmp", `omp-agent-${crypto.randomUUID()}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, MODELS_YAML_NAME), synthesizeModelsYaml(baseYaml, customProviders, onCollision));
  return dir;
}
