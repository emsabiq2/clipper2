import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { config } from "./config.js";

const CANVAS_WIDTH = 1080;
const CANVAS_HEIGHT = 1920;
const BOX_MARGIN_X = 60;
const BOX_W = CANVAS_WIDTH - (BOX_MARGIN_X * 2);
const BOX_PADDING_X = 36;
const BOX_PADDING_Y = 30;
const BOX_BOTTOM_OFFSET = Number(process.env.THUMBNAIL_BOTTOM_OFFSET || 480);
const BOX_MAX_HEIGHT = 380;
const MAX_TITLE_LINES = 4;
const MAX_TITLE_WORDS = 16;
const FONT_SIZE_MAX = 74;
const FONT_SIZE_MIN = 34;
const CHAR_WIDTH_RATIO = 0.62;
const TEXT_COLOR = process.env.THUMBNAIL_TEXT_COLOR || "0xFFD60A";
const BORDER_COLOR = process.env.THUMBNAIL_BORDER_COLOR || "0xFFD60A";
const BG_COLOR = process.env.THUMBNAIL_BG_COLOR || "0x000000";
const BG_OPACITY = clampOpacity(process.env.THUMBNAIL_BG_OPACITY, 0.6);
const BORDER_OPACITY = clampOpacity(process.env.THUMBNAIL_BORDER_OPACITY, 0.85);
const TEXT_OUTLINE_OPACITY = clampOpacity(process.env.THUMBNAIL_TEXT_OUTLINE_OPACITY, 0.85);
const JPEG_Q = process.env.THUMBNAIL_JPEG_Q || "1";
const INTRO_SECONDS = clampSeconds(process.env.THUMBNAIL_INTRO_SECONDS, 0.9);
const rendererPath = path.join(config.srcDir, "branding-renderer.py");

export async function generateThumbnail({ job, videoPath, text }) {
  await fs.mkdir(config.thumbnailDir, { recursive: true });
  const filename = `${job.job_id}-thumbnail.jpg`;
  const outputPath = path.join(config.thumbnailDir, filename);
  const basePath = path.join(config.thumbnailDir, `${job.job_id}-thumbnail-base.jpg`);

  const displayText = normalizeTitleText(text);
  const layout = buildTitleLayout(displayText);
  const fontOption = await resolveFontOption();
  const seek = await pickSeekTimestamp(videoPath);

  const baseFilters = [
    "scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos+accurate_rnd+full_chroma_int",
    "crop=1080:1920",
    "unsharp=lx=5:ly=5:la=0.85:cx=5:cy=5:ca=0.4",
    "eq=contrast=1.05:saturation=1.10"
  ];

  try {
    await runFfmpeg([
      "-y",
      "-ss", seek,
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", baseFilters.join(","),
      "-q:v", JPEG_Q,
      basePath
    ]);
    await runRenderer([
      "thumbnail",
      "--input", basePath,
      "--output", outputPath,
      "--title", displayText,
      "--pill", process.env.THUMBNAIL_PILL_TEXT || "Podcast | Highlight | Viral"
    ]);
    await fs.rm(basePath, { force: true }).catch(() => {});
    return { path: outputPath, filename, text: displayText };
  } catch (error) {
    await fs.rm(basePath, { force: true }).catch(() => {});
    console.warn(`Thumbnail renderer fallback dipakai: ${error.message}`);
  }

  const overlayFilter = [
    ...baseFilters,
    `drawbox=x=${BOX_MARGIN_X}:y=${layout.boxY}:w=${BOX_W}:h=${layout.boxH}:color=${BG_COLOR}@${BG_OPACITY}:t=fill`,
    `drawbox=x=${BOX_MARGIN_X}:y=${layout.boxY}:w=${BOX_W}:h=${layout.boxH}:color=${BORDER_COLOR}@${BORDER_OPACITY}:t=3`,
    ...layout.lines.map((line, idx) => (
      `drawtext=${fontOption}:text='${escapeDrawtext(line)}':fontcolor=${TEXT_COLOR}:fontsize=${layout.fontSize}:bordercolor=black@${TEXT_OUTLINE_OPACITY}:borderw=3:x=(w-text_w)/2:y=${layout.lineYs[idx]}`
    ))
  ].join(",");

  const fallbackFilter = baseFilters.join(",");

  try {
    await runFfmpeg([
      "-y",
      "-ss", seek,
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", overlayFilter,
      "-q:v", JPEG_Q,
      outputPath
    ]);
  } catch {
    await runFfmpeg([
      "-y",
      "-ss", seek,
      "-i", videoPath,
      "-frames:v", "1",
      "-vf", fallbackFilter,
      "-q:v", JPEG_Q,
      outputPath
    ]);
  }

  return { path: outputPath, filename, text: displayText };
}

