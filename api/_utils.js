import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { Client as FtpClient } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";

const STATE_FILES = ["themes.json", "videos.json", "prompts.json", "jobs.json", "history.json"];

export function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

export function methodAllowed(req, res, methods) {
  if (methods.includes(req.method)) return true;
  sendJson(res, 405, { error: `Method ${req.method} tidak didukung.` });
  return false;
}

export async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") {
    const rawBody = req.body.trim();
    return rawBody ? JSON.parse(rawBody) : {};
  }
  const chunks = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  if (!raw) return {};
  return JSON.parse(raw);
}

export function requireAuth(req, res) {
  const expected = clean(process.env.AUTO_DASHBOARD_PIN);
  if (!expected) {
    sendJson(res, 403, { error: "AUTO_DASHBOARD_PIN belum diset di Vercel Environment." });
    return false;
  }

  const provided = clean(
    req.headers["x-dashboard-pin"]
      || queryValue(req, "pin")
      || cookieValue(req.headers.cookie || "", "clipper_dashboard_pin")
  );

  if (provided === expected) return true;

  sendJson(res, 401, { error: "PIN dashboard tidak valid atau belum diisi." });
  return false;
}

export function setPinCookie(res, pin) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `clipper_dashboard_pin=${encodeURIComponent(pin)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`
  );
}

export function clearPinCookie(res) {
  res.setHeader("Set-Cookie", "clipper_dashboard_pin=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0");
}

export async function readState() {
  const entries = await Promise.all(STATE_FILES.map(async (file) => [file, await readStateFile(file)]));
  return Object.fromEntries(entries.map(([file, data]) => [file.replace(/\.json$/, ""), data]));
}

