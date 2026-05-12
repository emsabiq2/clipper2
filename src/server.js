import express from "express";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config, reloadConfigFromEnv } from "./config.js";
import { ensureProjectDirs, patchItem, readJson, upsertItem, writeJson } from "./storage.js";
import { addVideo } from "./selector.js";
import { runWorkflow } from "./workflow.js";
import { makeId, todayDate } from "./job-id.js";
import { downloadStateFromRemote, uploadStateToRemote } from "./state-sync.js";
import { runPreflight } from "./preflight.js";
import { exchangeTikTokCode, publishToTikTok } from "./tiktok.js";
import { ensureCaptionSourceCredit } from "./caption-policy.js";
import {
  buildYoutubeAuthUrl,
  exchangeYoutubeCode,
  persistYoutubeReconnect,
  renderYoutubeCallbackPage,
  requestOrigin,
  verifyYoutubeOAuthState
} from "./youtube-oauth.js";

await ensureProjectDirs();
await downloadStateFromRemote().catch(() => {});

const app = express();
app.use(express.json({ limit: "1mb" }));

let activeRun = null;
const resettableQueueStatuses = new Set(["queued", "failed", "retry"]);

function boolInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const envFilePath = path.join(config.rootDir, ".env");
const sensitiveEnvKeys = new Set([
  "AUTO_DASHBOARD_PIN",
  "FTP_PASSWORD",
  "SFTP_PASSWORD",
  "SFTP_PRIVATE_KEY",
  "SFTP_PASSPHRASE",
  "INSTAGRAM_ACCESS_TOKEN",
  "FACEBOOK_PAGE_ACCESS_TOKEN",
  "FACEBOOK_USER_ACCESS_TOKEN",
  "TIKTOK_CLIENT_SECRET",
  "TIKTOK_ACCESS_TOKEN",
  "TIKTOK_REFRESH_TOKEN",
  "META_APP_SECRET",
  "YOUTUBE_CLIENT_SECRET",
  "YOUTUBE_REFRESH_TOKEN",
  "YOUTUBE_OAUTH_STATE_SECRET",
  "OPENAI_API_KEY",
  "DEEPGRAM_API_KEY",
  "DEEPGRAM_API_KEYS",
  "YTDLP_COOKIES_TXT"
]);

