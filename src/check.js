import { ensureProjectDirs } from "./storage.js";
import { assertPreflightOk, printPreflightReport, runPreflight } from "./preflight.js";

await ensureProjectDirs();

const report = await runPreflight({ online: !process.argv.includes("--offline") });
printPreflightReport(report);

try {
  assertPreflightOk(report);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
