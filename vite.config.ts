import path from "node:path";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const spaRoot = fileURLToPath(new URL("./src/spa", import.meta.url));

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: {
      "@": spaRoot,
    },
  },
  root: "src/spa",
  publicDir: false,
  base: "/",
  build: {
    outDir: "../../dist/spa",
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