const envGroups = [
  {
    id: "core",
    title: "Core",
    fields: [
      field("PUBLIC_BASE_URL", "Public base URL"),
      field("UPLOAD_DRIVER", "Upload driver"),
      field("DRY_RUN", "Dry run"),
      field("AUTO_PUBLISH", "Auto publish"),
      field("DEFAULT_THEME", "Default theme"),
      field("APP_TIMEZONE", "Timezone"),
      field("LOCAL_PORT", "Local port"),
      field("AUTO_DASHBOARD_PIN", "Dashboard PIN", true)
    ]
  },
  {
    id: "remote",
    title: "Remote Storage",
    fields: [
      field("SFTP_HOST", "SFTP host"),
      field("SFTP_PORT", "SFTP port"),
      field("SFTP_USER", "SFTP user"),
      field("SFTP_PASSWORD", "SFTP password", true),
      field("SFTP_PRIVATE_KEY", "SFTP private key", true),
      field("SFTP_PASSPHRASE", "SFTP passphrase", true),
      field("SFTP_REMOTE_DIR", "SFTP remote dir"),
      field("SFTP_TIMEOUT_SECONDS", "Timeout seconds"),
      field("SFTP_UPLOAD_TIMEOUT_SECONDS", "Upload timeout seconds"),
      field("SFTP_CLEANUP_TIMEOUT_SECONDS", "Cleanup timeout seconds"),
      field("SFTP_STATE_TIMEOUT_SECONDS", "State timeout seconds"),
      field("SFTP_PRECHECK_RETRIES", "Precheck retries"),
      field("SFTP_UPLOAD_RETRIES", "Upload retries"),
      field("SFTP_PUBLIC_URL_RETRIES", "Public URL retries"),
      field("SFTP_PUBLIC_URL_RETRY_DELAY_MS", "Public URL retry delay ms"),
      field("SFTP_CLEANUP_DAYS", "Cleanup days"),
      field("SFTP_CLEANUP_DELETE_ALL", "Cleanup delete all"),
      field("SFTP_CLEANUP_SUBDIRS", "Cleanup subdirs"),
      field("SFTP_CLEANUP_MATCH", "Cleanup match"),
      field("FTP_HOST", "Legacy FTP host"),
      field("FTP_PORT", "Legacy FTP port"),
      field("FTP_USER", "Legacy FTP user"),
      field("FTP_PASSWORD", "Legacy FTP password", true),
      field("FTP_REMOTE_DIR", "Legacy FTP remote dir"),
      field("FTP_TIMEOUT_SECONDS", "Legacy timeout seconds"),
      field("FTP_UPLOAD_TIMEOUT_SECONDS", "Legacy upload timeout seconds"),
      field("FTP_CLEANUP_TIMEOUT_SECONDS", "Legacy cleanup timeout seconds"),
      field("FTP_STATE_TIMEOUT_SECONDS", "Legacy state timeout seconds"),
      field("FTP_PRECHECK_RETRIES", "Legacy precheck retries"),
      field("FTP_UPLOAD_RETRIES", "Legacy upload retries"),
      field("FTP_PUBLIC_URL_RETRIES", "Legacy public URL retries"),
      field("FTP_PUBLIC_URL_RETRY_DELAY_MS", "Legacy public URL retry delay ms"),
      field("FTP_CLEANUP_DAYS", "Cleanup days"),
      field("FTP_CLEANUP_DELETE_ALL", "Cleanup delete all"),
      field("FTP_CLEANUP_SUBDIRS", "Cleanup subdirs"),
      field("FTP_CLEANUP_MATCH", "Cleanup match")
    ]
  },
  {
    id: "meta",
    title: "Meta App",
    fields: [
      field("GRAPH_API_VERSION", "Graph API version"),
      field("META_APP_ID", "App ID"),
      field("META_APP_SECRET", "App Secret", true),
      field("TOKEN_REFRESH_BEFORE_DAYS", "Refresh before days")
    ]
  },
  {
    id: "branding",
    title: "Video Branding",
    fields: [
      field("VIDEO_FRAME_ENABLED", "Frame default"),
      field("VIDEO_FILTER_ENABLED", "Filter default"),
      field("VIDEO_WATERMARK_ENABLED", "Watermark default"),
      field("VIDEO_LOWER_THIRD_ENABLED", "Lower-third default"),
      field("VIDEO_LOWER_THIRD_BRAND", "Lower-third brand"),
      field("VIDEO_FRAME_ASSET", "Frame asset"),
      field("VIDEO_WATERMARK_ASSET", "Watermark asset"),
      field("VIDEO_EFFECT_CRF", "Effect CRF"),
      field("VIDEO_EFFECT_PRESET", "Effect preset"),
      field("BACKGROUND_MUSIC_ENABLED", "Backsound enabled"),
      field("BACKGROUND_MUSIC_FILE", "Backsound file"),
      field("BACKGROUND_MUSIC_MAP_FILE", "Backsound map"),
      field("BACKGROUND_MUSIC_VOLUME", "Backsound volume"),
      field("BACKGROUND_MUSIC_ORIGINAL_VOLUME", "Original audio volume")
    ]
  },
  {
    id: "instagram",
    title: "Instagram",
    fields: [
      field("INSTAGRAM_UPLOAD_ENABLED", "Upload enabled"),
      field("INSTAGRAM_IG_USER_ID", "IG user ID"),
      field("INSTAGRAM_ACCESS_TOKEN", "Access token", true),
      field("INSTAGRAM_REEL_UPLOAD_METHOD", "Upload method"),
      field("INSTAGRAM_MAX_UPLOAD_BYTES", "Max upload bytes"),
      field("AUTO_REFRESH_INSTAGRAM_TOKEN", "Auto refresh token")
    ]
  },
  {
    id: "facebook",
    title: "Facebook Page",
    fields: [
      field("FACEBOOK_UPLOAD_ENABLED", "Upload enabled"),
      field("FACEBOOK_PAGE_ID", "Page ID"),
      field("FACEBOOK_PAGE_ACCESS_TOKEN", "Page access token", true),
      field("FACEBOOK_USER_ACCESS_TOKEN", "User access token", true),
      field("AUTO_REFRESH_FACEBOOK_TOKEN", "Auto refresh token"),
      field("FACEBOOK_MEDIA_TYPE", "Media type"),
      field("FACEBOOK_VIDEO_STATE", "Video state"),
      field("FACEBOOK_TITLE_PREFIX", "Title prefix")
    ]
  },
  {
    id: "youtube",
    title: "YouTube",
    fields: [
      field("YOUTUBE_UPLOAD_ENABLED", "Upload enabled"),
      field("YOUTUBE_CLIENT_ID", "Client ID"),
      field("YOUTUBE_CLIENT_SECRET", "Client secret", true),
      field("YOUTUBE_REFRESH_TOKEN", "Refresh token", true),
      field("YOUTUBE_REDIRECT_URI", "Redirect URI"),
      field("YOUTUBE_OAUTH_STATE_SECRET", "OAuth state secret", true),
      field("YOUTUBE_PRIVACY_STATUS", "Privacy status"),
      field("YOUTUBE_CATEGORY_ID", "Category ID"),
      field("YOUTUBE_TAGS", "Tags"),
      field("YOUTUBE_TITLE_PREFIX", "Title prefix")
    ]
  },
  {
    id: "tiktok",
    title: "TikTok",
    fields: [
      field("TIKTOK_UPLOAD_PAUSED", "Upload paused"),
      field("TIKTOK_UPLOAD_ENABLED", "Upload enabled"),
      field("TIKTOK_CLIENT_KEY", "Client key"),
      field("TIKTOK_CLIENT_SECRET", "Client secret", true),
      field("TIKTOK_ACCESS_TOKEN", "Access token", true),
      field("TIKTOK_REFRESH_TOKEN", "Refresh token", true),
      field("TIKTOK_OPEN_ID", "Open ID"),
      field("TIKTOK_SCOPE", "Scope"),
      field("TIKTOK_REDIRECT_URI", "Redirect URI"),
      field("TIKTOK_PUBLISH_MODE", "Publish mode"),
      field("TIKTOK_PRIVACY_LEVEL", "Privacy level"),
      field("TIKTOK_DISABLE_DUET", "Disable duet"),
      field("TIKTOK_DISABLE_COMMENT", "Disable comment"),
      field("TIKTOK_DISABLE_STITCH", "Disable stitch")
    ]
  },
  {
    id: "ai",
    title: "AI & Transcript",
    fields: [
      field("OPENAI_API_KEY", "OpenAI key", true),
      field("OPENAI_MODEL", "OpenAI model"),
      field("OPENAI_MODELS", "OpenAI fallback models"),
      field("OPENAI_TRANSCRIBE_MODEL", "OpenAI transcript fallback model"),
      field("DEEPGRAM_ENABLED", "Deepgram enabled"),
      field("TRANSCRIBE_PROVIDER", "Transcript provider"),
      field("DEEPGRAM_API_KEYS", "Deepgram keys", true),
      field("DEEPGRAM_MODEL", "Deepgram model"),
      field("DEEPGRAM_TIMEOUT_SECONDS", "Deepgram timeout")
    ]
  },
  {
    id: "subtitle",
    title: "Subtitle",
    fields: [
      field("SUBTITLE_FONT_FAMILY", "Font family"),
      field("SUBTITLE_FALLBACK_FONTS", "Fallback fonts"),
      field("SUBTITLE_FONT_SIZE", "Font size"),
      field("SUBTITLE_MIN_FONT_SIZE", "Min font size"),
      field("SUBTITLE_MARGIN_V", "Bottom margin"),
      field("SUBTITLE_MARGIN_H", "Side margin"),
      field("SUBTITLE_MAX_LINES", "Max lines"),
      field("SUBTITLE_PRIMARY_COLOUR", "Primary colour"),
      field("SUBTITLE_OUTLINE_COLOUR", "Outline colour"),
      field("SUBTITLE_SHADOW_COLOUR", "Shadow colour"),
      field("SUBTITLE_BOLD", "Bold"),
      field("SUBTITLE_OUTLINE", "Outline"),
      field("SUBTITLE_SHADOW", "Shadow")
    ]
  }
];

