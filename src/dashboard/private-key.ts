/**
 * Private-key PEM normalization for the manifest commit (plan 11 B1 Task 2):
 * the GitHub App manifest conversion returns a PKCS#1 PEM
 * (`-----BEGIN RSA PRIVATE KEY-----`), which workerd WebCrypto `importKey`
 * cannot consume — the PRIVATE_KEY secret is normalized to PKCS#8 before the
 * Cloudflare secrets-bulk write.
 *
 * Same algorithm as src/worker/diff.ts and src/pipeline/comment.ts —
 * duplicated here because dashboard ↛ pipeline/worker (architect decision Q2
 * route isolation; plan 11 Global Constraints forbid importing pipeline/**)
 * and no shared module is extracted per plan. The equivalence is pinned by
 * tests/worker/dashboard.test.ts.
 */

/** DER tag for a SEQUENCE (0x30). */
const DER_SEQUENCE = 0x30;
/** DER tag for an OCTET STRING (0x04). */
const DER_OCTET_STRING = 0x04;
/** DER tag for an INTEGER (0x02). */
const DER_INTEGER = 0x02;
/** DER tag for an OBJECT IDENTIFIER (0x06). */
const DER_OID = 0x06;
/** DER tag for NULL (0x05). */
const DER_NULL = 0x05;
/** rsaEncryption OID (1.2.840.113549.1.1.1) — the only algorithm PKCS#1 keys use. */
const RSA_ENCRYPTION_OID = new Uint8Array([0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01]);
/** PKCS#8 version 0 (single-version, no attributes). */
const PKCS8_VERSION_ZERO = new Uint8Array([0x00]);

/** DER length encoding: short form (< 0x80) or long form (0x80 | byte count). */
function derLength(length: number): Uint8Array {
  if (length < 0x80) {
    return new Uint8Array([length]);
  }
  const bytes: number[] = [];
  let n = length;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n = Math.floor(n / 256);
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/** DER TLV element: tag byte + length + body. */
function derElement(tag: number, body: Uint8Array): Uint8Array {
  const len = derLength(body.length);
  const out = new Uint8Array(1 + len.length + body.length);
  out[0] = tag;
  out.set(len, 1);
  out.set(body, 1 + len.length);
  return out;
}

/** Concatenate byte arrays (DER building blocks). */
function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Base64 → bytes (PEM body decoding; `atob` is available in Bun and workerd). */
function base64ToBytes(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/** Bytes → base64 (PEM body encoding). */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * Wrap a PKCS#1 RSA private key DER in a PKCS#8 `PrivateKeyInfo` container
 * (version 0, rsaEncryption algorithm, OCTET STRING payload). Pure JS — no
 * `node:crypto` — so Bun and workerd behave identically. The output is
 * byte-identical to `openssl pkcs8 -topk8 -nocrypt` for RSA keys.
 */
export function pkcs1ToPkcs8(pkcs1Pem: string): string {
  const body = pkcs1Pem
    .replace(/-----BEGIN RSA PRIVATE KEY-----/, "")
    .replace(/-----END RSA PRIVATE KEY-----/, "")
    .replace(/\s+/g, "");
  const pkcs1Der = base64ToBytes(body);
  const algorithm = derElement(
    DER_SEQUENCE,
    concatBytes(derElement(DER_OID, RSA_ENCRYPTION_OID), derElement(DER_NULL, new Uint8Array(0))),
  );
  const wrappedKey = derElement(DER_OCTET_STRING, pkcs1Der);
  const pkcs8Der = derElement(
    DER_SEQUENCE,
    concatBytes(derElement(DER_INTEGER, PKCS8_VERSION_ZERO), algorithm, wrappedKey),
  );
  const b64 = bytesToBase64(pkcs8Der);
  return `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join("\n")}\n-----END PRIVATE KEY-----\n`;
}

/**
 * Normalize a private key PEM to PKCS#8 (the only format workerd WebCrypto
 * `importKey` accepts): PKCS#1 → wrapped; PKCS#8 → as-is; OpenSSH → hard
 * error with the conversion command.
 */
export function normalizePrivateKey(pem: string): string {
  if (pem.includes("-----BEGIN RSA PRIVATE KEY-----")) {
    return pkcs1ToPkcs8(pem);
  }
  if (pem.includes("-----BEGIN OPENSSH PRIVATE KEY-----")) {
    throw new Error(
      "PRIVATE_KEY is in OpenSSH format, which WebCrypto cannot sign with. Convert it to PKCS#8: openssl pkcs8 -topk8 -nocrypt -in <key> -out <key>.pkcs8.pem",
    );
  }
  return pem;
}
