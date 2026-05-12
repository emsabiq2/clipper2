import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { addVideo } from "./selector.js";
import { readJson, writeJson } from "./storage.js";
import { uploadStateToRemote } from "./state-sync.js";
import { todayDate } from "./job-id.js";
import { extractYoutubeVideoId } from "./youtube.js";
import { getYoutubeAccessToken } from "./youtube-publisher.js";

const DEFAULT_QUERIES = [
  "podcast indonesia hari ini",
  "podcast artis indonesia hari ini",
  "podcast artis indonesia terbaru",
  "podcast artis indonesia viral",
  "podcast deddy corbuzier terbaru",
  "podcast vindes terbaru",
  "podcast politik indonesia hari ini"
];

const FALLBACK_QUERIES = [
  "podcast indonesia hari ini",
  "podcast indonesia terbaru",
  "podcast indonesia viral",
  "podcast artis indonesia full",
  "podcast selebriti indonesia terbaru",
  "podcast deddy corbuzier terbaru",
  "raditya dika podcast terbaru",
  "podcast vindes terbaru",
  "komika indonesia podcast terbaru",
  "podcast politik indonesia",
  "podcast komedi indonesia"
];

const DEFAULT_CHANNEL_HANDLES = [
  "@corbuzier",
  "@VINDES",
  "@radityadika",
  "@DanielManantaNetwork",
  "@HASCreative",
  "@podkesmas",
  "@podhub",
  "@Kasisolusi",
  "@TotalPolitik"
];

const PODCAST_TOPIC_RE = /podcast|siniar|podhub|podkesmas|close\s*the\s*door|vindes|deddy|corbuzier|raditya|daniel\s*mananta|has\s*creative|kasisolusi|total\s*politik|podcast\s*politik|podcast\s*komedi/i;
const NON_PODCAST_NOISE_RE = /official\s*music\s*video|lirik|lyrics|trailer|teaser|sinetron|drama|full\s*movie|film\s*pendek|gameplay|live\s*stream\s*game|highlight\s*bola/i;
const YOUTUBE_API_BASE = "https://www.googleapis.com/youtube/v3";
const DISCOVERY_CACHE_FILE = "discovery-cache.json";
const AUTO_DISCOVERY_SELECTABLE_STATUSES = new Set(["queued", "failed", "retry"]);
const AUTO_DISCOVERY_CLOSED_STATUSES = new Set(["expired"]);
let youtubeApiQuotaExhausted = false;

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberEnv(name, fallback, min = 0, max = 100) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.floor(value), min), max);
}

