import { config } from "./config.js";
import { runWorkflow } from "./workflow.js";

function argValue(name, fallback = "") {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  return process.argv[index + 1] || fallback;
}

function hasArg(name) {
  return process.argv.includes(name);
}

function optionalBoolArg(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (value === undefined || value.startsWith("--")) return true;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

const options = {
  publish: hasArg("--publish"),
  scheduled: hasArg("--scheduled"),
  theme: argValue("--theme", process.env.THEME || config.defaultTheme),
  url: argValue("--url", ""),
  range: argValue("--range", ""),
  aiProvider: "openai",
  qualityProfile: argValue("--quality", process.env.VIDEO_QUALITY_PROFILE || "standard"),
  clipCount: Number(argValue("--clip-count", process.env.CLIP_COUNT || "1")),
  subtitleFont: argValue("--subtitle-font", process.env.SUBTITLE_FONT_FAMILY || "Segoe UI Semibold"),
  subtitleFontSize: Number(argValue("--subtitle-font-size", process.env.SUBTITLE_FONT_SIZE || "46")),
  subtitleMarginV: Number(argValue("--subtitle-margin-v", process.env.SUBTITLE_MARGIN_V || "550")),
  subtitleMarginH: Number(argValue("--subtitle-margin-h", process.env.SUBTITLE_MARGIN_H || "180")),
  useFrame: optionalBoolArg("--use-frame"),
  useFilter: optionalBoolArg("--use-filter"),
  useWatermark: optionalBoolArg("--use-watermark"),
  forceReprocess: hasArg("--force-reprocess")
};

if (hasArg("--dry-run")) {
  options.publish = false;
}

runWorkflow(options)
  .then((result) => {
    console.log(JSON.stringify(result, null, 2));
  })
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
