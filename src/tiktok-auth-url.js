import crypto from "node:crypto";
import { config } from "./config.js";

const scopes = (process.env.TIKTOK_AUTH_SCOPES || "user.info.basic,video.publish,video.upload")
  .split(/[\s,]+/)
  .map((item) => item.trim())
  .filter(Boolean)
  .join(",");

if (!config.tiktok.clientKey) {
  throw new Error("TIKTOK_CLIENT_KEY belum diisi.");
}

if (!config.tiktok.redirectUri) {
  throw new Error("TIKTOK_REDIRECT_URI belum diisi.");
}

const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
url.searchParams.set("client_key", config.tiktok.clientKey);
url.searchParams.set("response_type", "code");
url.searchParams.set("scope", scopes);
url.searchParams.set("redirect_uri", config.tiktok.redirectUri);
url.searchParams.set("state", crypto.randomBytes(16).toString("hex"));

console.log(url.toString());
