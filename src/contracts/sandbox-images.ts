/**
 * Sandbox runtime-image registry (spec
 * dashboard-sandbox-configuration § Runtime-image contract) — the single
 * source-controlled list of runtime images an App can select. Every entry is
 * static build-time data: this module must never import dashboard/pipeline/
 * review code, read D1, or touch secrets (dashboard Q2 isolation + the
 * zero-secrets constraint — capability hosts carry registry metadata only,
 * never key values).
 *
 * An entry carries its build definition (Dockerfile + wrangler
 * `containers[].image` paths, relative to repo root) and its CAPABILITY
 * HOSTS — the provider declarations the runtime synthesizer materializes
 * into every per-review models.yml. Hosts are runtime capabilities of the
 * image, NOT App configuration and NOT Providers catalog ids: `omp`'s
 * `ark-plan` host resolves its keys from the transported pool of its
 * `catalogProviderId` (`"ark"` → the credential payload's `ark` pool, which
 * the runner loads into the run's in-memory credential store as
 * `source:"login"` api_key rows), while the catalog/BYOK id stays `ark`.
 *
 * `omp` is the only entry for now and the only enabled one — a future
 * runtime ships its own Dockerfile, registry entry, and synthesizer. Enabling
 * a second image or changing an image's container target re-opens the
 * deploy-window skew contract (an old Worker against a newly built image
 * fails transiently and self-heals via queue retry — qc2 S3 / qc3 S-4) and
 * must re-validate it. Lookup
 * is CLOSED over these entries: unknown or disabled ids are rejected by the
 * callers (the dashboard store/route refuse to save them; execution resolves
 * and validates the persisted id before any sandbox is created).
 */

/** A stored sandbox image selection (github_apps.sandbox_image_id, migration 0018). */
export type SandboxImageId = string;

/** One model a capability host serves (the omp models.yml model-entry shape). */
export type SandboxImageHostModel = {
  id: string;
  name: string;
  reasoning: boolean;
  /** Input modalities (omp: e.g. ["text"]). */
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
};

/**
 * One capability host the image's synthesizer materializes into models.yml.
 * `apiKeyEnv` and `auth` are retained registry metadata carried by the locked
 * host shape — the synthesized block pins no scalar `apiKey` (every block
 * emits `auth: oauth`) and the host's keys arrive as the transported pool its
 * `catalogProviderId` names, so neither field selects the active credential.
 * Never a key value.
 *
 * Bare-YAML anchor (qc1 F-006): these registry-trusted scalars (host/model
 * ids, baseUrl, …) are emitted as BARE YAML scalars to keep the omp base
 * byte-identical to the retired baked file — a second registry entry must add
 * quoting/validation (a YAML-1.1 boolean-like id such as `on` misparses bare).
 */
export type SandboxImageHost = {
  /** Host id — the selector prefix (e.g. `ark-plan/deepseek-v4-flash`). */
  id: string;
  /** Providers/BYOK catalog id whose transported pool this host resolves from. */
  catalogProviderId: string;
  /** Retained registry metadata — no longer an active key-resolution input. */
  apiKeyEnv: string;
  baseUrl: string;
  api: string;
  /** Retained registry metadata — synthesis emits `auth: oauth` for every block. */
  auth: string;
  models: readonly SandboxImageHostModel[];
};

/**
 * The periodically-upgraded build inputs of a runtime image — version-agnostic
 * KEYS, the versions are the VALUES (nothing here is ever renamed on a bump).
 *
 * The Dockerfile cannot read this module: this image is built with no build
 * args and no env (image contains runtime only, never App configuration), so
 * its literals are a second, unavoidable copy. `tests/review/pin.test.ts`
 * locks that copy to this declaration — a bump edits exactly here plus the
 * matching Dockerfile line, and drift between the two fails the pin suite.
 */
