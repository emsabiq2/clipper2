import fs from "node:fs";
import fsp from "node:fs/promises";
import axios from "axios";
import { config } from "./config.js";
import { buildSourceCreditBlock, ensureCaptionSourceCredit, stripCaptionSourceCredit } from "./caption-policy.js";
import { extractYoutubeVideoId } from "./youtube.js";

const tokenUrl = "https://oauth2.googleapis.com/token";
const uploadUrl = "https://www.googleapis.com/upload/youtube/v3/videos";
const thumbnailUploadUrl = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const maxThumbnailBytes = 2 * 1024 * 1024;

function assertYoutubeConfig() {
  const missing = [];
  if (!config.youtube.clientId) missing.push("YOUTUBE_CLIENT_ID");
  if (!config.youtube.clientSecret) missing.push("YOUTUBE_CLIENT_SECRET");
  if (!config.youtube.refreshToken) missing.push("YOUTUBE_REFRESH_TOKEN");
  if (missing.length) throw new Error(`Missing YouTube config: ${missing.join(", ")}`);
}

export async function getYoutubeAccessToken() {
  assertYoutubeConfig();
  const body = new URLSearchParams({
    client_id: config.youtube.clientId,
    client_secret: config.youtube.clientSecret,
    refresh_token: config.youtube.refreshToken,
    grant_type: "refresh_token"
  });

  try {
    const response = await axios.post(tokenUrl, body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 60000
    });
    return response.data.access_token;
  } catch (error) {
    throw wrapGoogleError(error, "YouTube token refresh failed");
  }
}

export async function setYoutubeThumbnail({ videoId, thumbnailPath, accessToken }) {
  if (!videoId || !thumbnailPath) {
    return { ok: false, error: "videoId atau thumbnailPath kosong" };
  }

  let stat = null;
  try {
    stat = await fsp.stat(thumbnailPath);
  } catch (error) {
    return { ok: false, error: `thumbnail tidak ditemukan: ${error.message}` };
  }

  if (!stat.size) return { ok: false, error: "thumbnail kosong" };
  if (stat.size > maxThumbnailBytes) {
    return { ok: false, error: `thumbnail ${stat.size} bytes melebihi batas YouTube 2MB` };
  }

  let token = accessToken;
  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      if (!token) token = await getYoutubeAccessToken();
      const response = await axios.post(
        thumbnailUploadUrl,
        fs.createReadStream(thumbnailPath),
        {
          params: { videoId, uploadType: "media" },
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "image/jpeg",
            "Content-Length": stat.size
          },
          maxBodyLength: Infinity,
          maxContentLength: Infinity,
          timeout: 60000
        }
      );
      console.log("YT THUMBNAIL SET:", response.data);
      return { ok: true, response: response.data };
    } catch (error) {
      lastError = wrapGoogleError(error, "YouTube thumbnail upload failed");
      console.warn(`YouTube thumbnail attempt ${attempt}/3 gagal: ${lastError.message}`);
      if (attempt < 3) await sleep(5000 * attempt);
    }
  }

  return { ok: false, error: lastError?.message || "YouTube thumbnail upload failed" };
}

export async function publishToYoutube({ videoPath, title, description, tags = [], thumbnailPath }) {
  const accessToken = await getYoutubeAccessToken();
  const stat = await fsp.stat(videoPath);
  const metadata = {
    snippet: {
      title: normalizeTitle(title),
      description: normalizeDescription(description),
      tags: normalizeTags(tags),
      categoryId: config.youtube.categoryId || "22"
    },
    status: {
      privacyStatus: normalizePrivacyStatus(config.youtube.privacyStatus),
      selfDeclaredMadeForKids: false
    }
  };

  let sessionUrl = "";
  try {
    const start = await axios.post(uploadUrl, metadata, {
      params: {
        uploadType: "resumable",
        part: "snippet,status"
      },
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Length": stat.size,
        "X-Upload-Content-Type": "video/mp4"
      },
      maxBodyLength: Infinity,
      timeout: 60000
    });
    sessionUrl = start.headers.location;
  } catch (error) {
    throw wrapGoogleError(error, "YouTube upload session failed");
  }

  if (!sessionUrl) throw new Error("YouTube tidak mengembalikan upload session URL.");

  try {
    const upload = await axios.put(sessionUrl, fs.createReadStream(videoPath), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": stat.size
      },
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 30 * 60 * 1000
    });
    const id = upload.data?.id;
    if (!id) throw new Error("YouTube upload selesai tetapi video id kosong.");
    const thumbnail = config.youtube.customThumbnailEnabled
      ? await setYoutubeThumbnail({ videoId: id, thumbnailPath, accessToken })
      : { ok: false, skipped: true, error: "" };
    return {
      videoId: id,
      url: `https://www.youtube.com/watch?v=${id}`,
      privacyStatus: metadata.status.privacyStatus,
      title: metadata.snippet.title,
      type: "youtube_video",
      customThumbnail: thumbnail.ok,
      thumbnailError: thumbnail.ok || thumbnail.skipped ? "" : thumbnail.error
    };
  } catch (error) {
    throw wrapGoogleError(error, "YouTube video upload failed");
  }
}

