import { execFileSync, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..");
const packed = JSON.parse(
  execFileSync("npm", ["pack", "--ignore-scripts", "--json"], { cwd: root, encoding: "utf8" })
);
const filename = packed[0]?.filename;
if (typeof filename !== "string") throw new Error("npm pack did not return a filename");
const tarball = join(root, filename);
const project = await mkdtemp(join(tmpdir(), "pi-regraft-package-"));
try {
  execFileSync("npm", ["init", "-y"], { cwd: project, stdio: "ignore" });
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: project,
    stdio: "ignore"
  });

  const bins = join(project, "node_modules", ".bin");
  execFileSync(join(bins, "regraft"), ["--help"], { cwd: project, stdio: "ignore" });
  execFileSync(join(bins, "regrafter"), ["--help"], { cwd: project, stdio: "ignore" });
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      "import('pi-regraft/regrafter').then(m=>{if(typeof m.startRun!=='function')process.exit(1)})"
    ],
    { cwd: project, stdio: "ignore" }
  );

  const packageRoot = join(project, "node_modules", "pi-regraft");
  const manifestPath = join(packageRoot, "pi-factory.toml");
  execFileSync(join(bins, "pi-factory"), ["validate", manifestPath], {
    cwd: project,
    stdio: "ignore"
  });
  const plan = JSON.parse(
    execFileSync(join(bins, "pi-factory"), ["plan", "--app-file", manifestPath, "--cwd", project], {
      cwd: project,
      encoding: "utf8"
    })
  );
  if (plan.appRoot !== packageRoot || plan.launch?.cwd !== project) {
    throw new Error("packed Pi Factory app did not separate its app root and target directory");
  }
  await access(join(packageRoot, "scripts", "regrafter-pi-with-path.mjs"), constants.X_OK);
  const bundledRegraft = join(packageRoot, "scripts", "bin", "regraft");
  await access(bundledRegraft, constants.X_OK);
  const regraftUsage = spawnSync(bundledRegraft, [], { cwd: project, encoding: "utf8" });
  if (regraftUsage.status !== 2 || !regraftUsage.stderr.includes("regraft - update vendored")) {
    throw new Error("packed Regraft command wrapper did not return usage");
  }

  const manifest = await readFile(manifestPath, "utf8");
  if (!manifest.includes("./dist/regrafter/report-extension.js")) {
    throw new Error("packed manifest has no compiled report extension");
  }
  const reportPath = join(project, "report.json");
  const extensionUrl = pathToFileURL(
    join(packageRoot, "dist", "regrafter", "report-extension.js")
  ).href;
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import extension from ${JSON.stringify(extensionUrl)}; let tool; extension({registerTool(value){tool=value}}); const result=await tool.execute("call",{schema_version:1,state:"completed",summary:"https://user:secret@example.com/repo",commits:[],checks:[],updated_grafts:[],next:"None"}); if(result.terminate!==true||JSON.stringify(result.details).includes("user:secret"))process.exit(1);`
    ],
    { cwd: project, stdio: "ignore", env: { ...process.env, REGRAFTER_REPORT_FILE: reportPath } }
  );
  const report = await readFile(reportPath, "utf8");
  if (report.includes("user:secret") || !report.includes("[redacted]@example.com")) {
    throw new Error("packed report extension did not redact a credential-bearing URL");
  }
} finally {
  await rm(tarball, { force: true });
  await rm(project, { recursive: true, force: true });
}
