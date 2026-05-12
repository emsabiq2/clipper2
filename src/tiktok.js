import axios from "axios";
import fs from "node:fs";
import fsp from "node:fs/promises";
import { config } from "./config.js";

const apiBaseUrl = "https://open.tiktokapis.com";
const oauthTokenUrl = `${apiBaseUrl}/v2/oauth/token/`;

function apiUrl(pathName) {
  return `${apiBaseUrl}${pathName}`;
}

function applyTokens(data) {
  if (data.access_token) {
    process.env.TIKTOK_ACCESS_TOKEN = data.access_token;
    config.tiktok.accessToken = data.access_token;
  }
  if (data.refresh_token) {
    process.env.TIKTOK_REFRESH_TOKEN = data.refresh_token;
    config.tiktok.refreshToken = data.refresh_token;
  }
  if (data.open_id) {
    process.env.TIKTOK_OPEN_ID = data.open_id;
    config.tiktok.openId = data.open_id;
  }
  if (data.scope) {
    process.env.TIKTOK_SCOPE = data.scope;
    config.tiktok.scope = data.scope;
  }
  return data;
}

function assertTikTokAppConfig() {
  const missing = [];
  if (!config.tiktok.clientKey) missing.push("TIKTOK_CLIENT_KEY");
  if (!config.tiktok.clientSecret) missing.push("TIKTOK_CLIENT_SECRET");
  if (missing.length) throw new Error(`Missing TikTok app config: ${missing.join(", ")}`);
}

function assertTikTokPublishConfig() {
  assertTikTokAppConfig();
  if (!config.tiktok.accessToken && !config.tiktok.refreshToken) {
    throw new Error("Missing TikTok token: TIKTOK_ACCESS_TOKEN atau TIKTOK_REFRESH_TOKEN wajib diisi.");
  }
}

function wrapTikTokError(error, prefix) {
  const data = error.response?.data || {};
  const apiError = data.error || {};
  const code = data.error_code || apiError.code || data.error || "";
  const message = data.error_description || apiError.message || data.message || error.message;
  const logId = data.log_id || apiError.log_id || "";
  const wrapped = new Error(`${prefix}: ${message}${code ? ` [${code}]` : ""}${logId ? ` log_id=${logId}` : ""}`);
  wrapped.apiCode = code;
  wrapped.apiError = data;
  return wrapped;
}

async function postForm(url, values) {
  try {
    const response = await axios.post(url, new URLSearchParams(values), {
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache"
      },
      timeout: 60000
    });
    return response.data || {};
  } catch (error) {
    throw wrapTikTokError(error, "TikTok OAuth request failed");
  }
}

async function postJson(pathName, body, accessToken = config.tiktok.accessToken) {
  try {
    const response = await axios.post(apiUrl(pathName), body || {}, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8"
      },
      timeout: 120000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
    const data = response.data || {};
    if (data.error?.code && data.error.code !== "ok") {
      const error = new Error(data.error.message || data.error.code);
      error.response = { data };
      throw error;
    }
    return data;
  } catch (error) {
    throw wrapTikTokError(error, "TikTok API request failed");
  }
}

export async function exchangeTikTokCode({ code, redirectUri = config.tiktok.redirectUri }) {
  assertTikTokAppConfig();
  if (!code) throw new Error("TikTok authorization code kosong.");
  if (!redirectUri) throw new Error("TIKTOK_REDIRECT_URI wajib sama dengan callback yang dipakai login.");

  return applyTokens(await postForm(oauthTokenUrl, {
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    code,
    grant_type: "authorization_code",
    redirect_uri: redirectUri
  }));
}

export async function refreshTikTokAccessToken() {
  assertTikTokAppConfig();
  if (!config.tiktok.refreshToken) throw new Error("TIKTOK_REFRESH_TOKEN belum diisi.");

  return applyTokens(await postForm(oauthTokenUrl, {
    client_key: config.tiktok.clientKey,
    client_secret: config.tiktok.clientSecret,
    grant_type: "refresh_token",
    refresh_token: config.tiktok.refreshToken
  }));
}

export async function ensureTikTokAccessToken({ forceRefresh = false } = {}) {
  assertTikTokPublishConfig();
  if (forceRefresh || config.tiktok.refreshToken) {
    try {
      await refreshTikTokAccessToken();
    } catch (error) {
      if (!config.tiktok.accessToken) throw error;
      console.warn(`TikTok token refresh dilewati: ${error.message}`);
    }
  }
  return config.tiktok.accessToken;
}

export async function queryTikTokCreatorInfo() {
  const accessToken = await ensureTikTokAccessToken();
  const data = await postJson("/v2/post/publish/creator_info/query/", {}, accessToken);
  return data.data || {};
}

function normalizeCaption(value) {
  return String(value || "")
    .replace(/\s+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 2200);
}

function pickPrivacyLevel(options = []) {
  const values = options.map((item) => String(item || "").trim()).filter(Boolean);
  const desired = config.tiktok.privacyLevel || "SELF_ONLY";
  if (values.includes(desired)) return desired;
  if (values.includes("SELF_ONLY")) return "SELF_ONLY";
  return values[0] || desired;
}

