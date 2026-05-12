import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const clipperEnv = path.resolve(__dirname, "..", ".env");

if (fs.existsSync(clipperEnv)) {
  for (const line of fs.readFileSync(clipperEnv, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const [rawKey, ...rest] = trimmed.split("=");
    process.env[rawKey.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
}

await import("../../src/instagram-token-fastcheck.js");
