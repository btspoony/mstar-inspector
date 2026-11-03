/**
 * The image rebuild gate's decision seam (`scripts/check-image-inputs.ts`).
 *
 * The git invocation is the CLI's, not this test's: what must hold is the
 * VERDICT — the five declared path families fail without a marker change,
 * nothing else does, and a diff that changes the marker passes.
 */
import { describe, expect, test } from "bun:test";
import {
  evaluateImageGate,
  IMAGE_INPUT_PATTERNS,
  touchesImageInput,
  touchesRebuildMarker,
} from "./check-image-inputs";

describe("image gate", () => {
  test("a runner source change without a marker change fails", () =>
    expect(evaluateImageGate(["packages/runner/src/index.ts"], "")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));

  test("the same change with a rebuild marker diff passes", () =>
    expect(
      evaluateImageGate(["packages/runner/src/index.ts"], "+# rebuild: runner source change"),
    ).toEqual({ ok: true }));

  test("a docs-only change passes", () =>
    expect(evaluateImageGate(["docs/deploy.md"], "")).toEqual({ ok: true }));

  test("a sandbox-image shim change fails without the marker", () =>
    expect(evaluateImageGate(["sandbox-image/entry.sh"], "")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));

  test("a Dockerfile change that does not touch the marker fails", () =>
    expect(evaluateImageGate(["sandbox-image/Dockerfile"], "-FROM old\n+FROM new")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));
});

describe("touchesImageInput", () => {
  const declared = [
    "packages/runner/src/pipeline/sandbox.ts",
    "packages/shared/src/credential-payload.ts",
    "packages/runner/package.json",
    "packages/runner/bun.lock",
    "sandbox-image/cli-global/package.json",
  ];

  test("matches each of the five declared path families", () => {
    for (const path of declared) expect(touchesImageInput([path])).toBe(true);
    expect(IMAGE_INPUT_PATTERNS).toHaveLength(5);
  });

  test("an untouched path list passes", () => {
    for (const path of [
      "docs/deploy.md",
      "src/index.ts",
      "packages/shared/bun.lock",
      "packages/runner/src-extra/index.ts",
      "packages/runner/tsconfig.json",
      "sandbox-image-notes.md",
    ]) {
      expect(touchesImageInput([path])).toBe(false);
    }
  });
});

describe("touchesRebuildMarker", () => {
  test("an added marker line counts", () =>
    expect(touchesRebuildMarker("+# rebuild: new runner source")).toBe(true));

  test("a removed marker line counts", () =>
    expect(touchesRebuildMarker("-# rebuild: stale note")).toBe(true));

  test("diff headers naming the file do not count", () =>
    expect(touchesRebuildMarker("--- a/sandbox-image/Dockerfile\n+++ b/sandbox-image/Dockerfile")).toBe(
      false,
    ));

  test("context lines and unrelated hunks do not count", () =>
    expect(touchesRebuildMarker(" # rebuild: context only\n+FROM new")).toBe(false));
});
