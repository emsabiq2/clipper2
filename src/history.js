import { readJson, writeJson } from "./storage.js";
import { todayDate } from "./job-id.js";

function videoKeys(entry = {}) {
  return [
    entry.youtube_video_id,
    entry.source_url,
    entry.url,
    entry.final_video_hash,
    entry.instagram_media_id
  ].filter(Boolean);
}

export async function hasProcessedVideo(video) {
  const history = await readJson("history", []);
  const targetKeys = new Set(videoKeys(video));
  if (!targetKeys.size) return false;
  return history.some((entry) => {
    if (!["published", "ready_to_publish", "clipper_done"].includes(entry.status)) return false;
    return videoKeys(entry).some((key) => targetKeys.has(key));
  });
}

export async function hasPublishedToday(date = todayDate()) {
  const history = await readJson("history", []);
  return history.some((entry) => entry.status === "published" && entry.publish_date === date);
}

export async function publishedCountToday(date = todayDate()) {
  const history = await readJson("history", []);
  return history.filter((entry) => entry.status === "published" && entry.publish_date === date).length;
}

export async function appendHistory(entry) {
  const history = await readJson("history", []);
  history.push({
    ...entry,
    recorded_at: new Date().toISOString()
  });
  await writeJson("history", history.slice(-500));
}
