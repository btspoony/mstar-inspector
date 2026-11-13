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
import { writePerReviewModelsYaml } from "../packages/runner/src/models-synthesis";
import { createInMemoryAuthStorage } from "../packages/runner/src/runner";
import { ompAgentRuntime, parseModelSelectors } from "../packages/runner/src/runtime-omp";

const worktreePath = process.argv[2] ?? process.cwd();
// The smoke runs an App's own selector: the provider comes from the selector
// prefix and its key from the conventional `<PROVIDER>_API_KEY` env var. The
// per-review models.yml carries no image-declared provider — a built-in one
// resolves from the SDK's catalog, a custom one would be declared here.
const modelSelectors = parseModelSelectors(Bun.env.OMP_REVIEW_MODEL);
const provider = modelSelectors[0]?.split("/")[0]?.trim() ?? "";
const keyEnvName = `${provider.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_API_KEY`;
const providerKey = Bun.env[keyEnvName];
if (provider === "" || providerKey === undefined || providerKey.trim() === "") {
  console.error(`live-smoke-evidence: set OMP_REVIEW_MODEL (e.g. openai/gpt-5) and ${keyEnvName || "<PROVIDER>_API_KEY"}`);
  process.exit(2);
}
const agentDir = await writePerReviewModelsYaml([]);
const authStorage = await createInMemoryAuthStorage();
try {
  // An explicit `login` row — never an implicit lookup: an EMPTY store fails
  // loud here rather than letting the SDK discover a credential file.
  await authStorage.credentials.set(provider, [
    { type: "api_key" as const, key: providerKey, source: "login" as const },
  ]);
  // runReview resolves { envelope, recheck } — the smoke captures
  // the envelope only (the optional recheck document rides its own file).
  const { envelope } = await ompAgentRuntime.runReview({
    level: "quick",
    worktreePath,
    reconFacts: [],
    modelSelectors,
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
