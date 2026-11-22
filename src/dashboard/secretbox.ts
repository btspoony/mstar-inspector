
const ENVELOPE_VERSION = "v1";
const V1_KEY_ID = "primary";
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

const enc = new TextEncoder();
const dec = new TextDecoder();

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

function base64Encode(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function base64Decode(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

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
  encryptSecret(plain: string, aad: string): Promise<string>;
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
        throw new Error(
          "secretbox: decrypt failed (wrong key, tampered ciphertext, or AAD mismatch)",
          { cause: err },
        );
      }
    },
  };
}
