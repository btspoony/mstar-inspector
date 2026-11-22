/**
 * Ambient declarations for the workerd builtins the Worker side imports:
 * `cloudflare:workers` (`DurableObject` for src/pipeline/sandbox.ts, the
 * Workflow base for src/workflow/review.ts).
 *
 * @cloudflare/workers-types DECLARES this module, but in this repo the package
 * is only ever reached as a module import (no tsconfig `types` entry, no
 * generated `worker-configuration.d.ts`), and a `declare module` block inside
 * a module-scoped file never registers as an ambient declaration — so the
 * exact slice this repo needs is declared here against the installed
 * workers-types shapes. Runtime surface: the real workerd builtin (RPC
 * `runCommand`/`destroy` calls require extending this class, not a plain DO).
 */
declare module "cloudflare:workers" {
  export class DurableObject<Env = unknown, Props = unknown> {
    protected ctx: import("@cloudflare/workers-types").DurableObjectState<Props>;
    protected env: Env;
    constructor(ctx: import("@cloudflare/workers-types").DurableObjectState<Props>, env: Env);
  }

  export type WorkflowDurationLabel = "second" | "minute" | "hour" | "day" | "week" | "month" | "year";
  export type WorkflowSleepDuration = `${number} ${WorkflowDurationLabel}${"s" | ""}` | number;
  export type WorkflowBackoff = "constant" | "linear" | "exponential";
  export type WorkflowStepConfig = {
    retries?: { limit: number; delay: WorkflowSleepDuration; backoff?: WorkflowBackoff };
    timeout?: WorkflowSleepDuration;
    sensitive?: "output";
  };
  export type WorkflowStepContext = {
    step: { name: string; count: number };
    attempt: number;
    config: WorkflowStepConfig;
  };
  export type WorkflowEvent<T> = {
    payload: Readonly<T>;
    timestamp: Date;
    instanceId: string;
    workflowName: string;
    schedule?: { cron: string; scheduledTime: number };
  };
  export type WorkflowStepEvent<T> = {
    payload: Readonly<T>;
    timestamp: Date;
    type: string;
    sensitive?: "output";
  };
  export abstract class WorkflowStep {
    do<T>(name: string, callback: (ctx: WorkflowStepContext) => Promise<T>): Promise<T>;
    do<T>(name: string, config: WorkflowStepConfig, callback: (ctx: WorkflowStepContext) => Promise<T>): Promise<T>;
    sleep(name: string, duration: WorkflowSleepDuration): Promise<void>;
    sleepUntil(name: string, timestamp: Date | number): Promise<void>;
    waitForEvent<T>(
      name: string,
      options: { type: string; timeout?: WorkflowSleepDuration },
    ): Promise<WorkflowStepEvent<T>>;
  }
  export abstract class WorkflowEntrypoint<Env = unknown, T = unknown> {
    protected ctx: import("@cloudflare/workers-types").ExecutionContext;
    protected env: Env;
    constructor(ctx: import("@cloudflare/workers-types").ExecutionContext, env: Env);
    abstract run(event: Readonly<WorkflowEvent<T>>, step: WorkflowStep): Promise<unknown>;
  }
}
