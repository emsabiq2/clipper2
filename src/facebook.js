import fs from "node:fs";
import fsp from "node:fs/promises";
import axios from "axios";
import { config } from "./config.js";
import { ensureFreshFacebookToken } from "./facebook-token.js";

function graphUrl(apiPath) {
  return `https://graph.facebook.com/${config.graphApiVersion}/${apiPath}`;
}

function graphVideoUrl(apiPath) {
  return `https://graph-video.facebook.com/${config.graphApiVersion}/${apiPath}`;
}

function assertFacebookConfig() {
  const missing = [];
  if (!config.facebook.pageId) missing.push("FACEBOOK_PAGE_ID");
  if (!config.facebook.accessToken && !config.facebook.userAccessToken) {
    missing.push("FACEBOOK_PAGE_ACCESS_TOKEN atau FACEBOOK_USER_ACCESS_TOKEN");
  }
  if (missing.length) throw new Error(`Missing Facebook config: ${missing.join(", ")}`);
}

function wrapFacebookError(error, prefix) {
  const apiError = error.response?.data?.error;
  if (!apiError) {
    const detail = error.response?.data
      ? ` - ${JSON.stringify(error.response.data).slice(0, 600)}`
      : "";
    return new Error(`${prefix}: ${error.message}${detail}`);
  }

  const wrapped = new Error(
    `${prefix}: ${apiError.message} ` +
      `[code ${apiError.code || ""}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
  );
  wrapped.apiCode = apiError.code;
  wrapped.apiSubcode = apiError.error_subcode;
  wrapped.apiError = apiError;
  return wrapped;
}

function normalizeTitle(value) {
  const title = [config.facebook.titlePrefix, value]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return (title || "Podcast Clip").slice(0, 100);
}

function normalizeDescription(value) {
  return String(value || "").slice(0, 4900);
}

async function publishFacebookVideo({ videoUrl, title, description }) {
  if (!videoUrl) throw new Error("Facebook video upload butuh public video URL.");

  const body = new URLSearchParams({
    access_token: config.facebook.accessToken,
    file_url: videoUrl,
    title: normalizeTitle(title),
    description: normalizeDescription(description),
    published: String(config.facebook.videoState).toUpperCase() === "PUBLISHED" ? "true" : "false"
  });

  try {
    const response = await axios.post(graphVideoUrl(`${config.facebook.pageId}/videos`), body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 180000
    });
    const id = response.data?.id || "";
    return {
      videoId: id,
      url: id ? `https://www.facebook.com/${id}` : "",
      type: "facebook_video"
    };
  } catch (error) {
    throw wrapFacebookError(error, "Facebook video upload failed");
  }
}

async function startFacebookReel() {
  try {
    const response = await axios.post(graphUrl(`${config.facebook.pageId}/video_reels`), null, {
      params: {
        access_token: config.facebook.accessToken,
        upload_phase: "start"
      },
      timeout: 60000
    });
    const videoId = response.data?.video_id || "";
    const uploadUrl = response.data?.upload_url || "";
    if (!videoId || !uploadUrl) {
      throw new Error(`Facebook tidak mengembalikan video_id/upload_url: ${JSON.stringify(response.data)}`);
    }
    return { videoId, uploadUrl };
  } catch (error) {
    throw wrapFacebookError(error, "Facebook reel start failed");
  }
}

