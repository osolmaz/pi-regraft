import { chmod } from "node:fs/promises";

await chmod(new URL("../dist/cli-main.js", import.meta.url), 0o755);
