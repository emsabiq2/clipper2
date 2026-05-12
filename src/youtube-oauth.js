import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sodium from "libsodium-wrappers";

const googleAuthUrl = "https://accounts.google.com/o/oauth2/v2/auth";
const googleTokenUrl = "https://oauth2.googleapis.com/token";
const defaultScope = "https://www.googleapis.com/auth/youtube.upload";
const stateMaxAgeMs = 30 * 60 * 1000;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

export function youtubeOAuthConfig(options = {}) {
  const origin = cleanBaseUrl(options.origin || "");
  const publicBaseUrl = cleanBaseUrl(process.env.YOUTUBE_PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL || "");
  const baseUrl = origin || publicBaseUrl;
  const redirectUri = clean(
    process.env.YOUTUBE_REDIRECT_URI
      || options.redirectUri
      || (baseUrl ? `${baseUrl}/api/youtube/callback` : "")
  );

  return {
    clientId: clean(process.env.YOUTUBE_CLIENT_ID),
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || "",
    redirectUri,
    scope: clean(process.env.YOUTUBE_AUTH_SCOPE || defaultScope)
  };
}

export function buildYoutubeAuthUrl(options = {}) {
  const cfg = youtubeOAuthConfig(options);
  if (!cfg.clientId) throw new Error("YOUTUBE_CLIENT_ID belum diisi.");
  if (!cfg.clientSecret) throw new Error("YOUTUBE_CLIENT_SECRET belum diisi.");
  if (!cfg.redirectUri) throw new Error("YOUTUBE_REDIRECT_URI belum diisi atau origin dashboard tidak terbaca.");

  const state = createYoutubeOAuthState({
    origin: cleanBaseUrl(options.origin || ""),
    redirectUri: cfg.redirectUri
  });
  const url = new URL(googleAuthUrl);
  url.searchParams.set("client_id", cfg.clientId);
  url.searchParams.set("redirect_uri", cfg.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", cfg.scope);
  url.searchParams.set("access_type", "offline");
  url.searchParams.set("prompt", "consent");
  url.searchParams.set("include_granted_scopes", "false");
  url.searchParams.set("state", state);
  if (process.env.YOUTUBE_LOGIN_HINT) url.searchParams.set("login_hint", clean(process.env.YOUTUBE_LOGIN_HINT));

  return {
    url: url.toString(),
    redirectUri: cfg.redirectUri,
    scope: cfg.scope,
    state
  };
}

export async function exchangeYoutubeCode({ code, redirectUri }) {
  const cleanCode = clean(code);
  if (!cleanCode) throw new Error("YouTube authorization code kosong.");

  const cfg = youtubeOAuthConfig({ redirectUri });
  if (!cfg.clientId) throw new Error("YOUTUBE_CLIENT_ID belum diisi.");
  if (!cfg.clientSecret) throw new Error("YOUTUBE_CLIENT_SECRET belum diisi.");
  if (!cfg.redirectUri) throw new Error("YOUTUBE_REDIRECT_URI belum diisi.");

  const data = await postGoogleToken({
    code: cleanCode,
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    redirect_uri: cfg.redirectUri,
    grant_type: "authorization_code"
  }, "YouTube authorization exchange failed");

  if (data.refresh_token) {
    process.env.YOUTUBE_REFRESH_TOKEN = data.refresh_token;
  }
  if (data.access_token) {
    process.env.YOUTUBE_ACCESS_TOKEN = data.access_token;
  }

  return {
    accessToken: data.access_token || "",
    refreshToken: data.refresh_token || "",
    expiresIn: Number(data.expires_in || 0),
    scope: data.scope || cfg.scope,
    tokenType: data.token_type || ""
  };
}

export async function refreshYoutubeAccessToken(options = {}) {
  const cfg = youtubeOAuthConfig(options);
  const refreshToken = options.refreshToken || process.env.YOUTUBE_REFRESH_TOKEN || "";
  if (!cfg.clientId) throw new Error("YOUTUBE_CLIENT_ID belum diisi.");
  if (!cfg.clientSecret) throw new Error("YOUTUBE_CLIENT_SECRET belum diisi.");
  if (!refreshToken) throw new Error("YOUTUBE_REFRESH_TOKEN belum diisi.");

  const data = await postGoogleToken({
    client_id: cfg.clientId,
    client_secret: cfg.clientSecret,
    refresh_token: refreshToken,
    grant_type: "refresh_token"
  }, "YouTube token refresh failed");

  return data.access_token || "";
}

export async function persistYoutubeReconnect({ refreshToken, persistLocal = false, persistGithub = true }) {
  const result = {
    local: { skipped: true },
    github: { skipped: true },
    enabled: { skipped: true }
  };

  if (persistLocal) {
    result.local = persistLocalYoutubeTokens({ refreshToken });
  }

  if (persistGithub) {
    result.github = await upsertGithubSecret("YOUTUBE_REFRESH_TOKEN", refreshToken);
    result.enabled = await upsertGithubSecret("YOUTUBE_UPLOAD_ENABLED", "true").catch((error) => ({
      skipped: true,
      error: error.message
    }));
  }

  return result;
}

export function persistLocalYoutubeTokens({ refreshToken }) {
  const envPath = path.join(rootDir, ".env");
  if (!refreshToken) return { skipped: true, reason: "refresh_token kosong" };
  if (!fs.existsSync(envPath)) return { skipped: true, reason: ".env tidak ditemukan" };

  const raw = fs.readFileSync(envPath, "utf8");
  let next = updateEnvKey(raw, "YOUTUBE_REFRESH_TOKEN", refreshToken);
  next = updateEnvKey(next, "YOUTUBE_UPLOAD_ENABLED", "true");
  if (next === raw) return { skipped: false, updated: false };
  fs.writeFileSync(envPath, next, "utf8");
  return { skipped: false, updated: true };
}

export async function upsertGithubSecret(name, value) {
  const token = clean(process.env.GH_REPO_SECRET_TOKEN || process.env.GITHUB_TOKEN);
  const repo = clean(process.env.DASHBOARD_GITHUB_REPO || process.env.GITHUB_REPOSITORY || "emsabiq2/clipper2");
  if (!token) return { skipped: true, reason: "GH_REPO_SECRET_TOKEN belum diset" };
  if (!value) return { skipped: true, reason: `${name} kosong` };

  const headers = githubHeaders(token);
  const keyResponse = await fetch(`https://api.github.com/repos/${repo}/actions/secrets/public-key`, {
    headers,
    cache: "no-store"
  });
  if (!keyResponse.ok) {
    throw new Error(`Gagal membaca public key GitHub (${keyResponse.status}): ${await safeText(keyResponse)}`);
  }
  const publicKey = await keyResponse.json();
  if (!publicKey?.key || !publicKey?.key_id) {
    throw new Error("GitHub tidak mengembalikan public key untuk secret.");
  }

  await sodium.ready;
  const encryptedValue = sodium.to_base64(
    sodium.crypto_box_seal(
      new TextEncoder().encode(value),
      sodium.from_base64(publicKey.key, sodium.base64_variants.ORIGINAL)
    ),
    sodium.base64_variants.ORIGINAL
  );

  const putResponse = await fetch(
    `https://api.github.com/repos/${repo}/actions/secrets/${encodeURIComponent(name)}`,
    {
      method: "PUT",
      headers,
      body: JSON.stringify({
        encrypted_value: encryptedValue,
        key_id: publicKey.key_id
      })
    }
  );
  if (![201, 204].includes(putResponse.status)) {
    throw new Error(`Gagal update GitHub Secret ${name} (${putResponse.status}): ${await safeText(putResponse)}`);
  }

  return { skipped: false, repo, name, status: putResponse.status };
}

export function createYoutubeOAuthState(payload = {}) {
  const body = base64Url(JSON.stringify({
    iat: Date.now(),
    nonce: crypto.randomBytes(16).toString("hex"),
    redirectUri: clean(payload.redirectUri || ""),
    origin: cleanBaseUrl(payload.origin || "")
  }));
  const signature = signStateBody(body);
  return `${body}.${signature}`;
}

export function verifyYoutubeOAuthState(state) {
  const [body, signature] = clean(state).split(".");
  if (!body || !signature) throw new Error("State OAuth YouTube tidak valid.");

  const expected = signStateBody(body);
  if (!safeEqual(signature, expected)) throw new Error("State OAuth YouTube tidak cocok.");

  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    throw new Error("State OAuth YouTube tidak bisa dibaca.");
  }

  const age = Date.now() - Number(payload.iat || 0);
  if (!Number.isFinite(age) || age < 0 || age > stateMaxAgeMs) {
    throw new Error("State OAuth YouTube sudah kedaluwarsa. Ulangi dari tombol Reconnect.");
  }

  return payload;
}

