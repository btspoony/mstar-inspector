/**
 * AES-256-GCM secretbox for D1-stored dashboard secrets (plan 13 B5 Task 1;
 * plan 14 B2 reuses it for per-App provider keys). Spec
 * dashboard-multi-app-platform § Crypto envelope, architect lock L1.
 *
 * Envelope: `v1.<keyId>.<iv_b64>.<ct_b64>`
 *   - STANDARD base64 (the carrier is a D1 TEXT column — not the manifest
 *     hold cookie's base64url; same layout: 12B IV, ciphertext ‖ 16B tag).
 *   - iv_b64: 12 fresh random bytes per encryption (WebCrypto AES-GCM
 *     convention, same as the manifest hold).
 *   - ct_b64: the complete crypto.subtle.encrypt output — ciphertext and the
 *     16B GCM tag encoded together, never split.
 *   - keyId is constant "primary" in v1; decrypt on an unknown keyId →
 *     SecretboxKeyError (rotation is reserved via keyId, not implemented
 *     this iteration).
 *
 * Master key: the DASHBOARD_ENCRYPTION_KEY Worker secret, base64 of EXACTLY
 * 32 bytes (AES-256). Validation is lazy (first use) and the imported
 * CryptoKey is cached in module scope. Missing / non-base64 / wrong length →
 * SecretboxKeyError; encryption-dependent routes map that to 5xx fail-closed.
 * NEVER falls back to DASHBOARD_SESSION_SECRET — the session HMAC key and
 * the envelope master key are separate duties with decoupled rotation (same
 * precedent as the B0 session cookie key).
 *
 * AAD: caller-supplied `<table>.<column>:<rowKey>` string (composite keys
 * join with `:`, e.g. `<appId>:<provider>` for app_provider_keys, plan 14).
 * An AAD mismatch fails GCM tag verification → decrypt throws.
 *
 * Module boundary (lock L1): zero-dependency leaf — no imports at all — so
 * dashboard routes, the worker webhook face, and the pipeline consumer can
 * all import it without breaking the dashboard ↛ pipeline/worker isolation.
 * Plaintext PEM / secrets only ever live in call arguments and the returned
 * envelope string; this module never logs.
 */

/** Envelope version prefix (only "v1" exists; rotation reserved via keyId). */
const ENVELOPE_VERSION = "v1";
/** The only v1 keyId; rotation would add keyIds and per-keyId selection. */
const V1_KEY_ID = "primary";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Imported CryptoKeys keyed by the raw base64 secret. One deployment has one
 * key; tests add a handful. Lazy validation means the cache is only populated
 * after the secret has passed the exactly-32-bytes check.
 */
const keyCache = new Map<string, CryptoKey>();

/**
 * Key-availability error: master key missing / non-base64 / not exactly 32
 * bytes, or an envelope asking for an unknown keyId. Routes map this to 5xx
 * fail-closed. Deliberately the ONLY typed error — every other failure
 * (malformed envelope, tampered ciphertext, AAD mismatch) throws a plain
 * Error with a `secretbox:` prefix so callers can distinguish
 * misconfiguration from bad data.
 */
export class SecretboxKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretboxKeyError";
  }
}

/** Standard base64 (D1 column carrier — never the cookie base64url). */
function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

/** Throws on anything outside the standard base64 alphabet (incl. base64url). */
function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * Lazy master-key validation + import (cached per raw secret). Throws
 * SecretboxKeyError on any problem — checked on EVERY call before any
 * envelope work, so a broken key fails encrypt and decrypt alike.
 */
