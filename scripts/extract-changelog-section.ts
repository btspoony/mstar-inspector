#!/usr/bin/env bun
/**
 * extract-changelog-section.ts — print a version's changelog section body
 * (plan 50 D5). Feeds the bilingual GitHub Release notes.
 *
 * Usage:
 *   bun run scripts/extract-changelog-section.ts 1.0.0             # EN (CHANGELOG.md)
 *   bun run scripts/extract-changelog-section.ts 1.0.0 --lang cn   # CHANGELOG_CN.md
 *   RELEASE_VERSION=1.0.0 bun run scripts/extract-changelog-section.ts --lang en
 *
 * Output: the markdown body of the `## [X.Y.Z] - <date>` section, header
 * excluded (the release title already carries the version), written to
 * stdout without a trailing newline. Exits 1 when the version has no section
 * or the section is empty.
 */
import { join } from "node:path";
import { changelogPathFor } from "./release-surfaces";

export type ExtractOptions = {
  /** Bare version (X.Y.Z) — same form as the section header and archive dir. */
  version: string;
  lang: "en" | "cn";
  /** Base the changelog path resolves under. Default: process.cwd(). */
  root?: string;
};

/**
 * Extract the body of `## [<version>]` from changelog markdown: everything
 * after the full header line (the `- <date>` suffix is consumed, not leaked
 * into the body) up to the next `## [` section, trimmed. Throws when the
 * section is absent or empty.
 */
export function extractSection(changelog: string, version: string): string {
  const header = `## [${version}]`;
  const start = changelog.indexOf(header);
  if (start === -1) {
    throw new Error(`No CHANGELOG section found for ${header}`);
  }
  const lineEnd = changelog.indexOf("\n", start);
  const afterHeader = lineEnd === -1 ? "" : changelog.slice(lineEnd + 1);
  const nextSection = afterHeader.search(/\n## \[/);
  const body = (nextSection === -1 ? afterHeader : afterHeader.slice(0, nextSection)).trim();
  if (!body) {
    throw new Error(`CHANGELOG section for ${version} is empty`);
  }
  return body;
}

/** Read the right changelog for `lang` and extract the version section. */
export async function extractFromFile(opts: ExtractOptions): Promise<string> {
  const path = join(opts.root ?? process.cwd(), changelogPathFor(opts.lang));
  const changelog = await Bun.file(path).text();
  return extractSection(changelog, opts.version);
}

export function parseArgs(argv: string[]): { version?: string; lang: "en" | "cn"; help: boolean } {
  const rest = argv.slice(2).filter((a) => a !== "--");
  let version: string | undefined;
  let lang: "en" | "cn" = "en";
  let help = false;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i] ?? "";
    if (a === "--help" || a === "-h") help = true;
    else if (a === "--lang" || a.startsWith("--lang=")) {
      const value = a === "--lang" ? rest[++i] : a.slice("--lang=".length);
      if (value !== "en" && value !== "cn") {
        throw new Error(`Unknown --lang value: ${value ?? "<none>"} (expected en|cn)`);
      }
      lang = value;
    } else if (/^\d+\.\d+\.\d+/.test(a)) version = a;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { version, lang, help };
}

function printUsage(): void {
  console.log(`Usage:
  bun run scripts/extract-changelog-section.ts <version> [--lang en|cn]
  RELEASE_VERSION=<version> bun run scripts/extract-changelog-section.ts --lang cn`);
}

// Run only when executed directly — importing the module (unit tests) must
// not read the real checkout's changelogs.
if (import.meta.main) {
  let parsed;
  try {
    parsed = parseArgs(process.argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
  if (parsed.help) {
    printUsage();
  } else {
    const version = parsed.version ?? process.env.RELEASE_VERSION;
    if (!version) {
      console.error("Usage: bun run scripts/extract-changelog-section.ts <version>");
      process.exit(1);
    }
    extractFromFile({ version, lang: parsed.lang })
      .then((body) => process.stdout.write(body))
      .catch((err) => {
        console.error(err instanceof Error ? err.message : err);
        process.exit(1);
      });
  }
}
