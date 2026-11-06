# Test assertions must not pin dependency versions or file versions

**Category**: best-practices · **Tags**: testing, ci, dependabot, version-pins

## The rule

A test may assert a **structure**, a **set**, or a **behaviour**. It must never assert that a version number, a lockfile entry's value, or a document revision equals a specific literal.

Two concrete failures in this repo came from exactly that:

- **Lockfile drift allow-list** pinned `root` + `runner` version strings per package, so every Dependabot bump reddened CI. Dropping the version strings was not enough: the check still compared the exact **set of drifting names**, and an independent root re-resolve adds or removes names (`lucide-react`, the `@oh-my-pi/*` subtree) on a routine bump. It is gone. The contract worth asserting — the engine and the omp SDK resolve to the `packages/runner/package.json` pin in **both** lockfiles — stays in `tests/review/pin.test.ts`.
- **`DESIGN.md` version** was pinned with `expect(fm.version).toBe("0.3.5")`, so raising the design system to 0.4 broke the suite for a documentation change. The assertion is now structural — the version parses as a semver triple **and** the file's own change note names that same version — which still catches a version bumped without its note, while future bumps stay green.

A **set of names observed from a re-resolved dependency graph** is not an assertable set either: it changes on every bump that moves the graph. See § Evidence.

## What to assert instead

| Bad | Good |
| --- | --- |
| `expect(pkg.version).toBe("1.60.0")` | `expect(lockVersions(dep)).toEqual([pin, pin])` (the pin read from the manifest) |
| `expect(designVersion).toBe("0.3.5")` | `expect(version).toMatch(/^\d+\.\d+(?:\.\d+)?$/)` + the note contains `v${version}` |
| `expect(manifest.deps).toEqual({...})` | assert the property that matters (a package is present, a floor is honoured) |

Exactly-once pins are acceptable only for something the product itself freezes and must not drift — a storage key, a route path, a wire field name. A dependency's or a document's version is not that.

## Evidence

- The Dependabot PRs that broke on this: the allow-list moved from 45 exact-version rows to name-only, then still reddened when a devDependency bump added `lucide-react` and an SDK bump moved the whole `@oh-my-pi/*` subtree into the drift set. Name sets taken from a resolved graph inherit the graph's churn.
- The design-system case: `tests/spa/tokens.test.ts` pinned `0.3.5` and failed against `0.4` until plan 102's follow-up made it structural.
- The user's standing instruction across several PRs: CI must not follow version numbers; lock behaviour and sets, not literals.

## Check before adding an assertion

1. Will this test still pass after a routine dependency or doc bump that changes nothing else? If not, is that bump genuinely a defect?
2. If it fails, does the failure tell a reviewer which behaviour broke — product behaviour, or merely a number?
