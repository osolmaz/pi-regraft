import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      include: ["src/regrafter/**/*.ts"],
      exclude: [
        "src/regrafter/cli-main.ts",
        "src/regrafter/index.ts",
        "src/regrafter/report-extension.ts",
        "src/regrafter/types.ts"
      ],
      thresholds: { statements: 85, branches: 85, functions: 85, lines: 85 }
    }
  }
});
