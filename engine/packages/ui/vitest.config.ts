import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    include: ["test/**/*.test.ts", "test/**/*.test.tsx", "src/**/__tests__/**/*.test.ts", "src/**/__tests__/**/*.test.tsx"],
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    css: true,
  },
});
