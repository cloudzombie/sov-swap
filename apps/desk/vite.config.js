import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The @sov/sdk + noble libs are browser-safe; we only polyfill Buffer (used by base
// encoders) via an alias so the bundle stays lean.
export default defineConfig({
  plugins: [react()],
  resolve: { alias: { buffer: "buffer/" } },
  define: { global: "globalThis" },
  server: { port: 5178 },
});