export async function getYoutubeChannel() {
  const accessToken = await getYoutubeAccessToken();
  try {
    const response = await axios.get("https://www.googleapis.com/youtube/v3/channels", {
      params: {
        part: "snippet",
        mine: "true"
      },
      headers: {
        Authorization: `Bearer ${accessToken}`
      },
      timeout: 60000
    });
    return response.data?.items?.[0] || null;
  } catch (error) {
    throw wrapGoogleError(error, "YouTube channel check failed");
  }
}

export function buildYoutubeMetadata({ job, output, caption }) {
  const source = youtubeSourceDetails({ job, output });
  const cleanCaption = stripCaptionSourceCredit(caption, {
    sourceUrl: source.sourceUrl
  });
  const creditedCaption = ensureCaptionSourceCredit(cleanCaption, {
    sourceUrl: source.sourceUrl,
    sourceTitle: source.sourceTitle,
    sourceChannel: source.sourceChannel,
    sourceVideoId: source.sourceVideoId,
    maxLength: 1600
  });
  const context = [
    output.clipTranscript,
    output.caption,
    output.reason,
    output.title,
    output.hook,
    creditedCaption
  ].filter(Boolean).join(" ");
  const theme = detectTheme(context);
  const person = detectPerson({ job, output, caption: creditedCaption }) || "Podcast Indonesia";
  const hook = buildHookTitle({ job, output, caption: creditedCaption, theme });
  const rawTitle = normalizeTitleWithPerson(config.youtube.titlePrefix, hook, person);
  const hashtags = buildYoutubeHashtags({ theme, person, caption: creditedCaption, context });
  const firstLine = firstStrongLine(creditedCaption) || cleanText(output.clipTranscript || output.caption || hook).slice(0, 180);
  const keywordLine = buildYoutubeKeywordLine({ theme, person, source });
  const angle = cleanText(output.selectedAngle || output.reason || output.hook || hook);
  const insight = cleanText(output.reason || output.hook || output.clipTranscript || hook).slice(0, 160);
  const dynamicTags = tagsFromCaption(creditedCaption);
  const retentionLine = buildRetentionLine({ angle, theme });
  const insightLine = insight && !sameText(insight, firstLine) && !sameText(insight, angle)
    ? `Poin: ${insight}`
    : "";
  const engagementLine = buildEngagementLine({ theme, person });
  const sourceCredit = buildSourceCreditBlock(source);

  const descriptionParts = [
    firstLine,
    keywordLine,
    "",
    retentionLine,
    ...(insightLine ? [insightLine] : []),
    engagementLine,
    "",
    sourceCredit,
    "",
    hashtags.join(" "),
    config.youtube.descriptionFooter
  ];
  const description = compactDescriptionParts(descriptionParts).join("\n");

  return {
    title: rawTitle,
    description,
    tags: normalizeTags([
      ...config.youtube.tags,
      ...dynamicTags,
      "shorts indonesia",
      "podcast indonesia",
      "podcast viral",
      "highlight podcast",
      theme,
      person,
      source.sourceChannel,
      ...keywordsFromText(`${hook} ${person} ${theme} ${angle} ${source.sourceTitle} ${source.sourceChannel} ${output.title || ""} ${output.hook || ""}`)
    ])
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildHookTitle({ job, output, caption, theme = "inspirasi" }) {
  const firstLine = firstStrongLine(caption);
  const candidates = [
    output.thumbnailText,
    output.selectedAngle,
    firstLine,
    output.hook,
    output.title,
    job.source_title,
    job.theme
  ];

  for (const candidate of candidates) {
    const topic = shortTopic(candidate);
    if (topic !== "Podcast Clip") return topic;
  }
  return defaultHook(theme);
}

function normalizeTitleWithPerson(prefix, hook, person) {
  const cleanHook = shortTopic(hook);
  const cleanPerson = cleanText(person);
  const personSuffix = cleanPerson && !cleanHook.toLowerCase().includes(cleanPerson.toLowerCase())
    ? ` - ${cleanPerson}`
    : "";
  const withPerson = [prefix, `${cleanHook}${personSuffix}`, "#Shorts"].filter(Boolean).join(" ");
  if (withPerson.length <= 100) return withPerson;
  return [prefix, cleanHook, "#Shorts"].filter(Boolean).join(" ").slice(0, 100);
}

function buildRetentionLine({ angle, theme }) {
  const cleanAngle = cleanText(angle);
  if (cleanAngle && cleanAngle.length >= 18) {
    return `Kenapa ini menarik: ${limitText(cleanAngle, 170)}`;
  }
  const fallback = {
    bisnis: "Kenapa ini menarik: ada cara pandang bisnis yang jarang dibahas.",
    leadership: "Kenapa ini menarik: ada pelajaran memimpin yang bisa langsung terasa.",
    motivasi: "Kenapa ini menarik: pesannya sederhana, tapi bisa kena ke banyak orang.",
    karir: "Kenapa ini menarik: ada nasihat karir yang sering luput.",
    keuangan: "Kenapa ini menarik: ada sudut pandang uang yang penting dipahami.",
    agama: "Kenapa ini menarik: pengingatnya singkat dan mudah direnungkan.",
    keadilan: "Kenapa ini menarik: ada konflik dan sikap yang kuat.",
    podcast: "Kenapa ini menarik: potongan obrolannya punya hook yang kuat.",
    inspirasi: "Kenapa ini menarik: ada pesan yang mudah dibagikan."
  };
  return fallback[theme] || fallback.inspirasi;
}

function buildYoutubeKeywordLine({ theme, person, source }) {
  const cleanPerson = cleanText(person);
  const cleanChannel = cleanText(source.sourceChannel);
  const topic = cleanText(theme);
  const subject = cleanPerson && cleanPerson !== "Podcast Indonesia"
    ? cleanPerson
    : cleanChannel || "Podcast Indonesia";
  const topicText = topic && !["podcast", "inspirasi"].includes(topic)
    ? ` tentang ${topic}`
    : "";
  return `Highlight podcast ${subject}${topicText} untuk Shorts Indonesia.`;
}

function buildEngagementLine({ theme, person }) {
  const cleanPerson = cleanText(person);
  const topic = theme === "keadilan"
    ? "sikap ini"
    : theme === "bisnis"
      ? "cara mikir ini"
      : "poin ini";
  if (cleanPerson && cleanPerson !== "Podcast Indonesia") {
    return `Tonton sampai akhir biar konteksnya utuh. Kamu setuju sama ${topic} dari ${cleanPerson}?`;
  }
  return `Tonton sampai akhir biar konteksnya utuh. Kamu setuju sama ${topic}?`;
}

function firstStrongLine(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => cleanText(line))
    .find((line) => line && !line.startsWith("#") && line.length >= 12) || "";
}

function cleanText(value = "") {
  return String(value)
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N}\s#@.,!?|:'"-]/gu, "")
    .trim();
}

