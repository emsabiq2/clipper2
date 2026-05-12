import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config, canPublish, shouldUploadToRemote } from "./config.js";
import { ensureFreshInstagramToken } from "./instagram-token.js";
import { ensureFreshFacebookToken } from "./facebook-token.js";
import { withRemoteClient } from "./uploader.js";
import { getYoutubeAccessToken } from "./youtube-publisher.js";
import { queryTikTokCreatorInfo } from "./tiktok.js";
import { ensureFreshThreadsToken } from "./threads-token.js";

function checkResult(name, ok, detail = "", required = true) {
  return { name, ok, detail, required };
}

async function commandOk(command, args) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { windowsHide: true });
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  });
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function missingEnv(names) {
  return names.filter((name) => !String(process.env[name] || "").trim());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

async function fetchJson(url, options = {}, timeoutMs = config.apiCheckTimeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    let data = null;
    try {
      data = await response.json();
    } catch {
      data = null;
    }

    if (!response.ok) {
      const message = data?.error?.message || data?.message || response.statusText;
      throw new Error(`${response.status} ${message}`.trim());
    }
    return data;
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`timeout ${Math.round(timeoutMs / 1000)}s`);
    }
    if (error.cause?.code) {
      throw new Error(`${error.message} (${error.cause.code})`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithRetries(url, options = {}, retries = 3) {
  let lastError = null;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await fetchJson(url, options);
    } catch (error) {
      lastError = error;
      if (attempt < retries) await sleep(1200 * attempt);
    }
  }
  throw lastError;
}

async function localChecks() {
  const clipperScript = path.join(config.clipper.rootDir, "scripts", "clipper.py");
  const checks = await Promise.all([
    commandOk("ffmpeg", ["-version"]).then((ok) => checkResult("ffmpeg", ok)),
    commandOk("yt-dlp", ["--version"]).then((ok) => checkResult("yt-dlp", ok)),
    commandOk(config.clipper.pythonCommand, ["--version"]).then((ok) => checkResult(config.clipper.pythonCommand, ok)),
    commandOk(config.clipper.pythonCommand, ["-c", "import PIL"]).then((ok) => checkResult("Pillow", ok)),
    exists(clipperScript).then((ok) => checkResult("clipper/scripts/clipper.py", ok)),
    exists(path.join(config.dataDir, "themes.json")).then((ok) => checkResult("data/themes.json", ok)),
    exists(path.join(config.dataDir, "videos.json")).then((ok) => checkResult("data/videos.json", ok))
  ]);
  checks.push(
    await exists(config.videoEffects.frameAssetPath).then((ok) => checkResult("Video frame asset", ok, config.videoEffects.frameAssetPath, false)),
    await exists(config.videoEffects.watermarkAssetPath).then((ok) => checkResult("Video watermark asset", ok, config.videoEffects.watermarkAssetPath, false))
  );
  return checks;
}

async function checkDeepgram(online) {
  if (!config.deepgram.enabled) {
    return checkResult(
      "Deepgram",
      false,
      "DEEPGRAM_ENABLED harus 1; Deepgram tetap primary untuk transkripsi",
      true
    );
  }

  if (!config.deepgram.apiKeys.length) {
    return checkResult("Deepgram", false, "DEEPGRAM_API_KEYS / DEEPGRAM_API_KEY belum diisi", true);
  }

  if (!online) {
    return checkResult("Deepgram", true, `${config.deepgram.apiKeys.length} key terkonfigurasi`);
  }

  let validCount = 0;
  const failures = [];
  for (const [index, apiKey] of config.deepgram.apiKeys.entries()) {
    try {
      await fetchJsonWithRetries("https://api.deepgram.com/v1/auth/token", {
        headers: { Authorization: `Token ${apiKey}` }
      });
      validCount += 1;
    } catch (error) {
      failures.push(`key ${index + 1}: ${error.message}`);
    }
  }

  if (!validCount) {
    return checkResult("Deepgram", false, failures.join("; "), true);
  }

  const detail = failures.length
    ? `${validCount}/${config.deepgram.apiKeys.length} key valid; gagal: ${failures.join("; ")}`
    : `${validCount} key valid, model ${config.deepgram.model}, language ${config.deepgram.language}`;

  return checkResult(
    "Deepgram",
    true,
    detail
  );
}

