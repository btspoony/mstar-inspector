/**
 * Plan 13 Task 1 tests: the AES-256-GCM secretbox envelope (spec
 * dashboard-multi-app-platform § Crypto envelope, architect lock L1).
 *
 * Locked surface under test:
 *   - envelope `v1.<keyId>.<iv_b64>.<ct_b64>` — STANDARD base64 (D1 column
 *     carrier, not the cookie base64url), 12-byte random IV per encryption,
 *     ct_b64 = the full crypto.subtle.encrypt output (ciphertext ‖ 16B tag,
 *     encoded once, never split).
 *   - keyId is always "primary" in v1; decrypt on an unknown keyId → typed
 *     error (rotation reserved, not implemented this iteration).
 *   - master key = base64 DASHBOARD_ENCRYPTION_KEY decoding to EXACTLY 32
 *     bytes; missing / non-base64 / wrong length → SecretboxKeyError, lazy
 *     (first use), never a fallback to DASHBOARD_SESSION_SECRET.
 *   - AAD is caller-supplied (`<table>.<column>:<rowKey>`); an AAD mismatch
 *     must throw (GCM tag verification failure — the tamper anchor).
 */
import { describe, expect, test } from "bun:test";
import { SecretboxKeyError, createSecretbox } from "../../src/dashboard/secretbox";

/** 32 raw bytes as base64 — a valid AES-256 master key. */
const KEY_32 = btoa("k".repeat(32));
const AAD = "github_apps.private_key_enc:app-1";
// RSA-2048-shaped multi-line plaintext (PEM-like), not a real key.
const PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  ...Array.from({ length: 8 }, (_, i) => `${String(i).repeat(64)}`),
  "-----END RSA PRIVATE KEY-----",
  "",
].join("\n");

function b64Bytes(s: string): Uint8Array {
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

/** Flip the first base64 char to another valid one (stays well-formed). */
function flipFirstChar(s: string): string {
  return `${s.startsWith("A") ? "B" : "A"}${s.slice(1)}`;
}

describe("createSecretbox key validation (lazy, first use)", () => {
  test("a valid 32-byte base64 key encrypts and decrypts", async () => {
    const box = createSecretbox(KEY_32);
    const envelope = await box.encryptSecret(PEM, AAD);
    expect(await box.decryptSecret(envelope, AAD)).toBe(PEM);
  });

  test("missing key (undefined) fails at first use with SecretboxKeyError", async () => {
    const box = createSecretbox(undefined);
    await expect(box.encryptSecret(PEM, AAD)).rejects.toThrow(SecretboxKeyError);
  });

  test("empty-string key fails with SecretboxKeyError", async () => {
    const box = createSecretbox("");
    await expect(box.encryptSecret(PEM, AAD)).rejects.toThrow(SecretboxKeyError);
  });

  test("short key (16 bytes) is rejected — AES-256 needs exactly 32", async () => {
    const box = createSecretbox(btoa("s".repeat(16)));
    await expect(box.encryptSecret(PEM, AAD)).rejects.toThrow(SecretboxKeyError);
  });

  test("31-byte and 33-byte keys are rejected (exactly 32)", async () => {
    await expect(createSecretbox(btoa("a".repeat(31))).encryptSecret(PEM, AAD)).rejects.toThrow(
      SecretboxKeyError,
    );
    await expect(createSecretbox(btoa("a".repeat(33))).encryptSecret(PEM, AAD)).rejects.toThrow(
      SecretboxKeyError,
    );
  });

  test("non-base64 key is rejected with SecretboxKeyError", async () => {
    const box = createSecretbox("definitely not base64 !!!");
    await expect(box.encryptSecret(PEM, AAD)).rejects.toThrow(SecretboxKeyError);
  });

  test("a box whose key is broken still reports SecretboxKeyError on decrypt (lazy)", async () => {
    const box = createSecretbox(btoa("s".repeat(16)));
    await expect(box.decryptSecret("v1.primary.AAAA.AAAA", AAD)).rejects.toThrow(SecretboxKeyError);
  });
});

describe("encryptSecret envelope format (lock L1)", () => {
  test("envelope is v1.<keyId>.<iv_b64>.<ct_b64> in STANDARD base64", async () => {
    const box = createSecretbox(KEY_32);
    const envelope = await box.encryptSecret(PEM, AAD);
    const parts = envelope.split(".");
    expect(parts).toHaveLength(4);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe("primary"); // v1 keyId is constant; rotation reserved
    const ivB64 = parts[2]!;
    const ctB64 = parts[3]!;
    // Standard base64 alphabet — NOT the cookie carrier's base64url.
    expect(ivB64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(ctB64).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(ivB64).not.toMatch(/[-_]/);
    expect(ctB64).not.toMatch(/[-_]/);
    // 12-byte random IV per encryption (WebCrypto AES-GCM convention).
    expect(b64Bytes(ivB64)).toHaveLength(12);
    // ct_b64 is the full encrypt output: ciphertext ‖ 16B tag (never split).
    expect(b64Bytes(ctB64).length).toBeGreaterThanOrEqual(16);
    expect(b64Bytes(ctB64).length).toBeGreaterThan(16); // non-empty plaintext
  });

  test("each encryption uses a fresh IV (same plaintext → different envelopes)", async () => {
    const box = createSecretbox(KEY_32);
    const a = await box.encryptSecret(PEM, AAD);
    const b = await box.encryptSecret(PEM, AAD);
    expect(a).not.toBe(b);
    expect(await box.decryptSecret(a, AAD)).toBe(PEM);
    expect(await box.decryptSecret(b, AAD)).toBe(PEM);
  });
});

describe("decryptSecret failures", () => {
  const box = createSecretbox(KEY_32);

  test("AAD mismatch throws (GCM tag verification fails)", async () => {
    const envelope = await box.encryptSecret(PEM, AAD);
    await expect(box.decryptSecret(envelope, "github_apps.private_key_enc:other-row")).rejects.toThrow(
      /decrypt failed/,
    );
  });

  test("tampered ciphertext throws (bit-flip in ct_b64)", async () => {
    const envelope = await box.encryptSecret(PEM, AAD);
    const parts = envelope.split(".");
    parts[3] = flipFirstChar(parts[3]!);
    await expect(box.decryptSecret(parts.join("."), AAD)).rejects.toThrow(/decrypt failed/);
  });

  test("unknown keyId → SecretboxKeyError (rotation reserved, v1 = primary only)", async () => {
    const envelope = await box.encryptSecret(PEM, AAD);
    const parts = envelope.split(".");
    parts[1] = "secondary";
    await expect(box.decryptSecret(parts.join("."), AAD)).rejects.toThrow(SecretboxKeyError);
  });

  test("unknown envelope version throws", async () => {
    await expect(box.decryptSecret("v2.primary.AAAA.AAAA", AAD)).rejects.toThrow(/version/);
  });

  test("malformed envelope (wrong segment count) throws", async () => {
    await expect(box.decryptSecret("v1.primary.AAAA", AAD)).rejects.toThrow(/malformed/);
  });

  test("malformed envelope (non-base64 iv) throws", async () => {
    await expect(box.decryptSecret("v1.primary.!!!!.AAAA", AAD)).rejects.toThrow(/malformed/);
  });

  test("ciphertext shorter than the 16B tag throws", async () => {
    await expect(box.decryptSecret("v1.primary.AAAAAAAAAAAAAAAA.AAAA", AAD)).rejects.toThrow(
      /malformed/,
    );
  });
});
