/**
 * Credential-transport wire contract tests (runner stdin payload).
 *
 * The payload is the ONLY credential channel into the review container: the
 * consumer builds it from the App's decrypted key pools and streams it into the
 * runner exec's stdin; the runner validates it and writes the pools into the
 * run's credential store. The process environment never carries a key, so a
 * payload that does not parse, names no keys, or carries a non-string/empty
 * entry MUST be rejected before anything is written.
 *
 * Contract under test:
 *   - the encoded shape is self-describing and versioned:
 *     `{"version":1,"pools":{"<providerId>":["k1",…]}}`;
 *   - an ABSENT payload (empty / whitespace-only stdin) decodes to zero pools —
 *     the keyless run shape (a run that transports no credentials);
 *   - every rejection carries the provider id and the defect only — never a key
 *     value, and never the JSON parser's own message (which quotes the input).
 */

import { describe, expect, test } from "bun:test";
import {
  CREDENTIAL_PAYLOAD_VERSION,
  decodeCredentialPayload,
  encodeCredentialPayload,
} from "../../packages/shared/src/credential-payload";
import { sk } from "../helpers/fake-secrets";

describe("credential payload — encode", () => {
  test("the payload is versioned JSON keyed by provider id, pools in insertion order", () => {
    expect(encodeCredentialPayload({ ark: [sk("one"), sk("two")], openai: [sk("three")] })).toBe(
      `{"version":${CREDENTIAL_PAYLOAD_VERSION},"pools":{"ark":["${sk("one")}","${sk("two")}"],"openai":["${sk("three")}"]}}`,
    );
  });

  test("round-trips through the decoder", () => {
    const pools = { ark: [sk("one")], "my-provider": [sk("two"), sk("three")] };
    expect(decodeCredentialPayload(encodeCredentialPayload(pools))).toEqual(pools);
  });
});

describe("credential payload — decode", () => {
  test("an absent payload (empty stdin) is the keyless run shape", () => {
    expect(decodeCredentialPayload("")).toEqual({});
    expect(decodeCredentialPayload("   \n")).toEqual({});
  });

  test("zero pools decode to zero pools", () => {
    expect(decodeCredentialPayload(encodeCredentialPayload({}))).toEqual({});
  });

  test("unparseable payload → reject with no input echoed", () => {
    // A JSON syntax error quotes the offending input — the decoder must not
    // forward that text: it would put key material in the diagnostics.
    for (const raw of ["not json", `{"version":1,"pools":{"ark":["${sk("leaky")}"}`, "[1,2]"]) {
      expect(() => decodeCredentialPayload(raw)).toThrow(/not valid JSON|must be a JSON object/);
    }
    try {
      decodeCredentialPayload(`{"version":1,"pools":{"ark":["${sk("leaky")}"}`);
    } catch (error) {
      expect((error as Error).message).not.toContain(sk("leaky"));
    }
  });

  test("a non-object payload → reject", () => {
    expect(() => decodeCredentialPayload("[]")).toThrow("must be a JSON object");
    expect(() => decodeCredentialPayload("null")).toThrow("must be a JSON object");
    expect(() => decodeCredentialPayload('"ark"')).toThrow("must be a JSON object");
  });

  test("an unsupported version → reject", () => {
    expect(() => decodeCredentialPayload('{"version":2,"pools":{}}')).toThrow(
      `version must be ${CREDENTIAL_PAYLOAD_VERSION}`,
    );
    expect(() => decodeCredentialPayload('{"pools":{}}')).toThrow(
      `version must be ${CREDENTIAL_PAYLOAD_VERSION}`,
    );
  });

  test("a missing pools object → reject", () => {
    expect(() => decodeCredentialPayload('{"version":1}')).toThrow('must carry a "pools" object');
    expect(() => decodeCredentialPayload('{"version":1,"pools":[]}')).toThrow('must carry a "pools" object');
    expect(() => decodeCredentialPayload('{"version":1,"pools":null}')).toThrow('must carry a "pools" object');
  });

  test("a pool that is not an array → reject (provider named, no values)", () => {
    expect(() => decodeCredentialPayload('{"version":1,"pools":{"ark":"k1"}}')).toThrow(
      "credential pool ark must be an array of keys",
    );
  });

  test("an empty pool array → reject", () => {
    expect(() => decodeCredentialPayload('{"version":1,"pools":{"ark":[]}}')).toThrow(
      "credential pool ark is empty",
    );
  });

  test("a non-string or empty entry → reject, never echoing the entry", () => {
    expect(() => decodeCredentialPayload(`{"version":1,"pools":{"ark":[${JSON.stringify(sk("ok"))}, 7]}}`)).toThrow(
      "credential pool ark entry 1 must be a non-empty string",
    );
    expect(() => decodeCredentialPayload('{"version":1,"pools":{"ark":[""]}}')).toThrow(
      "credential pool ark entry 0 must be a non-empty string",
    );
    try {
      decodeCredentialPayload(`{"version":1,"pools":{"ark":[${JSON.stringify(sk("leaky"))}, 7]}}`);
    } catch (error) {
      expect((error as Error).message).not.toContain(sk("leaky"));
    }
  });

  test("a pool that names no provider → reject", () => {
    expect(() => decodeCredentialPayload('{"version":1,"pools":{"":["k"]}}')).toThrow(
      "must name a provider",
    );
  });

  test("a `!`-prefixed entry → reject (the credential store would run it as a shell command)", () => {
    // The rule the decoder mirrors is the SDK's own config-value test:
    // `valueConfig?.startsWith("!") === true` → `ptree.exec(["/bin/sh","-c",…])`.
    expect(() => decodeCredentialPayload('{"version":1,"pools":{"ark":["!touch /tmp/x"]}}')).toThrow(
      "credential pool ark entry 0 must not start with !",
    );
    // Only a LEADING `!` is the command shape — a key containing one is data.
    expect(decodeCredentialPayload('{"version":1,"pools":{"ark":["sk-live-a!b"]}}')).toEqual({
      ark: ["sk-live-a!b"],
    });
    try {
      decodeCredentialPayload('{"version":1,"pools":{"ark":["!touch /tmp/pwned"]}}');
    } catch (error) {
      expect((error as Error).message).not.toContain("pwned");
      expect((error as Error).message).toContain("ark");
    }
  });

  test("no declared pool is ever silently dropped (a `__proto__` key stays an own pool)", () => {
    // Assigning `__proto__` on a plain object literal re-targets the prototype,
    // so that pool would vanish from `Object.keys` — a transported credential
    // dropped without a word. The decoder builds a null-prototype dictionary.
    const pools = decodeCredentialPayload('{"version":1,"pools":{"__proto__":["k1"],"ark":["k2"]}}');
    expect(Object.keys(pools).sort()).toEqual(["__proto__", "ark"]);
    expect(pools.ark).toEqual(["k2"]);
    expect(Object.values(pools)).toHaveLength(2);
  });
});