function fileUploadSourceInfo(stat) {
  const defaultChunkSize = 10 * 1000 * 1000;
  const chunkSize = stat.size <= 64 * 1000 * 1000 ? stat.size : defaultChunkSize;
  const totalChunkCount = stat.size <= chunkSize ? 1 : Math.floor(stat.size / chunkSize);
  return {
    source: "FILE_UPLOAD",
    video_size: stat.size,
    chunk_size: chunkSize,
    total_chunk_count: totalChunkCount
  };
}

async function uploadVideoFile(uploadUrl, videoPath, stat) {
  const { chunk_size: chunkSize, total_chunk_count: totalChunkCount } = fileUploadSourceInfo(stat);

  for (let index = 0; index < totalChunkCount; index += 1) {
    const start = index * chunkSize;
    const end = index === totalChunkCount - 1 ? stat.size - 1 : Math.min(start + chunkSize, stat.size) - 1;
    await axios.put(uploadUrl, fs.createReadStream(videoPath, { start, end }), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${stat.size}`
      },
      timeout: 15 * 60 * 1000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    }).catch((error) => {
      throw wrapTikTokError(error, "TikTok file upload failed");
    });
  }
}

function isUrlOwnershipError(error) {
  return String(error?.apiCode || error?.message || "").includes("url_ownership_unverified");
}

function isUnauditedDirectPostError(error) {
  return String(error?.apiCode || error?.message || "").includes("unaudited_client_can_only_post_to_private_accounts");
}

async function publishDirect({ videoUrl, videoPath, caption, source = "PULL_FROM_URL" }) {
  const creator = await queryTikTokCreatorInfo();
  const privacyLevel = pickPrivacyLevel(creator.privacy_level_options || []);
  const stat = source === "FILE_UPLOAD" ? await fsp.stat(videoPath) : null;
  const data = await postJson("/v2/post/publish/video/init/", {
    post_info: {
      title: normalizeCaption(caption),
      privacy_level: privacyLevel,
      disable_duet: Boolean(config.tiktok.disableDuet || creator.duet_disabled),
      disable_comment: Boolean(config.tiktok.disableComment || creator.comment_disabled),
      disable_stitch: Boolean(config.tiktok.disableStitch || creator.stitch_disabled),
      video_cover_timestamp_ms: config.tiktok.coverTimestampMs
    },
    source_info: source === "FILE_UPLOAD"
      ? fileUploadSourceInfo(stat)
      : {
        source: "PULL_FROM_URL",
        video_url: videoUrl
      }
  });

  if (source === "FILE_UPLOAD") {
    const uploadUrl = data.data?.upload_url || "";
    if (!uploadUrl) throw new Error("TikTok tidak mengembalikan upload_url untuk file upload.");
    await uploadVideoFile(uploadUrl, videoPath, stat);
  }

  return {
    publishId: data.data?.publish_id || "",
    mode: "direct",
    source,
    privacyLevel,
    creatorUsername: creator.creator_username || "",
    type: "tiktok_direct_post"
  };
}

async function publishInbox({ videoUrl, videoPath, source = "PULL_FROM_URL" }) {
  await ensureTikTokAccessToken();
  const stat = source === "FILE_UPLOAD" ? await fsp.stat(videoPath) : null;
  const data = await postJson("/v2/post/publish/inbox/video/init/", {
    source_info: source === "FILE_UPLOAD"
      ? fileUploadSourceInfo(stat)
      : {
        source: "PULL_FROM_URL",
        video_url: videoUrl
      }
  });

  if (source === "FILE_UPLOAD") {
    const uploadUrl = data.data?.upload_url || "";
    if (!uploadUrl) throw new Error("TikTok tidak mengembalikan upload_url untuk file upload.");
    await uploadVideoFile(uploadUrl, videoPath, stat);
  }

  return {
    publishId: data.data?.publish_id || "",
    mode: "inbox",
    source,
    type: "tiktok_inbox_upload"
  };
}

export async function publishToTikTok({ videoUrl, videoPath, caption }) {
  if (!videoUrl) throw new Error("TikTok publish butuh public video URL.");
  assertTikTokPublishConfig();

  if (config.tiktok.publishMode === "inbox") {
    try {
      return await publishInbox({ videoUrl });
    } catch (error) {
      if (!videoPath || !isUrlOwnershipError(error)) throw error;
      console.warn(`TikTok inbox URL upload ditolak, coba file upload: ${error.message}`);
      return publishInbox({ videoUrl, videoPath, source: "FILE_UPLOAD" });
    }
  }

  try {
    return await publishDirect({ videoUrl, videoPath, caption });
  } catch (error) {
    if (videoPath && isUrlOwnershipError(error)) {
      console.warn(`TikTok direct URL upload ditolak, coba file upload: ${error.message}`);
      return publishDirect({ videoUrl, videoPath, caption, source: "FILE_UPLOAD" });
    }
    if (isUnauditedDirectPostError(error)) {
      console.warn(`TikTok direct post dibatasi audit app, fallback ke inbox upload: ${error.message}`);
      return publishInbox({ videoUrl, videoPath });
    }
    if (config.tiktok.publishMode === "direct") throw error;
    console.warn(`TikTok direct post gagal, coba inbox upload: ${error.message}`);
    return publishInbox({ videoUrl, videoPath });
  }
}
