import {
  methodAllowed,
  readBody,
  readStateFile,
  requireAuth,
  sendJson,
  uploadStateFile
} from "../_utils.js";

const resettableQueueStatuses = new Set(["queued", "failed", "retry"]);

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["POST"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const body = await readBody(req);
    const targetDate = clean(body.target_date) || todayDate();
    const result = await expireStaleAutoDiscoveryQueue(targetDate);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

async function expireStaleAutoDiscoveryQueue(targetDate) {
  const targetSerial = dateSerial(targetDate);
  if (targetSerial === null) throw new Error("target_date tidak valid.");

  const ttlDays = Math.max(1, Math.floor(Number(process.env.AUTO_DISCOVER_QUEUE_TTL_DAYS) || 1));
  const videos = await readStateFile("videos.json");
  const now = new Date().toISOString();
  let expired = 0;

  const nextVideos = (Array.isArray(videos) ? videos : []).map((video) => {
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

  if (expired) await uploadStateFile("videos.json", nextVideos);
  return {
    ok: true,
    expired,
    target_date: targetDate,
    ttl_days: ttlDays
  };
}

function dateSerial(dateString) {
  const match = String(dateString || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const [, year, month, day] = match.map(Number);
  return Math.floor(Date.UTC(year, month - 1, day) / 86400000);
}

function todayDate() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: clean(process.env.APP_TIMEZONE || "Asia/Jakarta"),
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function isAutoDiscoveryVideo(video) {
  return Boolean(
    video?.discovery_source
      || video?.discovery_query
      || String(video?.notes || "").startsWith("Auto discovery:")
  );
}

function clean(value) {
  return String(value || "").trim();
}
