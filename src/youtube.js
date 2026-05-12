export function extractYoutubeVideoId(input) {
  const value = String(input || "").trim();
  if (!value) return "";

  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "");
    if (host === "youtu.be") return cleanId(url.pathname.split("/").filter(Boolean)[0]);
    if (host.endsWith("youtube.com")) {
      const watchId = url.searchParams.get("v");
      if (watchId) return cleanId(watchId);
      const parts = url.pathname.split("/").filter(Boolean);
      const index = parts.findIndex((part) => ["shorts", "embed", "live"].includes(part));
      if (index !== -1 && parts[index + 1]) return cleanId(parts[index + 1]);
    }
  } catch {
    const match = value.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([A-Za-z0-9_-]{6,})/);
    return cleanId(match?.[1] || "");
  }

  return "";
}

function cleanId(value) {
  return String(value || "").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32);
}