export function requestOrigin(headers = {}) {
  const host = firstHeader(headers["x-forwarded-host"] || headers.host);
  const proto = firstHeader(headers["x-forwarded-proto"]) || (host?.includes("localhost") ? "http" : "https");
  if (!host) return cleanBaseUrl(process.env.PUBLIC_BASE_URL || "");
  return cleanBaseUrl(`${proto}://${host}`);
}

export function renderYoutubeCallbackPage({ ok, token = {}, persist = {}, error = "" }) {
  const refreshToken = token.refreshToken || "";
  const githubUpdated = persist.github && !persist.github.skipped;
  const localUpdated = persist.local && !persist.local.skipped && persist.local.updated !== false;
  const manualToken = refreshToken && !githubUpdated && !localUpdated;
  const title = ok ? "YouTube connected" : "YouTube reconnect failed";
  const message = ok
    ? "Refresh token baru sudah diterima."
    : error || "Reconnect YouTube gagal.";

  return `<!doctype html>
<html lang="id">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: dark; font-family: Segoe UI, Arial, sans-serif; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0b0d10; color: #f4f7fb; }
      main { width: min(640px, calc(100% - 28px)); border: 1px solid rgba(255,255,255,.12); border-radius: 8px; padding: 22px; background: #151a21; }
      h1 { margin: 0 0 8px; font-size: 22px; }
      p, li { color: #a8b0bd; line-height: 1.55; }
      code, textarea { width: 100%; color: #d7fff7; background: #0b0d10; border: 1px solid rgba(255,255,255,.12); border-radius: 8px; }
      textarea { min-height: 120px; padding: 12px; }
      a, button { display: inline-flex; align-items: center; height: 34px; padding: 0 12px; border-radius: 8px; background: #2dd4bf; color: #07100d; font-weight: 800; text-decoration: none; border: 0; cursor: pointer; }
      .row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 18px; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(message)}</p>
      <ul>
        <li>GitHub Secret: ${escapeHtml(githubUpdated ? "updated" : persist.github?.reason || persist.github?.error || "skipped")}</li>
        <li>Local .env: ${escapeHtml(localUpdated ? "updated" : persist.local?.reason || "skipped")}</li>
        <li>Access token: ${escapeHtml(token.accessToken ? "valid for this session" : "not returned")}</li>
      </ul>
      ${manualToken ? `<p>Copy token ini ke GitHub Secret <code>YOUTUBE_REFRESH_TOKEN</code>.</p><textarea readonly>${escapeHtml(refreshToken)}</textarea>` : ""}
      <div class="row">
        <a href="/">Kembali dashboard</a>
        <button type="button" onclick="window.close()">Tutup</button>
      </div>
    </main>
    <script>
      if (window.opener) {
        window.opener.postMessage({ type: "youtube-reconnect", ok: ${ok ? "true" : "false"} }, window.location.origin);
      }
    </script>
  </body>
</html>`;
}