async function uploadFacebookReelFromUrl({ uploadUrl, videoUrl }) {
  if (!videoUrl) throw new Error("Facebook Reel butuh public video URL.");
  try {
    const response = await axios.post(uploadUrl, null, {
      headers: {
        Authorization: `OAuth ${config.facebook.accessToken}`,
        file_url: videoUrl
      },
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
    if (response.data?.success === false) {
      throw new Error(`Facebook menolak URL upload: ${JSON.stringify(response.data)}`);
    }
  } catch (error) {
    throw wrapFacebookError(error, "Facebook reel URL upload failed");
  }
}

async function uploadFacebookReelFromFile({ uploadUrl, videoPath }) {
  if (!videoPath) throw new Error("Facebook Reel butuh videoPath untuk upload file.");
  const stat = await fsp.stat(videoPath);
  try {
    await axios.post(uploadUrl, fs.createReadStream(videoPath), {
      headers: {
        Authorization: `OAuth ${config.facebook.accessToken}`,
        offset: "0",
        file_size: String(stat.size),
        "Content-Length": String(stat.size),
        "Content-Type": "application/octet-stream"
      },
      timeout: 300000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
  } catch (error) {
    throw wrapFacebookError(error, "Facebook reel file upload failed");
  }
}

async function finishFacebookReel({ videoId, title, description }) {
  try {
    const response = await axios.post(graphUrl(`${config.facebook.pageId}/video_reels`), null, {
      params: {
        access_token: config.facebook.accessToken,
        video_id: videoId,
        upload_phase: "finish",
        video_state: config.facebook.videoState || "PUBLISHED",
        title: normalizeTitle(title),
        description: normalizeDescription(description)
      },
      timeout: 60000
    });
    return {
      videoId,
      postId: response.data?.post_id || "",
      url: videoId ? `https://www.facebook.com/reel/${videoId}` : "",
      type: "facebook_reel"
    };
  } catch (error) {
    throw wrapFacebookError(error, "Facebook reel publish failed");
  }
}

async function publishFacebookReel({ videoUrl, videoPath, title, description }) {
  const started = await startFacebookReel();
  try {
    await uploadFacebookReelFromUrl({ uploadUrl: started.uploadUrl, videoUrl });
  } catch (error) {
    console.warn(`Facebook reel URL upload gagal, coba upload file lokal: ${error.message}`);
    await uploadFacebookReelFromFile({ uploadUrl: started.uploadUrl, videoPath });
  }
  return finishFacebookReel({
    videoId: started.videoId,
    title,
    description
  });
}

async function setFacebookCustomThumbnail({ videoId, thumbnailPath }) {
  if (!videoId || !thumbnailPath) return false;

  let stat;
  try {
    stat = await fsp.stat(thumbnailPath);
  } catch (error) {
    console.warn(`Facebook thumbnail file tidak ditemukan, dilewati: ${error.message}`);
    return false;
  }
  if (!stat.size) {
    console.warn("Facebook thumbnail file kosong, dilewati.");
    return false;
  }

  try {
    const buffer = await fsp.readFile(thumbnailPath);
    const blob = new Blob([buffer], { type: "image/jpeg" });
    const form = new FormData();
    form.append("source", blob, "thumbnail.jpg");
    form.append("is_preferred", "true");
    form.append("access_token", config.facebook.accessToken);

    const response = await axios.post(graphUrl(`${videoId}/thumbnails`), form, {
      timeout: 60000,
      maxBodyLength: Infinity,
      maxContentLength: Infinity
    });
    console.log("FB CUSTOM THUMBNAIL SET:", response.data);
    return true;
  } catch (error) {
    const wrapped = wrapFacebookError(error, "Facebook thumbnail upload failed");
    console.warn(wrapped.message);
    return false;
  }
}

export async function publishToFacebook({ videoUrl, videoPath, title, description, thumbnailPath }) {
  assertFacebookConfig();
  await ensureFreshFacebookToken({ refreshValid: false });

  let result;
  if (config.facebook.mediaType === "video") {
    result = await publishFacebookVideo({ videoUrl, title, description });
  } else {
    try {
      result = await publishFacebookReel({ videoUrl, videoPath, title, description });
    } catch (error) {
      console.warn(`Facebook Reel gagal, coba upload sebagai Page video: ${error.message}`);
      try {
        const fallback = await publishFacebookVideo({ videoUrl, title, description });
        result = { ...fallback, fallbackFrom: "facebook_reel" };
      } catch (fallbackError) {
        throw new Error(`${error.message}; fallback Page video juga gagal: ${fallbackError.message}`);
      }
    }
  }

  if (result?.videoId && thumbnailPath) {
    const ok = await setFacebookCustomThumbnail({ videoId: result.videoId, thumbnailPath });
    if (ok) result.customThumbnail = true;
  }

  return result;
}
