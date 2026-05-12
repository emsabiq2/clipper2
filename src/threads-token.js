import axios from "axios";
import { config } from "./config.js";

const DAY_MS = 24 * 60 * 60 * 1000;

function apiUrl(pathName) {
  return `https://graph.threads.net/${config.threads.apiVersion}/${pathName}`;
}

function graphError(error) {
  const apiError = error.response?.data?.error;
  if (!apiError) return error;

  const wrapped = new Error(
    `Threads token error (${error.response.status}): ${apiError.message} ` +
      `[code ${apiError.code || ""}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
  );
  wrapped.apiCode = apiError.code;
  wrapped.apiSubcode = apiError.error_subcode;
  wrapped.apiError = apiError;
  return wrapped;
}

function applyToken(accessToken) {
  process.env.THREADS_ACCESS_TOKEN = accessToken;
  config.threads.accessToken = accessToken;
}

function isExpiredTokenError(error) {
  return error?.apiSubcode === 463 || error?.apiCode === 190 || /expired/i.test(String(error?.message || ""));
}

async function validateToken(accessToken = config.threads.accessToken) {
  try {
    const response = await axios.get(apiUrl(config.threads.userId || "me"), {
      params: {
        fields: "id,username",
        access_token: accessToken
      },
      timeout: 30000
    });

    return {
      valid: Boolean(response.data?.id),
      userId: response.data?.id || "",
      username: response.data?.username || ""
    };
  } catch (error) {
    throw graphError(error);
  }
}

async function refreshAccessToken() {
  try {
    const response = await axios.get(apiUrl("refresh_access_token"), {
      params: {
        grant_type: "th_refresh_token",
        access_token: config.threads.accessToken
      },
      timeout: 30000
    });

    const accessToken = response.data?.access_token || "";
    if (!accessToken) throw new Error("Threads tidak mengembalikan access_token baru.");
    applyToken(accessToken);

    return {
      refreshed: true,
      expiresIn: Number(response.data?.expires_in || 0)
    };
  } catch (error) {
    throw graphError(error);
  }
}

export async function ensureFreshThreadsToken() {
  if (!config.threads.enabled) {
    return { checked: false, refreshed: false, reason: "threads_disabled" };
  }

  if (!config.threads.accessToken) {
    return { checked: false, refreshed: false, reason: "threads_missing_token" };
  }

  let validation;
  try {
    validation = await validateToken();
  } catch (error) {
    if (isExpiredTokenError(error)) {
      throw new Error(
        "THREADS_ACCESS_TOKEN sudah expired. Buat ulang lewat Meta Developer dan update GitHub Secret THREADS_ACCESS_TOKEN."
      );
    }
    throw error;
  }

  if (!config.threads.autoRefreshToken) {
    return { checked: true, refreshed: false, reason: "auto_refresh_disabled", ...validation };
  }

  if (config.threads.tokenIssuedAt) {
    const issued = new Date(config.threads.tokenIssuedAt).getTime();
    if (Number.isFinite(issued)) {
      const ageDays = (Date.now() - issued) / DAY_MS;
      if (ageDays < 1) {
        return { checked: true, refreshed: false, reason: "token_too_fresh", ...validation };
      }
      const daysLeft = 60 - ageDays;
      if (daysLeft > config.meta.tokenRefreshBeforeDays) {
        return { checked: true, refreshed: false, daysLeft: Math.floor(daysLeft), ...validation };
      }
    }
  }

  try {
    const refreshed = await refreshAccessToken();
    console.log("Threads token berhasil direfresh untuk run ini.");
    return { checked: true, ...refreshed, ...validation };
  } catch (error) {
    console.warn(`Threads token refresh dilewati: ${error.message}`);
    return {
      checked: true,
      refreshed: false,
      reason: "refresh_failed_but_current_token_is_valid",
      ...validation
    };
  }
}
