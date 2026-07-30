import { chmod } from "node:fs/promises";

await Promise.all([
  chmod(new URL("../dist/cli-main.js", import.meta.url), 0o755),
  chmod(new URL("../dist/regrafter/cli-main.js", import.meta.url), 0o755),
  chmod(new URL("./regrafter-pi-with-path.mjs", import.meta.url), 0o755),
  chmod(new URL("./bin/regraft", import.meta.url), 0o755)
]);
