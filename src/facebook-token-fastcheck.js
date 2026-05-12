import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));

loadEnvFile(path.join(rootDir, ".env"));

const graphApiVersion = clean(process.env.GRAPH_API_VERSION || "v25.0");
const pageId = clean(process.env.FACEBOOK_PAGE_ID);
let pageAccessToken = process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "";
let userAccessToken = process.env.FACEBOOK_USER_ACCESS_TOKEN || "";
const appId = clean(process.env.META_APP_ID);
const appSecret = process.env.META_APP_SECRET || "";
const autoRefresh = boolEnv("AUTO_REFRESH_FACEBOOK_TOKEN", true);
const refreshBeforeDays = numberEnv("TOKEN_REFRESH_BEFORE_DAYS", 10);

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
  const url = new URL(`https://graph.facebook.com/${graphApiVersion}/${pathName}`);
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

async function validatePageToken(token) {
  const data = await fetchJson(pageId, {
    fields: "id,name",
    access_token: token
  });

  return {
    valid: Boolean(data?.id),
    pageName: data?.name || ""
  };
}

async function debugToken(token) {
  if (!appId || !appSecret || !token) return null;

  const data = await fetchJson("debug_token", {
    input_token: token,
    access_token: `${appId}|${appSecret}`
  });

  const detail = data?.data || {};
  return {
    valid: Boolean(detail.is_valid),
    expiresAt: detail.expires_at ? new Date(detail.expires_at * 1000) : null
  };
}

async function exchangeUserToken(token) {
  if (!appId || !appSecret) {
    throw new Error("META_APP_ID dan META_APP_SECRET wajib diisi untuk refresh Facebook user token.");
  }

  const data = await fetchJson("oauth/access_token", {
    grant_type: "fb_exchange_token",
    client_id: appId,
    client_secret: appSecret,
    fb_exchange_token: token
  });

  if (!data?.access_token) {
    throw new Error("Meta tidak mengembalikan Facebook user access_token baru.");
  }

  return {
    accessToken: data.access_token,
    expiresIn: Number(data.expires_in || 0)
  };
}

async function getPageToken(token) {
  const data = await fetchJson("me/accounts", {
    fields: "id,name,access_token",
    access_token: token
  });

  const pages = Array.isArray(data?.data) ? data.data : [];
  const page = pages.find((item) => String(item.id) === String(pageId));
  if (!page?.access_token) {
    throw new Error("FACEBOOK_USER_ACCESS_TOKEN tidak punya akses ke FACEBOOK_PAGE_ID.");
  }

  return {
    accessToken: page.access_token,
    pageName: page.name || ""
  };
}

function updateEnvKey(raw, key, value) {
  const nextLine = `${key}=${value}`;
  return raw.match(new RegExp(`^${key}=`, "m"))
    ? raw.replace(new RegExp(`^${key}=.*$`, "m"), nextLine)
    : `${raw.replace(/\s*$/, "\n")}${nextLine}\n`;
}

function updateEnvFile(filePath, updates) {
  if (!fs.existsSync(filePath)) return false;

  const raw = fs.readFileSync(filePath, "utf8");
  let next = raw;
  for (const [key, value] of Object.entries(updates)) {
    if (value) next = updateEnvKey(next, key, value);
  }

  if (next !== raw) fs.writeFileSync(filePath, next, "utf8");
  return next !== raw;
}

function writeGitHubEnv({ pageToken, pageRefreshed, userToken, userRefreshed }) {
  const githubEnv = process.env.GITHUB_ENV;
  if (!githubEnv) return;

  const lines = [
    "FACEBOOK_PAGE_ACCESS_TOKEN<<__FACEBOOK_PAGE_ACCESS_TOKEN__",
    pageToken,
    "__FACEBOOK_PAGE_ACCESS_TOKEN__",
    `FACEBOOK_TOKEN_REFRESHED=${pageRefreshed ? "true" : "false"}`,
    `FACEBOOK_USER_TOKEN_REFRESHED=${userRefreshed ? "true" : "false"}`
  ];

  if (userToken && userRefreshed) {
    lines.push(
      "FACEBOOK_USER_ACCESS_TOKEN<<__FACEBOOK_USER_ACCESS_TOKEN__",
      userToken,
      "__FACEBOOK_USER_ACCESS_TOKEN__"
    );
  }

  fs.appendFileSync(githubEnv, lines.join("\n") + "\n", "utf8");
}

