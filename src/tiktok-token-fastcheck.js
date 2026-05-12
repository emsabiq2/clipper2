import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { exchangeTikTokCode, queryTikTokCreatorInfo, refreshTikTokAccessToken } from "./tiktok.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function mask(value) {
  if (!value || !process.env.GITHUB_ACTIONS) return;
  console.log(`::add-mask::${value}`);
}

function updateEnvKey(raw, key, value) {
  const nextLine = `${key}=${value}`;
  return raw.match(new RegExp(`^${key}=`, "m"))
    ? raw.replace(new RegExp(`^${key}=.*$`, "m"), nextLine)
    : `${raw.replace(/\s*$/, "\n")}${nextLine}\n`;
}

function updateEnvFile(filePath, updates) {
  if (!fs.existsSync(filePath)) return false;
  const raw = fs.readFileSync(filePath, "utf8");
  let next = raw;
  for (const [key, value] of Object.entries(updates)) {
    if (value) next = updateEnvKey(next, key, value);
  }
  if (next !== raw) fs.writeFileSync(filePath, next, "utf8");
  return next !== raw;
}

function writeGitHubEnv({ refreshed }) {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) return;

  const lines = [
    "TIKTOK_ACCESS_TOKEN<<__TIKTOK_ACCESS_TOKEN__",
    config.tiktok.accessToken,
    "__TIKTOK_ACCESS_TOKEN__",
    "TIKTOK_REFRESH_TOKEN<<__TIKTOK_REFRESH_TOKEN__",
    config.tiktok.refreshToken,
    "__TIKTOK_REFRESH_TOKEN__",
    `TIKTOK_OPEN_ID=${config.tiktok.openId || ""}`,
    `TIKTOK_SCOPE=${config.tiktok.scope || ""}`,
    `TIKTOK_TOKEN_REFRESHED=${refreshed ? "true" : "false"}`
  ];
  fs.appendFileSync(githubEnv, lines.join("\n") + "\n", "utf8");
}

async function main() {
  let refreshed = false;
  const code = argValue("--code", "");

  if (code) {
    await exchangeTikTokCode({ code, redirectUri: argValue("--redirect-uri", config.tiktok.redirectUri) });
    refreshed = true;
  } else if (config.tiktok.refreshToken) {
    await refreshTikTokAccessToken();
    refreshed = true;
  } else if (!config.tiktok.accessToken) {
    throw new Error("TIKTOK_ACCESS_TOKEN atau TIKTOK_REFRESH_TOKEN wajib diisi.");
  }

  mask(config.tiktok.accessToken);
  mask(config.tiktok.refreshToken);

  let creator = null;
  if (config.tiktok.publishMode !== "inbox") {
    creator = await queryTikTokCreatorInfo();
  }

  if (args.has("--persist-local")) {
    updateEnvFile(path.join(rootDir, ".env"), {
      TIKTOK_ACCESS_TOKEN: config.tiktok.accessToken,
      TIKTOK_REFRESH_TOKEN: config.tiktok.refreshToken,
      TIKTOK_OPEN_ID: config.tiktok.openId,
      TIKTOK_SCOPE: config.tiktok.scope
    });
  }

  if (args.has("--github-env")) {
    writeGitHubEnv({ refreshed });
  }

  console.log(JSON.stringify({
    ok: true,
    refreshed,
    openId: config.tiktok.openId ? "configured" : "",
    scope: config.tiktok.scope || "",
    creatorUsername: creator?.creator_username || "",
    privacyLevelOptions: creator?.privacy_level_options || []
  }, null, 2));
}

main().catch((error) => {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    apiCode: error.apiCode || ""
  }, null, 2));
  process.exitCode = 1;
});