async function checkOpenAi(online, required = false) {
  if (!config.openai.apiKey) {
    return checkResult("OpenAI API", false, "OPENAI_API_KEY belum diisi", required);
  }

  const models = config.openai.models?.length ? config.openai.models : [config.openai.model];
  if (!online) {
    return checkResult("OpenAI API", true, `key terkonfigurasi, model ${models.join(" -> ")}`, required);
  }

  const failures = [];
  try {
    for (const model of models) {
      try {
        await fetchJson("https://api.openai.com/v1/responses", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${config.openai.apiKey}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            model,
            input: "Balas OK saja.",
            max_output_tokens: 16
          })
        });
        return checkResult("OpenAI API", true, `model valid: ${model}`, required);
      } catch (error) {
        failures.push(`${model}: ${error.message}`);
      }
    }
    throw new Error(failures.join("; "));
  } catch (error) {
    return checkResult("OpenAI API", false, error.message, required);
  }
}

async function aiChecks(online) {
  return [await checkOpenAi(online, false)];
}

function missingRemoteConfig() {
  const prefix = config.ftp.envPrefix || "FTP";
  const missing = [];
  if (!config.publicBaseUrl) missing.push("PUBLIC_BASE_URL");
  if (!config.ftp.host) missing.push(`${prefix}_HOST`);
  if (!config.ftp.user) missing.push(`${prefix}_USER`);
  if (!config.ftp.password && !config.ftp.privateKey) missing.push(`${prefix}_PASSWORD`);
  if (!config.ftp.remoteDir) missing.push(`${prefix}_REMOTE_DIR`);
  return missing;
}

async function checkRemoteStorage(online) {
  const label = config.ftp.label || "Remote storage";
  const required = config.remoteUploadRequired === true;

  if (!shouldUploadToRemote()) {
    return checkResult(label, true, "UPLOAD_DRIVER bukan ftp/sftp", false);
  }

  const missing = missingRemoteConfig();
  if (missing.length) {
    return checkResult(label, false, `missing env: ${missing.join(", ")}`, required);
  }

  if (!online) {
    return checkResult(label, true, "env lengkap", required);
  }

  const configuredAttempts = config.ftp.precheckRetries || Math.max(1, numberEnv("FTP_PRECHECK_RETRIES", 3));
  const attempts = required ? configuredAttempts : Math.min(configuredAttempts, 1);
  const configuredTimeoutMs = config.ftp.precheckTimeoutMs || Math.min(config.ftp.stateTimeoutMs, config.apiCheckTimeoutMs);
  const timeoutMs = required ? configuredTimeoutMs : Math.min(configuredTimeoutMs, 12000);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await withRemoteClient(async (client) => {
        await client.ensureDir(config.ftp.remoteDir);
        await client.list();
      }, { timeoutMs, retries: 1 });
      const detail = attempt > 1
        ? `remote siap: ${config.ftp.remoteDir} (attempt ${attempt}/${attempts})`
        : `remote siap: ${config.ftp.remoteDir}`;
      return checkResult(label, true, detail, required);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.warn(`${label} precheck attempt ${attempt}/${attempts} gagal: ${error.message}`);
        await sleep(1500 * attempt);
      }
    }
  }

  return checkResult(label, false, lastError?.message || `${label} precheck gagal`, required);
}

async function checkInstagram(online, required = canPublish()) {
  if (!config.instagram.enabled) {
    return checkResult("Instagram Graph API", true, "INSTAGRAM_UPLOAD_ENABLED=false", false);
  }

  const missing = missingEnv(["INSTAGRAM_IG_USER_ID", "INSTAGRAM_ACCESS_TOKEN"]);
  if (missing.length) {
    return checkResult("Instagram Graph API", false, `missing env: ${missing.join(", ")}`, required);
  }

  if (!online) {
    return checkResult("Instagram Graph API", true, "env lengkap", required);
  }

  try {
    const status = await ensureFreshInstagramToken();
    const detail = status.checked ? "token valid" : status.reason || "dilewati";
    return checkResult("Instagram Graph API", true, detail, required);
  } catch (error) {
    return checkResult("Instagram Graph API", false, error.message, required);
  }
}

