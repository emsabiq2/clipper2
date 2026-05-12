import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { appendHistory } from "./history.js";
import { publishReel } from "./instagram.js";
import { appendLog } from "./logger.js";
import { patchItem, readJson, writeJson } from "./storage.js";
import { downloadStateFromRemote, uploadStateToRemote } from "./state-sync.js";
import { buildYoutubeMetadata, isYoutubeQuotaError, publishToYoutube, setYoutubeThumbnail } from "./youtube-publisher.js";
import { publishToTikTok } from "./tiktok.js";
import { publishToThreads } from "./threads.js";
import { stripCaptionSourceCredit } from "./caption-policy.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function latestReadyJob(jobs) {
  return jobs
    .filter((job) => {
      const needsPlatform = [
        config.youtube.enabled && !job.youtube_url && !job.youtube_video_id,
        config.instagram.enabled && !job.instagram_media_id,
        config.tiktok.enabled && !job.tiktok_publish_id,
        config.threads.enabled && !job.threads_media_id
      ].some(Boolean);
      if (!needsPlatform) return false;
      return [job.status, job.publish_status, job.youtube_status]
        .some((status) => ["ready_to_publish", "publish_failed", "failed_publish"].includes(status));
    })
    .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")))[0] || null;
}

async function patchVideo(videoId, patch) {
  const videos = await readJson("videos", []);
  const index = videos.findIndex((video) => video.id === videoId);
  if (index === -1) return null;
  videos[index] = { ...videos[index], ...patch, updated_at: new Date().toISOString() };
  await writeJson("videos", videos);
  return videos[index];
}

function enrichJobWithSource(job, video) {
  return {
    ...job,
    source_url: job.source_url || video?.source_url || video?.url || "",
    source_youtube_video_id: job.source_youtube_video_id || video?.youtube_video_id || "",
    source_title: video?.source_title || job.source_title || "",
    source_channel: job.source_channel || job.channel_title || video?.source_channel || video?.channel_title || "",
    channel_title: job.channel_title || job.source_channel || video?.channel_title || video?.source_channel || ""
  };
}

async function resolveThumbnailPath(job) {
  const thumbnailPath = job.thumbnail_path || "";
  if (thumbnailPath) {
    try {
      const stat = await fs.stat(thumbnailPath);
      if (stat.size) return thumbnailPath;
    } catch {
      // Fall back to the public remote URL when the local generated file is gone.
    }
  }

  if (!job.public_thumbnail_url) return thumbnailPath;

  try {
    await fs.mkdir(config.thumbnailDir, { recursive: true });
    const target = path.join(config.thumbnailDir, `${job.job_id}-youtube-thumbnail.jpg`);
    const response = await fetch(job.public_thumbnail_url);
    if (!response.ok) return thumbnailPath;
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.writeFile(target, buffer);
    return target;
  } catch {
    return thumbnailPath;
  }
}

