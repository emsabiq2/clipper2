import fs from "node:fs/promises";
import path from "node:path";
import { generateAiText } from "./ai.js";

async function readClipContext(clipperRoot, output) {
  const parts = [output.title, output.hook, output.caption, output.reason].filter(Boolean);
  const reviewPath = output.transcriptReviewPath ? path.join(clipperRoot, output.transcriptReviewPath) : "";
  if (reviewPath) {
    try {
      const raw = await fs.readFile(reviewPath, "utf8");
      const data = JSON.parse(raw);
      const texts = [];
      collectText(data, texts);
      if (texts.length) parts.push(texts.slice(0, 90).join(" "));
    } catch {
      // Caption fallback can still use clip metadata.
    }
  }
  return parts.join("\n").slice(0, 9000);
}

function collectText(value, texts) {
  if (!value || texts.length > 120) return;
  if (typeof value === "string") {
    const cleaned = value.trim();
    if (cleaned && cleaned.split(/\s+/).length > 2) texts.push(cleaned);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectText(item, texts);
    return;
  }
  if (typeof value === "object") {
    for (const key of ["text", "caption", "corrected_text", "original_text"]) {
      collectText(value[key], texts);
    }
    for (const child of Object.values(value)) {
      if (typeof child === "object") collectText(child, texts);
    }
  }
}

export async function generateCaption({ job, output, promptTemplate, clipperRoot, aiProvider = "" }) {
  const quickHashtags = buildDynamicHashtags({ job, output, promptTemplate });
  if (hasStrategyCaption(output) && isCompleteCaption(output.caption)) {
    return ensureCaptionHashtags(output.caption, output, promptTemplate, quickHashtags);
  }

  const context = await readClipContext(clipperRoot, output);
  const dynamicHashtags = buildDynamicHashtags({ job, output, promptTemplate, context });
  const fallback = fallbackCaption(output, promptTemplate, dynamicHashtags);
  const prompt = [
    "Buat caption Instagram Reels berbahasa Indonesia.",
    "Aturan:",
    "- Baris pertama harus hook kuat, boleh berbentuk kutipan pendek atau pertanyaan yang bikin penasaran.",
    "- Paragraf kedua menjelaskan konflik, fakta mengejutkan, atau alasan clip ini layak ditonton.",
    "- Ringkas, natural, emosional, dan sesuai transkrip.",
    "- Jangan mengarang fakta di luar konteks.",
    "- Tambahkan CTA ringan.",
    "- Caption harus selesai utuh. Jangan akhiri dengan kalimat terpotong, koma, titik dua, kata sambung, atau ellipsis.",
    "- Jangan menyalin mentah transkrip yang terpotong; rangkum jadi kalimat lengkap.",
    "- Akhiri dengan tepat 3 hashtag relevan. Prioritaskan 1 hashtag konteks/tokoh/topik jika ada.",
    "",
    `Tema: ${job.theme}`,
    `Gaya: ${promptTemplate?.hook_style || "natural emotional"}`,
    `CTA: ${promptTemplate?.cta || "Menurut kamu bagaimana?"}`,
    `Base hashtag: ${BASE_HASHTAGS.join(" ")}`,
    `Arah hashtag dari konteks: ${dynamicHashtags.join(" ") || "-"}`,
    "",
    "Konteks clip:",
    context || fallback,
    "",
    "Tulis caption final saja tanpa markdown."
  ].join("\n");

  const text = await generateAiText(prompt, { maxOutputTokens: 900, provider: aiProvider });
  return ensureCaptionHashtags(text || fallback, output, promptTemplate, dynamicHashtags, fallback);
}

