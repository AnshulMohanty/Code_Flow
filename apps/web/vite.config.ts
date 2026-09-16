import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const DEFAULT_WEB_PORT = 5173;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT || DEFAULT_WEB_PORT),
  },
  build: {
    /**
     * Raised past the demo snapshot's chunk (~870 kB raw, ~107 kB gzipped).
     *
     * The warning is correct that the chunk is large and WRONG about what to do with it — its advice
     * is "use dynamic import to code-split", which is exactly what already produced this chunk. The
     * snapshot is a lazily-loaded JSON payload, deliberately kept out of the 220 kB entry bundle; it
     * is fetched only by visitors who open the demo.
     *
     * Raised rather than ignored on the same principle this codebase applies to log levels: a
     * warning that fires on every build and will never be actioned teaches people to skim past
     * warnings, and the next one will be real. The limit still guards the ENTRY bundle, which is the
     * number that matters for first paint.
     */
    chunkSizeWarningLimit: 1000,
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
