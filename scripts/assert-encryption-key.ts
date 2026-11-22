#!/usr/bin/env bun
/**
 * why: assert-encryption-key.ts — deploy gate for `DASHBOARD_ENCRYPTION_KEY`.
 *
 * The runtime binds the box without validating the key (lazy validation: the
 * first encrypt/decrypt is what throws), so a malformed secret deploys green
 * and then answers 500 on every encrypted write while the settings page still
 * renders — the operator sees a provider-looking failure with no trace of the
 * real cause.
 *
 * The key is checked with `createSecretbox` — the runtime's own public face
 * over the module-private `importKey` — and never with a second base64/length
 * rule. A malformed key therefore cannot pass here and fail there.
 *
 * The check is an encrypt/decrypt round-trip over fixed inputs, not a
 * verification of a stored envelope: production D1 starts empty, so the first
 * deploy has no envelope to verify, and a table read is not the preflight's
 * business. The round-trip exercises exactly what a broken key breaks — the
 * key import plus AES-GCM — and writes nothing.
 *
 * Usage:
 *   DASHBOARD_ENCRYPTION_KEY=… bun scripts/assert-encryption-key.ts
 *
 * Exit codes: 0 = the key encrypts and decrypts; 1 = it does not. The refusal
 * names the required shape and the observed length, never the value.
 */
import { createSecretbox } from "../src/dashboard/secretbox";

const PLAINTEXT = "mstar-preflight";
const AAD = "preflight:encryption-key";

/** The one shape the runtime accepts (`importKey` in `src/dashboard/secretbox.ts`). */
export const REQUIRED_SHAPE = "standard base64 of exactly 32 bytes (openssl rand -base64 32)";

export type EncryptionKeyVerdict = { ok: boolean; message: string };

/**
 * The verdict for one key value: does it encrypt AND decrypt? No database, no
 * network, nothing written — the answer depends on the key alone, which is why
 * an empty production database changes nothing.
 */
export async function encryptionKeyVerdict(
  rawKey: string | undefined,
): Promise<EncryptionKeyVerdict> {
  const box = createSecretbox(rawKey);
  try {
    const envelope = await box.encryptSecret(PLAINTEXT, AAD);
    if ((await box.decryptSecret(envelope, AAD)) !== PLAINTEXT) {
      return {
        ok: false,
        message: `encryption key: the round-trip did not return its own plaintext. Required shape: ${REQUIRED_SHAPE}`,
      };
    }
    return {
      ok: true,
      message: `encryption key: usable (encrypt/decrypt round-trip passed; required shape: ${REQUIRED_SHAPE})`,
    };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      message: `encryption key: DASHBOARD_ENCRYPTION_KEY is unusable — ${detail}. Required shape: ${REQUIRED_SHAPE}`,
    };
  }
}

if (import.meta.main) {
  const verdict = await encryptionKeyVerdict(process.env.DASHBOARD_ENCRYPTION_KEY);
  if (verdict.ok) console.log(verdict.message);
  else {
    console.error(`::error::${verdict.message}`);
    process.exit(1);
  }
}
