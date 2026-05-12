import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

const FRAME = {
  width: 950,
  height: 1375,
  x: 65,
  y: 138
};
const rendererPath = path.join(config.srcDir, "branding-renderer.py");

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function effectOptions(video = {}, options = {}) {
  return {
    frame: boolValue(options.useFrame ?? video.use_frame, config.videoEffects.frameEnabled),
    filter: boolValue(options.useFilter ?? video.use_filter, config.videoEffects.filterEnabled),
    watermark: boolValue(options.useWatermark ?? video.use_watermark, config.videoEffects.watermarkEnabled),
    lowerThird: boolValue(options.useLowerThird ?? video.use_lower_third, config.videoEffects.lowerThirdEnabled)
  };
}

function hasAnyEffect(options) {
  return options.frame || options.filter || options.watermark;
}

async function fileIsReadable(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function hasAudioStream(filePath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-select_streams", "a:0",
      "-show_entries", "stream=index",
      "-of", "csv=p=0",
      filePath
    ], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(false));
    child.on("close", () => resolve(Boolean(stdout.trim())));
  });
}

function ffmpegPathArg(filePath) {
  return String(filePath).replace(/\\/g, "/").replace(/'/g, "\\'");
}

function lightFilterChain() {
  return [
    "eq=brightness=0.012:contrast=1.035:saturation=1.06",
    "hue=h=2:s=1.02",
    "noise=alls=2:allf=t+u"
  ].join(",");
}

function normalizeOverlayText(value) {
  return String(value || "")
    .replace(/[`*_#]/g, "")
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .split(/\s+/)
    .slice(0, 11)
    .join(" ");
}

function buildFilterGraph({ useFrame, useFilter, useWatermark, useLowerThird }) {
  const filters = [];
  const sourceFilters = ["setpts=PTS-STARTPTS", "setsar=1", "fps=30"];
  let nextInputIndex = 1;
  const bgIndex = useFrame ? nextInputIndex++ : null;
  const frameIndex = useFrame ? nextInputIndex++ : null;
  const lowerThirdIndex = useLowerThird ? nextInputIndex++ : null;
  const watermarkIndex = useWatermark ? nextInputIndex++ : null;

  if (useFrame) {
    sourceFilters.push(`scale=${FRAME.width}:${FRAME.height}:force_original_aspect_ratio=increase`);
    sourceFilters.push(`crop=${FRAME.width}:${FRAME.height}`);
  }
  if (useFilter) sourceFilters.push(lightFilterChain());
  filters.push(`[0:v]${sourceFilters.join(",")}[video]`);

  let current = "video";
  if (useFrame) {
    filters.push(`[${bgIndex}:v][${current}]overlay=${FRAME.x}:${FRAME.y}:shortest=1[framedbase]`);
    filters.push(`[framedbase][${frameIndex}:v]overlay=0:0:shortest=1[framed]`);
    current = "framed";
  }

  if (useLowerThird) {
    filters.push(`[${current}][${lowerThirdIndex}:v]overlay=0:0:shortest=1[lowerthird]`);
    current = "lowerthird";
  }

  if (useWatermark) {
    const size = useFrame ? 118 : 126;
    const x = useFrame ? `${FRAME.x + FRAME.width - size - 34}` : "W-w-36";
    const y = useFrame ? `${FRAME.y + 34}` : "36";
    filters.push(`[${watermarkIndex}:v]scale=${size}:${size}:force_original_aspect_ratio=decrease,format=rgba,colorchannelmixer=aa=0.20[wm]`);
    filters.push(`[${current}][wm]overlay=${x}:${y}:shortest=1[vout]`);
    current = "vout";
  }

  if (current !== "vout") filters.push(`[${current}]null[vout]`);
  return filters.join(";");
}

async function renderLowerThirdOverlay({ job, text }) {
  const outputPath = path.join(config.generatedVideoDir, `${job.job_id}-lower-third.png`);
  await runRenderer([
    "lower-third",
    "--output", outputPath,
    "--quote", normalizeOverlayText(text),
    "--brand", config.videoEffects.lowerThirdBrand || "@clipperemsapro | Podcast Highlight"
  ]);
  return outputPath;
}

function runRenderer(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(config.clipper.pythonCommand, [rendererPath, ...args], { windowsHide: true });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `branding renderer exited with ${code}`));
    });
  });
}

async function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg video effects gagal (${code}): ${stderr.slice(-1600)}`));
    });
  });
}

