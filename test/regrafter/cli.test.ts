import { expect, it, vi } from "vitest";
import { runCli } from "../../src/regrafter/cli.js";

it("honors JSON output for parse-time errors", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  const errors = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  expect(await runCli(["start", "--unknown", "x", "--json"])).toBe(2);
  const value = JSON.parse(String(output.mock.calls[0]?.[0])) as { state: string };
  expect(value.state).toBe("failed");
  expect(errors).not.toHaveBeenCalled();
  output.mockRestore();
  errors.mockRestore();
});

it("prints help", async () => {
  const output = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  expect(await runCli(["--help"])).toBe(0);
  expect(String(output.mock.calls[0]?.[0])).toContain("regrafter start");
  expect(String(output.mock.calls[0]?.[0])).toContain("regrafter handoff prepare");
  output.mockRestore();
});
