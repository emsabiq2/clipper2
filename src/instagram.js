import axios from "axios";
import { config } from "./config.js";
import { ensureFreshInstagramToken } from "./instagram-token.js";

function apiUrl(apiPath) {
  return `https://graph.facebook.com/${config.graphApiVersion}/${apiPath}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assertInstagramConfig() {
  const missing = [];
  if (!config.instagram.igUserId) missing.push("INSTAGRAM_IG_USER_ID");
  if (!config.instagram.accessToken) missing.push("INSTAGRAM_ACCESS_TOKEN");

  if (missing.length) {
    throw new Error(`Missing Instagram config: ${missing.join(", ")}`);
  }
}

function isMetaMediaUploadFailed2207076(error) {
  const message = String(error?.message || "");
  const apiSubcode = error?.apiSubcode;
  const apiError = error?.apiError || {};

  return (
    message.includes("2207076") ||
    apiSubcode === 2207076 ||
    apiError.error_subcode === 2207076 ||
    message.toLowerCase().includes("media upload has failed")
  );
}

function isRuploadProcessingFailure(error) {
  const message = String(error?.message || "");
  return (
    message.includes("ProcessingFailedError") ||
    message.includes("Rupload gagal") ||
    message.toLowerCase().includes("request processing failed")
  );
}

function getReelUploadMethod() {
  return String(process.env.INSTAGRAM_REEL_UPLOAD_METHOD || "video_url")
    .trim()
    .toLowerCase();
}

function positiveIntEnv(name, fallback, max = 30) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function describeRequestError(error) {
  if (error?.response) {
    return `status=${error.response.status}, data=${JSON.stringify(error.response.data || {})}`;
  }

  return error?.message || error?.code || error?.name || "unknown_error";
}

function isVideoStatus(status) {
  return (status >= 200 && status < 300) || status === 206;
}

function urlLooksLikeMp4(videoUrl) {
  return String(videoUrl || "").split("?")[0].toLowerCase().endsWith(".mp4");
}

function isAcceptableVideoContentType(contentType, videoUrl) {
  const normalized = String(contentType || "").toLowerCase();
  return (
    normalized.includes("video/mp4") ||
    normalized.includes("application/octet-stream") ||
    (!normalized && urlLooksLikeMp4(videoUrl))
  );
}

function assertVideoProbe({ method, status, contentType, contentLength, bytes }, videoUrl) {
  if (!isVideoStatus(status)) {
    throw new Error(`${method} status=${status}`);
  }

  if (!isAcceptableVideoContentType(contentType, videoUrl)) {
    throw new Error(`${method} content-type bukan MP4: ${contentType || "kosong"}`);
  }

  if (method === "GET" && !bytes) {
    throw new Error("GET tidak mengembalikan byte video.");
  }

  return {
    contentType,
    contentLength: contentLength ? Number(contentLength) : 0,
    bytes: bytes || 0
  };
}

async function probeVideoHead(videoUrl, attempt) {
  const response = await axios.head(videoUrl, {
    headers: {
      "User-Agent": "facebookexternalhit/1.1",
      Accept: "video/mp4,*/*"
    },
    timeout: 30000,
    maxRedirects: 5,
    validateStatus: () => true
  });

  const contentType = response.headers?.["content-type"] || "";
  const contentLength = response.headers?.["content-length"] || "";

  console.log("IG VIDEO URL HEAD:", {
    attempt,
    status: response.status,
    contentType,
    contentLength
  });

  return {
    method: "HEAD",
    status: response.status,
    contentType,
    contentLength,
    bytes: 0
  };
}

async function probeVideoRange(videoUrl, attempt) {
  const response = await axios.get(videoUrl, {
    responseType: "arraybuffer",
    headers: {
      "User-Agent": "facebookexternalhit/1.1",
      Accept: "video/mp4,*/*",
      Range: "bytes=0-2047"
    },
    timeout: 45000,
    maxRedirects: 5,
    maxContentLength: 12 * 1024 * 1024,
    validateStatus: () => true
  });

  const contentType = response.headers?.["content-type"] || "";
  const contentLength = response.headers?.["content-length"] || "";
  const bytes = Buffer.from(response.data || []).length;

  console.log("IG VIDEO URL GET:", {
    attempt,
    status: response.status,
    contentType,
    contentLength,
    bytes
  });

  return {
    method: "GET",
    status: response.status,
    contentType,
    contentLength,
    bytes
  };
}

async function postForm(apiPath, fields) {
  const body = new URLSearchParams({
    ...fields,
    access_token: config.instagram.accessToken
  });

  try {
    const response = await axios.post(apiUrl(apiPath), body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 60000
    });

    return response.data;
  } catch (error) {
    const apiError = error.response?.data?.error;

    if (apiError) {
      const wrapped = new Error(
        `Instagram API error (${error.response.status}): ${apiError.message} ` +
          `[code ${apiError.code}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
      );

      wrapped.apiCode = apiError.code;
      wrapped.apiSubcode = apiError.error_subcode;
      wrapped.apiError = apiError;
      throw wrapped;
    }

    throw error;
  }
}

