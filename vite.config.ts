import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Builds the single-page app into dist/client, which the Worker serves as
// static assets after its session check (see wrangler.jsonc).
export default defineConfig({
  plugins: [react()],
  publicDir: "static",
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
    sourcemap: false,
  },
});