export async function applyVideoEffects({ job, video, output, options = {} }) {
  const selected = effectOptions(video, options);
  if (!hasAnyEffect(selected)) {
    return {
      output,
      effects: {
        applied: false,
        ...selected
      }
    };
  }

  const inputPath = output.finalAbsPath;
  if (!await fileIsReadable(inputPath)) {
    throw new Error(`Video efek gagal: file input tidak ditemukan: ${inputPath}`);
  }

  const useFrame = selected.frame;
  const useWatermark = selected.watermark && await fileIsReadable(config.videoEffects.watermarkAssetPath);
  const lowerThirdText = normalizeOverlayText(
    options.lowerThirdText
    || video.lower_third_text
    || output.frameQuoteText
    || output.thumbnailText
    || output.hook
    || output.caption
  );
  const useLowerThird = Boolean(useFrame && selected.lowerThird && lowerThirdText);
  if (selected.frame && !await fileIsReadable(config.videoEffects.frameAssetPath)) {
    throw new Error(`VIDEO_FRAME_ASSET tidak ditemukan: ${config.videoEffects.frameAssetPath}`);
  }
  if (selected.watermark && !useWatermark) {
    throw new Error(`VIDEO_WATERMARK_ASSET tidak ditemukan: ${config.videoEffects.watermarkAssetPath}`);
  }

  await fs.mkdir(config.generatedVideoDir, { recursive: true });
  const outputPath = path.join(config.generatedVideoDir, `${job.job_id}-branded.mp4`);
  const tempPath = path.join(config.generatedVideoDir, `${job.job_id}-branded.tmp.mp4`);
  await fs.rm(tempPath, { force: true }).catch(() => {});
  const hasAudio = await hasAudioStream(inputPath);

  const lowerThirdPath = useLowerThird
    ? await renderLowerThirdOverlay({ job, text: lowerThirdText })
    : "";

  const args = ["-y", "-fflags", "+genpts", "-i", inputPath];
  if (useFrame) {
    args.push("-f", "lavfi", "-i", "color=c=#070709:s=1080x1920:r=30");
    args.push("-loop", "1", "-i", config.videoEffects.frameAssetPath);
  }
  if (useLowerThird) {
    args.push("-loop", "1", "-i", lowerThirdPath);
  }
  if (useWatermark) {
    args.push("-loop", "1", "-i", config.videoEffects.watermarkAssetPath);
  }

  args.push(
    "-filter_complex",
    buildFilterGraph({
      useFrame,
      useFilter: selected.filter,
      useWatermark,
      useLowerThird
    }),
    "-map",
    "[vout]",
    "-c:v",
    "libx264",
    "-preset",
    config.videoEffects.preset || "veryfast",
    "-crf",
    String(config.videoEffects.crf),
    "-pix_fmt",
    "yuv420p"
  );

  if (hasAudio) {
    args.push(
      "-map",
      "0:a:0",
      "-af",
      "aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS",
      "-c:a",
      "aac",
      "-ar",
      "48000",
      "-ac",
      "2",
      "-b:a",
      "128k"
    );
  }

  args.push(
    "-avoid_negative_ts",
    "make_zero",
    "-movflags",
    "+faststart",
    "-shortest",
    tempPath
  );

  await runFfmpeg(args);
  await fs.rename(tempPath, outputPath);

  return {
    output: {
      ...output,
      originalFinalAbsPath: inputPath,
      finalAbsPath: outputPath
    },
    effects: {
      applied: true,
      frame: useFrame,
      filter: selected.filter,
      watermark: useWatermark,
      lowerThird: useLowerThird,
      lowerThirdText: useLowerThird ? lowerThirdText : "",
      frameAssetPath: useFrame ? ffmpegPathArg(config.videoEffects.frameAssetPath) : "",
      watermarkAssetPath: useWatermark ? ffmpegPathArg(config.videoEffects.watermarkAssetPath) : ""
    }
  };
}
