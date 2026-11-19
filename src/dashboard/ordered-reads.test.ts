import { describe, expect, test } from "bun:test";
import { orderedReads } from "./ordered-reads";

describe("orderedReads", () => {
  test("returns values in input order, including empty input", async () => {
    expect(await orderedReads([Promise.resolve("first"), Promise.resolve("second")])).toEqual(["first", "second"]);
    expect(await orderedReads([])).toEqual([]);
  });

  test("waits for earlier reads and rethrows their error, not the fastest rejection", async () => {
    let rejectFirst!: (error: Error) => void;
    const first = new Error("first read failed");
    const later = new Error("later read failed faster");
    const pending = orderedReads([
      new Promise<never>((_, reject) => { rejectFirst = reject; }),
      Promise.reject(later),
    ]);
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    rejectFirst(first);
    await expect(pending).rejects.toBe(first);
  });
});
