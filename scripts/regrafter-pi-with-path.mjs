#!/usr/bin/env node
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import spawn from "cross-spawn";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const commandBins = join(packageRoot, "scripts", "bin");
const dependencyBins = join(packageRoot, "node_modules", ".bin");
const child = spawn(
  "npx",
  ["-y", "@earendil-works/pi-coding-agent@0.83.0", ...process.argv.slice(2)],
  {
    shell: false,
    stdio: "inherit",
    env: {
      ...process.env,
      PATH: [commandBins, dependencyBins, process.env.PATH ?? ""].join(delimiter)
    }
  }
);

const forward = (signal) => {
  child.kill(signal);
};
const interrupt = () => {
  forward("SIGINT");
};
const terminate = () => {
  forward("SIGTERM");
};
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
child.on("error", (error) => {
  process.stderr.write(`regrafter: failed to launch Pi: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code, signal) => {
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", terminate);
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 1;
});
