import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "apps/api", "scripts"],
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**", "apps/api/src/**"],
      exclude: ["**/*.test.ts", "**/generated/**", "**/index.ts"],
    },
  },
});