function daysUntil(date) {
  if (!date) return null;
  return (date.getTime() - Date.now()) / (24 * 60 * 60 * 1000);
}

function isExpiredTokenError(error) {
  return error?.apiSubcode === 463 || error?.apiCode === 190 || /expired/i.test(String(error?.message || ""));
}

function printStatus(status) {
  console.log(JSON.stringify(status, null, 2));
}

async function main() {
  if (!pageId) throw new Error("FACEBOOK_PAGE_ID wajib diisi.");
  if (!pageAccessToken && !userAccessToken) {
    throw new Error("FACEBOOK_PAGE_ACCESS_TOKEN atau FACEBOOK_USER_ACCESS_TOKEN wajib diisi.");
  }

  mask(pageAccessToken);
  mask(userAccessToken);

  let pageValid = false;
  let pageName = "";
  let pageError = null;

  if (pageAccessToken) {
    try {
      const validation = await validatePageToken(pageAccessToken);
      pageValid = validation.valid;
      pageName = validation.pageName;
    } catch (error) {
      pageError = error;
      if (!isExpiredTokenError(error) && !userAccessToken) throw error;
    }
  }

  let userRefreshed = false;
  let userExpiresAt = null;
  const shouldFetchPageToken = Boolean(userAccessToken && (autoRefresh || !pageValid || args.has("--force")));

  if (shouldFetchPageToken) {
    let shouldExchangeUserToken = args.has("--force");

    if (autoRefresh) {
      try {
        const debug = await debugToken(userAccessToken);
        userExpiresAt = debug?.expiresAt || null;
        const daysLeft = daysUntil(userExpiresAt);
        shouldExchangeUserToken = shouldExchangeUserToken || Boolean(userExpiresAt && daysLeft <= refreshBeforeDays);
      } catch (error) {
        console.warn(`Facebook user token refresh dilewati: ${error.message}`);
      }
    }

    if (autoRefresh && shouldExchangeUserToken) {
      try {
        const exchanged = await exchangeUserToken(userAccessToken);
        userAccessToken = exchanged.accessToken;
        userRefreshed = true;
        mask(userAccessToken);
      } catch (error) {
        console.warn(`Facebook user token exchange gagal, coba pakai token yang ada: ${error.message}`);
      }
    }

    const pageToken = await getPageToken(userAccessToken);
    pageAccessToken = pageToken.accessToken;
    mask(pageAccessToken);
    const validation = await validatePageToken(pageAccessToken);
    pageValid = validation.valid;
    pageName = validation.pageName || pageToken.pageName || pageName;
  }

  if (!pageValid) {
    throw pageError || new Error("Facebook Page token tidak valid.");
  }

  const localFilesUpdated = args.has("--persist-local")
    ? Number(updateEnvFile(path.join(rootDir, ".env"), {
      FACEBOOK_PAGE_ACCESS_TOKEN: pageAccessToken,
      FACEBOOK_USER_ACCESS_TOKEN: userRefreshed ? userAccessToken : ""
    }))
    : 0;

  if (args.has("--github-env")) {
    writeGitHubEnv({
      pageToken: pageAccessToken,
      pageRefreshed: shouldFetchPageToken,
      userToken: userAccessToken,
      userRefreshed
    });
  }

  printStatus({
    ok: true,
    refreshed: shouldFetchPageToken,
    userTokenRefreshed: userRefreshed,
    pageName,
    userTokenExpiresAt: userExpiresAt ? userExpiresAt.toISOString() : "",
    localFilesUpdated
  });
}

main().catch((error) => {
  const message = isExpiredTokenError(error)
    ? "FACEBOOK_PAGE_ACCESS_TOKEN sudah expired. Masukkan Page token baru atau FACEBOOK_USER_ACCESS_TOKEN yang valid."
    : error.message;

  console.error(JSON.stringify({
    ok: false,
    error: message,
    apiCode: error.apiCode || "",
    apiSubcode: error.apiSubcode || ""
  }, null, 2));
  process.exitCode = 1;
});
