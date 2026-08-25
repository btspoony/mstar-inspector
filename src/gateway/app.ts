/**
 * Gateway app factory — registers webhook handlers on a Probot instance.
 *
 * Contract (plan 01 Module contracts):
 * - `createGatewayApp(options?)` returns `(app: Probot) => void`
 * - It does NOT `listen()`, does NOT `process.exit`, and does not bind a port.
 * - M0: handlers only log structured events; they do NOT fetch diffs or start reviews.
 *
 * Workers-compatible: this module only registers callbacks on the Probot
 * instance passed in; it performs no I/O and imports no Node-only APIs.
 * The `Probot` reference below is a type-only import (erased at runtime).
 */

import type { Probot } from "probot";

export type GatewayEventLog = {
  event: "pull_request" | "issue_comment";
  action: string;
  installation_id: number | null;
  owner: string;
  repo: string;
  pr_number: number | null;
  head_sha: string | null;
};

export type GatewayLog = {
  info: (fields: GatewayEventLog, msg?: string) => void;
};

export type GatewayAppOptions = {
  log?: GatewayLog;
};

export function createGatewayApp(options?: GatewayAppOptions): (app: Probot) => void {
  const log: GatewayLog = options?.log ?? {
    info: (fields, msg) => {
      // Default sink: structured JSON line on stdout. No secrets are logged.
      console.log(JSON.stringify({ ...fields, msg: msg ?? "" }));
    },
  };

  return (app: Probot) => {
    // M0: handlers are registered here by later tasks (Task 2). The factory
    // must remain constructible and side-effect free (no listen, no I/O).
    void app;
    void log;
  };
}
