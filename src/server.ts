/**
 * Gateway process entry — starts the Probot HTTP server and mounts GET /healthz.
 *
 * This file is the local process entry (plan: "入口 src/server.ts 除外"); it is
 * the only place allowed to bind a port. `createGatewayApp` itself never listens.
 *
 * Env: APP_ID, PRIVATE_KEY, WEBHOOK_SECRET (required for webhook handling),
 * PORT (default 3000), HOST (default 127.0.0.1), WEBHOOK_PATH (optional).
 */

import { Probot, Server } from "probot";
import { createGatewayApp } from "./gateway/app";

const DEFAULT_PORT = 3000;
const DEFAULT_HOST = "127.0.0.1";

/**
 * Fail-closed guard for the webhook secret (plan fix round 1, QC F-A):
 * Probot falls back to the public default HMAC secret "development" when
 * `secret` is falsy — reject both the empty case and the default itself so
 * the M1 live path can never run with a publicly-known webhook secret.
 */
export function validateWebhookSecret(secret: string): void {
  if (!secret) {
    throw new Error("WEBHOOK_SECRET environment variable is required (see .env.example)");
  }
  if (secret === "development") {
    throw new Error('WEBHOOK_SECRET must not be the Probot default "development" — set a real webhook secret');
  }
}

function readEnv(): { appId: number; privateKey: string; secret: string; port: number; host: string; webhookPath?: string } {
  const appId = Number(process.env.APP_ID);
  const privateKey = process.env.PRIVATE_KEY ?? "";
  const secret = process.env.WEBHOOK_SECRET ?? "";
  const port = Number(process.env.PORT) || DEFAULT_PORT;
  const host = process.env.HOST || DEFAULT_HOST;
  const webhookPath = process.env.WEBHOOK_PATH || undefined;

  if (!appId || !privateKey) {
    throw new Error("APP_ID and PRIVATE_KEY environment variables are required (see .env.example)");
  }
  validateWebhookSecret(secret);

  return { appId, privateKey, secret, port, host, webhookPath };
}

/** GET /healthz → 200 {"ok":true}. Returns true when the request was handled. */
function healthzHandler(req: { method?: string; url?: string }, res: {
  writeHead: (status: number, headers?: Record<string, string>) => unknown;
  end: (body?: string) => unknown;
}): boolean {
  if (req.method !== "GET") return false;
  const path = (req.url ?? "").split("?")[0] ?? "";
  if (path !== "/healthz") return false;
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true }));
  return true;
}

async function main(): Promise<void> {
  const { appId, privateKey, secret, port, host, webhookPath } = readEnv();

  const server = new Server({
    port,
    host,
    webhookPath,
    Probot: Probot.defaults({ appId, privateKey, secret }),
  });

  // Mount healthz before the app function; addHandler runs after the webhook
  // middleware and before the 404 handler.
  server.addHandler(healthzHandler);

  await server.load(createGatewayApp());
  await server.start();

  const stop = async (signal: string): Promise<void> => {
    console.log(`Received ${signal}, shutting down`);
    await server.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGTERM", () => void stop("SIGTERM"));
}

// Only auto-start when run as the entry point (`bun run src/server.ts`);
// importing this module from tests must not bind a port or exit the process.
if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error("Failed to start gateway:", error);
    process.exit(1);
  });
}
