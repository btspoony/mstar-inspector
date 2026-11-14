---
module: dashboard / SPA shell accessibility
date: 2026-11-14
last_updated: 2026-11-14
problem_type: best_practice
category: best-practices
severity: high
topic: shell accessibility & document metadata
tags: [a11y, wcag, lang, document-title, landmark, skip-link, focus, strictmode, spa]
related_components: [src/worker/document-locale.ts, src/spa/document-title.ts, src/spa/Layout.tsx, src/spa/components/AppSidebar.tsx, src/worker/spa-dispatch.ts, src/admin/index.ts]
applies_when:
  - serving a locale-dependent SPA shell from a Worker
  - adding or auditing landmarks, skip links, or focus management in the dashboard shell
  - a page is rendered by an early return instead of the route's own page
---

# The SPA shell's accessibility lives in five places a component test never looks

## The trap

A React SPA that looks accessible in the component tree can still fail the four
things an assistive-technology user depends on, because all four are facts about
the **document**, not about a component:

1. **`<html lang>` and `<title>` come from the HTML template**, which is static.
   A `zh_CN` reader got Chinese copy inside `<html lang="en">` with one static
   title for every page. The admin console had substituted both server-side for
   months; the workspace shell never did — the boot script was injected and
   nothing else.
2. **`aria-label` on a generic `<div>` names nothing.** The sidebar primitive's
   `collapsible="none"` branch renders a div, so the label the shell passed it
   was ignored and no `navigation` landmark existed.
3. **A skip link's target is a design decision, not "the nearest `<main>`".**
   The shell's `<main>` contains the toolbar (workspace switcher, theme, locale,
   logout), so `href="#main"` skipped the sidebar and then still made a keyboard
   user tab through five chrome controls.
4. **Client-side navigation updates content only.** The title and the focused
   element both stayed where the previous page left them, so neither a sighted
   keyboard user nor a screen reader was told the page had changed.

## The rules

**Document metadata is substituted server-side, once, by a shared function.**
`localizeDocument(html, locale, title)` takes the title as a parameter because
the two documents name themselves differently (console: one fixed string;
shell: the page being served). It throws on a missing anchor — a silent no-op
ships an English document to a `zh_CN` reader — and the test helper serves the
**real** template, so drift fails in CI rather than at a reader.

**One page-label map, imported by both faces.** `pageDocumentTitle` is shared by
the Worker (which writes the served document) and the client router effect;
two maps would eventually disagree. It also resolves the **rendered face**, in
the same order `pages.tsx` early-returns: a support-grant operator is served at
`<ref>/apps` while seeing the support page, and a workspace-less sign-in sees the
setup page. The title follows what is on screen, never the path.

**Landmarks are elements or roles, never labels on generic divs.**
`AppSidebar` passes `role="navigation"` down to the primitive, and the label then
names a real region.

**The skip target is the content column; the navigation-focus target is the
region.** `<main id="main">` stays the focus target for client navigations;
`#content` (the content column inside it) is what the skip link points at. Two
ids, two jobs, and the test asserts `#content` is inside `#main` so a future
restructure cannot quietly separate them.

**Both programmatic focus targets show a `focus-visible` ring.** `outline-none`
plus `tabIndex={-1}` plus `.focus()` moves focus invisibly; a sighted keyboard
user gets no feedback. Ring on `focus-visible`, not `focus`, so mouse users never
see it.

**A "first paint" guard is a pathname comparison, not a one-shot ref.**
React 19's `StrictMode` re-runs a mount effect setup→cleanup→setup with refs
intact, so `const first = useRef(true)` announces (and steals focus) on the first
paint in development — the one environment a UI is verified by hand. Compare the
pathname the effect last announced instead; a same-pathname run is exactly the
first paint. Pin it with a test that mounts under `StrictMode`.

## Verification surface

The DOM contract is testable and is what to assert: landmark count and accessible
name, skip-link DOM order and `href`, target `id`/`tabindex` and containment,
`document.title` and `document.activeElement` before and after a navigation,
`tabIndex`/`role` attributes, and the served document's `<html lang>` and
`<title>` through the real Worker route against the real template. A real screen
reader is not part of this gate — say so instead of implying it was tested.

## Residuals accepted at introduction

- One constant label for the App detail page: two Apps share a title. Distinguishing
  them would need the App's name at document time; the id must not leak into a title.
- The shell document now enters the substitution's throw path, so an `index.html`
  anchor drift turns every HTML navigation into a 500. That is deliberate: the
  template is bound by the test helper, so drift is caught before merge.
