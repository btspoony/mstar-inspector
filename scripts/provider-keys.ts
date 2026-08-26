/**
 * provider-keys — set omp-known provider API keys on the deployed Worker.
 *
 * Maps an omp built-in provider name to the Worker env var the review
 * sandbox expects (the same env names omp's built-in provider discovery
 * reads), then runs `wrangler secret put <ENV>` with the value piped on
 * stdin — the value never appears in argv, logs, or git (repo hard rule).
 *
 * Modes:
 *   bun run keys                 → interactive: numbered provider picker,
 *                                  then a masked stdin value prompt.
 *   bun run keys --list          → print the provider → env-name table.
 *   bun run keys --provider <name> [--value <secret>]
 *                                → non-interactive (CI-friendly). Value
 *                                  resolution order: --value, the env var
 *                                  named by the provider (e.g.
 *                                  ANTHROPIC_API_KEY), then piped stdin.
 *                                  Unknown provider or missing value → exit 1.
 *
 * The PROVIDERS table and providerEnvName() are pure and unit-tested
 * (tests/scripts/provider-keys.test.ts); the interactive path is
 * manual-smoke only (plan postdeploy-review-feedback T3).
 */

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export type ProviderInfo = {
  /** Worker env var name the key is stored under (wrangler secret put target). */
  envName: string;
  /** Human-readable provider label for the picker/table. */
  label: string;
};

/**
 * omp built-in providers → Worker env var names (pure mapping table, T3).
 * The env names match omp's built-in provider discovery (ANTHROPIC_API_KEY,
 * OPENAI_API_KEY, GEMINI_API_KEY, GROQ_API_KEY, CEREBRAS_API_KEY,
 * XAI_API_KEY, OPENROUTER_API_KEY, KILO_API_KEY, MISTRAL_API_KEY,
 * ZAI_API_KEY, MINIMAX_API_KEY, OPENCODE_API_KEY, CURSOR_ACCESS_TOKEN,
 * AI_GATEWAY_API_KEY). ARK_* is NOT built-in — the ark-plan provider stays
 * configured via sandbox-image/omp-models.yml (custom baseUrl provider).
 */
export const PROVIDERS: Record<string, ProviderInfo> = {
  anthropic: { envName: "ANTHROPIC_API_KEY", label: "Anthropic" },
  openai: { envName: "OPENAI_API_KEY", label: "OpenAI" },
  gemini: { envName: "GEMINI_API_KEY", label: "Google Gemini" },
  groq: { envName: "GROQ_API_KEY", label: "Groq" },
  cerebras: { envName: "CEREBRAS_API_KEY", label: "Cerebras" },
  xai: { envName: "XAI_API_KEY", label: "xAI" },
  openrouter: { envName: "OPENROUTER_API_KEY", label: "OpenRouter" },
  kilo: { envName: "KILO_API_KEY", label: "Kilo" },
  mistral: { envName: "MISTRAL_API_KEY", label: "Mistral" },
  zai: { envName: "ZAI_API_KEY", label: "Z.AI" },
  minimax: { envName: "MINIMAX_API_KEY", label: "MiniMax" },
  opencode: { envName: "OPENCODE_API_KEY", label: "OpenCode" },
  cursor: { envName: "CURSOR_ACCESS_TOKEN", label: "Cursor" },
  "ai-gateway": { envName: "AI_GATEWAY_API_KEY", label: "AI Gateway" },
};

/** Resolve the Worker env var name for a provider, or undefined if unknown. */
export function providerEnvName(name: string): string | undefined {
  return PROVIDERS[name]?.envName;
}

/** Render the provider → env-name table (aligned, one row per provider). */
export function listProviders(): string {
  const names = Object.keys(PROVIDERS);
  const nameWidth = Math.max(...names.map((name) => name.length));
  const envWidth = Math.max(...names.map((name) => PROVIDERS[name]!.envName.length));
  return names
    .map((name) => {
      const info = PROVIDERS[name]!;
      return `${name.padEnd(nameWidth)}  ${info.envName.padEnd(envWidth)}  ${info.label}`;
    })
    .join("\n");
}

