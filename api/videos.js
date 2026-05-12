import {
  buildVideo,
  dispatchWorkflow,
  methodAllowed,
  readBody,
  readStateFile,
  requireAuth,
  sendJson,
  uploadStateFile,
  upsertById
} from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  if (!requireAuth(req, res)) return;

  try {
    if (req.method === "GET") {
      sendJson(res, 200, await readStateFile("videos.json"));
      return;
    }

    const body = await readBody(req);
    const video = buildVideo(body);
    const videos = upsertById(await readStateFile("videos.json"), video);
    await uploadStateFile("videos.json", videos);

    if (body.run_now === true || body.run_now === "true") {
      await dispatchWorkflow({
        theme: video.theme || "auto",
        url: video.url,
        range: video.manual_range || "",
        force_reprocess: video.force_reprocess ? "true" : "false",
        ai_provider: "openai",
        quality_profile: video.quality_profile || "standard",
        deepgram_enabled: "1",
        scene_mode: video.scene_mode || "podcast",
        clip_count: String(video.clip_count || 1),
        subtitle_font: video.subtitle_font || "Segoe UI Semibold",
        subtitle_font_size: String(video.subtitle_font_size || 46),
        subtitle_margin_v: String(video.subtitle_margin_v || 550),
        subtitle_margin_h: String(video.subtitle_margin_h || 180),
        use_frame: video.use_frame ? "true" : "false",
        use_filter: video.use_filter ? "true" : "false",
        use_watermark: video.use_watermark ? "true" : "false",
        background_music_enabled: video.use_music ? "1" : "0"
      });
    }

    sendJson(res, 200, video);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}