async function importKey(rawKey: string | undefined): Promise<CryptoKey> {
  if (!rawKey) {
    throw new SecretboxKeyError("secretbox: DASHBOARD_ENCRYPTION_KEY is not set");
  }
  const cached = keyCache.get(rawKey);
  if (cached) return cached;
  let decoded: Uint8Array<ArrayBuffer>;
  try {
    decoded = base64Decode(rawKey);
  } catch {
    throw new SecretboxKeyError("secretbox: DASHBOARD_ENCRYPTION_KEY is not valid base64");
  }
  if (decoded.length !== KEY_BYTES) {
    throw new SecretboxKeyError(
      `secretbox: DASHBOARD_ENCRYPTION_KEY must decode to exactly ${KEY_BYTES} bytes (got ${decoded.length})`,
    );
  }
  const key = await crypto.subtle.importKey(
    "raw",
    decoded,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
  keyCache.set(rawKey, key);
  return key;
}

/** The secretbox face bound to one master key (createSecretbox per request). */
export type Secretbox = {
  /** Encrypt to a `v1.<keyId>.<iv_b64>.<ct_b64>` envelope. */
  encryptSecret(plain: string, aad: string): Promise<string>;
  /** Inverse of encryptSecret; AAD/tamper/key mismatch throws. */
  decryptSecret(envelope: string, aad: string): Promise<string>;
};

/**
 * Bind the secretbox to a master key. `rawKey` is the DASHBOARD_ENCRYPTION_KEY
 * env value; it is NOT validated here (lazy — first use), so constructing a
 * box is always safe and the failure surfaces as SecretboxKeyError at the
 * encrypt/decrypt call the route already wraps.
 */
export function createSecretbox(rawKey: string | undefined): Secretbox {
  return {
    async encryptSecret(plain, aad) {
      const key = await importKey(rawKey);
      const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
      // WebCrypto returns ciphertext ‖ tag as one buffer — encoded once.
      const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
          key,
          enc.encode(plain),
        ),
      );
      return `${ENVELOPE_VERSION}.${V1_KEY_ID}.${base64Encode(iv)}.${base64Encode(ciphertext)}`;
    },

    async decryptSecret(envelope, aad) {
      const key = await importKey(rawKey);
      const parts = envelope.split(".");
      if (parts.length !== 4) {
        throw new Error(
          `secretbox: malformed envelope (expected ${ENVELOPE_VERSION}.<keyId>.<iv_b64>.<ct_b64>)`,
        );
      }
      if (parts[0] !== ENVELOPE_VERSION) {
        throw new Error(
          `secretbox: unsupported envelope version ${JSON.stringify(parts[0])} (expected ${ENVELOPE_VERSION})`,
        );
      }
      const keyId = parts[1]!;
      if (keyId !== V1_KEY_ID) {
        throw new SecretboxKeyError(
          `secretbox: unknown keyId ${JSON.stringify(keyId)} (this deployment only knows ${JSON.stringify(V1_KEY_ID)}; rotation is not configured)`,
        );
      }
      let iv: Uint8Array<ArrayBuffer>;
      let ciphertext: Uint8Array<ArrayBuffer>;
      try {
        iv = base64Decode(parts[2]!);
        ciphertext = base64Decode(parts[3]!);
      } catch {
        throw new Error("secretbox: malformed envelope (iv/ct is not valid standard base64)");
      }
      if (iv.length !== IV_BYTES) {
        throw new Error(
          `secretbox: malformed envelope (iv must be ${IV_BYTES} bytes, got ${iv.length})`,
        );
      }
      if (ciphertext.length < TAG_BYTES) {
        throw new Error(
          `secretbox: malformed envelope (ciphertext shorter than the ${TAG_BYTES}-byte tag)`,
        );
      }
      try {
        const plain = await crypto.subtle.decrypt(
          { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
          key,
          ciphertext,
        );
        return dec.decode(plain);
      } catch (err) {
        // GCM tag verification failure: wrong key, tampered ciphertext, or a
        // different AAD. Wrapped so operators see the cause class, not a bare
        // "OperationError".
        throw new Error(
          "secretbox: decrypt failed (wrong key, tampered ciphertext, or AAD mismatch)",
          { cause: err },
        );
      }
    },
  };
}
