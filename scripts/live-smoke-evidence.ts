/**
 * Live smoke evidence capture (plan 07): run one real review (quick tier,
 * single seat) through the omp AgentRuntime, save the mstar.review/v1
 * envelope to a temp file, and report whether validateMstarReviewV1 accepts
 * it. Requires HARNESS_PLUGIN_ROOT + a configured provider key + a PR clone
 * path to review.
 */
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateMstarReviewV1 } from "@mstar-harness/engine";
import { ompAgentRuntime, parseModelSelectors } from "../src/review/runtime-omp";

const worktreePath = process.argv[2] ?? process.cwd();
const envelope = await ompAgentRuntime.runReview({
  level: "quick",
  worktreePath,
  reconFacts: [],
  modelSelectors: parseModelSelectors(Bun.env.OMP_REVIEW_MODEL),
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
