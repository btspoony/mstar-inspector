import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  root: "src/spa",
  publicDir: false,
  base: "/",
  build: {
    outDir: "../../dist/spa",
    emptyOutDir: true,
    assetsDir: "assets",
  },
});