function listEnv(name, fallback = []) {
  const value = String(process.env[name] || "").trim();
  if (!value) return fallback;
  return value
    .split(/[\n,|;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function listEnvMany(names, fallback = []) {
  const values = names.flatMap((name) => listEnv(name, []));
  return values.length ? [...new Set(values)] : fallback;
}

function uniqueList(items) {
  return [...new Set(items.map((item) => String(item || "").trim()).filter(Boolean))];
}

function daySerial(dateString) {
  const match = String(dateString || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function isAutoDiscoveredVideo(video) {
  return Boolean(
    video?.discovery_source
      || video?.discovery_query
      || String(video?.notes || "").startsWith("Auto discovery:")
  );
}

function autoDiscoveryDailyQueueLimit() {
  const fallback = numberEnv("MAX_SCHEDULED_POSTS_PER_DAY", 15, 0, 1000);
  return numberEnv("AUTO_DISCOVER_DAILY_QUEUE_LIMIT", fallback, 0, 1000);
}

function countDailyAutoDiscoveryQueue(videos, targetDate) {
  return videos.filter((video) => {
    if (!isAutoDiscoveredVideo(video)) return false;
    if (video.target_date !== targetDate) return false;
    if (video.active === false) return false;
    return !AUTO_DISCOVERY_CLOSED_STATUSES.has(video.status || "queued");
  }).length;
}

async function expireOldAutoDiscoveryQueue(targetDate) {
  if (!boolEnv("AUTO_DISCOVER_EXPIRE_OLD_QUEUE", true)) {
    return { expired: 0, videos: await readJson("videos", []) };
  }

  const targetDay = daySerial(targetDate);
  const ttlDays = numberEnv("AUTO_DISCOVER_QUEUE_TTL_DAYS", 1, 1, 365);
  const videos = await readJson("videos", []);
  if (targetDay === null) return { expired: 0, videos };

  const now = new Date().toISOString();
  let expired = 0;
  const nextVideos = videos.map((video) => {
    if (!isAutoDiscoveredVideo(video)) return video;
    if (!AUTO_DISCOVERY_SELECTABLE_STATUSES.has(video.status || "queued")) return video;

    const videoDay = daySerial(video.target_date);
    if (videoDay === null || videoDay + ttlDays > targetDay) return video;

    expired += 1;
    return {
      ...video,
      status: "expired",
      expired_at: now,
      updated_at: now,
      error_message: `Auto discovery expired setelah melewati target_date ${video.target_date}.`
    };
  });

  if (expired) {
    await writeJson("videos", nextVideos);
    console.log(`AUTO DISCOVERY expired ${expired} queue lama sebelum membuat queue ${targetDate}.`);
  }

  return { expired, videos: nextVideos };
}

async function readDiscoveryCache() {
  const cache = await readJson(DISCOVERY_CACHE_FILE, {});
  return cache && typeof cache === "object" && !Array.isArray(cache) ? cache : {};
}

async function writeDiscoveryCache(cache) {
  const entries = Object.entries(cache)
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(-14);
  await writeJson(DISCOVERY_CACHE_FILE, Object.fromEntries(entries));
}

async function patchDiscoveryCache(date, patch) {
  const cache = await readDiscoveryCache();
  cache[date] = {
    ...(cache[date] || {}),
    ...patch,
    updated_at: new Date().toISOString()
  };
  await writeDiscoveryCache(cache);
  if (boolEnv("AUTO_DISCOVER_CACHE_SYNC_IMMEDIATE", true)) {
    await uploadStateToRemote().catch(() => {});
  }
  return cache[date];
}

function videoUrl(id) {
  return `https://www.youtube.com/watch?v=${id}`;
}

function isYoutubeQuotaError(error) {
  const text = String(error?.message || error || "");
  return /quota|quotaExceeded|exceeded your/i.test(text);
}

function knownVideoIds(videos, history) {
  const ids = new Set();
  for (const item of [...videos, ...history]) {
    for (const value of [
      item.youtube_video_id,
      extractYoutubeVideoId(item.url),
      extractYoutubeVideoId(item.source_url)
    ]) {
      if (value) ids.add(value);
    }
  }
  return ids;
}

function candidatePublishedAt(item = {}) {
  if (item.publishedAt) return item.publishedAt;
  if (item.timestamp) return new Date(Number(item.timestamp) * 1000).toISOString();
  const uploadDate = String(item.upload_date || "").trim();
  if (/^\d{8}$/.test(uploadDate)) {
    return `${uploadDate.slice(0, 4)}-${uploadDate.slice(4, 6)}-${uploadDate.slice(6, 8)}T00:00:00Z`;
  }
  return uploadDate;
}

function ageHours(publishedAt) {
  const timestamp = Date.parse(publishedAt || "");
  if (!Number.isFinite(timestamp)) return 24 * 365;
  return Math.max(1, (Date.now() - timestamp) / 36e5);
}

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function candidateText(item) {
  return [
    item.title,
    item.description,
    item.channel,
    item.uploader,
    item.channelTitle
  ].join(" ");
}

function viralStats(item) {
  const views = numberValue(item.view_count);
  const likes = numberValue(item.like_count);
  const comments = numberValue(item.comment_count);
  const hours = ageHours(candidatePublishedAt(item));
  return {
    views,
    likes,
    comments,
    ageHours: hours,
    viewsPerHour: views / hours,
    likesPerHour: likes / hours,
    commentsPerHour: comments / hours,
    engagementRate: views ? (likes + comments * 2) / views : 0
  };
}

function isTrustedPodcastChannelSource(item) {
  return ["youtube_api_channel", "yt_dlp_channel"].includes(item.discovery_source);
}

function isPodcastCandidate(item) {
  const text = candidateText(item);
  if (NON_PODCAST_NOISE_RE.test(text) && !PODCAST_TOPIC_RE.test(text)) return false;
  return PODCAST_TOPIC_RE.test(text) || isTrustedPodcastChannelSource(item);
}

function passesDuration(item, options) {
  const duration = numberValue(item.duration);
  if (duration && duration < options.minDuration) return false;
  if (duration && duration > options.maxDuration) return false;
  return true;
}

function topicMultiplier(text) {
  const value = String(text || "").toLowerCase();
  if (/podcast.*artis|artis.*podcast|deddy|corbuzier|vindes|raditya|close\s*the\s*door/.test(value)) return 1.4;
  if (/podhub|podkesmas|daniel\s*mananta|has\s*creative|kasisolusi/.test(value)) return 1.28;
  if (/podcast.*politik|politik.*podcast|total\s*politik/.test(value)) return 1.16;
  if (/podcast.*komedi|komedi.*podcast|komika/.test(value)) return 1.1;
  return 1;
}

function scoreCandidate(item) {
  const duration = numberValue(item.duration);
  const stats = viralStats(item);
  const text = candidateText(item);
  const durationMultiplier = duration >= 1200 && duration <= 7200 ? 1.1 : 1;
  const recencyMultiplier = stats.ageHours <= 72 ? 1.15 : stats.ageHours <= 168 ? 1.05 : 0.95;
  const raw =
    stats.viewsPerHour * 0.75 +
    stats.likesPerHour * 2 +
    stats.commentsPerHour * 25 +
    stats.engagementRate * 50000;
  const trustedChannelBoost = isTrustedPodcastChannelSource(item) ? 35000 : 0;
  const trendingBoost = item.discovery_source === "youtube_api_trending" ? 45000 : 0;
  const freshBoost = stats.ageHours <= 12 ? 55000 : stats.ageHours <= 24 ? 40000 : stats.ageHours <= 72 ? 18000 : 0;

  return Math.round((raw + trustedChannelBoost + trendingBoost + freshBoost) * topicMultiplier(text) * durationMultiplier * recencyMultiplier);
}

function isViralCandidate(item, options) {
  const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
  if (!id) return false;

  if (!passesDuration(item, options)) return false;

  const stats = viralStats(item);
  const isFastGrowing = stats.viewsPerHour >= options.minViewsPerHour;
  const hasEnoughViews = stats.views >= options.minViews;
  if (!isFastGrowing && !hasEnoughViews) return false;

  return isPodcastCandidate(item);
}

function isTopicCandidate(item, options) {
  const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
  if (!id) return false;

  if (!passesDuration(item, options)) return false;

  return isPodcastCandidate(item);
}

function isFreshChannelCandidate(item, options) {
  const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
  if (!id) return false;

  if (!passesDuration(item, options)) return false;

  const isFresh = item.discovery_source === "yt_dlp_channel"
    || ageHours(candidatePublishedAt(item)) <= options.publishedAfterDays * 24 + 6;
  if (!isFresh) return false;

  return isPodcastCandidate(item);
}

function isTrendingPodcastCandidate(item, options) {
  const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
  if (!id) return false;
  if (!passesDuration(item, options)) return false;
  if (ageHours(candidatePublishedAt(item)) > options.trendingMaxAgeHours) return false;
  return isPodcastCandidate(item);
}

function parseJsonLines(stdout) {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function ytDlpCommonArgs() {
  const args = [];
  const cookiesFile = String(process.env.YTDLP_COOKIES_FILE || "").trim();
  if (cookiesFile) {
    const cookiePath = path.isAbsolute(cookiesFile)
      ? cookiesFile
      : path.join(config.clipper.rootDir, cookiesFile);
    if (existsSync(cookiePath)) args.push("--cookies", cookiePath);
  }
  if (process.env.YTDLP_USER_AGENT) args.push("--user-agent", process.env.YTDLP_USER_AGENT);
  if (process.env.YTDLP_REFERER) args.push("--referer", process.env.YTDLP_REFERER);
  if (process.env.YTDLP_JS_RUNTIMES) args.push("--js-runtimes", process.env.YTDLP_JS_RUNTIMES);
  if (process.env.YTDLP_REMOTE_COMPONENTS) args.push("--remote-components", process.env.YTDLP_REMOTE_COMPONENTS);
  return args;
}

function runYtDlpSearch(query, maxResults) {
  const command = process.env.YTDLP_COMMAND || "yt-dlp";
  const args = [
    "--dump-json",
    "--flat-playlist",
    ...ytDlpCommonArgs(),
    `ytsearch${maxResults}:${query}`
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(parseJsonLines(stdout));
      } else {
        reject(new Error(`yt-dlp search gagal (${code}): ${stderr.slice(-800)}`));
      }
    });
  });
}

function channelVideosUrl(handle) {
  const value = String(handle || "").trim();
  if (!value) return "";
  if (/^https?:\/\//i.test(value)) return value;
  if (/^UC[A-Za-z0-9_-]{20,}$/.test(value)) return `https://www.youtube.com/channel/${value}/videos`;
  return `https://www.youtube.com/${value.startsWith("@") ? value : `@${value}`}/videos`;
}

function runYtDlpChannel(handle, maxResults) {
  const url = channelVideosUrl(handle);
  if (!url) return Promise.resolve([]);
  const command = process.env.YTDLP_COMMAND || "yt-dlp";
  const args = [
    "--dump-json",
    "--flat-playlist",
    "--playlist-end",
    String(maxResults),
    ...ytDlpCommonArgs(),
    url
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(parseJsonLines(stdout));
      } else {
        reject(new Error(`yt-dlp channel gagal (${code}): ${stderr.slice(-800)}`));
      }
    });
  });
}