async function checkFacebook(online, required = false) {
  if (!config.facebook.enabled) {
    return checkResult("Facebook Page API", true, "FACEBOOK_UPLOAD_ENABLED=false", false);
  }

  const missing = missingEnv(["FACEBOOK_PAGE_ID"]);
  if (missing.length) {
    return checkResult("Facebook Page API", false, `missing env: ${missing.join(", ")}`, required);
  }

  if (!config.facebook.accessToken && !config.facebook.userAccessToken) {
    return checkResult(
      "Facebook Page API",
      false,
      "missing env: FACEBOOK_PAGE_ACCESS_TOKEN atau FACEBOOK_USER_ACCESS_TOKEN",
      required
    );
  }

  if (!online) {
    return checkResult("Facebook Page API", true, "env lengkap", required);
  }

  try {
    const status = await ensureFreshFacebookToken({ refreshValid: true });
    const detail = status.pageName ? `page valid: ${status.pageName}` : "page valid";
    return checkResult("Facebook Page API", true, status.refreshed ? `${detail}, token refreshed` : detail, required);
  } catch (error) {
    return checkResult("Facebook Page API", false, error.message, required);
  }
}

async function checkYoutube(online, required = canPublish()) {
  if (!config.youtube.enabled) {
    return checkResult("YouTube Data API", true, "YOUTUBE_UPLOAD_ENABLED=false", false);
  }

  const missing = missingEnv(["YOUTUBE_CLIENT_ID", "YOUTUBE_CLIENT_SECRET", "YOUTUBE_REFRESH_TOKEN"]);
  if (missing.length) {
    return checkResult("YouTube Data API", false, `missing env: ${missing.join(", ")}`, required);
  }

  if (!online) {
    return checkResult("YouTube Data API", true, "env lengkap", required);
  }

  try {
    const token = await getYoutubeAccessToken();
    return checkResult("YouTube Data API", Boolean(token), token ? "refresh token valid" : "access token kosong", required);
  } catch (error) {
    return checkResult("YouTube Data API", false, error.message, required);
  }
}

async function checkYoutubeDiscovery(online) {
  if (!boolEnv("AUTO_DISCOVER_VIDEOS", true)) {
    return checkResult("YouTube Discovery API", true, "AUTO_DISCOVER_VIDEOS=false", false);
  }

  if (!boolEnv("AUTO_DISCOVER_USE_API", false)) {
    return checkResult("YouTube Discovery API", true, "AUTO_DISCOVER_USE_API=false; discovery pakai yt-dlp", false);
  }

  const key = String(
    process.env.YOUTUBE_API_KEY ||
    process.env.YOUTUBE_DATA_API_KEY ||
    process.env.GOOGLE_API_KEY ||
    ""
  ).trim();

  if (!key) {
    return checkResult(
      "YouTube Discovery API",
      false,
      "YOUTUBE_API_KEY belum diisi; fallback ke yt-dlp search",
      false
    );
  }

  if (boolEnv("AUTO_DISCOVER_DAILY_SEARCH_ONLY", true)) {
    return checkResult("YouTube Discovery API", true, "API key terkonfigurasi; search.list max 1x/hari", false);
  }

  if (!online) {
    return checkResult("YouTube Discovery API", true, "API key terkonfigurasi", false);
  }

  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "id");
    url.searchParams.set("id", "dQw4w9WgXcQ");
    url.searchParams.set("key", key);
    await fetchJson(url);
    return checkResult("YouTube Discovery API", true, "API key valid", false);
  } catch (error) {
    return checkResult("YouTube Discovery API", false, error.message, false);
  }
}

