import type { WorkflowStep } from "cloudflare:workers";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { AttemptStarter } from "../../src/pipeline/consumer";

export function inlineWorkflowStarter(successorEnqueues: ReviewJobPayload[]): AttemptStarter {
  return async (deps, ref) => {
    const { runReviewAttemptWorkflow } = await import("../../src/workflow/review");
    await runReviewAttemptWorkflow(deps, ref, inlineWorkflowStep(), async (payload) => {
      successorEnqueues.push(payload);
    });
  };
}

/** A `WorkflowStep` whose `do` executes in place (see above). */
export function inlineWorkflowStep(): WorkflowStep {
  return {
    do: async (
      name: string,
      configOrCallback: unknown,
      maybeCallback?: unknown,
    ): Promise<unknown> => {
      const callback = (typeof configOrCallback === "function" ? configOrCallback : maybeCallback) as (
        ctx: unknown,
      ) => Promise<unknown>;
      return callback({ step: { name, count: 1 }, attempt: 1, config: {} });
    },
    sleep: async () => {},
    sleepUntil: async () => {},
    waitForEvent: async () => {
      throw new Error("the in-place workflow step does not wait for events");
    },
  } as unknown as WorkflowStep;
}
