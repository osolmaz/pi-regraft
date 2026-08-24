import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

import { parsePiAppManifest } from "@osolmaz/pi-factory";

it("bundles the report tool in the app tools allowlist", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const manifest = parsePiAppManifest(await readFile(join(root, "pi-factory.toml"), "utf8"));
  expect(manifest.tools).toContain("regrafter_report");
  expect(manifest.extensions?.some((entry) => entry.path.includes("report-extension"))).toBe(true);
});

it("requires clean authorized completion in the Regrafter prompt", async () => {
  const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  const prompt = await readFile(join(root, "regrafter", "system.md"), "utf8");
  expect(prompt).toContain("require a clean Git status");
  expect(prompt).toContain("overlay_pending");
  expect(prompt).toContain("never report `completed` with an uncommitted overlay");
  expect(prompt).toContain("Never suggest deleting a repository lease file manually");
});
