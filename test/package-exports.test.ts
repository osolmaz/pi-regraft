import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(
  readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")
) as { exports?: Record<string, unknown> };

describe("package exports", () => {
  it("exposes the source extension for Git consumers", () => {
    expect(manifest.exports?.["./extension-source"]).toBe("./src/extension.ts");
  });
});