app.use((req, res, next) => {
  const ip = req.ip || req.socket.remoteAddress || "";
  const local = ip === "::1" || ip === "127.0.0.1" || ip === "::ffff:127.0.0.1";
  if (local) return next();
  if (!config.dashboardAllowRemote) {
    res.status(403).json({ error: "Dashboard hanya aktif untuk localhost." });
    return;
  }

  if (!req.path.startsWith("/api/")) return next();
  if (req.path === "/api/auth") return next();
  if (req.path === "/api/youtube/callback") return next();

  if (!config.dashboardPin) {
    res.status(403).json({ error: "AUTO_DASHBOARD_PIN wajib diisi untuk akses remote." });
    return;
  }

  const pin = req.get("x-dashboard-pin") || req.query.pin || "";
  if (pin === config.dashboardPin) return next();

  res.status(401).json({ error: "PIN dashboard tidak valid atau belum diisi." });
});

app.post("/api/auth", (req, res) => {
  if (!config.dashboardPin) {
    res.json({ ok: true, local: true });
    return;
  }

  if (String(req.body?.pin || "") === config.dashboardPin) {
    res.json({ ok: true });
    return;
  }

  res.status(401).json({ error: "PIN dashboard salah." });
});

app.delete("/api/auth", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/state", async (_req, res) => {
  res.json({
    config: {
      dryRun: config.dryRun,
      autoPublish: config.autoPublish,
      uploadDriver: config.uploadDriver,
      defaultTheme: config.defaultTheme,
      publicBaseUrl: config.publicBaseUrl,
      postCron: config.postCron,
      timezone: config.timezone,
      maxScheduledPostsPerDay: Number(process.env.MAX_SCHEDULED_POSTS_PER_DAY || 15),
      autoDiscoverDailyQueueLimit: Number(process.env.AUTO_DISCOVER_DAILY_QUEUE_LIMIT || process.env.MAX_SCHEDULED_POSTS_PER_DAY || 15),
      instagramEnabled: config.instagram.enabled,
      facebookEnabled: config.facebook.enabled,
      youtubeEnabled: config.youtube.enabled,
      tiktokEnabled: config.tiktok.enabled,
      tiktokPaused: config.tiktok.paused,
      threadsEnabled: config.threads.enabled,
      videoFrameEnabled: config.videoEffects.frameEnabled,
      videoFilterEnabled: config.videoEffects.filterEnabled,
      videoWatermarkEnabled: config.videoEffects.watermarkEnabled,
      videoLowerThirdEnabled: config.videoEffects.lowerThirdEnabled,
      backgroundMusicEnabled: boolInput(process.env.BACKGROUND_MUSIC_ENABLED, true),
      backgroundMusicFile: process.env.BACKGROUND_MUSIC_FILE || "",
      backgroundMusicMapFile: process.env.BACKGROUND_MUSIC_MAP_FILE || "assets/music/music-map.json",
      backgroundMusicVolume: process.env.BACKGROUND_MUSIC_VOLUME || "0.06",
      aiProvider: config.ai.provider,
      subtitleFont: process.env.SUBTITLE_FONT_FAMILY || "Segoe UI Semibold",
      subtitleMarginV: process.env.SUBTITLE_MARGIN_V || "550"
    },
    activeRun,
    themes: await readJson("themes", []),
    videos: await readJson("videos", []),
    prompts: await readJson("prompts", []),
    jobs: await readJson("jobs", []),
    history: await readJson("history", [])
  });
});

