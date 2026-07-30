import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import { agentReportSchema } from "./report-schema.js";

export default function reportExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "regrafter_report",
    label: "Regrafter report",
    description: "Record the terminal state of the current Regrafter step.",
    parameters: agentReportSchema,
    async execute(_toolCallId, report) {
      const safeReport = redact(report);
      const path = process.env["REGRAFTER_REPORT_FILE"];
      if (path !== undefined) await writeReport(path, safeReport);
      return {
        content: [{ type: "text", text: `Recorded Regrafter state: ${report.state}` }],
        details: safeReport,
        terminate: true
      };
    }
  });
}

async function writeReport(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid.toString()}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function redact(value: unknown): unknown {
  if (typeof value === "string") return value.replace(/(https?:\/\/)[^/@\s]+@/giu, "$1[redacted]@");
  if (Array.isArray(value)) return value.map(redact);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redact(item)]));
  }
  return value;
}
