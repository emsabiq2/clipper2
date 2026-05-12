import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

function boolInput(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

export async function runClipper({ video, job, onLog = () => {} }) {
  const clipperRoot = config.clipper.rootDir;
  const scriptPath = path.join(clipperRoot, "scripts", "clipper.py");
  await assertFile(scriptPath, "Clipper script tidak ditemukan");

  const startedAt = Date.now();
  const args = ["scripts/clipper.py", video.url || video.source_url];
  if (video.manual_range) {
    args.push("--range", video.manual_range);
  }

  const quality = qualityPreset(video.quality_profile);
  const sceneMode = String(video.scene_mode || process.env.SCENE_MODE || process.env.SMART_CROP_MODE || "podcast");
  const clipCount = String(video.clip_count || process.env.CLIP_COUNT || config.clipper.clipCount);
  const subtitleMarginV = Math.max(
    550,
    Number(video.subtitle_margin_v || process.env.SUBTITLE_MARGIN_V || 550) || 550
  );
  const env = {
    ...process.env,
    CLIP_COUNT: clipCount,
    MIN_CLIP_SECONDS: String(config.clipper.minClipSeconds),
    MAX_CLIP_SECONDS: String(config.clipper.maxClipSeconds),
    DOWNLOAD_MAX_HEIGHT: String(quality.downloadMaxHeight),
    DOWNLOAD_COMPRESS_CRF: String(quality.downloadCrf),
    FINAL_RENDER_CRF: String(quality.finalCrf),
    SUBTITLE_FONT_FAMILY: String(video.subtitle_font || process.env.SUBTITLE_FONT_FAMILY || "Segoe UI Semibold"),
    SUBTITLE_FONT_SIZE: String(video.subtitle_font_size || process.env.SUBTITLE_FONT_SIZE || 46),
    SUBTITLE_MARGIN_V: String(subtitleMarginV),
    SUBTITLE_MARGIN_H: String(video.subtitle_margin_h || process.env.SUBTITLE_MARGIN_H || 180),
    SCENE_MODE: sceneMode,
    SMART_CROP_MODE: sceneMode,
    THEME: String(video.theme || job.theme || config.defaultTheme || ""),
    BACKGROUND_MUSIC_ENABLED: boolInput(video.use_music ?? job.use_music, boolInput(process.env.BACKGROUND_MUSIC_ENABLED, true)) ? "1" : "0"
  };

  onLog(`Running clipper: ${config.clipper.pythonCommand} ${args.join(" ")}`);

  const output = await new Promise((resolve, reject) => {
    const child = spawn(config.clipper.pythonCommand, args, {
      cwd: clipperRoot,
      env,
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stdout += text;
      onLog(text.trim());
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString("utf8");
      stderr += text;
      onLog(text.trim());
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`Clipper failed with exit code ${code}: ${stderr || stdout}`));
    });
  });

  const parsed = extractResultJson(output.stdout) || await findLatestResult(clipperRoot, video.url || video.source_url, startedAt);
  if (!parsed) throw new Error("Clipper selesai, tetapi file result JSON tidak ditemukan.");

  return normalizeClipperResult(parsed, clipperRoot, job);
}

function qualityPreset(value) {
  const preset = String(value || process.env.VIDEO_QUALITY_PROFILE || "standard").toLowerCase();
  const profiles = {
    fast: {
      downloadMaxHeight: 480,
      downloadCrf: 32,
      finalCrf: 30
    },
    standard: {
      downloadMaxHeight: 720,
      downloadCrf: 30,
      finalCrf: 27
    },
    high: {
      downloadMaxHeight: 1080,
      downloadCrf: 24,
      finalCrf: 23
    },
    ultra: {
      downloadMaxHeight: 1080,
      downloadCrf: 20,
      finalCrf: 20
    }
  };
  return profiles[preset] || profiles.standard;
}

async function assertFile(filePath, message) {
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error(message);
  } catch {
    throw new Error(`${message}: ${filePath}`);
  }
}

function extractResultJson(stdout) {
  const marker = '{\n  "jobId"';
  const index = stdout.lastIndexOf(marker);
  if (index === -1) return null;
  try {
    return JSON.parse(stdout.slice(index));
  } catch {
    return null;
  }
}

async function findLatestResult(clipperRoot, sourceUrl, startedAt) {
  const outputDir = path.join(clipperRoot, "output");
  let entries = [];
  try {
    entries = await fs.readdir(outputDir, { withFileTypes: true });
  } catch {
    return null;
  }

  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.startsWith("py-result-") || !entry.name.endsWith(".json")) continue;
    const fullPath = path.join(outputDir, entry.name);
    const stat = await fs.stat(fullPath);
    if (stat.mtimeMs < startedAt - 5000) continue;
    files.push({ fullPath, mtime: stat.mtimeMs });
  }

  files.sort((a, b) => b.mtime - a.mtime);
  for (const file of files) {
    try {
      const data = JSON.parse(await fs.readFile(file.fullPath, "utf8"));
      if (!sourceUrl || data.sourceUrl === sourceUrl) return data;
    } catch {
      // Try the next result file.
    }
  }
  return null;
}

function normalizeClipperResult(result, clipperRoot, job) {
  const outputs = Array.isArray(result.outputs) ? result.outputs : [];
  return {
    ...result,
    automationJobId: job.job_id,
    clipperRoot,
    outputs: outputs.map((item) => ({
      ...item,
      finalAbsPath: item.finalPath ? path.resolve(clipperRoot, item.finalPath) : "",
      subtitleAbsPath: item.subtitlePath ? path.resolve(clipperRoot, item.subtitlePath) : "",
      transcriptReviewAbsPath: item.transcriptReviewPath ? path.resolve(clipperRoot, item.transcriptReviewPath) : "",
      smartCropAbsPath: item.smartCropPath ? path.resolve(clipperRoot, item.smartCropPath) : ""
    }))
  };
}