export async function readStateFile(file) {
  const fromRemote = await readStateFileFromPublicBaseUrl(file);
  if (fromRemote) return fromRemote;

  try {
    const raw = await fs.readFile(path.join(process.cwd(), "data", file), "utf8");
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function readStateFileFromPublicBaseUrl(file) {
  const baseUrl = cleanBaseUrl(process.env.PUBLIC_BASE_URL);
  if (!baseUrl) return null;

  try {
    const response = await fetch(`${baseUrl}/state/${encodeURIComponent(file)}`, {
      cache: "no-store",
      headers: { Accept: "application/json" }
    });
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  }
}

export async function uploadStateFile(file, data) {
  const cfg = remoteConfig();
  if (!["ftp", "sftp"].includes(cfg.driver)) return { skipped: true };

  const missing = remoteMissingEnv(cfg);
  if (missing.length) {
    throw new Error(`${cfg.label} env belum lengkap untuk update state: ${missing.join(", ")}`);
  }

  const raw = `${JSON.stringify(data, null, 2)}\n`;

  await withRemoteRetry(async () => {
    if (cfg.driver === "sftp") {
      const client = new SftpClient();
      try {
        await client.connect({
          host: cfg.host,
          port: cfg.port,
          username: cfg.user,
          password: cfg.password || undefined,
          privateKey: cfg.privateKey || undefined,
          passphrase: cfg.passphrase || undefined,
          readyTimeout: Math.max(cfg.stateTimeoutMs, cfg.connectionTimeoutMs, 30000),
          keepaliveInterval: 10000,
          keepaliveCountMax: 12
        });
        const stateDir = path.posix.join(cfg.remoteDir, "state");
        await client.mkdir(stateDir, true);
        await client.put(Readable.from([Buffer.from(raw, "utf8")]), path.posix.join(stateDir, file));
      } finally {
        await client.end().catch(() => {});
      }
      return;
    }

    const client = new FtpClient(cfg.stateTimeoutMs);
    try {
      await client.access({
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        secure: false
      });
      await client.ensureDir(path.posix.join(cfg.remoteDir, "state"));
      await client.uploadFrom(Readable.from([Buffer.from(raw, "utf8")]), file);
    } finally {
      client.close();
    }
  });

  return { skipped: false };
}

export function configSummary() {
  return {
    dryRun: boolEnv("DRY_RUN", false),
    autoPublish: boolEnv("AUTO_PUBLISH", true),
    uploadDriver: clean(process.env.UPLOAD_DRIVER || "sftp"),
    defaultTheme: clean(process.env.DEFAULT_THEME || "auto"),
    publicBaseUrl: cleanBaseUrl(process.env.PUBLIC_BASE_URL),
    postCron: clean(process.env.POST_CRON || ""),
    timezone: clean(process.env.APP_TIMEZONE || "Asia/Jakarta"),
    maxScheduledPostsPerDay: Number(process.env.MAX_SCHEDULED_POSTS_PER_DAY || 15),
    autoDiscoverDailyQueueLimit: Number(process.env.AUTO_DISCOVER_DAILY_QUEUE_LIMIT || process.env.MAX_SCHEDULED_POSTS_PER_DAY || 15),
    instagramEnabled: boolEnv("INSTAGRAM_UPLOAD_ENABLED", true),
    facebookEnabled: boolEnv("FACEBOOK_UPLOAD_ENABLED", true),
    youtubeEnabled: boolEnv("YOUTUBE_UPLOAD_ENABLED", true),
    tiktokPaused: boolEnv("TIKTOK_UPLOAD_PAUSED", true),
    tiktokEnabled: !boolEnv("TIKTOK_UPLOAD_PAUSED", true) && boolEnv("TIKTOK_UPLOAD_ENABLED", false),
    threadsEnabled: boolEnv("THREADS_UPLOAD_ENABLED", false),
    aiProvider: "openai",
    openaiModel: clean(process.env.OPENAI_MODEL || "gpt-4.1-nano"),
    transcribeProvider: clean(process.env.TRANSCRIBE_PROVIDER || "deepgram"),
    deepgramEnabled: boolEnv("DEEPGRAM_ENABLED", true),
    deepgramModel: clean(process.env.DEEPGRAM_MODEL || "nova-3"),
    videoFrameEnabled: boolEnv("VIDEO_FRAME_ENABLED", true),
    videoFilterEnabled: boolEnv("VIDEO_FILTER_ENABLED", true),
    videoWatermarkEnabled: boolEnv("VIDEO_WATERMARK_ENABLED", true),
    videoLowerThirdEnabled: boolEnv("VIDEO_LOWER_THIRD_ENABLED", true),
    backgroundMusicEnabled: boolEnv("BACKGROUND_MUSIC_ENABLED", true),
    backgroundMusicFile: clean(process.env.BACKGROUND_MUSIC_FILE || ""),
    backgroundMusicMapFile: clean(process.env.BACKGROUND_MUSIC_MAP_FILE || "assets/music/music-map.json"),
    backgroundMusicVolume: clean(process.env.BACKGROUND_MUSIC_VOLUME || "0.06"),
    subtitleFont: clean(process.env.SUBTITLE_FONT_FAMILY || "Segoe UI Semibold"),
    subtitleMarginV: clean(process.env.SUBTITLE_MARGIN_V || "550"),
    vercelDashboard: true
  };
}

export async function getRecentRuns(limit = 5) {
  const token = githubToken();
  if (!token) return [];

  const repo = githubRepo();
  const response = await fetch(`https://api.github.com/repos/${repo}/actions/runs?per_page=${limit}`, {
    headers: githubHeaders(token),
    cache: "no-store"
  });
  if (!response.ok) return [];
  const data = await response.json();
  return (data.workflow_runs || []).map((run) => ({
    id: run.id,
    name: run.name,
    status: run.status,
    conclusion: run.conclusion,
    event: run.event,
    head_sha: run.head_sha,
    head_branch: run.head_branch,
    run_attempt: run.run_attempt,
    display_title: run.display_title || run.head_commit?.message || "",
    created_at: run.created_at,
    updated_at: run.updated_at,
    html_url: run.html_url
  }));
}

export async function getRunJobs(runId) {
  const token = githubToken();
  if (!token || !runId) return [];

  const repo = githubRepo();
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/runs/${runId}/jobs?per_page=30`,
    { headers: githubHeaders(token), cache: "no-store" }
  );
  if (!response.ok) return [];
  const data = await response.json();
  return (data.jobs || []).map((job) => ({
    id: job.id,
    name: job.name,
    status: job.status,
    conclusion: job.conclusion,
    started_at: job.started_at,
    completed_at: job.completed_at,
    html_url: job.html_url,
    steps: (job.steps || []).map((step) => ({
      name: step.name,
      status: step.status,
      conclusion: step.conclusion,
      number: step.number,
      started_at: step.started_at,
      completed_at: step.completed_at
    }))
  }));
}

export async function dispatchWorkflow(inputs) {
  const token = githubToken();
  if (!token) throw new Error("GH_REPO_SECRET_TOKEN belum diset di Vercel Environment.");

  const repo = githubRepo();
  const workflow = process.env.DASHBOARD_WORKFLOW_FILE || "podcast-automation.yml";
  const ref = process.env.DASHBOARD_GITHUB_REF || "main";
  const response = await fetch(
    `https://api.github.com/repos/${repo}/actions/workflows/${encodeURIComponent(workflow)}/dispatches`,
    {
      method: "POST",
      headers: githubHeaders(token),
      body: JSON.stringify({ ref, inputs })
    }
  );

  if (response.status === 204) {
    return { ok: true, repo, workflow, ref };
  }

  let detail = "";
  try {
    detail = JSON.stringify(await response.json());
  } catch {
    detail = await response.text();
  }
  throw new Error(`Gagal trigger workflow (${response.status}): ${detail.slice(0, 500)}`);
}

export function buildVideo(input) {
  const url = clean(input.url);
  if (!url) throw new Error("URL wajib diisi.");

  const now = new Date().toISOString();
  return {
    id: input.id || makeId("video"),
    source_type: "youtube_video",
    url,
    source_url: url,
    youtube_video_id: extractYoutubeVideoId(url),
    theme: clean(input.theme || "podcast artis"),
    priority: Number(input.priority || 1),
    target_date: clean(input.target_date || ""),
    active: input.active !== false,
    status: clean(input.status || "queued"),
    notes: clean(input.notes || "Ditambahkan dari dashboard Vercel"),
    manual_range: clean(input.manual_range || ""),
    quality_profile: clean(input.quality_profile || "standard"),
    ai_provider: "openai",
    scene_mode: clean(input.scene_mode || process.env.SCENE_MODE || "podcast"),
    clip_count: Number(input.clip_count || process.env.CLIP_COUNT || 1),
    subtitle_font: clean(input.subtitle_font || process.env.SUBTITLE_FONT_FAMILY || "Segoe UI Semibold"),
    subtitle_font_size: Number(input.subtitle_font_size || process.env.SUBTITLE_FONT_SIZE || 46),
    subtitle_margin_v: Number(input.subtitle_margin_v || process.env.SUBTITLE_MARGIN_V || 550),
    subtitle_margin_h: Number(input.subtitle_margin_h || process.env.SUBTITLE_MARGIN_H || 180),
    use_frame: boolInput(input.use_frame, boolEnv("VIDEO_FRAME_ENABLED", true)),
    use_filter: boolInput(input.use_filter, boolEnv("VIDEO_FILTER_ENABLED", true)),
    use_watermark: boolInput(input.use_watermark, boolEnv("VIDEO_WATERMARK_ENABLED", true)),
    use_music: boolInput(input.use_music, boolEnv("BACKGROUND_MUSIC_ENABLED", true)),
    force_reprocess: input.force_reprocess === true,
    created_at: input.created_at || now,
    updated_at: now
  };
}

export function upsertById(items, item) {
  const list = Array.isArray(items) ? [...items] : [];
  const index = list.findIndex((entry) => entry?.id === item.id);
  if (index === -1) list.push(item);
  else list[index] = { ...list[index], ...item };
  return list;
}

export function extractYoutubeVideoId(input) {
  const value = clean(input);
  if (!value) return "";

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return cleanId(url.pathname.split("/").filter(Boolean)[0]);
    if (host.endsWith("youtube.com")) {
      const watchId = url.searchParams.get("v");
      if (watchId) return cleanId(watchId);
      const parts = url.pathname.split("/").filter(Boolean);
      const index = parts.findIndex((part) => ["shorts", "embed", "live"].includes(part));
      if (index !== -1 && parts[index + 1]) return cleanId(parts[index + 1]);
    }
  } catch {
    const match = value.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/);
    return cleanId(match?.[1] || "");
  }

  return "";
}

