import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

const target = process.env.CONSOLE2_TARGET ?? "http://127.0.0.1:3012";

export default defineConfig(({ command }) => ({
  // Built output uses relative URLs so it works under any reverse-proxy prefix. The dev server serves at /console2/ so
  // the same relative API URLs resolve exactly as in production.
  base: command === "serve" ? "/console2/" : "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "@api": fileURLToPath(new URL("../../src/console2", import.meta.url)),
    },
  },
  server: {
    // In dev the app is served at /console2/ so relative API URLs resolve exactly as in production.
    proxy: { "/console2/api": { target, changeOrigin: false } },
  },
  build: { outDir: "dist", emptyOutDir: true, sourcemap: false },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
}));
