import { readJson, patchItem, upsertItem } from "./storage.js";
import { todayDate, createJobId, makeId } from "./job-id.js";
import { extractYoutubeVideoId } from "./youtube.js";
import { hasProcessedVideo } from "./history.js";

const selectableStatuses = new Set(["queued", "failed", "retry"]);

function statusRank(status) {
  const value = String(status || "queued").toLowerCase();
  if (value === "queued") return 0;
  if (value === "retry") return 1;
  if (value === "failed") return 2;
  return 3;
}

function compareCandidates(a, b) {
  const status = statusRank(a.status) - statusRank(b.status);
  if (status !== 0) return status;
  const priority = Number(a.priority || 100) - Number(b.priority || 100);
  if (priority !== 0) return priority;
  return String(a.created_at || "").localeCompare(String(b.created_at || ""));
}

function shuffle(items) {
  const list = [...items];
  for (let index = list.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [list[index], list[swapIndex]] = [list[swapIndex], list[index]];
  }
  return list;
}

function orderCandidates(candidates, randomize = false) {
  if (!randomize) return [...candidates].sort(compareCandidates);

  const byStatus = new Map();
  for (const video of candidates) {
    const rank = statusRank(video.status);
    if (!byStatus.has(rank)) byStatus.set(rank, []);
    byStatus.get(rank).push(video);
  }

  return [...byStatus.keys()]
    .sort((a, b) => a - b)
    .flatMap((rank) => shuffle(byStatus.get(rank)));
}

function boolInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export async function selectNextVideo(options = {}) {
  const date = options.targetDate || todayDate();
  const videos = await readJson("videos", []);
  const themes = await readJson("themes", []);
  const prompts = await readJson("prompts", []);

  const activeThemes = themes.filter((theme) => theme.status === "active");
  const requestedTheme = options.theme && options.theme !== "auto" ? options.theme : "";
  const preferredVideoIds = new Set((options.preferredVideoIds || []).filter(Boolean));
  const excludedVideoIds = new Set((options.excludeVideoIds || []).filter(Boolean));

  let candidates = videos
    .map(normalizeVideo)
    .filter((video) => video.active !== false)
    .filter((video) => !excludedVideoIds.has(video.id))
    .filter((video) => selectableStatuses.has(video.status || "queued"))
    .filter((video) => !requestedTheme || video.theme === requestedTheme);

  const todayCandidates = candidates.filter((video) => video.target_date === date);
  if (todayCandidates.length) candidates = todayCandidates;

  const preferredCandidates = preferredVideoIds.size
    ? candidates.filter((video) => preferredVideoIds.has(video.id))
    : [];
  if (preferredCandidates.length) candidates = preferredCandidates;

  candidates = orderCandidates(candidates, options.randomize === true);

  for (const video of candidates) {
    if (!options.forceReprocess && !video.force_reprocess && await hasProcessedVideo(video)) {
      await patchItem("videos", video.id, { status: "skipped_duplicate" });
      continue;
    }
    const theme = activeThemes.find((item) => item.name === video.theme) || activeThemes[0] || null;
    const prompt = prompts.find((item) => item.theme === video.theme) || prompts[0] || null;
    return { video, theme, prompt };
  }

  return null;
}

export async function addVideo(input) {
  const url = String(input.url || "").trim();
  if (!url) throw new Error("URL wajib diisi.");

  const now = new Date().toISOString();
  const video = normalizeVideo({
    id: input.id || makeId("video"),
    source_type: "youtube_video",
    url,
    source_url: url,
    youtube_video_id: extractYoutubeVideoId(url),
    theme: input.theme || "podcast artis",
    priority: Number(input.priority || 1),
    target_date: input.target_date || "",
    active: input.active !== false,
    status: input.status || "queued",
    notes: input.notes || "",
    manual_range: input.manual_range || "",
    quality_profile: input.quality_profile || "standard",
    ai_provider: "openai",
    scene_mode: input.scene_mode || "podcast",
    clip_count: Number(input.clip_count || process.env.CLIP_COUNT || 1),
    subtitle_font: input.subtitle_font || "Segoe UI Semibold",
    subtitle_font_size: Number(input.subtitle_font_size || 46),
    subtitle_margin_v: Number(input.subtitle_margin_v || 550),
    subtitle_margin_h: Number(input.subtitle_margin_h || 180),
    use_frame: boolInput(input.use_frame, boolInput(process.env.VIDEO_FRAME_ENABLED, true)),
    use_filter: boolInput(input.use_filter, boolInput(process.env.VIDEO_FILTER_ENABLED, true)),
    use_watermark: boolInput(input.use_watermark, boolInput(process.env.VIDEO_WATERMARK_ENABLED, true)),
    use_music: boolInput(input.use_music, boolInput(process.env.BACKGROUND_MUSIC_ENABLED, true)),
    force_reprocess: input.force_reprocess === true,
    source_title: input.source_title || "",
    source_channel: input.source_channel || input.channel_title || "",
    channel_title: input.channel_title || input.source_channel || "",
    published_at_source: input.published_at_source || "",
    discovery_source: input.discovery_source || "",
    discovery_query: input.discovery_query || "",
    discovery_fallback_mode: input.discovery_fallback_mode || "",
    discovery_score: Number(input.discovery_score || 0),
    discovery_views: Number(input.discovery_views || 0),
    discovery_likes: Number(input.discovery_likes || 0),
    discovery_comments: Number(input.discovery_comments || 0),
    discovery_views_per_hour: Number(input.discovery_views_per_hour || 0),
    created_at: input.created_at || now,
    updated_at: now
  });
  await upsertItem("videos", video);
  return video;
}

