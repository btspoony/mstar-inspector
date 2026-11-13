/**
 * Sandbox runtime-image registry (spec
 * dashboard-sandbox-configuration § Runtime-image contract) — the single
 * source-controlled list of runtime images an App can select. Every entry is
 * static build-time data: this module must never import dashboard/pipeline/
 * review code, read D1, or touch secrets (dashboard Q2 isolation + the
 * zero-secrets constraint — an entry carries no credential-bearing field).
 *
 * An entry carries its build definition only (Dockerfile + wrangler
 * `containers[].image` paths, relative to repo root, plus the versioned
 * build pins). It declares NO provider and NO model: the per-review
 * models.yml is synthesized from the App's own provider declarations, and the
 * runtime resolves built-in providers from the SDK's own catalog.
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

/**
 * The periodically-upgraded build inputs of a runtime image — version-agnostic
 * KEYS, the versions are the VALUES (nothing here is ever renamed on a bump).
 *
 * The Dockerfile cannot read this module: this image is built with no build
 * args and no env (image contains runtime only, never App configuration), so
 * its literals are a second, unavoidable copy. Nothing compares the two
 * automatically — a bump edits this declaration and the matching Dockerfile
 * line together.
 *
 * `gh` is deliberately absent. The release-asset CDN answered 504 to every retry
 * (2026-11-08), and GitHub's own apt pool did not serve the two older releases
 * probed the same day, so a version-pinned URL is not durably reachable. The
 * Dockerfile installs `gh` from that pool unpinned and writes the resolved
 * version into the image (`/etc/mstar-image-versions`); the accepted cost is that
 * two builds of this same Dockerfile can carry different gh binaries.
 */
export type SandboxImagePins = {
  /** Debian base image manifest digest (linux/amd64). */
  readonly baseImageDigest: string;
  /** `docker.io/cloudflare/sandbox` shim tag the Dockerfile COPYs from. */
  readonly sandboxShimTag: string;
  /** The shim image's manifest digest — moves only together with `sandboxShimTag`. */
  readonly sandboxShimDigest: string;
  /** Bun version, carried by the `oven/bun:<v>-debian` image tag. */
  readonly bunVersion: string;
  /** The `oven/bun:<bunVersion>-debian` manifest digest — moves only together with `bunVersion`. */
  readonly bunImageDigest: string;
  /** mstar-harness tag the image clones (recorded in the Dockerfile comment). */
  readonly harnessVersion: string;
  /** mstar-harness deref commit fetched into the image. */
  readonly harnessRef: string;
  /** Exact `@mstar-harness/cli` version preinstalled at the container level. */
  readonly harnessCliVersion: string;
};

/**
 * The one mstar-harness release the image pins: both version fields below
 * carry it, so a bump changes a single literal. `harnessRef` stays a literal
 * commit — a tag cannot yield the deref sha. The Dockerfile's `ref`/`tag`
 * comment pair, the engine manifest and the lock rows are hand-synced to it.
 */
export const HARNESS_VERSION = "4.5.3";

/** The `omp` image's build pins — the single declaration of its versioned inputs. */
export const OMP_SANDBOX_IMAGE_PINS: SandboxImagePins = Object.freeze({
  baseImageDigest: "sha256:918311b7b6c4c6f68b232ba516584925f6c78ad82b6fd534b98979df6438e483",
  sandboxShimTag: "1.0.0",
  sandboxShimDigest: "sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06",
  bunVersion: "1.4.0",
  bunImageDigest: "sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef",
  harnessVersion: HARNESS_VERSION,
  harnessRef: "bc33a78c6d4fbc079c3e954833ae0bdc93a1ac3c",
  harnessCliVersion: HARNESS_VERSION,
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
};

/** The App default (migration 0018 DDL default; every existing row backfills to it). */
export const DEFAULT_SANDBOX_IMAGE_ID: SandboxImageId = "omp";

const SANDBOX_IMAGES: readonly SandboxImageDefinition[] = Object.freeze([
  Object.freeze({
    id: "omp",
    enabled: true,
    dockerfilePath: "sandbox-image/Dockerfile",
    wranglerImagePath: "./sandbox-image/Dockerfile",
    pins: OMP_SANDBOX_IMAGE_PINS,
    runtime: "omp",
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