async function checkThreads(online, required = false) {
  if (!config.threads.enabled) {
    return checkResult("Threads API", true, "THREADS_UPLOAD_ENABLED=false", false);
  }

  const missing = missingEnv(["THREADS_ACCESS_TOKEN"]);
  if (missing.length) {
    return checkResult("Threads API", false, `missing env: ${missing.join(", ")}`, required);
  }

  if (!online) {
    return checkResult("Threads API", true, "env lengkap", required);
  }

  try {
    const status = await ensureFreshThreadsToken();
    const detail = status.username
      ? `user valid: @${status.username}`
      : status.checked ? "token valid" : status.reason || "dilewati";
    return checkResult("Threads API", true, status.refreshed ? `${detail}, token refreshed` : detail, required);
  } catch (error) {
    return checkResult("Threads API", false, error.message, required);
  }
}

async function checkTikTok(online, required = false) {
  if (!config.tiktok.enabled) {
    if (config.tiktok.paused) {
      return checkResult("TikTok Content Posting API", true, "TIKTOK_UPLOAD_PAUSED=true", false);
    }
    return checkResult("TikTok Content Posting API", true, "TIKTOK_UPLOAD_ENABLED=false", false);
  }

  const missing = missingEnv(["TIKTOK_CLIENT_KEY", "TIKTOK_CLIENT_SECRET"]);
  if (missing.length) {
    return checkResult("TikTok Content Posting API", false, `missing env: ${missing.join(", ")}`, required);
  }

  if (!config.tiktok.accessToken && !config.tiktok.refreshToken) {
    return checkResult(
      "TikTok Content Posting API",
      false,
      "missing env: TIKTOK_ACCESS_TOKEN atau TIKTOK_REFRESH_TOKEN",
      required
    );
  }

  if (!online) {
    return checkResult("TikTok Content Posting API", true, "env lengkap", required);
  }

  try {
    if (config.tiktok.publishMode === "inbox") {
      return checkResult("TikTok Content Posting API", true, "token siap untuk inbox upload", required);
    }
    const creator = await queryTikTokCreatorInfo();
    const detail = creator.creator_username
      ? `creator valid: ${creator.creator_username}`
      : "creator valid";
    return checkResult("TikTok Content Posting API", true, detail, required);
  } catch (error) {
    return checkResult("TikTok Content Posting API", false, error.message, required);
  }
}

export async function runPreflight(options = {}) {
  const online = options.online !== false;
  const aiOnline = options.aiOnline ?? false;
  const deepgramOnline = options.deepgramOnline ?? online;
  const ftpOnline = options.ftpOnline ?? online;
  const socialOnline = options.socialOnline ?? false;
  const youtubeOnline = options.youtubeOnline ?? online;
  const publishRequired = options.publishRequired ?? canPublish();
  const socialPublishRequired = options.socialPublishRequired ?? false;
  const preChecks = [
    ...await localChecks(),
    await checkRemoteStorage(ftpOnline),
    await checkInstagram(socialOnline, socialPublishRequired),
    await checkFacebook(socialOnline, socialPublishRequired),
    await checkYoutube(youtubeOnline, publishRequired),
    await checkYoutubeDiscovery(youtubeOnline),
    await checkTikTok(socialOnline, socialPublishRequired),
    await checkThreads(socialOnline, socialPublishRequired)
  ];
  const precheckFailed = preChecks.some((check) => check.required && !check.ok);

  if (precheckFailed) {
    return {
      online,
      ok: false,
      checks: preChecks
    };
  }

  const ai = await aiChecks(aiOnline);
  const checks = [
    ...preChecks,
    await checkDeepgram(deepgramOnline),
    ...ai
  ];

  return {
    online,
    ok: checks.every((check) => check.ok || !check.required),
    checks
  };
}

export function printPreflightReport(report) {
  console.log(`Preflight status (${report.online ? "online" : "offline"}):`);
  for (const check of report.checks) {
    const status = check.ok ? "OK" : check.required ? "FAIL" : "WARN";
    const detail = check.detail ? ` - ${check.detail}` : "";
    console.log(`${status} ${check.name}${detail}`);
  }
}

export function assertPreflightOk(report) {
  const failures = report.checks.filter((check) => check.required && !check.ok);
  if (!failures.length) return;
  throw new Error(`Preflight gagal: ${failures.map((check) => check.name).join(", ")}`);
}
