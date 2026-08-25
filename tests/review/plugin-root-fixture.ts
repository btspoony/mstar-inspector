/**
 * Test-only plugin-root fixture (plan 03 CI fix).
 *
 * Creates a minimal temp mstar-harness layout — a `skills/mstar-audit/SKILL.md`
 * marker mirroring the real plugin root just far enough for the session unit
 * tests — and injects it through $M0_HARNESS_PLUGIN_ROOT BEFORE
 * src/review/session.ts is evaluated (import this module first). This makes
 * the plugin-root assertions environment-independent: they never depend on the
 * machine-absolute default root existing (it does not on GitHub Actions
 * runners).
 *
 * The env var name must match `HARNESS_ROOT_ENV` in src/review/session.ts.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Must match `HARNESS_ROOT_ENV` in src/review/session.ts. */
const HARNESS_ROOT_ENV = "M0_HARNESS_PLUGIN_ROOT";

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

// Inject before src/review/session.ts evaluates M0_HARNESS_PLUGIN_ROOT.
process.env[HARNESS_ROOT_ENV] = PLUGIN_ROOT_FIXTURE;
