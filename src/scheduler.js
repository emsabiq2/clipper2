import cron from "node-cron";
import { config } from "./config.js";
import { runWorkflow } from "./workflow.js";

console.log(`Scheduler active. Cron: ${config.postCron}`);
console.log(`Timezone: ${config.timezone}`);
console.log(`Auto publish: ${config.autoPublish && !config.dryRun ? "ON" : "OFF / dry-run"}`);

const task = cron.schedule(config.postCron, async () => {
  console.log(`[${new Date().toISOString()}] Scheduled workflow started`);
  try {
    await runWorkflow({
      theme: config.defaultTheme,
      publish: true,
      scheduled: true
    });
    console.log(`[${new Date().toISOString()}] Scheduled workflow finished`);
  } catch (error) {
    console.error("Scheduled workflow failed:", error);
  }
}, {
  timezone: config.timezone
});

console.log(`Next run: ${task.getNextRun()?.toString() || "unknown"}`);