async function getContainerStatus(containerId) {
  const response = await axios.get(apiUrl(containerId), {
    params: {
      fields: "id,status_code,status",
      access_token: config.instagram.accessToken
    },
    timeout: 30000
  });

  return response.data || {};
}

async function waitForContainerReady(containerId, label = "reel") {
  const maxAttempts = positiveIntEnv("INSTAGRAM_CONTAINER_MAX_ATTEMPTS", 90, 180);
  const pollMs = positiveIntEnv("INSTAGRAM_CONTAINER_POLL_SECONDS", 6, 60) * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await getContainerStatus(containerId);
    const code = status.status_code || "";

    console.log("IG CONTAINER STATUS:", {
      attempt,
      containerId,
      status_code: status.status_code,
      status: status.status
    });

    if (code === "FINISHED") return status;

    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(
        `Instagram ${label} gagal diproses. ` +
          `container=${containerId}, status_code=${code}, status=${status.status || ""}`
      );
    }

    await sleep(pollMs);
  }

  const waitedMinutes = Math.round((maxAttempts * pollMs) / 60000);
  throw new Error(`Instagram ${label} belum siap setelah ${waitedMinutes} menit: ${containerId}`);
}

async function assertPublicVideoUrl(videoUrl) {
  if (!videoUrl) {
    throw new Error("videoUrl kosong, tidak bisa publish Reels.");
  }

  console.log("IG REEL VIDEO URL:", videoUrl);

  const maxAttempts = positiveIntEnv("INSTAGRAM_VIDEO_URL_CHECK_ATTEMPTS", 8, 20);
  const delayMs = positiveIntEnv("INSTAGRAM_VIDEO_URL_CHECK_DELAY_SECONDS", 8, 60) * 1000;
  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const headProbe = await probeVideoHead(videoUrl, attempt);
      return assertVideoProbe(headProbe, videoUrl);
    } catch (error) {
      lastError = new Error(`HEAD gagal: ${describeRequestError(error)}`);
      console.log("IG VIDEO URL HEAD belum siap:", {
        attempt,
        message: lastError.message
      });
    }

    try {
      const getProbe = await probeVideoRange(videoUrl, attempt);
      return assertVideoProbe(getProbe, videoUrl);
    } catch (error) {
      lastError = new Error(`GET gagal: ${describeRequestError(error)}`);
      console.log("IG VIDEO URL GET belum siap:", {
        attempt,
        message: lastError.message
      });
    }

    if (attempt < maxAttempts) {
      await sleep(delayMs);
    }
  }

  throw new Error(
    `Gagal validasi video URL sebelum publish setelah ${maxAttempts} percobaan: ` +
      `${lastError?.message || "unknown_error"}`
  );
}

async function publishContainer(containerId) {
  const published = await postForm(`${config.instagram.igUserId}/media_publish`, {
    creation_id: containerId
  });

  console.log("IG REEL PUBLISHED:", published.id);

  return published;
}

async function publishReelViaVideoUrl({ videoUrl, caption, coverUrl }) {
  await assertPublicVideoUrl(videoUrl);

  console.log("IG upload method: video_url");

  const params = {
    media_type: "REELS",
    video_url: videoUrl,
    caption: caption || "",
    share_to_feed: "true"
  };
  if (coverUrl) {
    params.cover_url = coverUrl;
    console.log("IG REEL cover_url:", coverUrl);
  }

  const created = await postForm(`${config.instagram.igUserId}/media`, params);

  console.log("IG REEL CONTAINER CREATED:", created.id);

  await waitForContainerReady(created.id, "reel video_url");

  const published = await publishContainer(created.id);

  return {
    mediaId: published.id,
    containerId: created.id,
    type: "reel_video",
    uploadMethod: "video_url",
    videoUrl
  };
}

