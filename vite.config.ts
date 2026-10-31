import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const spaRoot = fileURLToPath(new URL("./src/spa", import.meta.url));
const designSystemRoot = fileURLToPath(new URL("./src/design-system", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": spaRoot,
      // Single door into the design system: the module's own index.ts. The
      // boundary test rejects any other specifier shape.
      "@design-system": designSystemRoot,
    },
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