export async function prependThumbnailIntro({ job, videoPath, thumbnailPath }) {
  if (!boolValue(process.env.THUMBNAIL_INTRO_ENABLED, true)) return null;
  if (!videoPath || !thumbnailPath) return null;
  if (!await fileExists(videoPath) || !await fileExists(thumbnailPath)) return null;

  await fs.mkdir(config.generatedVideoDir, { recursive: true });
  const introPath = path.join(config.generatedVideoDir, `${job.job_id}-thumb-intro.mp4`);
  const outputPath = path.join(config.generatedVideoDir, `${job.job_id}-with-thumb-intro.mp4`);
  await Promise.all([
    fs.rm(introPath, { force: true }).catch(() => {}),
    fs.rm(outputPath, { force: true }).catch(() => {})
  ]);

  await runFfmpeg([
    "-y",
    "-loop", "1",
    "-framerate", "30",
    "-t", String(INTRO_SECONDS),
    "-i", thumbnailPath,
    "-f", "lavfi",
    "-t", String(INTRO_SECONDS),
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-vf", "setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,fps=30,format=yuv420p",
    "-af", "aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS",
    "-r", "30",
    "-c:v", "libx264",
    "-preset", config.videoEffects.preset || "veryfast",
    "-crf", String(config.videoEffects.crf),
    "-c:a", "aac",
    "-ar", "48000",
    "-ac", "2",
    "-b:a", "128k",
    "-shortest",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    introPath
  ]);

  await runFfmpeg([
    "-y",
    "-fflags", "+genpts",
    "-i", introPath,
    "-fflags", "+genpts",
    "-i", videoPath,
    "-filter_complex",
    [
      "[0:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,fps=30,format=yuv420p[v0]",
      "[1:v]setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setsar=1,fps=30,format=yuv420p[v1]",
      "[0:a]aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[a0]",
      "[1:a]aresample=async=1:first_pts=0,asetpts=PTS-STARTPTS[a1]",
      "[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]"
    ].join(";"),
    "-map", "[v]",
    "-map", "[a]",
    "-c:v", "libx264",
    "-preset", config.videoEffects.preset || "veryfast",
    "-crf", String(config.videoEffects.crf),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-ar", "48000",
    "-ac", "2",
    "-b:a", "128k",
    "-avoid_negative_ts", "make_zero",
    "-movflags", "+faststart",
    outputPath
  ]);

  return {
    path: outputPath,
    introPath,
    durationSeconds: INTRO_SECONDS
  };
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

function buildTitleLayout(value) {
  const title = String(value || "BAGIAN INI BIKIN PENONTON BERHENTI SCROLL")
    .replace(/\s+/g, " ")
    .trim();
  const textAreaW = BOX_W - (BOX_PADDING_X * 2);
  let fontSize = FONT_SIZE_MAX;
  let lines = [];

  while (fontSize >= FONT_SIZE_MIN) {
    const maxChars = Math.max(10, Math.floor(textAreaW / (fontSize * CHAR_WIDTH_RATIO)));
    lines = wrapText(title, maxChars, MAX_TITLE_LINES);
    const textBlockH = estimateTextBlockHeight(lines.length, fontSize);
    const widthOk = lines.every((line) => estimateTextWidth(line, fontSize) <= textAreaW);
    const heightOk = (textBlockH + BOX_PADDING_Y * 2) <= BOX_MAX_HEIGHT;
    if (widthOk && heightOk) break;
    fontSize -= 2;
  }

  if (!lines.length) lines = ["BAGIAN INI BIKIN", "PENONTON BERHENTI SCROLL"];
  const textBlockH = estimateTextBlockHeight(lines.length, fontSize);
  const boxH = Math.min(BOX_MAX_HEIGHT, textBlockH + BOX_PADDING_Y * 2);
  const boxBottom = CANVAS_HEIGHT - BOX_BOTTOM_OFFSET;
  const boxY = boxBottom - boxH;
  const firstLineY = boxY + Math.round((boxH - textBlockH) / 2);

  return {
    lines,
    fontSize,
    boxH,
    boxY,
    lineYs: lines.map((_, idx) => firstLineY + (idx * (fontSize + 12)))
  };
}

function normalizeTitleText(value) {
  return String(value || "BAGIAN INI BIKIN PENONTON BERHENTI SCROLL")
    .replace(/[`"'*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase()
    .split(/\s+/)
    .slice(0, MAX_TITLE_WORDS)
    .join(" ") || "BAGIAN INI BIKIN PENONTON BERHENTI SCROLL";
}

function wrapText(value, maxChars, maxLines) {
  const words = String(value || "")
    .split(/\s+/)
    .flatMap((word) => splitLongWord(word, maxChars))
    .filter(Boolean);
  const lines = [];
  let current = "";

  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (current && next.length > maxChars) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);

  if (lines.length <= maxLines) return lines;

  const kept = lines.slice(0, maxLines);
  const overflow = lines.slice(maxLines - 1).join(" ");
  kept[maxLines - 1] = truncateLine(overflow, maxChars);
  return kept;
}

function splitLongWord(word, maxChars) {
  if (word.length <= maxChars) return [word];
  const chunks = [];
  let remaining = word;
  while (remaining.length > maxChars) {
    chunks.push(remaining.slice(0, maxChars - 1));
    remaining = remaining.slice(maxChars - 1);
  }
  if (remaining) chunks.push(remaining);
  return chunks;
}

function truncateLine(value, maxChars) {
  const cleaned = String(value || "").trim();
  if (cleaned.length <= maxChars) return cleaned;
  return `${cleaned.slice(0, Math.max(1, maxChars - 3)).trim()}...`;
}

function estimateTextWidth(value, fontSize) {
  return String(value || "").length * fontSize * CHAR_WIDTH_RATIO;
}

function estimateTextBlockHeight(lineCount, fontSize) {
  return (lineCount * fontSize) + (Math.max(0, lineCount - 1) * 12);
}

async function resolveFontOption() {
  const home = process.env.HOME || "";
  const candidates = [
    process.env.THUMBNAIL_FONT_FILE,
    "C:\\Windows\\Fonts\\arialbd.ttf",
    "C:\\Windows\\Fonts\\segoeuib.ttf",
    home ? path.join(home, ".local/share/fonts/selawik/Selawik-Bold.ttf") : "",
    home ? path.join(home, ".local/share/fonts/selawik/SelawikBold.ttf") : "",
    home ? path.join(home, ".local/share/fonts/selawik/Selawik-Semibold.ttf") : "",
    home ? path.join(home, ".local/share/fonts/selawik/SelawikSemibold.ttf") : "",
    "/usr/share/fonts/truetype/msttcorefonts/Arial_Bold.ttf",
    "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
  ].filter(Boolean);

  for (const fontPath of candidates) {
    try {
      await fs.access(fontPath);
      return `fontfile='${escapeFontPath(fontPath)}'`;
    } catch {
      // Try the next installed bold sans font.
    }
  }

  return "font='Selawik Bold'";
}

function escapeFontPath(value) {
  return path.resolve(value)
    .replace(/\\/g, "/")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'");
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
      else reject(new Error(stderr || `ffmpeg exited with ${code}`));
    });
  });
}

function probeDurationSeconds(videoPath) {
  return new Promise((resolve) => {
    const child = spawn("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=noprint_wrappers=1:nokey=1",
      videoPath
    ], { windowsHide: true });
    let stdout = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", () => {
      const value = parseFloat(stdout.trim());
      resolve(Number.isFinite(value) ? value : null);
    });
  });
}

async function pickSeekTimestamp(videoPath) {
  const fallback = "00:00:03";
  const duration = await probeDurationSeconds(videoPath);
  if (!duration || duration <= 2) return fallback;
  const seconds = Math.max(2, Math.min(duration - 2, duration * 0.3));
  return formatTimestamp(seconds);
}

async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

function boolValue(value, fallback = false) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function clampSeconds(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(3, Math.max(0.3, num));
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const ms = total % 1000;
  const totalSeconds = Math.floor(total / 1000);
  const s = totalSeconds % 60;
  const m = Math.floor(totalSeconds / 60) % 60;
  const h = Math.floor(totalSeconds / 3600);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(ms, 3)}`;
}

function pad(value, width) {
  return String(value).padStart(width, "0");
}

function clampOpacity(value, fallback) {
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(1, Math.max(0, num));
}

function escapeDrawtext(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/:/g, "\\:")
    .replace(/'/g, "\\'")
    .replace(/,/g, "\\,")
    .replace(/%/g, "\\%");
}
