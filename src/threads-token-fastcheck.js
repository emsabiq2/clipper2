import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));

loadEnvFile(path.join(rootDir, ".env"));

const apiVersion = clean(process.env.THREADS_API_VERSION || "v1.0");
const userId = clean(process.env.THREADS_USER_ID) || "me";
let accessToken = process.env.THREADS_ACCESS_TOKEN || "";
const autoRefresh = boolEnv("AUTO_REFRESH_THREADS_TOKEN", true);
const refreshBeforeDays = numberEnv("TOKEN_REFRESH_BEFORE_DAYS", 10);
const tokenIssuedAt = clean(process.env.THREADS_TOKEN_ISSUED_AT);

function clean(value) {
  return String(value || "").trim();
}

function boolEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const [rawKey, ...rest] = trimmed.split("=");
    const key = rawKey.trim();
    const value = rest.join("=").trim().replace(/^["']|["']$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function mask(value) {
  if (!value || !process.env.GITHUB_ACTIONS) return;
  console.log(`::add-mask::${value}`);
}

function apiUrl(pathName, params = {}) {
  const url = new URL(`https://graph.threads.net/${apiVersion}/${pathName}`);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  }
  return url;
}

async function fetchJson(pathName, params = {}) {
  const response = await fetch(apiUrl(pathName, params));
  let data = null;
  try {
    data = await response.json();
  } catch {
    data = null;
  }

  if (!response.ok) {
    const apiError = data?.error || {};
    const error = new Error(
      `${apiError.message || response.statusText} ` +
        `[code ${apiError.code || response.status}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
    );
    error.apiCode = apiError.code;
    error.apiSubcode = apiError.error_subcode;
    throw error;
  }

  return data;
}

async function validateToken(token) {
  const data = await fetchJson(userId, {
    fields: "id,username",
    access_token: token
  });

  return {
    valid: Boolean(data?.id),
    userId: data?.id || "",
    username: data?.username || ""
  };
}

async function refreshToken(token) {
  const data = await fetchJson("refresh_access_token", {
    grant_type: "th_refresh_token",
    access_token: token
  });

  if (!data?.access_token) {
    throw new Error("Threads tidak mengembalikan access_token baru.");
  }

  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in || 0)
  };
}

function updateEnvFile(filePath, token, issuedAt) {
  if (!fs.existsSync(filePath)) return false;

  const raw = fs.readFileSync(filePath, "utf8");
  let next = raw;

  const tokenLine = `THREADS_ACCESS_TOKEN=${token}`;
  next = next.match(/^THREADS_ACCESS_TOKEN=/m)
    ? next.replace(/^THREADS_ACCESS_TOKEN=.*$/m, tokenLine)
    : `${next.replace(/\s*$/, "\n")}${tokenLine}\n`;

  if (issuedAt) {
    const issuedLine = `THREADS_TOKEN_ISSUED_AT=${issuedAt}`;
    next = next.match(/^THREADS_TOKEN_ISSUED_AT=/m)
      ? next.replace(/^THREADS_TOKEN_ISSUED_AT=.*$/m, issuedLine)
      : `${next.replace(/\s*$/, "\n")}${issuedLine}\n`;
  }

  if (next !== raw) fs.writeFileSync(filePath, next, "utf8");
  return next !== raw;
}

function persistLocalToken(token, issuedAt) {
  const files = [path.join(rootDir, ".env")];
  return files.filter((filePath) => updateEnvFile(filePath, token, issuedAt)).length;
}

function writeGitHubEnv(token, refreshed, issuedAt) {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) return;

  fs.appendFileSync(
    githubEnv,
    [
      "THREADS_ACCESS_TOKEN<<__THREADS_ACCESS_TOKEN__",
      token,
      "__THREADS_ACCESS_TOKEN__",
      `THREADS_TOKEN_REFRESHED=${refreshed ? "true" : "false"}`,
      `THREADS_TOKEN_ISSUED_AT=${issuedAt || ""}`
    ].join("\n") + "\n",
    "utf8"
  );
}

function daysUntil(date) {
  if (!date) return null;
  return (date.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
}

function isExpiredTokenError(error) {
  return error?.apiSubcode === 463 || error?.apiCode === 190 || /expired/i.test(String(error?.message || ""));
}

function computeExpiresAt(issuedAtRaw) {
  if (!issuedAtRaw) return null;
  const ts = new Date(issuedAtRaw).getTime();
  if (!Number.isFinite(ts)) return null;
  return new Date(ts + 60 * 24 * 60 * 60 * 1000);
}

function ageDays(issuedAtRaw) {
  if (!issuedAtRaw) return null;
  const ts = new Date(issuedAtRaw).getTime();
  if (!Number.isFinite(ts)) return null;
  return (Date.now() - ts) / (24 * 60 * 60 * 1000);
}

function printStatus(status) {
  console.log(JSON.stringify(status, null, 2));
}

async function main() {
  if (!accessToken) {
    throw new Error("THREADS_ACCESS_TOKEN wajib diisi.");
  }

  mask(accessToken);

  const validation = await validateToken(accessToken);

  let expiresAt = computeExpiresAt(tokenIssuedAt);
  let issuedAtOut = tokenIssuedAt;
  const age = ageDays(tokenIssuedAt);
  const daysLeft = expiresAt ? daysUntil(expiresAt) : null;

  const tokenFreshEnough = age != null && age < 1;
  const shouldRefresh = autoRefresh && !tokenFreshEnough && (
    args.has("--force") ||
    !expiresAt ||
    (daysLeft != null && daysLeft <= refreshBeforeDays)
  );

  let refreshed = false;
  let localFilesUpdated = 0;

  if (shouldRefresh) {
    try {
      const exchanged = await refreshToken(accessToken);
      accessToken = exchanged.accessToken;
      mask(accessToken);
      refreshed = true;
      issuedAtOut = new Date().toISOString().slice(0, 10);
      expiresAt = computeExpiresAt(issuedAtOut);
      await validateToken(accessToken);

      if (args.has("--persist-local")) {
        localFilesUpdated = persistLocalToken(accessToken, issuedAtOut);
      }
    } catch (error) {
      if (isExpiredTokenError(error)) {
        throw error;
      }
      console.warn(`Threads token refresh dilewati: ${error.message}`);
    }
  }

  if (args.has("--github-env")) {
    writeGitHubEnv(accessToken, refreshed, issuedAtOut);
  }

  printStatus({
    ok: true,
    refreshed,
    username: validation.username,
    userId: validation.userId,
    issuedAt: issuedAtOut || "",
    expiresAt: expiresAt ? expiresAt.toISOString() : "",
    daysLeft: expiresAt ? Math.floor(daysUntil(expiresAt)) : "",
    localFilesUpdated
  });
}

main().catch((error) => {
  const message = isExpiredTokenError(error)
    ? "THREADS_ACCESS_TOKEN sudah expired. Buat ulang via OAuth Threads, lalu update GitHub Secret."
    : error.message;

  console.error(JSON.stringify({
    ok: false,
    error: message,
    apiCode: error.apiCode || "",
    apiSubcode: error.apiSubcode || ""
  }, null, 2));
  process.exitCode = 1;
});