export function makeId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = crypto.randomBytes(2).toString("hex");
  return `${prefix}_${stamp}_${random}`;
}

export function check(name, ok, detail = "", required = true) {
  return { name, ok: Boolean(ok), detail, required };
}

export function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function boolInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export function clean(value) {
  return String(value || "").trim();
}

function cleanId(value) {
  return clean(value).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}

function cleanBaseUrl(value) {
  return clean(value).replace(/\/+$/, "");
}

function firstEnv(names, fallback = "") {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return fallback;
}

function numberEnvFrom(names, fallback) {
  const value = Number(firstEnv(names));
  return Number.isFinite(value) ? value : fallback;
}

export function remoteConfig() {
  const driver = clean(process.env.UPLOAD_DRIVER || "sftp").toLowerCase();
  const prefix = driver === "sftp" ? "SFTP" : "FTP";
  const fallbackPrefix = prefix === "SFTP" ? "FTP" : "SFTP";
  const names = (suffix) => [`${prefix}_${suffix}`, `${fallbackPrefix}_${suffix}`];
  const portNames = driver === "sftp" ? ["SFTP_PORT"] : names("PORT");
  const defaultPort = driver === "sftp" ? 65002 : 21;

  return {
    driver,
    label: driver === "sftp" ? "SFTP" : "FTP",
    prefix,
    host: clean(firstEnv(names("HOST"))),
    port: numberEnvFrom(portNames, defaultPort),
    user: clean(firstEnv(names("USER"))),
    password: firstEnv(names("PASSWORD")),
    privateKey: firstEnv(["SFTP_PRIVATE_KEY"]).replace(/\\n/g, "\n").trim(),
    passphrase: firstEnv(["SFTP_PASSPHRASE"]),
    remoteDir: clean(firstEnv(names("REMOTE_DIR"), "/public_html/ig-generated")),
    connectionTimeoutMs: numberEnvFrom(names("TIMEOUT_SECONDS"), 420) * 1000,
    stateTimeoutMs: numberEnvFrom(names("STATE_TIMEOUT_SECONDS"), 180) * 1000,
    retries: Math.max(1, numberEnvFrom(names("UPLOAD_RETRIES"), 4))
  };
}

