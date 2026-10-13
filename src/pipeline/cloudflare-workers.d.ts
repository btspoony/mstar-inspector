/**
 * Ambient declarations for the workerd builtins the sandbox adapter imports
 * (`cloudflare:workers` — src/pipeline/sandbox.ts is the only importer).
 *
 * @cloudflare/workers-types DECLARES this module, but in this repo the package
 * is only ever reached as a module import (no tsconfig `types` entry, no
 * generated `worker-configuration.d.ts`), and a `declare module` block inside
 * a module-scoped file never registers as an ambient declaration — so the
 * exact slice the adapter needs is declared here against the installed
 * workers-types shapes. Runtime surface: the real workerd builtin (RPC
 * `runCommand`/`destroy` calls require extending this class, not a plain DO).
 */
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown, Props = unknown> {
    protected ctx: import("@cloudflare/workers-types").DurableObjectState<Props>;
    protected env: Env;
    constructor(ctx: import("@cloudflare/workers-types").DurableObjectState<Props>, env: Env);
  }
}
