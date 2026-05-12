import axios from "axios";
import { config } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function apiUrl(pathName) {
  return `https://graph.facebook.com/${config.graphApiVersion}/${pathName}`;
}

function graphError(error) {
  const apiError = error.response?.data?.error;
  if (!apiError) return error;

  const wrapped = new Error(
    `Instagram token error (${error.response.status}): ${apiError.message} ` +
      `[code ${apiError.code}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
  );
  wrapped.apiCode = apiError.code;
  wrapped.apiSubcode = apiError.error_subcode;
  wrapped.apiError = apiError;
  return wrapped;
}

function applyToken(accessToken) {
  process.env.INSTAGRAM_ACCESS_TOKEN = accessToken;
  config.instagram.accessToken = accessToken;
}

function isExpiredTokenError(error) {
  return error?.apiSubcode === 463 || error?.apiCode === 190 || /expired/i.test(String(error?.message || ""));
}

async function validateTokenWithInstagram(accessToken = config.instagram.accessToken) {
  try {
    const response = await axios.get(apiUrl(config.instagram.igUserId), {
      params: {
        fields: "id,username",
        access_token: accessToken
      },
      timeout: 30000
    });

    return {
      valid: Boolean(response.data?.id),
      expiresAt: null,
      usernamePresent: Boolean(response.data?.username)
    };
  } catch (error) {
    throw graphError(error);
  }
}

async function getFacebookPageTokenFromUser() {
  if (!config.facebook.pageId || !config.facebook.userAccessToken) return null;

  try {
    const response = await axios.get(apiUrl("me/accounts"), {
      params: {
        fields: "id,name,access_token",
        access_token: config.facebook.userAccessToken
      },
      timeout: 30000
    });

    const pages = Array.isArray(response.data?.data) ? response.data.data : [];
    const page = pages.find((item) => String(item.id) === String(config.facebook.pageId));
    return page?.access_token || null;
  } catch (error) {
    console.warn(`IG fallback facebook_page_from_user_token gagal: ${graphError(error).message}`);
    return null;
  }
}

async function fallbackTokenCandidates() {
  const pageFromUser = await getFacebookPageTokenFromUser();
  const candidates = [
    ["facebook_page_from_user_token", pageFromUser],
    ["facebook_page_token", config.facebook.accessToken],
    ["facebook_user_token", config.facebook.userAccessToken]
  ];
  const seen = new Set();
  return candidates.filter(([, token]) => {
    if (!token || seen.has(token)) return false;
    seen.add(token);
    return true;
  });
}

async function applyValidFallbackToken() {
  for (const [label, token] of await fallbackTokenCandidates()) {
    if (token === config.instagram.accessToken) continue;

    try {
      const validation = await validateTokenWithInstagram(token);
      applyToken(token);
      console.warn(`IG token utama tidak valid; memakai fallback ${label} untuk run ini.`);
      return validation;
    } catch (error) {
      console.warn(`IG fallback ${label} tidak valid: ${graphError(error).message}`);
    }
  }

  return null;
}

async function debugToken() {
  if (!config.meta.appId || !config.meta.appSecret) return null;

  try {
    const response = await axios.get(apiUrl("debug_token"), {
      params: {
        input_token: config.instagram.accessToken,
        access_token: `${config.meta.appId}|${config.meta.appSecret}`
      },
      timeout: 30000
    });

    const data = response.data?.data || {};
    return {
      valid: Boolean(data.is_valid),
      expiresAt: data.expires_at ? new Date(data.expires_at * 1000) : null
    };
  } catch (error) {
    console.warn(`IG token debug dilewati: ${graphError(error).message}`);
    return null;
  }
}

async function exchangeToken() {
  if (!config.meta.appId || !config.meta.appSecret) {
    throw new Error("META_APP_ID dan META_APP_SECRET wajib diisi untuk refresh token Instagram.");
  }

  try {
    const response = await axios.get(apiUrl("oauth/access_token"), {
      params: {
        grant_type: "fb_exchange_token",
        client_id: config.meta.appId,
        client_secret: config.meta.appSecret,
        fb_exchange_token: config.instagram.accessToken
      },
      timeout: 30000
    });

    const accessToken = response.data?.access_token || "";
    if (!accessToken) throw new Error("Meta tidak mengembalikan access_token baru.");
    applyToken(accessToken);

    return {
      refreshed: true,
      expiresIn: Number(response.data?.expires_in || 0)
    };
  } catch (error) {
    throw graphError(error);
  }
}

export async function ensureFreshInstagramToken() {
  if (!config.instagram.enabled) {
    return { checked: false, refreshed: false, reason: "instagram_disabled" };
  }

  if (!config.instagram.accessToken) {
    const fallbackValidation = await applyValidFallbackToken();
    if (!fallbackValidation) {
      return { checked: false, refreshed: false, reason: "instagram_missing_token" };
    }
  }

  let validation;
  try {
    validation = await validateTokenWithInstagram();
  } catch (error) {
    if (isExpiredTokenError(error)) {
      const fallbackValidation = await applyValidFallbackToken();
      if (fallbackValidation) {
        return { checked: true, refreshed: true, reason: "fallback_token_applied", ...fallbackValidation };
      }
      throw new Error(
        "INSTAGRAM_ACCESS_TOKEN sudah expired. Buat token baru dan update GitHub Secret INSTAGRAM_ACCESS_TOKEN."
      );
    }
    throw error;
  }

  if (!config.meta.autoRefreshInstagramToken) {
    return { checked: true, refreshed: false, reason: "auto_refresh_disabled" };
  }

  const debug = await debugToken();
  if (debug?.expiresAt) {
    const daysLeft = (debug.expiresAt.getTime() - Date.now()) / DAY_MS;
    if (daysLeft > config.meta.tokenRefreshBeforeDays) {
      console.log(`IG token valid, refresh belum perlu (${Math.floor(daysLeft)} hari lagi).`);
      return { checked: true, refreshed: false, expiresAt: debug.expiresAt.toISOString() };
    }
  }

  try {
    const refreshed = await exchangeToken();
    console.log("IG token berhasil direfresh untuk run ini.");
    return { checked: true, ...refreshed };
  } catch (error) {
    if (debug?.expiresAt) {
      const daysLeft = (debug.expiresAt.getTime() - Date.now()) / DAY_MS;
      if (daysLeft <= config.meta.tokenRefreshBeforeDays) throw error;
    }

    console.warn(`IG token refresh dilewati: ${error.message}`);
    return {
      checked: true,
      refreshed: false,
      reason: "refresh_failed_but_current_token_is_valid",
      usernamePresent: validation.usernamePresent
    };
  }
}
