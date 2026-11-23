/**
 * The sandbox boundary's error leaf. It imports nothing at all on purpose: the
 * Durable Object module links `cloudflare:workers` at module-link time, so a
 * caller that only needs to CLASSIFY an outcome (the pipeline, the Workflows
 * host, any suite) must be able to name the class without linking a container
 * binding. Same reason `./shell-command` is its own dependency-free leaf.
 */

/**
 * A command was addressed to a slot that is not running. Transient by nature:
 * only `provision` may start a container, so the caller's retry re-provisions.
 */
export class ContainerNotRunningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContainerNotRunningError";
  }
}