export function remoteMissingEnv(cfg) {
  const missing = [];
  if (!cfg.host) missing.push(`${cfg.prefix}_HOST`);
  if (!cfg.user) missing.push(`${cfg.prefix}_USER`);
  if (!cfg.password && !cfg.privateKey) missing.push(`${cfg.prefix}_PASSWORD`);
  if (!cfg.remoteDir) missing.push(`${cfg.prefix}_REMOTE_DIR`);
  return missing;
}

async function withRemoteRetry(task) {
  const cfg = remoteConfig();
  const attempts = cfg.retries;
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || "");
      const retriable = !/\b(530|550|553)\b|auth|authentication|permission denied|login incorrect/i.test(message)
        && /timeout|timed out|closed|socket|econn|etimedout|econnreset|econnrefused|epipe|no control connection|connection lost|421|425|426|450|451/i.test(message);
      if (attempt >= attempts || !retriable) throw error;
      await new Promise((resolve) => setTimeout(resolve, Math.min(30000, 1500 * attempt)));
    }
  }
  throw lastError;
}

function githubRepo() {
  return clean(process.env.DASHBOARD_GITHUB_REPO || process.env.GITHUB_REPOSITORY || "emsabiq2/clipper2");
}

function githubToken() {
  return clean(process.env.GH_REPO_SECRET_TOKEN || process.env.GITHUB_TOKEN);
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "clipper-dashboard"
  };
}

function queryValue(req, name) {
  try {
    return new URL(req.url, "https://dashboard.local").searchParams.get(name) || "";
  } catch {
    return "";
  }
}

function cookieValue(raw, name) {
  for (const part of String(raw || "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return "";
}