export function isInvalidGrant(error) {
  return /invalid_grant/i.test(String(error?.apiCode || error?.message || ""));
}

async function postGoogleToken(params, label) {
  const response = await fetch(googleTokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const detail = data.error_description || data.error || response.statusText;
    const error = new Error(`${label}: ${detail}`);
    error.apiCode = data.error || "";
    error.status = response.status;
    throw error;
  }
  return data;
}

function signStateBody(body) {
  const secret = stateSecret();
  return crypto.createHmac("sha256", secret).update(body).digest("base64url");
}

function stateSecret() {
  const secret = clean(
    process.env.YOUTUBE_OAUTH_STATE_SECRET
      || process.env.AUTO_DASHBOARD_PIN
      || process.env.YOUTUBE_CLIENT_SECRET
      || process.env.GH_REPO_SECRET_TOKEN
      || process.env.GITHUB_TOKEN
  );
  if (!secret) throw new Error("YOUTUBE_OAUTH_STATE_SECRET atau AUTO_DASHBOARD_PIN wajib diisi untuk Reconnect YouTube.");
  return secret;
}

function safeEqual(left, right) {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function updateEnvKey(raw, key, value) {
  const nextLine = `${key}=${value}`;
  return raw.match(new RegExp(`^${key}=`, "m"))
    ? raw.replace(new RegExp(`^${key}=.*$`, "m"), nextLine)
    : `${raw.replace(/\s*$/, "\n")}${nextLine}\n`;
}

function githubHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "clipper-youtube-oauth"
  };
}

async function safeText(response) {
  const text = await response.text().catch(() => "");
  return text.slice(0, 500);
}

function firstHeader(value) {
  const raw = Array.isArray(value) ? value[0] : value;
  return clean(String(raw || "").split(",")[0]);
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function clean(value) {
  return String(value || "").trim();
}

function cleanBaseUrl(value) {
  return clean(value).replace(/\/+$/, "");
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