export async function generateThumbnailText({ job, output, promptTemplate, aiProvider = "" }) {
  const existing = output.thumbnailText ? normalizeThumbnailText(output.thumbnailText, "") : "";
  const fallback = fallbackThumbnailText(output);
  const prompt = [
    "Buat teks thumbnail Reels dalam Bahasa Indonesia.",
    "Aturan: 6 sampai 16 kata, boleh panjang jika hook-nya lengkap, huruf besar, kuat, mudah dibaca, tidak clickbait menyesatkan.",
    "- Jangan jawab satu atau dua kata, jangan hanya dua kata besar.",
    "- Buat sebagai hook utama, bukan potongan kalimat yang terputus.",
    "- Buat kalimat/judul utuh yang membuat orang ingin menonton sampai akhir.",
    "- Jangan ambil potongan transkrip mentah yang tidak jelas.",
    "- Buat seperti judul cover video, bukan subtitle.",
    "- Wajib mengandung hook: konflik, rahasia, alasan mengejutkan, pertanyaan, atau momen paling bikin penasaran.",
    "- Hindari kalimat menggantung yang berakhir koma.",
    `Tema: ${job.theme}`,
    `Style: ${promptTemplate?.thumbnail_style || "singkat dan kuat"}`,
    `Teks clipper jika ada: ${existing || "-"}`,
    `Judul/hook clip: ${output.hook || output.title || ""}`,
    `Alasan clip: ${output.reason || ""}`,
    `Transkrip singkat: ${String(output.clipTranscript || output.caption || "").slice(0, 900)}`,
    "Balas hanya teks thumbnail."
  ].join("\n");
  const text = await generateAiText(prompt, { maxOutputTokens: 110, temperature: 0.65, provider: aiProvider });
  const generated = text ? normalizeThumbnailText(text, "") : "";
  return isStrongThumbnailText(generated) ? generated : fallback;
}

export async function generateFrameQuoteText({ job, output, promptTemplate, aiProvider = "" }) {
  const fallback = fallbackFrameQuote(output);
  const prompt = [
    "Buat quote pendek untuk lower-third video Reels dalam Bahasa Indonesia.",
    "Aturan: 5 sampai 11 kata, terasa seperti kalimat paling kuat dari clip, natural, rapi, dan mudah dibaca.",
    "- Jangan pakai hashtag.",
    "- Jangan pakai emoji.",
    "- Jangan pakai markdown.",
    "- Jangan menambah fakta di luar konteks.",
    "- Jangan terlalu clickbait.",
    `Tema: ${job.theme}`,
    `Style: ${promptTemplate?.thumbnail_style || "singkat dan kuat"}`,
    `Judul/hook clip: ${output.hook || output.title || ""}`,
    `Alasan clip: ${output.reason || ""}`,
    `Transkrip singkat: ${String(output.clipTranscript || output.caption || "").slice(0, 900)}`,
    "Balas hanya quote tanpa tanda kutip."
  ].join("\n");
  const text = await generateAiText(prompt, { maxOutputTokens: 60, temperature: 0.45, provider: aiProvider });
  const generated = normalizeFrameQuoteText(text);
  return isStrongFrameQuote(generated) ? generated : fallback;
}

function hasStrategyCaption(output) {
  return Boolean(
    output?.caption
    && String(output.caption).trim().length >= 20
    && (
      output.viralScore
      || output.selectedAngle
      || output.publishDecision
      || output.candidateId
    )
  );
}

function fallbackCaption(output, promptTemplate, dynamicHashtags = []) {
  const hook = completeSentence(output.hook || output.title || "Ada bagian menarik dari obrolan ini.");
  const body = completeSentence(
    output.reason
    || output.selectedAngle
    || output.caption
    || "Potongan ini diambil dari momen yang paling kuat di podcast."
  );
  const cta = completeSentence(promptTemplate?.cta || "Menurut kamu, bagian paling relate yang mana?");
  const tags = captionHashtags({ dynamicHashtags, output, promptTemplate }).join(" ");
  return `${hook}\n\n${body}\n\n${cta}\n\n${tags}`;
}

function fallbackFrameQuote(output) {
  const candidates = [
    output?.clipTranscript,
    output?.caption,
    output?.hook,
    output?.reason,
    output?.title
  ].filter(Boolean);

  for (const value of candidates) {
    const sentence = String(value)
      .split(/[.!?\n]+/)
      .map((item) => normalizeFrameQuoteText(item))
      .find(isStrongFrameQuote);
    if (sentence) return sentence;
  }
  return "Gue baru sadar setelah kehilangan";
}

