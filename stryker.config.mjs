export default {
  mutate: ["src/regrafter/reports.ts", "src/regrafter/lease.ts", "src/regrafter/runs.ts"],
  testRunner: "vitest",
  reporters: ["clear-text", "progress"],
  coverageAnalysis: "perTest",
  thresholds: { high: 80, low: 70, break: 70 }
};
