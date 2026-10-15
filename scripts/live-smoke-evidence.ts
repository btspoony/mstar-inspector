/**
 * Live smoke evidence capture: run one real review (quick tier,
 * single seat) through the omp AgentRuntime, save the mstar.review/v1
 * envelope to a temp file, and report whether validateMstarReviewV1 accepts
 * it. Requires HARNESS_PLUGIN_ROOT + a configured provider key + a PR clone
 * path to review.
 *
 * This is a runtime entry point like the container runner, so it owns the
 * SAME per-run shape: a synthesized per-review models.yml directory and the
 * shared IN-MEMORY credential store (`createInMemoryAuthStorage` — the one
 * definition; passing anything else lets the SDK fall back to
 * `discoverAuthStorage(agentDir)` and recreate the on-disk credential
 * database this seam exists to remove).
 */
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMstarReviewV1 } from "@mstar-harness/engine";
import { getSandboxImage } from "../src/contracts/sandbox-images";
import { writePerReviewModelsYaml } from "../src/review/models-synthesis";
import { createInMemoryAuthStorage } from "../src/review/runner";
import { ompAgentRuntime, parseModelSelectors } from "../src/review/runtime-omp";

const worktreePath = process.argv[2] ?? process.cwd();
const hosts = getSandboxImage("omp")?.hosts ?? [];
// The operator's key is read from the capability host's env var and stored as
// an explicit `login` row under the models.yml provider id — the same shape the
// runner's transported pool takes. Never an implicit lookup: an EMPTY store
// fails loud here rather than letting the SDK discover a credential file.
const keys = hosts.flatMap((host) => {
  const key = Bun.env[host.apiKeyEnv];
  return key ? [{ host, key }] : [];
});
if (keys.length === 0) {
  console.error(
    `live-smoke-evidence: no provider key set (expected ${hosts.map((h) => h.apiKeyEnv).join(", ")})`,
  );
  process.exit(2);
}
const agentDir = await writePerReviewModelsYaml(hosts);
const authStorage = await createInMemoryAuthStorage();
try {
  for (const { host, key } of keys) {
    await authStorage.set(host.id, [{ type: "api_key" as const, key, source: "login" as const }]);
  }
  // runReview resolves { envelope, recheck } — the smoke captures
  // the envelope only (the optional recheck document rides its own file).
  const { envelope } = await ompAgentRuntime.runReview({
    level: "quick",
    worktreePath,
    reconFacts: [],
    modelSelectors: parseModelSelectors(Bun.env.OMP_REVIEW_MODEL),
    agentDir,
    authStorage,
  });
  const outPath = join(tmpdir(), "omp-review-live-envelope.json");
  writeFileSync(outPath, JSON.stringify(envelope, null, 2));
  const gate = validateMstarReviewV1(envelope);
  console.log(`WORKTREE=${worktreePath}`);
  console.log(`ENVELOPE_SAVED=${outPath}`);
  console.log(`VALIDATE_OK=${gate.ok}`);
  console.log(`VERDICT=${envelope.verdict}`);
  console.log(`FINDINGS=${envelope.findings.length}`);
  for (const violation of gate.violations) {
    console.log(`VIOLATION=${violation.code}: ${violation.message}`);
  }
  if (!gate.ok) {
    process.exitCode = 1;
  }
} finally {
  authStorage.close();
  rmSync(agentDir, { recursive: true, force: true });
}