function normalizeFrameQuoteText(value) {
  const cleaned = String(value || "")
    .replace(/[`"'*_#]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return "";
  return cleaned
    .split(/\s+/)
    .slice(0, 11)
    .join(" ");
}

function isStrongFrameQuote(value) {
  const words = String(value || "").trim().split(/\s+/).filter(Boolean);
  return words.length >= 5 && words.join("").length >= 16;
}

function ensureCaptionHashtags(caption, output, promptTemplate, dynamicHashtags = [], fallback = "") {
  const cleaned = String(caption || "").trim();
  const hashtags = captionHashtags({ caption: cleaned, dynamicHashtags, output, promptTemplate });
  if (!hashtags.length) return cleaned;
  const body = completeCaptionBody(stripHashtags(cleaned), stripHashtags(fallback));
  return `${body || cleaned}\n\n${hashtags.join(" ")}`.trim();
}

function completeCaptionBody(value, fallback = "") {
  const cleaned = normalizeCaptionBody(value);
  if (isCompleteCaption(cleaned)) return cleaned;

  const trimmed = trimToLastCompleteSentence(cleaned);
  if (isCompleteCaption(trimmed)) return trimmed;

  const fallbackCleaned = normalizeCaptionBody(fallback);
  if (isCompleteCaption(fallbackCleaned)) return fallbackCleaned;

  return completeSentence(fallbackCleaned || cleaned || "Ada bagian menarik dari obrolan ini.");
}

function normalizeCaptionBody(value) {
  return String(value || "")
    .replace(/\s*(?:\.{3}|…)\s*$/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.!?;:])/g, "$1")
    .trim();
}

function isCompleteCaption(value) {
  const cleaned = normalizeCaptionBody(value);
  if (!cleaned) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 6) return false;
  const lastLine = cleaned.split(/\n+/).map((line) => line.trim()).filter(Boolean).pop() || "";
  return !INCOMPLETE_CAPTION_END_RE.test(lastLine);
}

function trimToLastCompleteSentence(value) {
  const cleaned = normalizeCaptionBody(value);
  const end = Math.max(cleaned.lastIndexOf("."), cleaned.lastIndexOf("?"), cleaned.lastIndexOf("!"));
  if (end < 20) return "";
  return cleaned.slice(0, end + 1).trim();
}

function completeSentence(value) {
  const cleaned = normalizeCaptionBody(value)
    .replace(INCOMPLETE_CAPTION_END_RE, "")
    .trim();
  if (!cleaned) return "";
  return /[.!?]$/.test(cleaned) ? cleaned : `${cleaned}.`;
}

function captionHashtags({ caption = "", dynamicHashtags = [], output, promptTemplate } = {}) {
  const outputHashtags = normalizeHashtags(output?.hashtags || []);
  const existingHashtags = normalizeHashtags(extractHashtags(caption));
  const contextHashtags = normalizeHashtags(dynamicHashtags);
  const templateHashtags = normalizeHashtags(promptTemplate?.hashtag_template || []);
  return mergeHashtags(
    ["#PodcastIndonesia"],
    contextHashtags,
    outputHashtags,
    existingHashtags,
    templateHashtags,
    BASE_HASHTAGS.slice(1),
    ["#Viral"]
  ).slice(0, HASHTAG_LIMIT);
}

function buildDynamicHashtags({ job, output, context = "" }) {
  const provided = normalizeHashtags(output?.hashtags || [])
    .filter((tag) => !isGenericHashtag(tag));
  if (provided.length >= 1) return provided.slice(0, HASHTAG_LIMIT);

  const directFields = [
    output?.selectedAngle,
    output?.hook,
    output?.title,
    output?.reason,
    output?.caption,
    output?.clipTranscript
  ].filter(Boolean);
  const source = [...directFields, context, job?.theme].join(" ");
  const candidates = [...provided];

  for (const tag of topicHashtags(source)) addHashtagCandidate(candidates, tag);
  for (const name of namedPhrases(source)) addHashtagCandidate(candidates, name);

  for (const phrase of directFields.slice(0, 5)) {
    addHashtagCandidate(candidates, phrase);
    for (const pair of keywordPairs(phrase)) addHashtagCandidate(candidates, pair);
  }

  for (const keyword of topKeywords(source, 12)) addHashtagCandidate(candidates, keyword);

  return normalizeHashtags(candidates)
    .filter((tag) => !isGenericHashtag(tag))
    .slice(0, HASHTAG_LIMIT);
}

function addHashtagCandidate(candidates, value) {
  const hashtag = toHashtag(value);
  if (hashtag) candidates.push(hashtag);
}

function keywordPairs(value) {
  const tokens = meaningfulTokens(value);
  const pairs = [];
  for (let index = 0; index < tokens.length - 1; index += 1) {
    pairs.push(`${tokens[index]} ${tokens[index + 1]}`);
  }
  return pairs.slice(0, 4);
}

function namedPhrases(value) {
  const matches = String(value || "").match(/\b[A-Z][\p{L}\p{N}]+(?:\s+[A-Z][\p{L}\p{N}]+){1,2}/gu) || [];
  return matches
    .map((item) => item.trim())
    .filter((item) => meaningfulTokens(item).length >= 2)
    .slice(0, 8);
}

function topKeywords(value, limit) {
  const scores = new Map();
  const firstSeen = new Map();
  const tokens = meaningfulTokens(value);
  tokens.forEach((token, index) => {
    scores.set(token, (scores.get(token) || 0) + 1);
    if (!firstSeen.has(token)) firstSeen.set(token, index);
  });
  return [...scores.entries()]
    .sort((left, right) => {
      const scoreDiff = right[1] - left[1];
      if (scoreDiff) return scoreDiff;
      return (firstSeen.get(left[0]) || 0) - (firstSeen.get(right[0]) || 0);
    })
    .map(([token]) => token)
    .slice(0, limit);
}

function topicHashtags(value) {
  const source = String(value || "").toLowerCase();
  const tags = [];
  if (/\byusuf\s+hamka\b/i.test(value)) tags.push("Yusuf Hamka");
  if (/hak|adil|keadilan|nuntut|tuntut|perjuang/.test(source)) tags.push("Keadilan");
  if (/ancam|diancam|tekan|intimidasi/.test(source)) tags.push("Ancaman");
  if (/oknum|petugas|backing|orang gede|orang besar/.test(source)) tags.push("Oknum");
  if (/royalti|lagu|musik/.test(source)) tags.push("Royalti Musik");
  if (/selingkuh|spill|sosmed/.test(source)) tags.push("Drama Sosmed");
  if (/usaha|bisnis|jualan|dagang/.test(source)) tags.push("Bisnis");
  return tags;
}

function meaningfulTokens(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !STOPWORDS.has(token));
}

function toHashtag(value) {
  const words = meaningfulTokens(value)
    .filter((word) => !GENERIC_HASHTAGS.has(word))
    .slice(0, 3);
  if (!words.length) return "";
  const tag = words.map(capitalizeTagPart).join("");
  if (tag.length < 3 || tag.length > 36) return "";
  return `#${tag}`;
}

function capitalizeTagPart(value) {
  const cleaned = String(value || "").toLowerCase();
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

function extractHashtags(value) {
  return String(value || "").match(/#[\p{L}\p{N}_]+/gu) || [];
}

function stripHashtags(value) {
  return String(value || "")
    .replace(/(?:^|\s)#[\p{L}\p{N}_]+/gu, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

function mergeHashtags(...groups) {
  const seen = new Set();
  const merged = [];
  for (const tag of groups.flat()) {
    const normalized = normalizeHashtags([tag])[0];
    if (!normalized) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(normalized);
  }
  return merged;
}

function isGenericHashtag(value) {
  const key = String(value || "")
    .replace(/^#+/, "")
    .toLowerCase();
  return GENERIC_HASHTAGS.has(key);
}

function normalizeHashtags(value) {
  const rawItems = Array.isArray(value)
    ? value
    : String(value || "#PodcastIndonesia #ReelsIndonesia")
      .split(/[\s,]+/);

  const seen = new Set();
  const tags = [];
  for (const item of rawItems) {
    const cleaned = String(item || "")
      .trim()
      .replace(/^#+/, "")
      .replace(/[^\p{L}\p{N}_]/gu, "");
    if (!cleaned) continue;
    const tag = `#${cleaned}`;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }
  return tags.slice(0, 8);
}

const GENERIC_HASHTAGS = new Set([
  "podcast",
  "podcastindonesia",
  "podcastartis",
  "reels",
  "reelsindonesia",
  "short",
  "shorts",
  "shortsindonesia",
  "fyp",
  "foryou",
  "viral",
  "trending",
  "kontenviral",
  "clip",
  "klip",
  "video",
  "indonesia",
  "artis"
]);

const BASE_HASHTAGS = [
  "#PodcastIndonesia",
  "#PodcastArtis",
  "#ReelsIndonesia"
];

const HASHTAG_LIMIT = 3;

const INCOMPLETE_CAPTION_END_RE = /(?:\.{3}|…|[,;:]|\s[-–]|\b(?:dan|atau|karena|yang|untuk|dengan|ke|di|dari|agar|supaya|kalau|tapi|jadi|sehingga|lalu|terus|bahwa|seperti|saat|ketika|biar))$/i;

const STOPWORDS = new Set([
  ...GENERIC_HASHTAGS,
  "ada",
  "agar",
  "akan",
  "aku",
  "amat",
  "anda",
  "apa",
  "apakah",
  "atau",
  "bagai",
  "bagaimana",
  "bagian",
  "bagi",
  "bahwa",
  "banyak",
  "baru",
  "begini",
  "begitu",
  "belum",
  "bisa",
  "buat",
  "bukan",
  "cuma",
  "dan",
  "dari",
  "dalam",
  "dengan",
  "dia",
  "diri",
  "dong",
  "gak",
  "harus",
  "ini",
  "itu",
  "jadi",
  "jangan",
  "juga",
  "kalau",
  "kamu",
  "karena",
  "kata",
  "ke",
  "ketika",
  "kita",
  "lagi",
  "lebih",
  "mereka",
  "mungkin",
  "nggak",
  "nih",
  "nya",
  "orang",
  "pada",
  "paling",
  "para",
  "punya",
  "saat",
  "saja",
  "saling",
  "sama",
  "sampai",
  "sangat",
  "sebagai",
  "sedang",
  "seperti",
  "siapa",
  "soal",
  "sudah",
  "supaya",
  "tapi",
  "telah",
  "tentang",
  "terus",
  "tidak",
  "untuk",
  "waktu",
  "yang",
  "your",
  "with",
  "this",
  "that",
  "what",
  "when",
  "where",
  "about",
  "from",
  "into",
  "how",
  "why"
]);

function normalizeThumbnailText(value, fallback = "RAHASIA DI BALIK CERITA INI BIKIN PENASARAN") {
  const cleaned = String(value || "")
    .replace(/[`"'*_#]/g, "")
    .replace(/[,:;]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return cleaned.split(/\s+/).slice(0, 16).join(" ") || fallback;
}

function isStrongThumbnailText(value) {
  const cleaned = String(value || "").trim();
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 6 || words.length > 16) return false;
  if (/[,:;]$/.test(cleaned)) return false;
  const meaningfulCount = words.filter((word) => !STOPWORDS.has(word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, ""))).length;
  return words.join("").length >= 24 && meaningfulCount >= 4;
}

function fallbackThumbnailText(output) {
  const candidates = [
    output?.hook,
    output?.title,
    output?.selectedAngle,
    output?.reason,
    output?.caption
  ];

  for (const candidate of candidates) {
    const normalized = candidate ? normalizeThumbnailText(candidate, "") : "";
    if (isStrongThumbnailText(normalized)) return normalized;
  }

  const transcriptTitle = buildTranscriptThumbnailText(output?.clipTranscript);
  if (isStrongThumbnailText(transcriptTitle)) return transcriptTitle;

  return "RAHASIA DI BALIK CERITA INI BIKIN PENASARAN";
}

function buildTranscriptThumbnailText(value) {
  const words = String(value || "")
    .replace(/[^\p{L}\p{N}\s?]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 3 && !STOPWORDS.has(word.toLowerCase()))
    .slice(0, 14);
  return normalizeThumbnailText(words.join(" "), "");
}