/** Run `wrangler secret put <envName>` with the value piped on stdin. */
function runWranglerSecretPut(envName: string, value: string): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = spawn("wrangler", ["secret", "put", envName], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.on("error", (err) => {
    reject(new Error(`failed to spawn wrangler: ${err.message}`));
  });
  child.on("exit", (code, signal) => {
    if (code === 0) {
      resolve();
    } else {
      reject(
        new Error(`wrangler secret put ${envName} exited with code ${code ?? signal ?? "unknown"}`),
      );
    }
  });
  // The value flows on stdin only — never in argv, never in logs.
  child.stdin.write(value);
  child.stdin.end();
  return promise;
}

/** Prompt for a value with echo suppressed (interactive secret entry). */
function promptMasked(question: string): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  // Write-through stream that echoes ONLY the prompt, never typed characters
  // (readline writes the prompt and each echoed char through `output`).
  const mutedOutput = {
    write(chunk: unknown, ...rest: unknown[]) {
      if (String(chunk).includes(question)) {
        return process.stdout.write(String(chunk), ...(rest as [BufferEncoding?, ((err?: Error | null) => void)?]));
      }
      return true;
    },
  };
  const rl = createInterface({
    input: process.stdin,
    output: mutedOutput as unknown as NodeJS.WritableStream,
    terminal: true,
  });
  rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  });
  rl.on("error", reject);
  return promise;
}

/** Interactive numbered provider picker. */
function pickProvider(): Promise<string> {
  const { promise, resolve, reject } = Promise.withResolvers<string>();
  const names = Object.keys(PROVIDERS);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const table = names
    .map((name, index) => `  ${index + 1}. ${name} (${PROVIDERS[name]!.label})`)
    .join("\n");
  rl.question(`Select a provider:\n${table}\n> `, (answer) => {
    rl.close();
    const index = Number.parseInt(answer.trim(), 10) - 1;
    const name = names[index];
    if (!name) {
      reject(new Error(`invalid selection: ${answer.trim() || "(empty)"}`));
      return;
    }
    resolve(name);
  });
  rl.on("error", reject);
  return promise;
}

/** Read piped stdin (non-TTY) as the secret value; undefined when empty/TTY. */
async function readPipedStdin(): Promise<string | undefined> {
  if (process.stdin.isTTY) return undefined;
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  const value = Buffer.concat(chunks).toString("utf8").trim();
  return value === "" ? undefined : value;
}

/**
 * CLI entry. Returns the process exit code: 0 success, 1 error (unknown
 * provider, missing value, wrangler failure).
 */
export async function main(argv: string[]): Promise<number> {
  if (argv.includes("--list")) {
    console.log(listProviders());
    return 0;
  }

  const providerIndex = argv.indexOf("--provider");
  if (providerIndex === -1) {
    // Interactive: picker → masked value prompt → wrangler secret put.
    try {
      const name = await pickProvider();
      const info = PROVIDERS[name]!;
      const value = await promptMasked(`Paste the ${info.label} API key (${info.envName}): `);
      if (!value) {
        console.error(`provider-keys: empty value for ${name}`);
        return 1;
      }
      await runWranglerSecretPut(info.envName, value);
      console.log(`provider-keys: ${info.envName} set on the deployed Worker`);
      return 0;
    } catch (err) {
      console.error(`provider-keys: ${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  // Non-interactive (CI-friendly).
  const name = argv[providerIndex + 1];
  if (!name) {
    console.error("provider-keys: --provider requires a provider name (see --list)");
    return 1;
  }
  const envName = providerEnvName(name);
  if (!envName) {
    console.error(`provider-keys: unknown provider '${name}' (see --list)`);
    return 1;
  }

  const valueIndex = argv.indexOf("--value");
  const explicit = valueIndex !== -1 ? argv[valueIndex + 1] : undefined;
  let value = explicit && explicit !== "" ? explicit : process.env[envName];
  if (!value) {
    value = await readPipedStdin();
  }
  if (!value) {
    console.error(
      `provider-keys: no value for ${name} — pass --value, set the ${envName} env var, or pipe stdin`,
    );
    return 1;
  }

  try {
    await runWranglerSecretPut(envName, value);
    console.log(`provider-keys: ${envName} set on the deployed Worker`);
    return 0;
  } catch (err) {
    console.error(`provider-keys: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

// Auto-run only when executed directly (bun run keys / bun run scripts/provider-keys.ts).
if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
