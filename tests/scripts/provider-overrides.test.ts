/**
 * why: `scripts/provider-catalog/lib/overrides.ts` — the hand-measured override layer.
 *
 * The vendored snapshot used to be the package's vocabulary verbatim. That made
 * the generated catalog wrong whenever the package and the vendor's live
 * endpoint disagreed, and a hand edit to the generated JSON was destroyed by
 * the next `bun run provider:catalog`. The override file is that measurement in
 * a place regeneration reads instead of overwrites.
 *
 * These assertions are about the RULE, not about today's counts: a bucket is
 * replaced wholesale (never unioned), an absent override leaves the package
 * value alone, and ids are carried verbatim in both dialects — the provider
 * rejects a prefixed Claude id and needs the slash on an `org/` id, so
 * normalizing either direction publishes a vocabulary it cannot serve.
 */
import { describe, expect, test } from "bun:test";
import { applyOverrides, type Override } from "../../scripts/provider-catalog/lib/overrides";

type Row = { id: string; api: string; models: string[] };

function row(id: string, api: string, models: string[]): Row {
  return { id, api, models };
}

const OVERRIDE: Override = {
  source: "https://example.invalid/models",
  fetched: "2026-11-18",
  buckets: { "openai-completions": ["org/a", "b"] },
};

describe("applyOverrides — a measured bucket replaces the package's", () => {
  test("the named bucket is replaced wholesale, not unioned with the package", () => {
    // why: The package holds an id the provider rejects: a union would publish it.
    const before = [row("commandcode-completions", "openai-completions", ["org/pkg-only", "org/a"])];
    const { records, applied } = applyOverrides(before, { commandcode: OVERRIDE });

    expect(records[0]!.models).toEqual(["org/a", "b"]);
    expect(records[0]!.models).not.toContain("org/pkg-only");
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({
      provider: "commandcode",
      bucket: "openai-completions",
      recordId: "commandcode-completions",
      models: 2,
      source: OVERRIDE.source,
      fetched: OVERRIDE.fetched,
    });
  });

  test("the primary protocol is matched by the plain provider id", () => {
    // why: The extraction names the most common protocol `<provider>`, every other
    // one `<provider>-<suffix>`; both spellings must resolve.
    const before = [row("commandcode", "openai-responses", ["pkg-1", "pkg-2"])];
    const { records } = applyOverrides(before, {
      commandcode: { ...OVERRIDE, buckets: { "openai-responses": ["live-1"] } },
    });
    expect(records[0]!.id).toBe("commandcode");
    expect(records[0]!.models).toEqual(["live-1"]);
  });

  test("a bucket for a protocol the extraction did not produce is reported, not invented", () => {
    const before = [row("commandcode", "openai-completions", ["org/a"])];
    const { records, applied, unmatched } = applyOverrides(before, {
      commandcode: { ...OVERRIDE, buckets: { "anthropic-messages": ["claude-x"] } },
    });
    expect(applied).toEqual([]);
    expect(unmatched).toEqual(["commandcode anthropic-messages"]);
    // note: Nothing was added: the record set is exactly what the package shipped.
    expect(records.map((r) => r.api)).toEqual(["openai-completions"]);
  });
});

describe("applyOverrides — an absent override changes nothing", () => {
  test("a provider with no entry keeps the package's vocabulary verbatim", () => {
    const untouched = row("helmcode", "openai-completions", ["deepseek-v4-flash", "gemma4"]);
    const overridden = row("commandcode-completions", "openai-completions", ["org/pkg"]);
    const { records, applied, unmatched } = applyOverrides([untouched, overridden], {
      commandcode: OVERRIDE,
    });
    // note: Only the provider the file names moved; the sibling is byte-identical.
    expect(records[0]).toEqual(untouched);
    expect(records[1]!.models).toEqual(["org/a", "b"]);
    expect(applied).toHaveLength(1);
    expect(unmatched).toEqual([]);
  });

  test("an override naming a provider the package does not ship reports it instead of inventing a row", () => {
    const before = [row("helmcode", "openai-completions", ["deepseek-v4-flash"])];
    const { records, applied, unmatched } = applyOverrides(before, { commandcode: OVERRIDE });
    expect(records).toEqual(before);
    expect(applied).toEqual([]);
    expect(unmatched).toEqual(["commandcode openai-completions"]);
  });

  test("an empty override set is a no-op, not an error", () => {
    const before = [row("commandcode", "openai-completions", ["org/a"])];
    expect(applyOverrides(before, {})).toEqual({ records: before, applied: [], unmatched: [] });
  });

  test("the caller's records are not mutated", () => {
    const before = [row("commandcode-completions", "openai-completions", ["org/a"])];
    applyOverrides(before, { commandcode: OVERRIDE });
    expect(before[0]!.models).toEqual(["org/a"]);
  });
});

describe("applyOverrides — ids survive verbatim", () => {
  test("a bare id stays bare and no prefix is invented for it", () => {
    const before = [row("commandcode-anthropic", "anthropic-messages", ["stale"])];
    const { records } = applyOverrides(before, {
      commandcode: {
        ...OVERRIDE,
        buckets: { "anthropic-messages": ["claude-sonnet-5-5", "claude-opus-5"] },
      },
    });
    expect(records[0]!.models).toEqual(["claude-sonnet-5-5", "claude-opus-5"]);
    expect(records[0]!.models.every((id) => !id.includes("/"))).toBe(true);
  });

  test("a slash is preserved exactly, including case", () => {
    const before = [row("commandcode-completions", "openai-completions", [])];
    const ids = ["MiniMaxAI/MiniMax-M2.5", "Qwen/Qwen3.8-Max", "gpt-6-sol"];
    const { records } = applyOverrides(before, {
      commandcode: { ...OVERRIDE, buckets: { "openai-completions": ids } },
    });
    expect(records[0]!.models).toEqual(ids);
  });
});
