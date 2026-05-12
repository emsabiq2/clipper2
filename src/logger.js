import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { ensureProjectDirs } from "./storage.js";

export async function appendLog(message, data = {}) {
  await ensureProjectDirs();
  const line = JSON.stringify({
    at: new Date().toISOString(),
    message,
    ...data
  });
  await fs.appendFile(path.join(config.logDir, "automation.log"), `${line}\n`, "utf8");
}

export function publicLogLine(message, data = {}) {
  return {
    at: new Date().toISOString(),
    message,
    ...data
  };
}