async function resolveVideoPath(job) {
  const videoPath = job.final_video_path || "";
  if (videoPath) {
    try {
      const stat = await fs.stat(videoPath);
      if (stat.size) return videoPath;
    } catch {
      // GitHub runner baru biasanya tidak punya file lokal; ambil lagi dari public URL remote.
    }
  }

  if (!job.public_video_url) return videoPath;

  await fs.mkdir(path.join(config.generatedDir, "ready-videos"), { recursive: true });
  const target = path.join(config.generatedDir, "ready-videos", `${job.job_id}.mp4`);
  const response = await fetch(job.public_video_url);
  if (!response.ok) {
    throw new Error(`Gagal download ulang video ready dari remote storage: HTTP ${response.status}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error("Video ready dari remote storage kosong.");
  await fs.writeFile(target, buffer);
  return target;
}

const jobId = argValue("--job", "");
const forceYoutube = process.argv.includes("--force-youtube");
const onlyYoutubeThumbnail = process.argv.includes("--only-youtube-thumbnail");
const forceThumbnail = onlyYoutubeThumbnail || process.argv.includes("--force-thumbnail") || process.argv.includes("--set-youtube-thumbnail");

await downloadStateFromRemote().catch((error) => {
  console.warn(`State remote dilewati: ${error.message}`);
});

const jobs = await readJson("jobs", []);
const job = jobId ? jobs.find((item) => item.job_id === jobId) : latestReadyJob(jobs);
const videos = await readJson("videos", []);
const sourceVideo = job ? videos.find((item) => item.id === job.video_id) : null;
const jobWithSource = job ? enrichJobWithSource(job, sourceVideo) : null;

if (!job) {
  console.error("Tidak ada job ready_to_publish.");
  process.exit(1);
}

if (!config.youtube.enabled && !config.instagram.enabled && !config.tiktok.enabled && !config.threads.enabled) {
  console.error("Tidak ada platform aktif. Aktifkan YOUTUBE_UPLOAD_ENABLED, INSTAGRAM_UPLOAD_ENABLED, TIKTOK_UPLOAD_ENABLED, atau THREADS_UPLOAD_ENABLED.");
  process.exit(1);
}

if (!job.final_video_path && !job.public_video_url) {
  console.error(`Job ${job.job_id} tidak punya final_video_path/public_video_url.`);
  process.exit(1);
}

if (onlyYoutubeThumbnail && !config.youtube.enabled) {
  console.error("YOUTUBE_UPLOAD_ENABLED harus aktif untuk set thumbnail YouTube.");
  process.exit(1);
}

if (onlyYoutubeThumbnail && !job.youtube_video_id) {
  console.error(`Job ${job.job_id} belum punya youtube_video_id.`);
  process.exit(1);
}

await patchItem("jobs", job.job_id, onlyYoutubeThumbnail ? {
  youtube_status: "processing",
  youtube_thumbnail_error: ""
} : {
  youtube_status: config.youtube.enabled && (!job.youtube_url || forceYoutube) ? "processing" : job.youtube_status,
  instagram_status: config.instagram.enabled && !job.instagram_media_id ? "processing" : job.instagram_status,
  tiktok_status: config.tiktok.enabled && !job.tiktok_publish_id ? "processing" : job.tiktok_status,
  threads_status: config.threads.enabled && !job.threads_media_id ? "processing" : job.threads_status,
  publish_status: "publishing",
  status: "publishing"
});

let youtube = (job.youtube_url || job.youtube_video_id) ? {
  videoId: job.youtube_video_id,
  url: job.youtube_url || (job.youtube_video_id ? `https://www.youtube.com/watch?v=${job.youtube_video_id}` : ""),
  customThumbnail: job.youtube_custom_thumbnail === true,
  thumbnailError: job.youtube_thumbnail_error || "",
  skipped: true
} : null;
let instagram = job.instagram_media_id ? {
  mediaId: job.instagram_media_id,
  skipped: true
} : null;
let tiktok = job.tiktok_publish_id ? {
  publishId: job.tiktok_publish_id,
  mode: job.tiktok_mode || "",
  skipped: true
} : null;
let threads = job.threads_media_id ? {
  mediaId: job.threads_media_id,
  url: job.threads_url || "",
  skipped: true
} : null;

try {
  const thumbnailPath = await resolveThumbnailPath(jobWithSource);
  const videoPath = await resolveVideoPath(jobWithSource);
  const socialCaption = stripCaptionSourceCredit(jobWithSource.caption || "", {
    sourceUrl: jobWithSource.source_url
  });
  const output = {
    title: jobWithSource.source_title || jobWithSource.clip_title,
    hook: jobWithSource.source_title || jobWithSource.clip_title,
    finalAbsPath: videoPath,
    caption: socialCaption,
    clipTranscript: jobWithSource.clipTranscript || "",
    selectedAngle: jobWithSource.selectedAngle || ""
  };

  if (!onlyYoutubeThumbnail && config.youtube.enabled && (!youtube || forceYoutube)) {
    const metadata = buildYoutubeMetadata({
      job: jobWithSource,
      output,
      caption: socialCaption
    });
    youtube = await publishToYoutube({
      videoPath,
      thumbnailPath,
      ...metadata
    });
  }

  if (
    config.youtube.enabled
    && youtube?.videoId
    && thumbnailPath
    && (forceThumbnail || (config.youtube.customThumbnailEnabled && youtube.customThumbnail !== true))
  ) {
    const thumbnail = await setYoutubeThumbnail({
      videoId: youtube.videoId,
      thumbnailPath
    });
    youtube = {
      ...youtube,
      customThumbnail: thumbnail.ok,
      thumbnailError: thumbnail.ok ? "" : thumbnail.error
    };
  }

  if (onlyYoutubeThumbnail) {
    const thumbnailOk = youtube?.customThumbnail === true;
    await patchItem("jobs", job.job_id, {
      youtube_status: thumbnailOk ? "published" : "thumbnail_failed",
      youtube_custom_thumbnail: thumbnailOk,
      youtube_thumbnail_error: youtube?.thumbnailError || ""
    });
    await appendLog(thumbnailOk ? "youtube_thumbnail_set" : "youtube_thumbnail_failed", {
      job_id: job.job_id,
      youtube_video_id: youtube?.videoId || "",
      error: youtube?.thumbnailError || ""
    });
    await uploadStateToRemote().catch(() => {});
    console.log(JSON.stringify({
      status: thumbnailOk ? "thumbnail_set" : "thumbnail_failed",
      job_id: job.job_id,
      youtube
    }, null, 2));
    process.exit(thumbnailOk ? 0 : 1);
  }

  if (config.instagram.enabled && !instagram) {
    if (!job.public_video_url) throw new Error("public_video_url kosong, Instagram butuh URL video publik dari remote storage.");
    instagram = await publishReel({
      videoUrl: job.public_video_url,
      caption: socialCaption
    });
  }

  if (config.tiktok.enabled && !tiktok) {
    if (!job.public_video_url) throw new Error("public_video_url kosong, TikTok butuh URL video publik dari remote storage.");
    tiktok = await publishToTikTok({
      videoUrl: job.public_video_url,
      videoPath,
      caption: socialCaption
    });
  }

  if (config.threads.enabled && !threads) {
    if (!job.public_video_url) throw new Error("public_video_url kosong, Threads butuh URL video publik dari remote storage.");
    threads = await publishToThreads({
      videoUrl: job.public_video_url,
      caption: socialCaption
    });
  }

  if (!youtube && !instagram && !tiktok && !threads) {
    throw new Error("Tidak ada publish yang dijalankan.");
  }

  const now = new Date().toISOString();
  await patchItem("jobs", job.job_id, {
    status: "published",
    publish_status: "published",
    caption: socialCaption,
    source_url: jobWithSource.source_url,
    source_youtube_video_id: jobWithSource.source_youtube_video_id,
    source_title: jobWithSource.source_title,
    source_channel: jobWithSource.source_channel,
    channel_title: jobWithSource.channel_title,
    youtube_status: youtube ? "published" : "disabled",
    youtube_video_id: youtube?.videoId || "",
    youtube_url: youtube?.url || "",
    youtube_custom_thumbnail: youtube?.customThumbnail === true,
    youtube_thumbnail_error: youtube?.thumbnailError || "",
    youtube_published_at: youtube?.skipped ? job.youtube_published_at : youtube ? now : "",
    instagram_status: instagram ? "published" : "disabled",
    instagram_media_id: instagram?.mediaId || "",
    tiktok_status: tiktok ? "submitted" : "disabled",
    tiktok_publish_id: tiktok?.publishId || "",
    tiktok_mode: tiktok?.mode || "",
    threads_status: threads ? "published" : "disabled",
    threads_media_id: threads?.mediaId || "",
    threads_url: threads?.url || "",
    published_at: now
  });
  await patchVideo(job.video_id, {
    status: "published",
    youtube_video_id: youtube?.videoId || job.youtube_video_id,
    youtube_url: youtube?.url || job.youtube_url,
    instagram_media_id: instagram?.mediaId || job.instagram_media_id,
    tiktok_publish_id: tiktok?.publishId || job.tiktok_publish_id,
    threads_media_id: threads?.mediaId || job.threads_media_id,
    threads_url: threads?.url || job.threads_url
  });
  await appendHistory({
    job_id: job.job_id,
    video_id: job.video_id,
    source_url: jobWithSource.source_url,
    source_youtube_video_id: jobWithSource.source_youtube_video_id,
    source_title: jobWithSource.source_title,
    source_channel: jobWithSource.source_channel,
    youtube_video_id: job.youtube_video_id,
    theme: job.theme,
    status: "published",
    final_video_path: job.final_video_path,
    public_video_url: job.public_video_url || "",
    public_thumbnail_url: job.public_thumbnail_url || "",
    caption: socialCaption,
    instagram_media_id: instagram?.mediaId || "",
    tiktok_publish_id: tiktok?.publishId || "",
    tiktok_mode: tiktok?.mode || "",
    youtube_video_id: youtube?.videoId || "",
    youtube_url: youtube?.url || "",
    threads_media_id: threads?.mediaId || "",
    threads_url: threads?.url || "",
    published_at: now
  });
  await appendLog("platform_published", {
    job_id: job.job_id,
    instagram_media_id: instagram?.mediaId || "",
    tiktok_publish_id: tiktok?.publishId || "",
    youtube_video_id: youtube?.videoId || "",
    youtube_url: youtube?.url || "",
    threads_media_id: threads?.mediaId || ""
  });
  await uploadStateToRemote().catch(() => {});
  console.log(JSON.stringify({
    status: "published",
    job_id: job.job_id,
    instagram,
    tiktok,
    youtube,
    threads
  }, null, 2));
} catch (error) {
  const hasYoutube = Boolean(youtube?.url || youtube?.videoId || job.youtube_url || job.youtube_video_id);
  const hasTikTok = Boolean(tiktok?.publishId || job.tiktok_publish_id);
  const hasThreads = Boolean(threads?.mediaId || job.threads_media_id);
  if (isYoutubeQuotaError(error)) {
    await patchItem("jobs", job.job_id, {
      status: "ready_to_publish",
      publish_status: "queued",
      youtube_status: hasYoutube ? "published" : "quota_exceeded",
      youtube_video_id: youtube?.videoId || job.youtube_video_id || "",
      youtube_url: youtube?.url || job.youtube_url || "",
      error_message: "Quota YouTube habis; menunggu queue reguler berikutnya."
    });
    await appendLog("youtube_quota_exceeded", {
      job_id: job.job_id,
      error: error.message
    });
    await uploadStateToRemote().catch(() => {});
    console.log(JSON.stringify({
      status: "queued",
      job_id: job.job_id,
      error: error.message
    }, null, 2));
    process.exit(0);
  }
  await patchItem("jobs", job.job_id, {
    status: "failed_publish",
    publish_status: "failed_publish",
    youtube_status: hasYoutube ? "published" : config.youtube.enabled ? "failed" : job.youtube_status,
    youtube_video_id: youtube?.videoId || job.youtube_video_id || "",
    youtube_url: youtube?.url || job.youtube_url || "",
    instagram_status: config.instagram.enabled ? "failed" : job.instagram_status,
    tiktok_status: hasTikTok ? "submitted" : config.tiktok.enabled ? "failed" : job.tiktok_status,
    tiktok_publish_id: tiktok?.publishId || job.tiktok_publish_id || "",
    threads_status: hasThreads ? "published" : config.threads.enabled ? "failed" : job.threads_status,
    threads_media_id: threads?.mediaId || job.threads_media_id || "",
    threads_url: threads?.url || job.threads_url || "",
    error_message: error.message
  });
  await appendLog("platform_publish_failed", {
    job_id: job.job_id,
    error: error.message
  });
  await uploadStateToRemote().catch(() => {});
  throw error;
}
