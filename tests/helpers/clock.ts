/**
 * Run `fn` against a frozen wall clock so a derived deadline is exact: the
 * clock only moves when the test advances `clock.now` itself.
 *
 * Every consumer suite that pins a deadline arithmetic uses THIS helper — a
 * second copy would let one suite's clock semantic (frozen at entry vs.
 * advanced per step) drift from the other's.
 */
export async function withFrozenClock<T>(fn: (clock: { now: number }) => Promise<T>): Promise<T> {
  const realNow = Date.now;
  const clock = { now: realNow() };
  Date.now = () => clock.now;
  try {
    return await fn(clock);
  } finally {
    Date.now = realNow;
  }
}
