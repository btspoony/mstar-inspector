---
title: SPA test DOM install: warm is not install
type: best-practice
status: active
last_updated: 2026-10-26
tags: [testing, spa, happy-dom, react]
---

# SPA test DOM install: warm is not install

React decides `canUseDOM` **once, at module evaluation**. Two consequences that are easy to
confuse:

- A preload that installs globals, imports the DOM-latching modules and then removes the
  globals does **not** install a DOM. It **warms** the module graph so a later static import
  finds `canUseDOM === true`. Tests still need their own DOM before they mount anything.
- A test file that imports `react-dom/client` at module scope *before* any DOM exists latches
  `canUseDOM === false` for the whole process if it evaluates first. This is why the old
  convention was "install, then `await import()`" — and why that convention made every file's
  correctness depend on runner order.

## The shape that removes the ordering dependency

- One preload (`warmDom()`) installs a throwaway window, dynamically imports the latching
  modules (a static import would hoist above the install and latch false), then cleans up.
- One helper (`installDom()`) is the only place that installs test globals; every file calls
  it and imports React statically.
- The helper's teardown **restores each name's previous property descriptor** instead of
  deleting it. Deleting silently removes globals the runner or another test owned (`navigator`,
  a `location` stub, `IS_REACT_ACT_ENVIRONMENT`).

## How to prove it

A control file that imports `react-dom/client` at module scope and mounts nothing until a test
body may pass for the wrong reason. Pin the real latch: drive a controlled input through a
mounted component and assert the change handler fired. Remove the warm step → the handler
never fires. Run the suite in two different file orders; both must pass, and so must the SSR
suites that never install a DOM at all.
