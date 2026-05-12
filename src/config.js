import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

function cleanText(value) {
  return String(value || "").trim();
}

function cleanBaseUrl(value) {
  return cleanText(value).replace(/\/+$/, "");
}

function cleanBrandText(value) {
  return cleanText(value).replace(/@emsa\.pro\b/gi, "@clipperemsapro");
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function firstEnv(names, fallback = "") {
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined && value !== "") return value;
  }
  return fallback;
}

function numberEnvFrom(names, fallback) {
  const value = Number(firstEnv(names, ""));
  return Number.isFinite(value) ? value : fallback;
}

function listEnv(...names) {
  const values = [];
  for (const name of names) {
    const raw = process.env[name] || "";
    values.push(...raw.split(/[\n,;]+/).map(cleanText).filter(Boolean));
  }
  return [...new Set(values)];
}

function uniqueList(values) {
  return [...new Set(values.map(cleanText).filter(Boolean))];
}

function encodePathSegment(value) {
  return String(value)
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

function buildConfig() {
  const openaiModels = listEnv("OPENAI_MODELS");
  const openaiModel = cleanText(process.env.OPENAI_MODEL || "gpt-4.1-nano");
  const deepgramApiKeys = cleanText(process.env.DEEPGRAM_API_KEYS)
    ? listEnv("DEEPGRAM_API_KEYS")
    : listEnv("DEEPGRAM_API_KEY");
  const uploadDriver = cleanText(process.env.UPLOAD_DRIVER || "local").toLowerCase();
  const remotePrefix = uploadDriver === "sftp" ? "SFTP" : "FTP";
  const remoteFallbackPrefix = remotePrefix === "SFTP" ? "FTP" : "SFTP";
  const remoteEnvNames = (suffix) => [`${remotePrefix}_${suffix}`, `${remoteFallbackPrefix}_${suffix}`];
  const remotePortEnvNames = uploadDriver === "sftp" ? ["SFTP_PORT"] : remoteEnvNames("PORT");
  const remoteHost = cleanText(firstEnv(remoteEnvNames("HOST")));
  const remoteUser = cleanText(firstEnv(remoteEnvNames("USER")));
  const remotePassword = firstEnv(remoteEnvNames("PASSWORD"));
  const remotePrivateKey = firstEnv(["SFTP_PRIVATE_KEY"])
    .replace(/\\n/g, "\n")
    .trim();
  const remoteDefaultPort = uploadDriver === "sftp" ? 65002 : 21;
  const tiktokUploadPaused = boolEnv("TIKTOK_UPLOAD_PAUSED", true);

  return {
    rootDir,
    srcDir: path.join(rootDir, "src"),
    publicDir: path.join(rootDir, "public"),
    dataDir: path.join(rootDir, "data"),
    generatedDir: path.join(rootDir, "generated"),
    generatedVideoDir: path.join(rootDir, "generated", "videos"),
    thumbnailDir: path.join(rootDir, "generated", "thumbnails"),
    metadataDir: path.join(rootDir, "generated", "metadata"),
    logDir: path.join(rootDir, "generated", "logs"),
    localPort: numberEnv("LOCAL_PORT", 8788),
    timezone: cleanText(process.env.APP_TIMEZONE || "Asia/Jakarta"),
    publicBaseUrl: cleanBaseUrl(process.env.PUBLIC_BASE_URL),
    uploadDriver,
    dryRun: boolEnv("DRY_RUN", true),
    autoPublish: boolEnv("AUTO_PUBLISH", false),
    cleanupLocalAfterPublish: boolEnv("CLEANUP_LOCAL_AFTER_PUBLISH", false),
    videoEffects: {
      frameEnabled: boolEnv("VIDEO_FRAME_ENABLED", true),
      filterEnabled: boolEnv("VIDEO_FILTER_ENABLED", true),
      watermarkEnabled: boolEnv("VIDEO_WATERMARK_ENABLED", true),
      lowerThirdEnabled: boolEnv("VIDEO_LOWER_THIRD_ENABLED", true),
      lowerThirdBrand: cleanBrandText(process.env.VIDEO_LOWER_THIRD_BRAND || "@clipperemsapro | Podcast Highlight"),
      frameAssetPath: path.resolve(rootDir, cleanText(process.env.VIDEO_FRAME_ASSET || "assets/branding/frame-1080x1920.png")),
      watermarkAssetPath: path.resolve(rootDir, cleanText(process.env.VIDEO_WATERMARK_ASSET || "assets/branding/logo.png")),
      crf: numberEnv("VIDEO_EFFECT_CRF", numberEnv("FINAL_RENDER_CRF", 27)),
      preset: cleanText(process.env.VIDEO_EFFECT_PRESET || "veryfast")
    },
    defaultTheme: cleanText(process.env.DEFAULT_THEME || "auto"),
    postCron: cleanText(process.env.POST_CRON || "7 5 * * *"),
    dashboardPin: cleanText(process.env.AUTO_DASHBOARD_PIN),
    dashboardAllowRemote: boolEnv("AUTO_DASHBOARD_ALLOW_REMOTE", false),
    graphApiVersion: cleanText(process.env.GRAPH_API_VERSION || "v25.0"),
    apiCheckTimeoutMs: numberEnv("API_CHECK_TIMEOUT_SECONDS", 30) * 1000,
    remoteUploadRequired: boolEnv("REMOTE_UPLOAD_REQUIRED", false),
    instagram: {
      enabled: boolEnv("INSTAGRAM_UPLOAD_ENABLED", true),
      igUserId: cleanText(process.env.INSTAGRAM_IG_USER_ID),
      accessToken: process.env.INSTAGRAM_ACCESS_TOKEN || "",
      maxUploadBytes: numberEnv("INSTAGRAM_MAX_UPLOAD_BYTES", 7800000)
    },
    facebook: {
      enabled: boolEnv("FACEBOOK_UPLOAD_ENABLED", true),
      pageId: cleanText(process.env.FACEBOOK_PAGE_ID),
      accessToken: process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "",
      userAccessToken: process.env.FACEBOOK_USER_ACCESS_TOKEN || "",
      autoRefreshToken: boolEnv("AUTO_REFRESH_FACEBOOK_TOKEN", true),
      mediaType: cleanText(process.env.FACEBOOK_MEDIA_TYPE || "reel").toLowerCase(),
      videoState: cleanText(process.env.FACEBOOK_VIDEO_STATE || "PUBLISHED"),
      titlePrefix: cleanText(process.env.FACEBOOK_TITLE_PREFIX)
    },
    meta: {
      appId: cleanText(process.env.META_APP_ID),
      appSecret: process.env.META_APP_SECRET || "",
      autoRefreshInstagramToken: boolEnv("AUTO_REFRESH_INSTAGRAM_TOKEN", true),
      tokenRefreshBeforeDays: numberEnv("TOKEN_REFRESH_BEFORE_DAYS", 10)
    },
    youtube: {
      enabled: boolEnv("YOUTUBE_UPLOAD_ENABLED", false),
      customThumbnailEnabled: boolEnv("YOUTUBE_CUSTOM_THUMBNAIL_ENABLED", false),
      clientId: cleanText(process.env.YOUTUBE_CLIENT_ID),
      clientSecret: process.env.YOUTUBE_CLIENT_SECRET || "",
      refreshToken: process.env.YOUTUBE_REFRESH_TOKEN || "",
      redirectUri: cleanText(process.env.YOUTUBE_REDIRECT_URI),
      privacyStatus: cleanText(process.env.YOUTUBE_PRIVACY_STATUS || "public"),
      categoryId: cleanText(process.env.YOUTUBE_CATEGORY_ID || "22"),
      tags: listEnv("YOUTUBE_TAGS"),
      titlePrefix: cleanText(process.env.YOUTUBE_TITLE_PREFIX),
      descriptionFooter: cleanText(process.env.YOUTUBE_DESCRIPTION_FOOTER)
    },
    tiktok: {
      enabled: !tiktokUploadPaused && boolEnv("TIKTOK_UPLOAD_ENABLED", false),
      paused: tiktokUploadPaused,
      clientKey: cleanText(process.env.TIKTOK_CLIENT_KEY),
      clientSecret: process.env.TIKTOK_CLIENT_SECRET || "",
      accessToken: process.env.TIKTOK_ACCESS_TOKEN || "",
      refreshToken: process.env.TIKTOK_REFRESH_TOKEN || "",
      openId: cleanText(process.env.TIKTOK_OPEN_ID),
      scope: cleanText(process.env.TIKTOK_SCOPE),
      redirectUri: cleanText(process.env.TIKTOK_REDIRECT_URI),
      publishMode: cleanText(process.env.TIKTOK_PUBLISH_MODE || "direct").toLowerCase(),
      privacyLevel: cleanText(process.env.TIKTOK_PRIVACY_LEVEL || "SELF_ONLY"),
      disableDuet: boolEnv("TIKTOK_DISABLE_DUET", false),
      disableComment: boolEnv("TIKTOK_DISABLE_COMMENT", false),
      disableStitch: boolEnv("TIKTOK_DISABLE_STITCH", false),
      coverTimestampMs: numberEnv("TIKTOK_COVER_TIMESTAMP_MS", 1000)
    },
    threads: {
      enabled: boolEnv("THREADS_UPLOAD_ENABLED", false),
      accessToken: process.env.THREADS_ACCESS_TOKEN || "",
      userId: cleanText(process.env.THREADS_USER_ID),
      apiVersion: cleanText(process.env.THREADS_API_VERSION || "v1.0"),
      autoRefreshToken: boolEnv("AUTO_REFRESH_THREADS_TOKEN", true),
      tokenIssuedAt: cleanText(process.env.THREADS_TOKEN_ISSUED_AT)
    },
    instagramIgUserId: cleanText(process.env.INSTAGRAM_IG_USER_ID),
    instagramAccessToken: cleanText(process.env.INSTAGRAM_ACCESS_TOKEN),
    ai: {
      provider: "openai"
    },
    openai: {
      apiKey: process.env.OPENAI_API_KEY || "",
      model: openaiModel,
      models: uniqueList([openaiModel, "gpt-4.1-nano", ...openaiModels, "gpt-5-nano", "gpt-4o-mini"]),
      temperature: numberEnv("OPENAI_TEMPERATURE", 0.45),
      requestTimeoutMs: numberEnv("AI_REQUEST_TIMEOUT_SECONDS", 25) * 1000
    },
    deepgram: {
      enabled: boolEnv("DEEPGRAM_ENABLED", true),
      apiKey: deepgramApiKeys[0] || "",
      apiKeys: deepgramApiKeys,
      model: cleanText(process.env.DEEPGRAM_MODEL || "nova-3"),
      language: cleanText(process.env.DEEPGRAM_LANGUAGE || process.env.VIDEO_LANGUAGE || "id"),
      timeoutSeconds: numberEnv("DEEPGRAM_TIMEOUT_SECONDS", 900)
    },
    ftp: {
      driver: uploadDriver,
      label: uploadDriver === "sftp" ? "SFTP" : "FTP",
      envPrefix: remotePrefix,
      host: remoteHost,
      port: numberEnvFrom(remotePortEnvNames, remoteDefaultPort),
      user: remoteUser,
      password: remotePassword,
      privateKey: remotePrivateKey,
      passphrase: firstEnv(["SFTP_PASSPHRASE"]),
      remoteDir: cleanText(firstEnv(remoteEnvNames("REMOTE_DIR"), "/public_html/ig-generated")),
      timeoutMs: numberEnvFrom(remoteEnvNames("TIMEOUT_SECONDS"), 420) * 1000,
      uploadTimeoutMs: numberEnvFrom(remoteEnvNames("UPLOAD_TIMEOUT_SECONDS"), 1800) * 1000,
      cleanupTimeoutMs: numberEnvFrom(remoteEnvNames("CLEANUP_TIMEOUT_SECONDS"), 600) * 1000,
      stateTimeoutMs: numberEnvFrom(remoteEnvNames("STATE_TIMEOUT_SECONDS"), 180) * 1000,
      precheckTimeoutMs: numberEnvFrom(remoteEnvNames("PRECHECK_TIMEOUT_SECONDS"), 12) * 1000,
      precheckRetries: Math.max(1, numberEnvFrom(remoteEnvNames("PRECHECK_RETRIES"), 5)),
      retries: Math.max(1, numberEnvFrom(remoteEnvNames("UPLOAD_RETRIES"), 4)),
      publicUrlRetries: Math.max(1, numberEnvFrom(remoteEnvNames("PUBLIC_URL_RETRIES"), 8)),
      publicUrlRetryDelayMs: Math.max(250, numberEnvFrom(remoteEnvNames("PUBLIC_URL_RETRY_DELAY_MS"), 2500))
    },
    clipper: {
      rootDir: path.resolve(rootDir, cleanText(process.env.CLIPPER_ROOT || "clipper")),
      pythonCommand: cleanText(process.env.PYTHON_CMD || (process.platform === "win32" ? "python" : "python3")),
      clipCount: numberEnv("CLIP_COUNT", 1),
      minClipSeconds: numberEnv("MIN_CLIP_SECONDS", 40),
      maxClipSeconds: numberEnv("MAX_CLIP_SECONDS", 60)
    }
  };
}

export const config = buildConfig();

export function reloadConfigFromEnv() {
  dotenv.config({ override: true });
  const next = buildConfig();
  for (const key of Object.keys(config)) {
    delete config[key];
  }
  Object.assign(config, next);
  return config;
}

export function shouldUploadToFtp() {
  return shouldUploadToRemote();
}

export function shouldUploadToRemote() {
  return config.uploadDriver === "ftp" || config.uploadDriver === "sftp";
}

export function canPublish() {
  return config.autoPublish && !config.dryRun;
}

export function publicGeneratedUrl(folder, filename) {
  if (!config.publicBaseUrl) return "";
  return `${config.publicBaseUrl}/${folder}/${encodePathSegment(filename)}`;
}

export function publicVideoUrl(filename) {
  return publicGeneratedUrl("videos", filename);
}

export function publicThumbnailUrl(filename) {
  return publicGeneratedUrl("thumbnails", filename);
}

export function publicMetadataUrl(filename) {
  return publicGeneratedUrl("metadata", filename);
}
