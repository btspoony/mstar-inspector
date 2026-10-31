/**
 * The primitive tier: the shadcn-derived controls, unchanged in behaviour
 * (Radix props, handlers, aria and keyboard paths) and re-faced onto the
 * semantic layer only — no palette step, no raw colour.
 *
 * Module internals: consumers reach these through `@design-system`, never by
 * path. `use-mobile.ts` stays out of this barrel because it is the sidebar's
 * private implementation detail, not a public face.
 */
export * from "./button";
export * from "./card";
export * from "./dialog";
export * from "./dropdown-menu";
export * from "./input";
export * from "./select";
export * from "./separator";
export * from "./sheet";
export * from "./sidebar";
export * from "./skeleton";
export * from "./table";
export * from "./tabs";
export * from "./toggle";
export * from "./toggle-group";
export * from "./tooltip";
