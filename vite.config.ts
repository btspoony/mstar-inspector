import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const spaRoot = fileURLToPath(new URL("./src/spa", import.meta.url));
/** The module's single public entry; the alias resolves to this file, not the directory. */
const designSystemPath = fileURLToPath(new URL("./src/design-system/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: [
      // Single door into the design system: the module's own index.ts. A
      // regex anchored to the bare specifier, not the usual object form — an
      // object key `@design-system` matches `@design-system/tokens` too, so a
      // deep import that fails typecheck would still resolve in the dev server
      // and the build. With the anchor it falls through to real resolution and
      // fails, which is what the boundary test asserts statically.
      { find: /^@design-system$/, replacement: designSystemPath },
      { find: /^@\//, replacement: `${spaRoot}/` },
    ],
  },
  root: "src/spa",
  publicDir: false,
  base: "/",
  build: {
    outDir: "../../dist/spa",
    emptyOutDir: true,
    assetsDir: "assets",
    rollupOptions: {
      // Two documents, one hashed `/assets` bucket (`base` stays "/"): the
      // workspace shell and the hidden admin console. The console document is
      // answered only by the gated admin sub-app (`src/admin/index.ts`).
      input: {
        main: path.resolve(spaRoot, "index.html"),
        admin: path.resolve(spaRoot, "admin.html"),
      },
    },
  },
});
