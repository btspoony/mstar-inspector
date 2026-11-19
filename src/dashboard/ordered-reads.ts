export async function orderedReads<const T extends readonly unknown[]>(
  reads: { [K in keyof T]: Promise<T[K]> },
): Promise<T> {
  const results = await Promise.allSettled(reads);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as unknown as T;
}
