/**
 * The run's request allowance refused a request BEFORE it was dispatched
 * (spec §7.11.1: "budget exhaustion is not a failed attempt").
 *
 * Lives in contracts, not in the recovery lane, because TWO sides must agree
 * on it: the transport that refuses (and meters) the request, and the read
 * paths that must report the refusal as "nothing was observed, nothing is
 * spent" instead of as a failed readback.
 *
 * It is a distinct type because the refusal must be told apart from a send
 * that MIGHT have reached GitHub: the caller restores the claimed publication
 * to its due `prepared` state instead of recording post-attempt `unknown`, so
 * a publication that was never sent is never stranded behind read-only
 * discovery. Nothing dispatches, so no attempt is spent either.
 */
export class RecoveryBudgetRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RecoveryBudgetRefused";
  }
}

/**
 * Does this error CHAIN carry a pre-dispatch budget refusal? Octokit does not
 * let a custom transport error reach the caller intact: `fetchWrapper`
 * re-wraps every non-abort rejection in `RequestError(message, 500, ...)`
 * with the original parked on `cause` (`@octokit/request`), and the
 * paginate/plugin layers re-wrap again. The refusal therefore has to be
 * recognized by walking `cause` rather than by an `instanceof` at the throw
 * site. The chain is walked by IDENTITY, never by message text — a message
 * match would classify any error that merely mentions the budget as
 * un-dispatched, which is exactly the false "never sent" claim this
 * distinction exists to prevent. Each link is read defensively: `cause` is
 * not typed on `Error`, and a hostile/cyclic cause chain must not hang the
 * recovery lane, so the walk is bounded and deduplicated by identity.
 */
export function isBudgetRefusal(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  for (let depth = 0; depth < 8; depth += 1) {
    if (current instanceof RecoveryBudgetRefused) return true;
    if (typeof current !== "object" || current === null || seen.has(current)) return false;
    seen.add(current);
    if (!("cause" in current)) return false;
    current = current.cause;
  }
  return false;
}
