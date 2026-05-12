import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import { uploadVideoFile } from "./uploader.js";

const QUALITY_STEPS = [
  { video: "900k", audio: "96k" },
  { video: "750k", audio: "80k" },
  { video: "600k", audio: "64k" }
];

async function fileSize(filePath) {
  const stat = await fs.stat(filePath);
  return stat.size;
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg gagal (${code}): ${stderr.slice(-1200)}`));
    });
  });
}

async function transcodeInstagramVideo({ sourcePath, targetPath, videoBitrate, audioBitrate }) {
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  await runFfmpeg([
    "-y",
    "-i",
    sourcePath,
    "-map_metadata",
    "-1",
    "-vf",
    "fps=30,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2,format=yuv420p",
    "-c:v",
    "libx264",
    "-profile:v",
    "high",
    "-level:v",
    "4.1",
    "-preset",
    "veryfast",
    "-b:v",
    videoBitrate,
    "-maxrate",
    videoBitrate,
    "-bufsize",
    "1800k",
    "-g",
    "60",
    "-bf",
    "0",
    "-c:a",
    "aac",
    "-ar",
    "48000",
    "-ac",
    "2",
    "-b:a",
    audioBitrate,
    "-movflags",
    "+faststart",
    "-shortest",
    targetPath
  ]);
}

export async function prepareInstagramVideo({ job, sourcePath, currentVideoUrl }) {
  const maxBytes = config.instagram.maxUploadBytes;
  const originalSize = await fileSize(sourcePath);

  if (!maxBytes || originalSize <= maxBytes) {
    return {
      videoUrl: currentVideoUrl,
      videoPath: sourcePath,
      compressed: false,
      bytes: originalSize
    };
  }

  let best = null;
  const dir = path.join(config.generatedDir, "instagram");

  for (const [index, quality] of QUALITY_STEPS.entries()) {
    const targetPath = path.join(dir, `${job.job_id}-ig-${index + 1}.mp4`);
    await transcodeInstagramVideo({
      sourcePath,
      targetPath,
      videoBitrate: quality.video,
      audioBitrate: quality.audio
    });

    const bytes = await fileSize(targetPath);
    best = { targetPath, bytes, quality };
    console.log("IG video variant dibuat:", {
      file: path.basename(targetPath),
      bytes,
      maxBytes,
      videoBitrate: quality.video,
      audioBitrate: quality.audio
    });

    if (bytes <= maxBytes) break;
  }

  if (!best) {
    return {
      videoUrl: currentVideoUrl,
      videoPath: sourcePath,
      compressed: false,
      bytes: originalSize
    };
  }

  const videoName = `${job.job_id}-ig.mp4`;
  const videoUrl = await uploadVideoFile({
    videoPath: best.targetPath,
    videoName
  });

  console.log("IG memakai video khusus:", {
    videoName,
    originalBytes: originalSize,
    instagramBytes: best.bytes,
    maxBytes
  });

  return {
    videoUrl,
    videoPath: best.targetPath,
    compressed: true,
    bytes: best.bytes,
    originalBytes: originalSize
  };
}