export async function updateVideoStatus(videoId, status, patch = {}) {
  return patchItem("videos", videoId, {
    ...patch,
    status
  });
}

export async function createJobRecord({ video, theme, prompt }, options = {}) {
  const jobId = createJobId(theme?.name || video?.theme || "podcast");
  const now = new Date().toISOString();
  const keepVideoStatus = options.keepVideoStatus === true;
  const job = {
    job_id: jobId,
    video_id: video.id,
    theme: theme?.name || video.theme,
    source_type: video.source_type || "youtube_video",
    source_url: video.url || video.source_url,
    source_youtube_video_id: video.youtube_video_id || extractYoutubeVideoId(video.url),
    source_title: video.source_title || "",
    source_channel: video.source_channel || video.channel_title || "",
    channel_title: video.channel_title || video.source_channel || "",
    clipper_status: "pending",
    caption_status: "pending",
    thumbnail_status: "pending",
    publish_status: "pending",
    instagram_status: "pending",
    facebook_status: "pending",
    tiktok_status: "pending",
    youtube_status: "pending",
    threads_status: "pending",
    status: "selected",
    prompt_id: prompt?.id || "",
    final_video_path: "",
    transcript_path: "",
    metadata_path: "",
    thumbnail_path: "",
    public_video_url: "",
    public_thumbnail_url: "",
    public_metadata_url: "",
    instagram_media_id: "",
    instagram_error: "",
    facebook_video_id: "",
    facebook_post_id: "",
    facebook_url: "",
    facebook_error: "",
    tiktok_publish_id: "",
    tiktok_mode: "",
    tiktok_error: "",
    threads_media_id: "",
    threads_url: "",
    threads_error: "",
    youtube_video_id: "",
    youtube_url: "",
    youtube_error: "",
    youtube_published_at: "",
    use_frame: video.use_frame,
    use_filter: video.use_filter,
    use_watermark: video.use_watermark,
    use_music: video.use_music,
    created_at: now,
    updated_at: now,
    published_at: "",
    error_message: ""
  };
  await upsertItem("jobs", job, "job_id");
  if (keepVideoStatus) {
    await patchItem("videos", video.id, { current_job_id: jobId });
  } else {
    await updateVideoStatus(video.id, "selected", { current_job_id: jobId });
  }
  return job;
}

export function normalizeVideo(video) {
  const url = video.url || video.source_url || "";
  return {
    ...video,
    id: video.id || makeId("video"),
    source_type: video.source_type || "youtube_video",
    url,
    source_url: url,
    youtube_video_id: video.youtube_video_id || extractYoutubeVideoId(url),
    source_title: video.source_title || "",
    source_channel: video.source_channel || video.channel_title || "",
    channel_title: video.channel_title || video.source_channel || "",
    theme: video.theme || "podcast artis",
    priority: Number(video.priority || 1),
    quality_profile: video.quality_profile || "standard",
    ai_provider: "openai",
    scene_mode: video.scene_mode || "podcast",
    clip_count: Number(video.clip_count || process.env.CLIP_COUNT || 1),
    subtitle_font: video.subtitle_font || "Segoe UI Semibold",
    subtitle_font_size: Number(video.subtitle_font_size || 46),
    subtitle_margin_v: Number(video.subtitle_margin_v || 550),
    subtitle_margin_h: Number(video.subtitle_margin_h || 180),
    use_frame: boolInput(video.use_frame, boolInput(process.env.VIDEO_FRAME_ENABLED, true)),
    use_filter: boolInput(video.use_filter, boolInput(process.env.VIDEO_FILTER_ENABLED, true)),
    use_watermark: boolInput(video.use_watermark, boolInput(process.env.VIDEO_WATERMARK_ENABLED, true)),
    use_music: boolInput(video.use_music, boolInput(process.env.BACKGROUND_MUSIC_ENABLED, true)),
    force_reprocess: video.force_reprocess === true,
    active: video.active !== false,
    status: video.status || "queued"
  };
}