app.get("/api/settings", async (_req, res) => {
  res.json(await readDashboardSettings());
});

app.post("/api/settings", async (req, res) => {
  try {
    const result = await saveDashboardSettings(req.body?.values || {});
    reloadConfigFromEnv();
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/preflight", async (_req, res) => {
  try {
    reloadConfigFromEnv();
    const report = await runPreflight({
      online: true,
      aiOnline: false,
      deepgramOnline: false,
      socialOnline: true,
      youtubeOnline: true,
      ftpOnline: true,
      socialPublishRequired: false
    });
    res.json(report);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/api/tiktok/auth-url", (_req, res) => {
  try {
    res.json({
      url: buildTikTokAuthUrl(),
      redirectUri: config.tiktok.redirectUri,
      scopes: tiktokScopes()
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/tiktok/demo-status", async (_req, res) => {
  const latestJob = await latestTikTokDemoJob();
  res.json({
    configured: Boolean(config.tiktok.clientKey && config.tiktok.clientSecret && config.tiktok.redirectUri),
    connected: Boolean(config.tiktok.accessToken || config.tiktok.refreshToken),
    uploadEnabled: config.tiktok.enabled,
    paused: config.tiktok.paused,
    publishMode: config.tiktok.publishMode,
    privacyLevel: config.tiktok.privacyLevel,
    redirectUri: config.tiktok.redirectUri,
    scopes: tiktokScopes(),
    latestJob: latestJob ? {
      job_id: latestJob.job_id,
      title: latestJob.source_title || latestJob.job_id,
      public_video_url: latestJob.public_video_url,
      tiktok_status: latestJob.tiktok_status || "",
      tiktok_publish_id: latestJob.tiktok_publish_id || "",
      tiktok_mode: latestJob.tiktok_mode || ""
    } : null
  });
});

app.post("/api/tiktok/exchange", async (req, res) => {
  try {
    const code = String(req.body?.code || "").trim();
    if (!code) throw new Error("TikTok authorization code kosong.");
    const token = await exchangeTikTokCode({ code, redirectUri: config.tiktok.redirectUri });
    await persistTikTokTokens();
    res.json({
      ok: true,
      connected: true,
      openId: token.open_id ? "configured" : "",
      scope: token.scope || "",
      redirectUri: config.tiktok.redirectUri
    });
  } catch (error) {
    res.status(400).json({ error: error.message, apiCode: error.apiCode || "" });
  }
});

app.post("/api/tiktok/demo-publish", async (req, res) => {
  try {
    if (config.tiktok.paused) throw new Error("TikTok upload dipause sampai app disetujui.");
    if (!config.tiktok.enabled) throw new Error("TIKTOK_UPLOAD_ENABLED=false.");
    const job = await latestTikTokDemoJob(String(req.body?.job_id || "").trim());
    if (!job) throw new Error("Belum ada video dengan public_video_url untuk demo TikTok.");
    const caption = ensureCaptionSourceCredit(job.caption || "Clipper Emsa Pro TikTok video", {
      sourceUrl: job.source_url,
      sourceTitle: job.source_title,
      maxLength: 2200
    });
    const result = await publishToTikTok({
      videoUrl: job.public_video_url,
      videoPath: job.final_video_path || "",
      caption
    });
    await patchItem("jobs", job.job_id, {
      tiktok_status: result?.publishId ? "submitted" : "failed",
      tiktok_publish_id: result?.publishId || "",
      tiktok_mode: result?.mode || config.tiktok.publishMode,
      tiktok_error: "",
      publish_status: job.publish_status || "ready"
    });
    await syncState();
    res.json({ ok: true, job_id: job.job_id, result });
  } catch (error) {
    res.status(400).json({ error: error.message, apiCode: error.apiCode || "" });
  }
});

app.get("/api/youtube/auth-url", (req, res) => {
  try {
    const auth = buildYoutubeAuthUrl({ origin: requestOrigin(req.headers) });
    res.json({
      url: auth.url,
      redirectUri: auth.redirectUri,
      scope: auth.scope
    });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.get("/api/youtube/callback", async (req, res) => {
  try {
    if (req.query?.error) {
      throw new Error(String(req.query.error_description || req.query.error));
    }
    const state = verifyYoutubeOAuthState(String(req.query?.state || ""));
    const token = await exchangeYoutubeCode({
      code: String(req.query?.code || ""),
      redirectUri: state.redirectUri
    });
    if (!token.refreshToken) {
      throw new Error("Google tidak mengembalikan refresh_token. Ulangi Reconnect YouTube dan pastikan prompt consent muncul.");
    }
    const persist = await persistYoutubeReconnect({
      refreshToken: token.refreshToken,
      persistLocal: true,
      persistGithub: true
    });
    reloadConfigFromEnv();
    res.type("html").send(renderYoutubeCallbackPage({ ok: true, token, persist }));
  } catch (error) {
    res.status(400).type("html").send(renderYoutubeCallbackPage({
      ok: false,
      error: error.message,
      persist: {}
    }));
  }
});

app.post("/api/videos", async (req, res) => {
  try {
    const video = await addVideo(req.body || {});
    await syncState();
    res.json(video);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.post("/api/videos/reset-queue", async (req, res) => {
  try {
    const result = await expireStaleAutoDiscoveryQueue({
      targetDate: String(req.body?.target_date || "").trim() || todayDate()
    });
    await syncState();
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.patch("/api/videos/:id", async (req, res) => {
  const item = await patchItem("videos", req.params.id, req.body || {});
  if (!item) {
    res.status(404).json({ error: "Video tidak ditemukan." });
    return;
  }
  await syncState();
  res.json(item);
});

app.post("/api/themes", async (req, res) => {
  const now = new Date().toISOString();
  const item = {
    id: req.body.id || makeId("theme"),
    name: req.body.name || "podcast",
    status: req.body.status || "active",
    language: req.body.language || "id",
    caption_style: req.body.caption_style || "natural",
    post_per_day: Number(req.body.post_per_day || 1),
    created_at: now,
    updated_at: now
  };
  await upsertItem("themes", item);
  await syncState();
  res.json(item);
});

app.patch("/api/themes/:id", async (req, res) => {
  const item = await patchItem("themes", req.params.id, req.body || {});
  if (!item) {
    res.status(404).json({ error: "Theme tidak ditemukan." });
    return;
  }
  await syncState();
  res.json(item);
});

app.post("/api/prompts", async (req, res) => {
  const item = {
    id: req.body.id || makeId("prompt"),
    theme: req.body.theme || "podcast artis",
    hook_style: req.body.hook_style || "emotional curiosity",
    language: req.body.language || "id",
    cta: req.body.cta || "Menurut kamu bagaimana?",
    hashtag_template: req.body.hashtag_template || "#PodcastIndonesia #ReelsIndonesia",
    thumbnail_style: req.body.thumbnail_style || "singkat dan kuat",
    updated_at: new Date().toISOString()
  };
  await upsertItem("prompts", item);
  await syncState();
  res.json(item);
});

app.patch("/api/prompts/:id", async (req, res) => {
  const item = await patchItem("prompts", req.params.id, req.body || {});
  if (!item) {
    res.status(404).json({ error: "Prompt tidak ditemukan." });
    return;
  }
  await syncState();
  res.json(item);
});

app.post("/api/run", async (req, res) => {
  if (activeRun?.status === "running") {
    res.status(409).json({ error: "Masih ada workflow berjalan." });
    return;
  }

  reloadConfigFromEnv();
  const body = req.body || {};
  activeRun = {
    id: makeId("run"),
    status: "running",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    error: "",
    result: null,
    logs: []
  };

  appendRunLog("system", [`Run ${activeRun.id} dimulai.`]);

  captureConsoleForRun(() => runWorkflow({
    publish: Boolean(body.publish),
    theme: body.theme || config.defaultTheme,
    url: body.url || "",
    range: body.range || "",
    sceneMode: body.scene_mode || "podcast",
    clipCount: Number(body.clip_count || process.env.CLIP_COUNT || 1),
    aiProvider: "openai",
    qualityProfile: body.quality_profile || "standard",
    useFrame: boolInput(body.use_frame, config.videoEffects.frameEnabled),
    useFilter: boolInput(body.use_filter, config.videoEffects.filterEnabled),
    useWatermark: boolInput(body.use_watermark, config.videoEffects.watermarkEnabled),
    useMusic: boolInput(body.use_music, boolInput(process.env.BACKGROUND_MUSIC_ENABLED, true)),
    subtitleFont: body.subtitle_font || "Segoe UI Semibold",
    subtitleFontSize: Number(body.subtitle_font_size || 46),
    subtitleMarginV: Number(body.subtitle_margin_v || 550),
    subtitleMarginH: Number(body.subtitle_margin_h || 180)
  }))
    .then((result) => {
      activeRun = {
        ...activeRun,
        status: "completed",
        finishedAt: new Date().toISOString(),
        result
      };
      appendRunLog("system", [`Run selesai: ${result?.status || "completed"}`]);
    })
    .catch((error) => {
      activeRun = {
        ...activeRun,
        status: "failed",
        finishedAt: new Date().toISOString(),
        error: error.message
      };
      appendRunLog("error", [error.message]);
    });

  res.json(activeRun);
});

app.use(express.static(config.publicDir));
app.use((_req, res) => {
  res.sendFile(path.join(config.publicDir, "index.html"));
});

async function listenWithFallback(startPort) {
  let port = startPort;
  while (port < startPort + 20) {
    try {
      await new Promise((resolve, reject) => {
        const server = app.listen(port, "127.0.0.1");
        server.once("listening", resolve);
        server.once("error", reject);
      });
      return port;
    } catch (error) {
      if (error.code !== "EADDRINUSE") throw error;
      port += 1;
    }
  }
  throw new Error("Tidak ada port kosong untuk dashboard.");
}

const port = await listenWithFallback(config.localPort);
console.log(`Dashboard aktif: http://localhost:${port}`);

async function syncState() {
  try {
    await uploadStateToRemote();
  } catch (error) {
    console.warn(`State remote sync dilewati: ${error.message}`);
  }
}

function dateSerial(dateString) {
  const match = String(dateString || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function isAutoDiscoveryVideo(video) {
  return Boolean(
    video?.discovery_source
      || video?.discovery_query
      || String(video?.notes || "").startsWith("Auto discovery:")
  );
}

async function expireStaleAutoDiscoveryQueue({ targetDate }) {
  const targetSerial = dateSerial(targetDate);
  if (targetSerial === null) throw new Error("target_date tidak valid.");

  const ttlDays = Math.max(1, Math.floor(Number(process.env.AUTO_DISCOVER_QUEUE_TTL_DAYS) || 1));
  const videos = await readJson("videos", []);
  const now = new Date().toISOString();
  let expired = 0;

  const nextVideos = videos.map((video) => {
    if (!isAutoDiscoveryVideo(video)) return video;
    if (!resettableQueueStatuses.has(video.status || "queued")) return video;

    const videoSerial = dateSerial(video.target_date);
    if (videoSerial === null || videoSerial + ttlDays > targetSerial) return video;

    expired += 1;
    return {
      ...video,
      status: "expired",
      expired_at: now,
      updated_at: now,
      error_message: `Auto discovery expired setelah melewati target_date ${video.target_date}.`
    };
  });

  if (expired) await writeJson("videos", nextVideos);
  return {
    ok: true,
    expired,
    target_date: targetDate,
    ttl_days: ttlDays
  };
}

function tiktokScopes() {
  return (process.env.TIKTOK_AUTH_SCOPES || "user.info.basic,video.upload,video.publish")
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildTikTokAuthUrl() {
  if (!config.tiktok.clientKey) throw new Error("TIKTOK_CLIENT_KEY belum diisi.");
  if (!config.tiktok.redirectUri) throw new Error("TIKTOK_REDIRECT_URI belum diisi.");

  const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
  url.searchParams.set("client_key", config.tiktok.clientKey);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", tiktokScopes().join(","));
  url.searchParams.set("redirect_uri", config.tiktok.redirectUri);
  url.searchParams.set("state", crypto.randomBytes(16).toString("hex"));
  return url.toString();
}

async function latestTikTokDemoJob(jobId = "") {
  const jobs = await readJson("jobs", []);
  if (jobId) return jobs.find((job) => job.job_id === jobId && job.public_video_url) || null;
  return [...jobs]
    .filter((job) => job.public_video_url)
    .sort((a, b) => {
      const left = String(a.updated_at || a.published_at || a.created_at || "");
      const right = String(b.updated_at || b.published_at || b.created_at || "");
      return right.localeCompare(left);
    })[0] || null;
}

async function persistTikTokTokens() {
  const updates = {
    TIKTOK_ACCESS_TOKEN: config.tiktok.accessToken,
    TIKTOK_REFRESH_TOKEN: config.tiktok.refreshToken,
    TIKTOK_OPEN_ID: config.tiktok.openId,
    TIKTOK_SCOPE: config.tiktok.scope
  };
  const filtered = Object.fromEntries(Object.entries(updates).filter(([, value]) => value));
  if (!Object.keys(filtered).length) return;

  let raw = "";
  try {
    raw = await fs.readFile(envFilePath, "utf8");
  } catch {
    raw = "";
  }

  await fs.writeFile(envFilePath, updateEnvContent(raw, filtered), "utf8");
}

function field(key, label, sensitive = false) {
  return {
    key,
    label,
    sensitive: sensitive || sensitiveEnvKeys.has(key)
  };
}

async function readEnvMap() {
  let raw = "";
  try {
    raw = await fs.readFile(envFilePath, "utf8");
  } catch {
    raw = "";
  }

  const values = {};
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.trim();
    values[key] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return values;
}

async function readDashboardSettings() {
  const fileValues = await readEnvMap();
  return {
    envFile: envFilePath,
    groups: envGroups.map((group) => ({
      ...group,
      fields: group.fields.map((item) => {
        const value = fileValues[item.key] ?? process.env[item.key] ?? "";
        return {
          ...item,
          configured: Boolean(String(value || "").trim()),
          masked: item.sensitive ? maskSecret(value) : "",
          value: item.sensitive ? "" : value
        };
      })
    }))
  };
}

async function saveDashboardSettings(values) {
  const allowed = new Map(envGroups.flatMap((group) => group.fields.map((item) => [item.key, item])));
  const updates = {};

  for (const [key, rawValue] of Object.entries(values || {})) {
    const item = allowed.get(key);
    if (!item) continue;

    const value = normalizeEnvValue(rawValue);
    if (item.sensitive && !value) continue;
    updates[key] = value;
  }

  if (!Object.keys(updates).length) {
    return { ok: true, updated: [], settings: await readDashboardSettings() };
  }

  let raw = "";
  try {
    raw = await fs.readFile(envFilePath, "utf8");
  } catch {
    raw = "";
  }

  const next = updateEnvContent(raw, updates);
  await fs.writeFile(envFilePath, next, "utf8");
  Object.assign(process.env, updates);

  return {
    ok: true,
    updated: Object.keys(updates),
    settings: await readDashboardSettings()
  };
}

function normalizeEnvValue(value) {
  return String(value ?? "").replace(/\r?\n/g, "\\n").trim();
}

function updateEnvContent(raw, updates) {
  const lines = raw.split(/\r?\n/);
  const seen = new Set();
  const next = [];

  for (const line of lines) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match || !Object.prototype.hasOwnProperty.call(updates, match[1])) {
      next.push(line);
      continue;
    }

    const key = match[1];
    if (seen.has(key)) continue;
    next.push(`${key}=${updates[key]}`);
    seen.add(key);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) next.push(`${key}=${value}`);
  }

  return `${next.join("\n").replace(/\s*$/, "")}\n`;
}

function captureConsoleForRun(callback) {
  const original = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console)
  };

  for (const level of Object.keys(original)) {
    console[level] = (...args) => {
      appendRunLog(level, args);
      original[level](...args);
    };
  }

  return Promise.resolve()
    .then(callback)
    .finally(() => {
      console.log = original.log;
      console.warn = original.warn;
      console.error = original.error;
    });
}

function appendRunLog(level, args) {
  if (!activeRun) return;

  const logs = Array.isArray(activeRun.logs) ? activeRun.logs : [];
  logs.push({
    at: new Date().toISOString(),
    level,
    text: maskSecrets(args.map(formatLogArg).join(" "))
  });
  activeRun.logs = logs.slice(-500);
}

function formatLogArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function maskSecrets(text) {
  let masked = String(text || "")
    .replace(/EA[A-Za-z0-9_-]{20,}/g, "[META_TOKEN]")
    .replace(/ya29\.[A-Za-z0-9_.-]+/g, "[GOOGLE_TOKEN]")
    .replace(/\b(act|rft)\.[A-Za-z0-9_.-]{20,}/g, "[TIKTOK_TOKEN]")
    .replace(/AIza[A-Za-z0-9_-]+/g, "[API_KEY]");

  for (const key of sensitiveEnvKeys) {
    const value = process.env[key];
    if (value && String(value).length >= 8) {
      masked = masked.split(String(value)).join(`[${key}]`);
    }
  }
  return masked;
}

function maskSecret(value) {
  const text = String(value || "");
  if (!text) return "";
  if (text.length <= 8) return "configured";
  return `${text.slice(0, 3)}...${text.slice(-3)}`;
}
