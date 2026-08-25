/**
 * Live smoke evidence capture: run one real session, save the raw output to
 * a temp file, and report whether parseReviewOutput accepts it.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewSession } from "../src/review/session";
import { parseReviewOutput } from "../src/review/schema";

const diff = readFileSync(new URL("../tests/fixtures/sample-pr.diff", import.meta.url), "utf8");
const raw = await runReviewSession(diff);
const outPath = join(tmpdir(), "omp-review-live-raw.txt");
writeFileSync(outPath, raw);
const parsed = parseReviewOutput(raw);
console.log(`RAW_LENGTH=${raw.length}`);
console.log(`RAW_SAVED=${outPath}`);
console.log(`PARSE_OK=${parsed.ok}`);
if (parsed.ok) {
  console.log(`VERDICT=${parsed.output.verdict}`);
  console.log(`FINDINGS=${parsed.output.findings.length}`);
} else {
  console.log(`PARSE_ERROR=${parsed.error}`);
}
if (raw.trim().length === 0) {
  console.error("LIVE_SMOKE_FAILED: empty output");
  process.exit(1);
}
console.log("LIVE_SMOKE_OK");
