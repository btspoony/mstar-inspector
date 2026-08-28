/**
 * Test-only plugin-root fixture (plan 03 CI fix).
 *
 * Creates a minimal temp mstar-harness layout — a `skills/mstar-audit/SKILL.md`
 * marker mirroring the real plugin root just far enough for the runtime unit
 * tests — and injects it through $HARNESS_PLUGIN_ROOT. resolveHarnessRoot()
 * reads the env lazily per call (import this module first anyway), so the
 * plugin-root assertions stay environment-independent: they never depend on
 * the machine-absolute default root existing (it does not on GitHub Actions
 * runners).
 *
 * The env var name must match `HARNESS_ROOT_ENV` in src/review/runtime-omp.ts.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Must match `HARNESS_ROOT_ENV` in src/review/runtime-omp.ts. */
const HARNESS_ROOT_ENV = "HARNESS_PLUGIN_ROOT";

/** Absolute path of the temp fixture plugin root. */
export const PLUGIN_ROOT_FIXTURE = mkdtempSync(join(tmpdir(), "mstar-harness-"));

// Mirror the real layout only as far as the assertions need: the session unit
// tests assert `skills/mstar-audit` exists on disk and that the SDK mock's
// loadSkillsFromDir result (mstar-audit) is what reaches the session options.
mkdirSync(join(PLUGIN_ROOT_FIXTURE, "skills", "mstar-audit"), { recursive: true });
writeFileSync(
  join(PLUGIN_ROOT_FIXTURE, "skills", "mstar-audit", "SKILL.md"),
  [
    "---",
    "name: mstar-audit",
    "---",
    "",
    "# mstar-audit",
    "",
    "Fixture marker for plugin-root unit tests.",
    "",
  ].join("\n"),
);

// Plan 07 Task 1: the pinned harness 3.5.0 plugin root ships
// `commands/amazing-pr-review.md`; the fixture mirrors it as a marker only
// (zero-copy of the real command body — plan 07 Global Constraints).
mkdirSync(join(PLUGIN_ROOT_FIXTURE, "commands"), { recursive: true });
writeFileSync(
  join(PLUGIN_ROOT_FIXTURE, "commands", "amazing-pr-review.md"),
  ["# amazing-pr-review", "", "Fixture marker for the pinned 3.5.0 command.", ""].join("\n"),
);

// Plan 09 Task 2: the deep parent path installs the deep seat roles
// (code-reviewer / fullstack-dev / frontend-dev — the Stage 2 domain seats
// of the harness three-stage flow) into the PR clone at .omp/agents/ so omp
// task discovery can spawn them — the fixture mirrors one-line markers only
// (zero copy of the real role definitions, plan 02 Global Constraints).
mkdirSync(join(PLUGIN_ROOT_FIXTURE, "agents"), { recursive: true });
writeFileSync(join(PLUGIN_ROOT_FIXTURE, "agents", "code-reviewer.md"), "# fixture agent: code-reviewer\n");
writeFileSync(join(PLUGIN_ROOT_FIXTURE, "agents", "frontend-dev.md"), "# fixture agent: frontend-dev\n");
writeFileSync(join(PLUGIN_ROOT_FIXTURE, "agents", "fullstack-dev.md"), "# fixture agent: fullstack-dev\n");

// Inject before src/review/session.ts evaluates HARNESS_PLUGIN_ROOT.
process.env[HARNESS_ROOT_ENV] = PLUGIN_ROOT_FIXTURE;
