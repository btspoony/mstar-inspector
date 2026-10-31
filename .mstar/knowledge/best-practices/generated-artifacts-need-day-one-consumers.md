# A generated design system needs a day-one consumer for every artifact

## Problem

The first attempt at a design system here was a hand-written `DESIGN.md`
(1326 lines) beside a hand-written `tokens.css` (351 custom properties, ~60
consumed). Nothing compared them. They drifted, a validator that only read
`DESIGN.md` frontmatter could not see it, and the document ended up describing
components that did not render and omitting ones that did.

The rebuild added a chain — `baseline → tokens → fixture → DESIGN.md` — and two
of its artifacts had no reader on day one:

- **`fixture.json`** looked like it should feed `mstar design-md validate`, but
  that command reads `DESIGN.md` frontmatter and (optionally) `DESIGN.dark.md`
  parity. Nothing else. A fixture with no reader is a file, not a baseline.
- **The preview page** was generated and `--check`ed, but no build step invoked
  it, so the deliverable never materialised even though its check was green.

Both were caught in review. The fixes were cheap and specific: the fixture earned
its place as the comparator between source and document, and `build:spa` was made
to run the preview generator.

## Rule

**Before generating an artifact, name the thing that reads it and the moment it
reads it.** Three links close, and a chain is only live when all three are closed:

1. the artifact exists and is tracked,
2. every comparator points at it and defaults to strict mode,
3. a CI job or a build step actually calls those comparators.

An artifact with links 1 and 2 but not 3 is documentation. Link 2 without a real
reader is decoration.

## Corollaries

- **A baseline outside the repository is not a baseline.** The approved design
  reference lived in a gitignored `.mstar/` prototype directory. It had to be
  copied into the tree before anything could converge onto it.
- **One-directional sync.** The source is the only hand-editable input; CSS,
  fixture and document are generated. Editing a generated artifact, or editing
  the document and back-filling the fixture, is a defect regardless of which side
  turns out to be right.
- **A live list beats a fixed count.** The transitional palette set was first
  written as a number ("26 survivors plus 2 transitional"). It was wrong — twelve
  more steps still had consumers in later plans. A membership rule ("a step stays
  declared only while something outside the module reads it, and leaves in the
  commit that migrates that last consumer") survived four plan boundaries without
  another correction.
- **Make the generator the template.** A preview page with a hand-maintained
  template drifts from the source exactly like the document did. Emitting every
  specimen from data means a new token cannot be silently unrepresented — and the
  check that proves it is the specimen-family rule, not the entry count, because
  a derived entry list can never fail for a missing token.
