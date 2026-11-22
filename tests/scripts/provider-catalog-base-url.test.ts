import { describe, expect, test } from "bun:test";
import { declarationBaseUrl, storableBaseUrl } from "../../scripts/provider-catalog/lib/base-url";

describe("storableBaseUrl", () => {
  test("https is the only accepted scheme (the declaration store's rule)", () => {
    expect(storableBaseUrl("https://api.example.com/v1")).toBe("https://api.example.com/v1");
    expect(storableBaseUrl("http://api.example.com/v1")).toBeNull();
    expect(storableBaseUrl("ftp://api.example.com")).toBeNull();
    expect(storableBaseUrl("not a url")).toBeNull();
    expect(storableBaseUrl(null)).toBeNull();
    expect(storableBaseUrl(undefined)).toBeNull();
  });

  test("loopback hosts are refused even over https", () => {
    expect(storableBaseUrl("https://localhost:8443/v1")).toBeNull();
    expect(storableBaseUrl("https://127.0.0.1:1234/v1")).toBeNull();
    expect(storableBaseUrl("http://127.0.0.1:8080/v1")).toBeNull();
    expect(storableBaseUrl("https://[::1]:9000/v1")).toBeNull();
    expect(storableBaseUrl("https://localhost.example.com/v1")).toBe("https://localhost.example.com/v1");
  });
});

describe("declarationBaseUrl", () => {
  test("the most common model URL wins when storable", () => {
    expect(declarationBaseUrl(["https://a.example.com", "https://b.example.com"])).toBe(
      "https://a.example.com",
    );
  });

  test("a rejected leading candidate falls through to the next (the round-2 bug)", () => {
    expect(declarationBaseUrl(["http://127.0.0.1:1234/v1", "https://api.example.com/v1"])).toBe(
      "https://api.example.com/v1",
    );
    expect(declarationBaseUrl(["https://localhost:8080/v1", undefined, "https://seed.example.com"])).toBe(
      "https://seed.example.com",
    );
  });

  test("null only when EVERY candidate is unusable — the rule as published", () => {
    expect(declarationBaseUrl(["http://127.0.0.1:8080/v1", undefined])).toBeNull();
    expect(declarationBaseUrl([])).toBeNull();
  });
});