export type SandboxImagePins = {
  /** Debian base image manifest digest (linux/amd64). */
  readonly baseImageDigest: string;
  /** `docker.io/cloudflare/sandbox` shim tag the Dockerfile COPYs from. */
  readonly sandboxShimTag: string;
  /** Bun release tag (base ships none; omp needs a floor). */
  readonly bunVersion: string;
  /** gh CLI release version. */
  readonly ghVersion: string;
  /** mstar-harness tag the image clones (recorded in the Dockerfile comment). */
  readonly harnessVersion: string;
  /** mstar-harness deref commit fetched into the image. */
  readonly harnessRef: string;
  /** Exact `@mstar-harness/cli` version preinstalled at the container level. */
  readonly harnessCliVersion: string;
};

/** The `omp` image's build pins — the single declaration of its versioned inputs. */
export const OMP_SANDBOX_IMAGE_PINS: SandboxImagePins = Object.freeze({
  baseImageDigest: "sha256:918311b7b6c4c6f68b232ba516584925f6c78ad82b6fd534b98979df6438e483",
  sandboxShimTag: "1.0.0",
  bunVersion: "1.4.0",
  ghVersion: "2.98.0",
  harnessVersion: "4.0.0",
  harnessRef: "4cc910fd06c2499c4ba6365e108448087c828802",
  harnessCliVersion: "4.0.0",
});

/** One selectable sandbox runtime image. */
export type SandboxImageDefinition = {
  /** Stable registry id — the value stored on github_apps.sandbox_image_id. */
  id: SandboxImageId;
  /** Only ENABLED entries are storable/selectable (store-enforced value domain). */
  enabled: boolean;
  /** Dockerfile path relative to repo root. */
  dockerfilePath: string;
  /** wrangler `containers[].images.sandbox.dockerfile` path (build_context stays repo root). */
  wranglerImagePath: string;
  /** That image's build pins (see `SandboxImagePins`). */
  pins: SandboxImagePins;
  /** Runtime kind — names the runner/synthesizer implementation this entry executes under. */
  runtime: "omp";
  /** Capability hosts synthesized into every per-review models.yml (base wins on collision). */
  hosts: readonly SandboxImageHost[];
};

/** The App default (migration 0018 DDL default; every existing row backfills to it). */
export const DEFAULT_SANDBOX_IMAGE_ID: SandboxImageId = "omp";

const SANDBOX_IMAGES: readonly SandboxImageDefinition[] = Object.freeze([
  Object.freeze({
    id: "omp",
    enabled: true,
    dockerfilePath: "sandbox-image/omp/Dockerfile",
    wranglerImagePath: "./sandbox-image/omp/Dockerfile",
    pins: OMP_SANDBOX_IMAGE_PINS,
    runtime: "omp",
    hosts: [
      Object.freeze({
        id: "ark-plan",
        catalogProviderId: "ark",
        apiKeyEnv: "ARK_API_KEY",
        baseUrl: "https://ark.cn-beijing.volces.com/api/plan",
        api: "anthropic-messages",
        auth: "apiKey",
        models: [
          Object.freeze({
            id: "deepseek-v4-flash",
            name: "Deepseek v4 flash 0731",
            reasoning: true,
            input: Object.freeze(["text"]),
            contextWindow: 1024000,
            maxTokens: 65536,
          }),
        ],
      }),
    ],
  }),
] satisfies SandboxImageDefinition[]);

/**
 * Closed registry lookup: the definition for `id`, or undefined when unknown.
 * Known-but-disabled entries come back with `enabled: false` so callers can
 * distinguish the two refusal reasons.
 */
export function getSandboxImage(id: string): SandboxImageDefinition | undefined {
  return SANDBOX_IMAGES.find((image) => image.id === id);
}

/** The enabled registry entries, registry order — the App selector's choices. */
export function enabledSandboxImages(): SandboxImageDefinition[] {
  return SANDBOX_IMAGES.filter((image) => image.enabled);
}

/**
 * The capability host ids of one registry entry — the dashboard's
 * custom-provider collision vocabulary and the consumer's neededEnvName
 * mapping. An unknown id yields [] (nothing to refuse / map); execution-time
 * resolution fails closed on unknown ids separately via getSandboxImage.
 */
export function sandboxImageHostIds(id: string): readonly string[] {
  return getSandboxImage(id)?.hosts.map((host) => host.id) ?? [];
}
