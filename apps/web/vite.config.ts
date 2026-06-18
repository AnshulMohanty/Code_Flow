import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const DEFAULT_WEB_PORT = 5173;

export default defineConfig({
  plugins: [react()],
  server: {
    port: Number(process.env.WEB_PORT || DEFAULT_WEB_PORT),
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
  },
});