function plainText(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim();
}

function youtubeSourceDetails({ job = {}, output = {} } = {}) {
  const sourceUrl = plainText(job.source_url || job.url || output.sourceUrl || "");
  const sourceTitle = cleanText(
    job.source_title
      || job.source_video_title
      || output.sourceTitle
      || output.originalTitle
      || output.title
      || ""
  );
  const sourceChannel = cleanText(
    job.source_channel
      || job.sourceChannel
      || job.channel_title
      || job.channelTitle
      || output.sourceChannel
      || output.channel
      || ""
  );
  return {
    sourceUrl,
    sourceTitle,
    sourceChannel,
    sourceVideoId: extractYoutubeVideoId(sourceUrl)
  };
}

function limitText(value, maxLength) {
  const text = cleanText(value);
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, maxLength).replace(/\s+\S*$/, "").trim();
}

function sameText(left, right) {
  return cleanText(left).toLowerCase() === cleanText(right).toLowerCase();
}

function toHashtag(value = "") {
  const cleaned = cleanText(value)
    .replace(/^#+/, "")
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .slice(0, 3)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join("");
  return cleaned ? `#${cleaned}` : "";
}

function detectTheme(text = "") {
  const source = String(text || "").toLowerCase();
  const themes = [
    { key: "bisnis", words: ["bisnis", "usaha", "jualan", "market", "customer", "profit", "dagang"] },
    { key: "leadership", words: ["pemimpin", "leader", "kepemimpinan", "tim", "manager"] },
    { key: "motivasi", words: ["semangat", "sukses", "gagal", "bangkit", "mimpi", "target"] },
    { key: "karir", words: ["kerja", "karir", "kantor", "profesi", "gaji"] },
    { key: "keuangan", words: ["uang", "investasi", "modal", "bank", "keuangan", "aset"] },
    { key: "agama", words: ["allah", "islam", "sedekah", "shalat", "rezeki", "dakwah"] },
    { key: "keadilan", words: ["hak", "adil", "keadilan", "nuntut", "tuntut", "ancam", "oknum"] },
    { key: "podcast", words: ["podcast", "ngobrol", "cerita", "obrolan"] }
  ];

  let best = { key: "inspirasi", score: 0 };
  for (const item of themes) {
    const score = item.words.reduce((total, word) => total + (source.includes(word) ? 1 : 0), 0);
    if (score > best.score) best = { key: item.key, score };
  }
  return best.key;
}

function defaultHook(theme) {
  const hooks = {
    bisnis: "Cara mikir ini bisa mengubah bisnis",
    leadership: "Pemimpin harus paham hal ini",
    motivasi: "Kalimat ini bisa bikin kamu bergerak",
    karir: "Nasihat karir yang sering dilupakan",
    keuangan: "Cara pandang soal uang yang penting",
    agama: "Pengingat singkat tapi dalam",
    keadilan: "Nyali besar melawan tekanan",
    podcast: "Potongan obrolan paling menarik",
    inspirasi: "Pesan singkat yang kena banget"
  };
  return hooks[theme] || hooks.inspirasi;
}

function detectPerson({ job, output, caption }) {
  const text = [
    output.title,
    output.hook,
    output.clipTranscript,
    caption,
    job.source_title,
    job.source_channel,
    job.channel_title
  ].filter(Boolean).join(" ");
  const known = [
    "Yusuf Hamka",
    "Ayu Ting Ting",
    "Ariel NOAH",
    "Deddy Corbuzier",
    "Raditya Dika",
    "Vidi Aldiano",
    "Vincent",
    "Desta"
  ];
  const foundKnown = known.find((name) => new RegExp(`\\b${name.replace(/\s+/g, "\\s+")}\\b`, "i").test(text));
  if (foundKnown) return foundKnown;

  const matches = text.matchAll(/\b[A-Z][\p{L}\p{N}]+(?:\s+[A-Z][\p{L}\p{N}]+){1,2}/gu);
  for (const match of matches) {
    const name = cleanText(match[0]);
    if (isLikelyPersonName(name)) return name;
  }
  return "";
}

function isLikelyPersonName(value) {
  const generic = new Set([
    "podcast",
    "clip",
    "shorts",
    "indonesia",
    "ternyata",
    "rahasia",
    "cerita",
    "kenapa",
    "momen",
    "viral",
    "highlight"
  ]);
  const words = cleanText(value).split(/\s+/).filter(Boolean);
  if (words.length < 2 || words.length > 3) return false;
  if (generic.has(words[0].toLowerCase()) || generic.has(words[words.length - 1].toLowerCase())) return false;
  return words.some((word) => !generic.has(word.toLowerCase()));
}

function buildYoutubeHashtags({ theme, person, caption, context }) {
  const fromCaption = extractHashtags(caption);
  const candidates = [
    "#Shorts",
    toHashtag(theme),
    person ? toHashtag(person) : "",
    ...topicHashtags(context),
    "#PodcastIndonesia",
    "#Motivasi"
  ];
  const values = [...candidates, ...fromCaption, "#PodcastIndonesia", "#Indonesia"].filter(Boolean);
  return uniqueNormalized(values).slice(0, 3);
}

function compactDescriptionParts(parts) {
  const result = [];
  for (const part of parts) {
    const value = typeof part === "string" ? part.trim() : "";
    if (!value && !result.length) continue;
    if (!value && result[result.length - 1] === "") continue;
    result.push(value);
  }
  while (result[result.length - 1] === "") result.pop();
  return result;
}

function tagsFromCaption(value) {
  return String(value || "")
    .match(/#[\p{L}\p{N}_]+/gu)
    ?.map((tag) => tag.replace(/^#/, ""))
    .filter(Boolean) || [];
}

function keywordsFromText(value) {
  const stopwords = new Set([
    "yang",
    "dan",
    "atau",
    "ini",
    "itu",
    "dari",
    "dengan",
    "karena",
    "untuk",
    "gak",
    "nggak",
    "tidak",
    "kok",
    "sih"
  ]);
  const seen = new Set();
  const tags = [];
  for (const word of String(value || "").split(/[^\p{L}\p{N}]+/u)) {
    const cleaned = word.trim();
    const key = cleaned.toLowerCase();
    if (cleaned.length < 4 || stopwords.has(key) || seen.has(key)) continue;
    seen.add(key);
    tags.push(cleaned);
    if (tags.length >= 8) break;
  }
  return tags;
}

function extractHashtags(value) {
  return String(value || "").match(/#[\p{L}\p{N}_]+/gu) || [];
}

function topicHashtags(value) {
  const source = String(value || "").toLowerCase();
  const tags = [];
  if (/\byusuf\s+hamka\b/i.test(value)) tags.push("#YusufHamka");
  if (/hak|adil|keadilan|nuntut|tuntut|perjuang/.test(source)) tags.push("#Keadilan");
  if (/bisnis|usaha|jualan|dagang/.test(source)) tags.push("#Bisnis");
  if (/motivasi|bangkit|gagal|sukses/.test(source)) tags.push("#Motivasi");
  return tags;
}

function uniqueNormalized(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const cleaned = String(value || "").trim();
    if (!cleaned) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(cleaned);
  }
  return result;
}

function shortTopic(value) {
  const cleaned = String(value || "")
    .replace(/[#"`*_]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || cleaned.length < 5 || cleaned.endsWith(":")) return "Podcast Clip";
  return cleaned
    .replace(/\b(selama|hampir)\s+\d+\s+tahun\b/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

function normalizeTitle(value) {
  const cleaned = String(value || "Podcast Clip #Shorts").replace(/\s+/g, " ").trim();
  return cleaned.slice(0, 100);
}

function normalizeDescription(value) {
  return String(value || "").slice(0, 4900);
}

function normalizeTags(tags) {
  const values = Array.isArray(tags) ? tags : [];
  const normalized = values.map((tag) => String(tag).trim()).filter(Boolean);
  return [...new Set(normalized)].slice(0, 15);
}

function normalizePrivacyStatus(value) {
  const status = String(value || "private").toLowerCase();
  return ["private", "unlisted", "public"].includes(status) ? status : "private";
}

export function isYoutubeQuotaError(error) {
  const text = [
    error?.message,
    error?.reason,
    error?.code,
    error?.response?.data?.error?.message,
    error?.response?.data?.error?.status,
    ...(error?.response?.data?.error?.errors || []).map((item) => item.reason || item.message)
  ].filter(Boolean).join(" ");
  return /quota|quotaExceeded|dailyLimitExceeded|exceeded your/i.test(text);
}

function wrapGoogleError(error, prefix) {
  const detail = error.response?.data?.error;
  const reason = detail?.errors?.[0]?.reason || detail?.status || "";
  const status = error.response?.status || 0;
  let message = error.message;
  if (detail) {
    message = typeof detail === "string" ? detail : detail.message || JSON.stringify(detail);
  }
  const wrapped = new Error(`${prefix}: ${message}`);
  wrapped.reason = reason;
  wrapped.status = status;
  if (isYoutubeQuotaError(wrapped) || isYoutubeQuotaError(error) || isYoutubeQuotaError({ message, reason })) {
    wrapped.code = "YOUTUBE_QUOTA_EXCEEDED";
    wrapped.quotaExceeded = true;
  }
  return wrapped;
}
