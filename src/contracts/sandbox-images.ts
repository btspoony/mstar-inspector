
/** A stored sandbox image selection (review_bots.sandbox_image_id, migration 0018). */
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
  readonly baseImageDigest: string;
  readonly sandboxShimTag: string;
  readonly sandboxShimDigest: string;
  readonly bunVersion: string;
  readonly bunImageDigest: string;
  readonly harnessVersion: string;
  readonly harnessRef: string;
  readonly harnessCliVersion: string;
};

/**
 * The one mstar-harness release the image pins: both version fields below
 * carry it, so a bump changes a single literal. `harnessRef` stays a literal
 * commit — a tag cannot yield the deref sha. The Dockerfile's `ref`/`tag`
 * comment pair, the engine manifest and the lock rows are hand-synced to it.
 */
export const HARNESS_VERSION = "4.8.2";

/** The `omp` image's build pins — the single declaration of its versioned inputs. */
export const OMP_SANDBOX_IMAGE_PINS: SandboxImagePins = Object.freeze({
  baseImageDigest: "sha256:918311b7b6c4c6f68b232ba516584925f6c78ad82b6fd534b98979df6438e483",
  sandboxShimTag: "1.0.0",
  sandboxShimDigest: "sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06",
  bunVersion: "1.4.0",
  bunImageDigest: "sha256:5bb0f9be3a1a36a03e27c9a9dd894a3b1ad26657155c7df4dda771e17bf872ef",
  harnessVersion: HARNESS_VERSION,
  harnessRef: "a3b2763a7f33a14c1193aee5ac8880dda970d218",
  harnessCliVersion: HARNESS_VERSION,
});

/** One selectable sandbox runtime image. */
export type SandboxImageDefinition = {
  id: SandboxImageId;
  enabled: boolean;
  dockerfilePath: string;
  wranglerImagePath: string;
  pins: SandboxImagePins;
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