function runYtDlpValidate(url) {
  const command = process.env.YTDLP_COMMAND || "yt-dlp";
  const args = [
    "--skip-download",
    "--no-warnings",
    "--print",
    "id",
    ...ytDlpCommonArgs(),
    url
  ];

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error("yt-dlp validate timeout"));
    }, numberEnv("AUTO_DISCOVER_VALIDATE_TIMEOUT_SECONDS", 45, 5, 180) * 1000);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0 && stdout.trim()) resolve(stdout.trim());
      else reject(new Error(`yt-dlp validate gagal (${code}): ${stderr.slice(-500)}`));
    });
  });
}

function parseIsoDuration(value) {
  const match = String(value || "").match(/^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return 0;
  const [, days, hours, minutes, seconds] = match.map((part) => Number(part || 0));
  return days * 86400 + hours * 3600 + minutes * 60 + seconds;
}

function publishedAfterDate(days) {
  const date = new Date(Date.now() - days * 86400 * 1000);
  return date.toISOString();
}

async function fetchYoutube(pathname, params, credential) {
  const url = new URL(`${YOUTUBE_API_BASE}/${pathname}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") url.searchParams.set(key, String(value));
  }
  const headers = {};
  if (credential.apiKey) {
    url.searchParams.set("key", credential.apiKey);
  } else if (credential.accessToken) {
    headers.Authorization = `Bearer ${credential.accessToken}`;
  }

  const response = await fetch(url, { headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = body?.error?.message || `${response.status} ${response.statusText}`;
    const error = new Error(`YouTube API ${pathname} gagal: ${message}`);
    error.reason = body?.error?.errors?.[0]?.reason || "";
    if (isYoutubeQuotaError(error) || error.reason === "quotaExceeded") error.quotaExceeded = true;
    throw error;
  }
  return body;
}

function chunk(items, size) {
  const chunks = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function youtubeVideoResourceToCandidate(item, discoveryQuery) {
  if (!item?.id) return null;
  if (item.status?.embeddable === false) return null;
  const snippet = item.snippet || {};
  const statistics = item.statistics || {};
  const duration = parseIsoDuration(item.contentDetails?.duration);
  return {
    id: item.id,
    url: videoUrl(item.id),
    webpage_url: videoUrl(item.id),
    title: snippet.title || "",
    description: snippet.description || "",
    channel: snippet.channelTitle || "",
    channelId: snippet.channelId || "",
    publishedAt: snippet.publishedAt || "",
    duration,
    view_count: numberValue(statistics.viewCount),
    like_count: numberValue(statistics.likeCount),
    comment_count: numberValue(statistics.commentCount),
    discovery_source: discoveryQuery.startsWith("channel:")
      ? "youtube_api_channel"
      : discoveryQuery.startsWith("trending:")
        ? "youtube_api_trending"
        : "youtube_api",
    discovery_query: discoveryQuery
  };
}

async function searchYoutubeIds({ credential, query, channelId, options }) {
  const data = await fetchYoutube("search", {
    part: "snippet",
    type: "video",
    q: query || undefined,
    channelId: channelId || undefined,
    maxResults: options.maxResults,
    order: channelId ? "date" : "relevance",
    regionCode: options.regionCode,
    relevanceLanguage: options.relevanceLanguage,
    safeSearch: "none",
    videoEmbeddable: "true",
    publishedAfter: publishedAfterDate(options.publishedAfterDays)
  }, credential);

  return (data.items || [])
    .map((item) => item?.id?.videoId)
    .filter(Boolean);
}

async function resolveChannelHandles(credential, handles) {
  const resolved = [];
  for (const rawHandle of handles) {
    const handle = String(rawHandle || "").trim();
    if (!handle) continue;
    if (/^UC[A-Za-z0-9_-]{20,}$/.test(handle)) {
      resolved.push(handle);
      continue;
    }

    const forHandle = handle.startsWith("@") ? handle : `@${handle}`;
    try {
      const data = await fetchYoutube("channels", {
        part: "id,snippet",
        forHandle
      }, credential);
      const id = data.items?.[0]?.id;
      if (id) {
        resolved.push(id);
        continue;
      }
    } catch (error) {
      if (error.quotaExceeded || isYoutubeQuotaError(error)) throw error;
      console.warn(`Resolve channel handle gagal (${handle}): ${error.message}`);
    }

    try {
      const data = await fetchYoutube("search", {
        part: "snippet",
        type: "channel",
        q: handle.replace(/^@/, ""),
        maxResults: 1,
        safeSearch: "none"
      }, credential);
      const id = data.items?.[0]?.id?.channelId;
      if (id) resolved.push(id);
    } catch (error) {
      if (error.quotaExceeded || isYoutubeQuotaError(error)) throw error;
      console.warn(`Fallback search channel gagal (${handle}): ${error.message}`);
    }
  }
  return uniqueList(resolved);
}

async function loadYoutubeDetails(credential, ids, queryById) {
  const candidates = [];
  for (const group of chunk(ids, 50)) {
    const data = await fetchYoutube("videos", {
      part: "snippet,statistics,contentDetails,status",
      id: group.join(",")
    }, credential);

    for (const item of data.items || []) {
      const candidate = youtubeVideoResourceToCandidate(item, queryById.get(item.id) || "");
      if (candidate) candidates.push(candidate);
    }
  }
  return candidates;
}

async function youtubeDiscoveryCredentials() {
  const apiKeys = listEnvMany(["YOUTUBE_API_KEY", "YOUTUBE_DATA_API_KEY", "GOOGLE_API_KEY"], []);
  if (apiKeys.length) {
    return apiKeys.map((apiKey) => ({ apiKey, label: "api_key" }));
  }

  if (boolEnv("AUTO_DISCOVER_ALLOW_OAUTH", false)
    && config.youtube.clientId
    && config.youtube.clientSecret
    && config.youtube.refreshToken) {
    const accessToken = await getYoutubeAccessToken();
    return [{ accessToken, label: "oauth" }];
  }

  return [];
}

async function discoverWithYoutubeApi({ queries, knownIds, options, channelOnly = false }) {
  if (youtubeApiQuotaExhausted) {
    console.log("AUTO DISCOVERY: YouTube API quota sudah habis, langsung fallback ke yt-dlp search.");
    return null;
  }

  const credentials = await youtubeDiscoveryCredentials();
  if (!credentials.length) {
    console.log("AUTO DISCOVERY: credential YouTube discovery belum ada, fallback ke yt-dlp search.");
    return null;
  }

  const configuredChannelIds = listEnv("AUTO_DISCOVER_CHANNEL_IDS", []);
  const channelHandles = listEnv("AUTO_DISCOVER_CHANNEL_HANDLES", DEFAULT_CHANNEL_HANDLES);
  let lastError = null;
  for (const credential of credentials) {
    const ids = [];
    const queryById = new Map();

    try {
      console.log(`AUTO DISCOVERY: memakai YouTube ${credential.label}.`);
      if (!channelOnly) {
        for (const query of queries) {
          const found = await searchYoutubeIds({ credential, query, options });
          for (const id of found) {
            if (knownIds.has(id) || queryById.has(id)) continue;
            ids.push(id);
            queryById.set(id, query);
          }
        }
      }

      const includeChannels = channelOnly || boolEnv("AUTO_DISCOVER_INCLUDE_CHANNELS_EVERY_PASS", false);
      if (includeChannels) {
        const channelIds = uniqueList([
          ...configuredChannelIds,
          ...await resolveChannelHandles(credential, channelHandles)
        ]);
        for (const channelId of channelIds) {
          const found = await searchYoutubeIds({ credential, channelId, options });
          for (const id of found) {
            if (knownIds.has(id) || queryById.has(id)) continue;
            ids.push(id);
            queryById.set(id, `channel:${channelId}`);
          }
        }
      }

      if (!ids.length) return [];
      return loadYoutubeDetails(credential, ids, queryById);
    } catch (error) {
      lastError = error;
      if (error.quotaExceeded || isYoutubeQuotaError(error)) {
        youtubeApiQuotaExhausted = true;
        throw error;
      }
      console.warn(`YouTube API discovery gagal, coba credential berikutnya: ${error.message}`);
    }
  }

  throw lastError || new Error("YouTube API discovery gagal.");
}

async function discoverWithDailyYoutubeApiSearch({ queries, knownIds, options, targetDate }) {
  const cache = await readDiscoveryCache();
  const todayCache = cache[targetDate] || {};
  const cached = Array.isArray(todayCache.youtube_api_candidates) ? todayCache.youtube_api_candidates : [];
  const query = String(process.env.AUTO_DISCOVER_DAILY_QUERY || queries[0] || DEFAULT_QUERIES[0]).trim();
  const cacheMatchesQuery = todayCache.youtube_api_search_query === query
    && Number(todayCache.youtube_api_search_max_results || 0) === Number(options.maxResults || 0);

  if (todayCache.youtube_api_search_done && cacheMatchesQuery) {
    console.log(`AUTO DISCOVERY: search.list sudah dipakai untuk ${targetDate}, pakai cache ${cached.length} kandidat.`);
    return cached.filter((item) => {
      const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
      return id && !knownIds.has(id);
    });
  }

  const credentials = await youtubeDiscoveryCredentials();
  if (!credentials.length) {
    console.log("AUTO DISCOVERY: YOUTUBE_API_KEY belum ada, daily API search dilewati.");
    return null;
  }

  const credential = credentials[0];
  await patchDiscoveryCache(targetDate, {
    youtube_api_search_done: true,
    youtube_api_search_attempted_at: new Date().toISOString(),
    youtube_api_search_query: query,
    youtube_api_search_max_results: options.maxResults,
    youtube_api_candidates: []
  });

  try {
    console.log(`AUTO DISCOVERY: daily search.list sekali untuk ${targetDate}, query="${query}", maxResults=${options.maxResults}.`);
    const found = await searchYoutubeIds({ credential, query, options });
    const ids = uniqueList(found).filter((id) => !knownIds.has(id)).slice(0, options.maxResults);
    const queryById = new Map(ids.map((id) => [id, query]));
    const candidates = ids.length ? await loadYoutubeDetails(credential, ids, queryById) : [];
    await patchDiscoveryCache(targetDate, {
      youtube_api_search_completed_at: new Date().toISOString(),
      youtube_api_search_error: "",
      youtube_api_candidates: candidates
    });
    return candidates;
  } catch (error) {
    await patchDiscoveryCache(targetDate, {
      youtube_api_search_error: error.message,
      youtube_api_candidates: []
    });
    if (error.quotaExceeded || isYoutubeQuotaError(error)) {
      youtubeApiQuotaExhausted = true;
    }
    throw error;
  }
}

async function discoverTrendingWithYoutubeApi({ knownIds, options }) {
  if (youtubeApiQuotaExhausted) {
    console.log("AUTO DISCOVERY: YouTube API quota sudah habis, trending dilewati.");
    return null;
  }

  const credentials = await youtubeDiscoveryCredentials();
  if (!credentials.length) {
    console.log("AUTO DISCOVERY: YOUTUBE_API_KEY belum ada, trending dilewati.");
    return null;
  }

  const categoryIds = listEnv("AUTO_DISCOVER_TRENDING_CATEGORY_IDS", ["24", "22"])
    .map((item) => String(item || "").trim())
    .map((item) => item.toLowerCase() === "all" ? "" : item)
    .filter((item, index, list) => list.indexOf(item) === index);
  const categories = categoryIds.length ? categoryIds : [""];
  let lastError = null;

  for (const credential of credentials) {
    const candidates = new Map();
    try {
      for (const categoryId of categories) {
        const query = `trending:${options.regionCode}${categoryId ? `:${categoryId}` : ""}`;
        const data = await fetchYoutube("videos", {
          part: "snippet,statistics,contentDetails,status",
          chart: "mostPopular",
          regionCode: options.regionCode,
          videoCategoryId: categoryId || undefined,
          maxResults: options.trendingMaxResults || options.maxResults
        }, credential);

        for (const item of data.items || []) {
          if (knownIds.has(item.id) || candidates.has(item.id)) continue;
          const candidate = youtubeVideoResourceToCandidate(item, query);
          if (candidate) candidates.set(item.id, candidate);
        }
      }
      return [...candidates.values()];
    } catch (error) {
      lastError = error;
      if (error.quotaExceeded || isYoutubeQuotaError(error)) {
        youtubeApiQuotaExhausted = true;
        throw error;
      }
      console.warn(`YouTube trending discovery gagal, coba credential berikutnya: ${error.message}`);
    }
  }

  throw lastError || new Error("YouTube trending discovery gagal.");
}

async function discoverWithYtDlp({ queries, knownIds, options }) {
  const candidates = new Map();
  for (const query of queries) {
    try {
      const results = await runYtDlpSearch(query, options.maxResults);
      for (const item of results) {
        const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
        if (!id || knownIds.has(id) || candidates.has(id)) continue;
        candidates.set(id, {
          ...item,
          id,
          url: item.webpage_url || item.url || videoUrl(id),
          discovery_source: "yt_dlp",
          discovery_query: query
        });
      }
    } catch (error) {
      console.warn(`Auto discovery query gagal (${query}): ${error.message}`);
    }
  }
  return [...candidates.values()];
}

async function discoverChannelsWithYtDlp({ knownIds, options }) {
  const channelHandles = listEnv("AUTO_DISCOVER_CHANNEL_HANDLES", DEFAULT_CHANNEL_HANDLES);
  const candidates = new Map();
  for (const handle of channelHandles) {
    try {
      const results = await runYtDlpChannel(handle, options.maxResults);
      for (const item of results) {
        const id = item.id || extractYoutubeVideoId(item.url || item.webpage_url);
        if (!id || knownIds.has(id) || candidates.has(id)) continue;
        candidates.set(id, {
          ...item,
          id,
          url: item.webpage_url || item.url || videoUrl(id),
          channel: item.channel || item.uploader || item.playlist_channel || item.playlist_uploader || handle,
          discovery_source: "yt_dlp_channel",
          discovery_query: `channel:${handle}`
        });
      }
    } catch (error) {
      console.warn(`Auto discovery channel gagal (${handle}): ${error.message}`);
    }
  }
  return [...candidates.values()];
}

async function loadRawCandidates({ queries, knownIds, options, targetDate, channelOnly = false, useApi = true, dailyApiSearch = false, trending = false }) {
  let rawCandidates = null;
  if (trending) {
    try {
      rawCandidates = await discoverTrendingWithYoutubeApi({ knownIds, options });
    } catch (error) {
      console.warn(`YouTube trending discovery dilewati: ${error.message}`);
    }
    return rawCandidates || [];
  }

  if (dailyApiSearch) {
    try {
      rawCandidates = await discoverWithDailyYoutubeApiSearch({ queries, knownIds, options, targetDate });
    } catch (error) {
      console.warn(`Daily YouTube API search dilewati: ${error.message}`);
    }
  } else if (useApi) {
    try {
      rawCandidates = await discoverWithYoutubeApi({ queries, knownIds, options, channelOnly });
    } catch (error) {
      console.warn(`YouTube API discovery dilewati: ${error.message}`);
    }
  } else {
    console.log("AUTO DISCOVERY: pass ini pakai yt-dlp agar hemat YouTube API quota.");
  }

  if (!rawCandidates) {
    rawCandidates = channelOnly
      ? await discoverChannelsWithYtDlp({ knownIds, options })
      : await discoverWithYtDlp({ queries, knownIds, options });
  }

  return rawCandidates || [];
}

async function validateCandidateAvailability(item) {
  if (!boolEnv("AUTO_DISCOVER_VALIDATE_URL", true)) return true;
  const url = item.webpage_url || item.url || videoUrl(item.id);
  try {
    await runYtDlpValidate(url);
    return true;
  } catch (error) {
    console.warn(`AUTO DISCOVERY kandidat dilewati karena link tidak valid (${url}): ${error.message}`);
    return false;
  }
}

async function selectDiscoveredCandidates(rawCandidates, options, addCount, mode) {
  const filter = mode === "fresh_channels"
    ? isFreshChannelCandidate
    : mode === "today_trending" ? isTrendingPodcastCandidate
    : ["best_available", "daily_api_search"].includes(mode) ? isTopicCandidate : isViralCandidate;
  const ranked = rawCandidates
    .filter((item) => filter(item, options))
    .map((item) => ({
      ...item,
      discovery_score: scoreCandidate(item),
      discovery_stats: viralStats(item),
      discovery_fallback_mode: mode
    }))
    .sort((a, b) => b.discovery_score - a.discovery_score)
    .slice(0, Math.max(addCount * 4, addCount));

  const selected = [];
  for (const item of ranked) {
    if (!await validateCandidateAvailability(item)) continue;
    selected.push(item);
    if (selected.length >= addCount) break;
  }
  return selected;
}

function fallbackPasses(baseQueries, baseOptions) {
  const fallbackQueries = uniqueList([...baseQueries, ...FALLBACK_QUERIES]);
  const useDailyApi = boolEnv("AUTO_DISCOVER_USE_API", false);
  const dailyApiMaxResults = numberEnv("AUTO_DISCOVER_DAILY_SEARCH_RESULTS", 7, 1, 50);
  const trendingMaxResults = numberEnv("AUTO_DISCOVER_TRENDING_MAX_RESULTS", 25, 1, 50);
  const fallbackMaxResults = numberEnv("AUTO_DISCOVER_FALLBACK_MAX_RESULTS", 12, baseOptions.maxResults, 50);
  const freshUploadDays = numberEnv("AUTO_DISCOVER_FRESH_UPLOAD_DAYS", 1, 1, 30);
  const freshChannelMaxResults = numberEnv("AUTO_DISCOVER_CHANNEL_MAX_RESULTS", 3, 1, 25);
  const trendingEnabled = boolEnv("AUTO_DISCOVER_TRENDING_ENABLED", true);

  return [
    {
      mode: "fresh_channels",
      channelOnly: true,
      useApi: true,
      queries: [],
      options: {
        ...baseOptions,
        maxResults: freshChannelMaxResults,
        publishedAfterDays: freshUploadDays,
        minViews: 0,
        minViewsPerHour: 0
      }
    },
    ...(useDailyApi && trendingEnabled ? [{
      mode: "today_trending",
      trending: true,
      useApi: true,
      queries: [],
      options: {
        ...baseOptions,
        maxResults: trendingMaxResults,
        trendingMaxResults,
        minViews: 0,
        minViewsPerHour: 0
      }
    }] : []),
    ...(useDailyApi ? [{
      mode: "daily_api_search",
      dailyApiSearch: true,
      useApi: true,
      queries: [String(process.env.AUTO_DISCOVER_DAILY_QUERY || baseQueries[0] || DEFAULT_QUERIES[0]).trim()],
      options: {
        ...baseOptions,
        maxResults: dailyApiMaxResults
      }
    }] : []),
    {
      mode: "strict",
      useApi: false,
      queries: baseQueries,
      options: baseOptions
    },
    {
      mode: "wide_search",
      useApi: false,
      queries: fallbackQueries,
      options: {
        ...baseOptions,
        maxResults: fallbackMaxResults,
        publishedAfterDays: Math.max(baseOptions.publishedAfterDays, 7),
        minViews: Math.max(10000, Math.floor(baseOptions.minViews * 0.5)),
        minViewsPerHour: Math.max(250, Math.floor(baseOptions.minViewsPerHour * 0.5))
      }
    },
    {
      mode: "relaxed_viral",
      useApi: false,
      queries: fallbackQueries,
      options: {
        ...baseOptions,
        maxResults: fallbackMaxResults,
        publishedAfterDays: Math.max(baseOptions.publishedAfterDays, 14),
        minDuration: Math.min(baseOptions.minDuration, 300),
        minViews: Math.max(5000, Math.floor(baseOptions.minViews * 0.25)),
        minViewsPerHour: Math.max(100, Math.floor(baseOptions.minViewsPerHour * 0.2))
      }
    },
    {
      mode: "best_available",
      useApi: false,
      queries: fallbackQueries,
      options: {
        ...baseOptions,
        maxResults: fallbackMaxResults,
        publishedAfterDays: Math.max(baseOptions.publishedAfterDays, 30),
        minDuration: Math.min(baseOptions.minDuration, 300),
        minViews: 0,
        minViewsPerHour: 0
      }
    }
  ];
}

export async function discoverAndQueueVideos(options = {}) {
  if (!boolEnv("AUTO_DISCOVER_VIDEOS", true)) {
    return { skipped: true, reason: "AUTO_DISCOVER_VIDEOS=false", added: [] };
  }

  const targetDate = options.targetDate || todayDate();
  const queueMaintenance = await expireOldAutoDiscoveryQueue(targetDate);
  const dailyQueueLimit = autoDiscoveryDailyQueueLimit();
  const currentDailyQueue = countDailyAutoDiscoveryQueue(queueMaintenance.videos, targetDate);
  const ignoreDailyQueueLimit = options.ignoreDailyQueueLimit === true;
  const remainingDailyQueueSlots = dailyQueueLimit > 0
    ? Math.max(0, dailyQueueLimit - currentDailyQueue)
    : Number.POSITIVE_INFINITY;

  if (dailyQueueLimit > 0 && remainingDailyQueueSlots <= 0 && !ignoreDailyQueueLimit) {
    console.log(
      `AUTO DISCOVERY skip: queue harian ${targetDate} sudah ${currentDailyQueue}/${dailyQueueLimit}.`
    );
    return {
      skipped: true,
      reason: "daily_queue_limit_reached",
      added: [],
      expired_count: queueMaintenance.expired,
      daily_queue_count: currentDailyQueue,
      daily_queue_limit: dailyQueueLimit
    };
  }

  const queries = listEnv("AUTO_DISCOVER_QUERY", DEFAULT_QUERIES);
  const maxResults = numberEnv("AUTO_DISCOVER_MAX_RESULTS", 4, 1, 25);
  const requestedAddCount = numberEnv("AUTO_DISCOVER_ADD_COUNT", 1, 1, 10);
  const addCount = ignoreDailyQueueLimit
    ? requestedAddCount
    : Math.min(requestedAddCount, remainingDailyQueueSlots);
  const minDuration = numberEnv("AUTO_DISCOVER_MIN_DURATION_SECONDS", 600, 0, 86400);
  const maxDuration = numberEnv("AUTO_DISCOVER_MAX_DURATION_SECONDS", 10800, 60, 86400);
  const minViews = numberEnv("AUTO_DISCOVER_MIN_VIEWS", 25000, 0, 1000000000);
  const minViewsPerHour = numberEnv("AUTO_DISCOVER_MIN_VIEWS_PER_HOUR", 500, 0, 1000000000);
  const publishedAfterDays = numberEnv("AUTO_DISCOVER_PUBLISHED_AFTER_DAYS", 2, 1, 365);
  const trendingMaxAgeHours = numberEnv("AUTO_DISCOVER_TRENDING_MAX_AGE_HOURS", 36, 1, 168);
  const regionCode = String(process.env.AUTO_DISCOVER_REGION_CODE || "ID").trim().toUpperCase();
  const relevanceLanguage = String(process.env.AUTO_DISCOVER_RELEVANCE_LANGUAGE || "id").trim().toLowerCase();
  const discoveryOptions = {
    maxResults,
    minDuration,
    maxDuration,
    minViews,
    minViewsPerHour,
    publishedAfterDays,
    trendingMaxAgeHours,
    regionCode,
    relevanceLanguage
  };
  const theme = options.theme && options.theme !== "auto" ? options.theme : "podcast artis";

  const videos = queueMaintenance.videos;
  const history = await readJson("history", []);
  const knownIds = knownVideoIds(videos, history);

  let selected = [];
  let selectedPass = "";
  for (const pass of fallbackPasses(queries, discoveryOptions)) {
    console.log(`AUTO DISCOVERY pass=${pass.mode}, queries=${pass.queries.length}, maxResults=${pass.options.maxResults}, days=${pass.options.publishedAfterDays}`);
    const rawCandidates = await loadRawCandidates({
      queries: pass.queries,
      knownIds,
      options: pass.options,
      targetDate,
      channelOnly: Boolean(pass.channelOnly),
      useApi: pass.useApi !== false,
      dailyApiSearch: Boolean(pass.dailyApiSearch),
      trending: Boolean(pass.trending)
    });
    selected = await selectDiscoveredCandidates(rawCandidates, pass.options, addCount, pass.mode);
    if (selected.length) {
      selectedPass = pass.mode;
      console.log(`AUTO DISCOVERY pass=${pass.mode} memilih ${selected.length} kandidat.`);
      break;
    }
    console.log(`AUTO DISCOVERY pass=${pass.mode} kosong; lanjut fallback.`);
  }

  const added = [];
  for (const [index, item] of selected.entries()) {
    const url = item.webpage_url || item.url || videoUrl(item.id);
    const stats = item.discovery_stats || viralStats(item);
    const video = await addVideo({
      url,
      theme,
      target_date: targetDate,
      priority: 10 + index,
      status: "queued",
      quality_profile: process.env.VIDEO_QUALITY_PROFILE || "standard",
      clip_count: Number(process.env.CLIP_COUNT || 1),
      subtitle_font: process.env.SUBTITLE_FONT_FAMILY || "Segoe UI Semibold",
      subtitle_font_size: Number(process.env.SUBTITLE_FONT_SIZE || 46),
      subtitle_margin_v: Number(process.env.SUBTITLE_MARGIN_V || 550),
      subtitle_margin_h: Number(process.env.SUBTITLE_MARGIN_H || 180),
      use_frame: boolEnv("VIDEO_FRAME_ENABLED", true),
      use_filter: boolEnv("VIDEO_FILTER_ENABLED", true),
      use_watermark: boolEnv("VIDEO_WATERMARK_ENABLED", true),
      notes: [
        `Auto discovery: ${item.discovery_query || "unknown"}`,
        `source=${item.discovery_source || "unknown"}`,
        `fallback=${item.discovery_fallback_mode || selectedPass || "strict"}`,
        `score=${item.discovery_score}`,
        item.channel ? `channel=${item.channel}` : "",
        stats.views ? `views=${stats.views}` : "",
        stats.viewsPerHour ? `views_per_hour=${Math.round(stats.viewsPerHour)}` : ""
      ].filter(Boolean).join("; "),
      source_title: item.title || "",
      channel_title: item.channel || "",
      published_at_source: item.publishedAt || "",
      discovery_source: item.discovery_source || "",
      discovery_query: item.discovery_query || "",
      discovery_fallback_mode: item.discovery_fallback_mode || selectedPass || "strict",
      discovery_score: item.discovery_score || 0,
      discovery_views: stats.views || 0,
      discovery_likes: stats.likes || 0,
      discovery_comments: stats.comments || 0,
      discovery_views_per_hour: Math.round(stats.viewsPerHour || 0)
    });
    added.push(video);
    knownIds.add(video.youtube_video_id);
  }

  if (added.length) {
    console.log("AUTO DISCOVERY queued videos:", added.map((item) => ({
      id: item.id,
      youtube_video_id: item.youtube_video_id,
      url: item.url,
      target_date: item.target_date
    })));
  } else {
    console.log("AUTO DISCOVERY tidak menemukan kandidat viral baru.");
  }

  return {
    skipped: false,
    added,
    expired_count: queueMaintenance.expired,
    daily_queue_count: currentDailyQueue + added.length,
    daily_queue_limit: dailyQueueLimit
  };
}

const isCli = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  discoverAndQueueVideos({
    theme: process.env.THEME || "podcast artis",
    targetDate: todayDate()
  })
    .then((result) => {
      console.log(JSON.stringify({
        ...result,
        added: result.added?.map((item) => ({
          id: item.id,
          url: item.url,
          status: item.status
        })) || []
      }, null, 2));
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}
