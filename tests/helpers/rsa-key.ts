/**
 * Real RSA key material for tests that must reach the HTTP transport
 * — a `fakePem`-shaped dummy cannot: `createAppAuth` signs
 * the App JWT with WebCrypto and `importKey` throws on a non-PKCS#8 body, so
 * the request never leaves the process and a fetch/identity seam stays
 * unobservable. Generated once per process and memoized — RSA-2048 keygen
 * costs ~100ms, which per-test generation would multiply across the suite.
 */
import { pemBanner } from "./fake-secrets";

let cached: Promise<string> | null = null;

async function generate(): Promise<string> {
  const { privateKey } = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const der = new Uint8Array((await crypto.subtle.exportKey("pkcs8", privateKey)) as ArrayBuffer);
  let binary = "";
  for (const byte of der) binary += String.fromCharCode(byte);
  const b64 = btoa(binary);
  const label = "PRIVATE KEY";
  return `${pemBanner("BEGIN", label)}\n${b64.match(/.{1,64}/g)!.join("\n")}\n${pemBanner("END", label)}\n`;
}

/** A memoized, genuinely importable PKCS#8 App private key PEM. */
export function testAppPem(): Promise<string> {
  cached ??= generate();
  return cached;
}