async function downloadVideoBuffer(videoUrl) {
  console.log("Downloading video for resumable upload:", videoUrl);

  const response = await axios.get(videoUrl, {
    responseType: "arraybuffer",
    timeout: 180000,
    maxRedirects: 5,
    headers: {
      "User-Agent": "facebookexternalhit/1.1"
    }
  });

  const buffer = Buffer.from(response.data);
  const contentType = response.headers?.["content-type"] || "";
  const contentLength = response.headers?.["content-length"] || "";

  console.log("Downloaded video for resumable upload:", {
    bytes: buffer.length,
    contentType,
    contentLength
  });

  if (!buffer.length) {
    throw new Error("Video buffer kosong saat resumable upload.");
  }

  return buffer;
}

async function createResumableContainer({ caption, coverUrl }) {
  console.log("IG upload method: resumable");

  const params = {
    media_type: "REELS",
    upload_type: "resumable",
    caption: caption || "",
    share_to_feed: "true"
  };
  if (coverUrl) {
    params.cover_url = coverUrl;
    console.log("IG REEL cover_url:", coverUrl);
  }

  const created = await postForm(`${config.instagram.igUserId}/media`, params);

  console.log("IG RESUMABLE CONTAINER CREATED:", created);

  if (!created.id) {
    throw new Error(`Resumable container tidak mengembalikan id: ${JSON.stringify(created)}`);
  }

  if (!created.uri) {
    throw new Error(`Resumable container tidak mengembalikan uri: ${JSON.stringify(created)}`);
  }

  return created;
}

async function uploadVideoToRupload({ uploadUri, videoBuffer }) {
  console.log("Uploading video binary to Meta rupload:", {
    uploadUri,
    bytes: videoBuffer.length
  });

  try {
    const response = await axios.post(uploadUri, videoBuffer, {
      headers: {
        Authorization: `OAuth ${config.instagram.accessToken}`,
        offset: "0",
        file_size: String(videoBuffer.length),
        "Content-Type": "application/octet-stream"
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 300000,
      validateStatus: () => true
    });

    console.log("IG RESUMABLE UPLOAD RESPONSE:", {
      status: response.status,
      data: response.data
    });

    if (response.status < 200 || response.status >= 300) {
      throw new Error(
        `Rupload gagal. status=${response.status}, data=${JSON.stringify(response.data)}`
      );
    }

    return response.data;
  } catch (error) {
    const apiError = error.response?.data?.error;

    if (apiError) {
      const wrapped = new Error(
        `Instagram rupload error (${error.response.status}): ${apiError.message} ` +
          `[code ${apiError.code}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
      );

      wrapped.apiCode = apiError.code;
      wrapped.apiSubcode = apiError.error_subcode;
      wrapped.apiError = apiError;
      throw wrapped;
    }

    throw error;
  }
}

async function publishReelViaResumable({ videoUrl, caption, coverUrl }) {
  await assertPublicVideoUrl(videoUrl);

  const videoBuffer = await downloadVideoBuffer(videoUrl);
  const created = await createResumableContainer({ caption, coverUrl });

  await uploadVideoToRupload({
    uploadUri: created.uri,
    videoBuffer
  });

  await waitForContainerReady(created.id, "reel resumable");

  const published = await publishContainer(created.id);

  return {
    mediaId: published.id,
    containerId: created.id,
    type: "reel_video",
    uploadMethod: "resumable",
    videoUrl
  };
}

export async function publishReel({ videoUrl, caption, coverUrl }) {
  await ensureFreshInstagramToken();
  assertInstagramConfig();

  const method = getReelUploadMethod();

  console.log("IG GRAPH VERSION:", config.graphApiVersion);
  console.log("IG REEL UPLOAD METHOD:", method);

  if (method === "resumable") {
    try {
      return await publishReelViaResumable({ videoUrl, caption, coverUrl });
    } catch (error) {
      if (!isRuploadProcessingFailure(error)) throw error;
      console.log("IG resumable gagal saat rupload. Mencoba fallback video_url.", {
        message: error.message
      });
      return publishReelViaVideoUrl({ videoUrl, caption, coverUrl });
    }
  }

  if (method === "video_url") {
    try {
      return await publishReelViaVideoUrl({ videoUrl, caption, coverUrl });
    } catch (error) {
      if (!isMetaMediaUploadFailed2207076(error)) throw error;
      console.log("IG video_url gagal dengan 2207076. Mencoba fallback resumable upload.", {
        message: error.message
      });
      return publishReelViaResumable({ videoUrl, caption, coverUrl });
    }
  }

  try {
    return await publishReelViaVideoUrl({ videoUrl, caption, coverUrl });
  } catch (error) {
    if (!isMetaMediaUploadFailed2207076(error)) {
      throw error;
    }

    console.log("IG video_url gagal dengan 2207076. Mencoba fallback resumable upload.", {
      message: error.message
    });

    return publishReelViaResumable({ videoUrl, caption, coverUrl });
  }
}
