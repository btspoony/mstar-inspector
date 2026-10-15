/**
 * Credential-transport wire contract — the runner's stdin payload.
 *
 * This is the ONLY credential channel into the review container. The consumer
 * builds the payload from the App's decrypted key pools and streams it into the
 * runner exec's stdin (`container.exec(argv, { stdin: "pipe" })`); the in-image
 * runner validates it and writes the pools into the run's credential store
 * (`<agentDir>/agent.db`, `{type:"api_key", source:"login"}` rows). The process
 * environment, argv, every log line and every error message stay key-free.
 *
 * Shape (self-describing and versioned):
 *
 *   {"version":1,"pools":{"<providerId>":["k1","k2",…]}}
 *
 * `<providerId>` is the App-config provider id — the consumer's own key space
 * (the BYOK store id, or a custom declaration's provider id). The runner
 * resolves each one to the models.yml provider id it serves (a capability
 * host's `catalogProviderId` → its host id; everything else identity), so the
 * encoding stays free of provider-identity knowledge.
 *
 * Shim-free by construction: this module must stay importable from the in-image
 * runner graph (src/review only + the admitted src/contracts files) and from the
 * Worker, so it imports nothing but the zero-dependency shared credential-key
 * contract (itself admitted to the image).
 */

import { COMMAND_CONFIG_KEY_PREFIX, isCommandConfigKey } from "../contracts/credential-key";

/** The only payload version this build produces and accepts. */
export const CREDENTIAL_PAYLOAD_VERSION = 1;

/** Provider id → ordered key pool (the order the credential store rows carry). */
export type CredentialPools = Record<string, string[]>;

/** Serialize one payload for the runner's stdin (consumer side). */
export function encodeCredentialPayload(pools: CredentialPools): string {
  return JSON.stringify({ version: CREDENTIAL_PAYLOAD_VERSION, pools });
}

/**
 * Parse and validate a streamed payload (runner side). Throws on any violation
 * BEFORE the caller writes a credential or starts a session.
 *
 * An absent payload (empty / whitespace-only stdin) is the keyless run shape:
 * zero pools, nothing written — the same shape the retired env channel produced
 * when no pool was transported.
 *
 * Diagnostics carry the provider id and the defect only. Key values are never
 * echoed, and neither is the JSON parser's own message — a syntax error quotes
 * the offending input, which is key material.
 */
export function decodeCredentialPayload(raw: string): CredentialPools {
  if (raw.trim() === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("the credential payload is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("the credential payload must be a JSON object");
  }
  const record = parsed as Record<string, unknown>;
  if (record.version !== CREDENTIAL_PAYLOAD_VERSION) {
    throw new Error(`the credential payload version must be ${CREDENTIAL_PAYLOAD_VERSION}`);
  }
  const rawPools = record.pools;
  if (rawPools === null || typeof rawPools !== "object" || Array.isArray(rawPools)) {
    throw new Error('the credential payload must carry a "pools" object');
  }
  // Null-prototype dictionary: a `__proto__` pool key must become an OWN
  // property, never silently re-target the object's prototype (that would drop
  // a transported pool without a word — the one thing this channel must not do).
  const pools: CredentialPools = Object.create(null);
  for (const [providerId, value] of Object.entries(rawPools as Record<string, unknown>)) {
    if (providerId === "") {
      throw new Error("a credential pool must name a provider");
    }
    if (!Array.isArray(value)) {
      throw new Error(`credential pool ${providerId} must be an array of keys`);
    }
    if (value.length === 0) {
      throw new Error(`credential pool ${providerId} is empty`);
    }
    pools[providerId] = value.map((entry, index) => {
      if (typeof entry !== "string" || entry === "") {
        throw new Error(`credential pool ${providerId} entry ${index} must be a non-empty string`);
      }
      // The stored `login` api_key is handed to the SDK's config-value
      // resolver verbatim, and THAT runs any `!`-prefixed value as a shell
      // command (src/contracts/credential-key.ts) — a transported key of this
      // shape would be remote code execution inside the review container on
      // the first authenticating request. Refused here, before any credential
      // exists. The diagnostic names the pool and the index only.
      if (isCommandConfigKey(entry)) {
        throw new Error(
          `credential pool ${providerId} entry ${index} must not start with ${COMMAND_CONFIG_KEY_PREFIX} ` +
            "(the credential store would resolve it as a shell command)",
        );
      }
      return entry;
    });
  }
  return pools;
}
