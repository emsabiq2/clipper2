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
    `Facebook token error (${error.response.status}): ${apiError.message} ` +
      `[code ${apiError.code || ""}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
  );
  wrapped.apiCode = apiError.code;
  wrapped.apiSubcode = apiError.error_subcode;
  wrapped.apiError = apiError;
  return wrapped;
}

function applyPageToken(accessToken) {
  process.env.FACEBOOK_PAGE_ACCESS_TOKEN = accessToken;
  config.facebook.accessToken = accessToken;
}

function applyUserToken(accessToken) {
  process.env.FACEBOOK_USER_ACCESS_TOKEN = accessToken;
  config.facebook.userAccessToken = accessToken;
}

function isExpiredTokenError(error) {
  return error?.apiSubcode === 463 || error?.apiCode === 190 || /expired/i.test(String(error?.message || ""));
}

async function validatePageToken(accessToken = config.facebook.accessToken) {
  try {
    const response = await axios.get(apiUrl(config.facebook.pageId), {
      params: {
        fields: "id,name",
        access_token: accessToken
      },
      timeout: 30000
    });

    return {
      valid: Boolean(response.data?.id),
      pageName: response.data?.name || ""
    };
  } catch (error) {
    throw graphError(error);
  }
}

async function debugToken(accessToken) {
  if (!config.meta.appId || !config.meta.appSecret || !accessToken) return null;

  try {
    const response = await axios.get(apiUrl("debug_token"), {
      params: {
        input_token: accessToken,
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
    console.warn(`Facebook token debug dilewati: ${graphError(error).message}`);
    return null;
  }
}

async function exchangeUserToken(accessToken) {
  if (!config.meta.appId || !config.meta.appSecret) {
    throw new Error("META_APP_ID dan META_APP_SECRET wajib diisi untuk refresh Facebook user token.");
  }

  try {
    const response = await axios.get(apiUrl("oauth/access_token"), {
      params: {
        grant_type: "fb_exchange_token",
        client_id: config.meta.appId,
        client_secret: config.meta.appSecret,
        fb_exchange_token: accessToken
      },
      timeout: 30000
    });

    const nextToken = response.data?.access_token || "";
    if (!nextToken) throw new Error("Meta tidak mengembalikan Facebook user access_token baru.");
    applyUserToken(nextToken);
    return {
      accessToken: nextToken,
      expiresIn: Number(response.data?.expires_in || 0)
    };
  } catch (error) {
    throw graphError(error);
  }
}

async function getPageToken(userAccessToken) {
  try {
    const response = await axios.get(apiUrl("me/accounts"), {
      params: {
        fields: "id,name,access_token",
        access_token: userAccessToken
      },
      timeout: 30000
    });

    const pages = Array.isArray(response.data?.data) ? response.data.data : [];
    const page = pages.find((item) => String(item.id) === String(config.facebook.pageId));
    if (!page?.access_token) {
      throw new Error("FACEBOOK_USER_ACCESS_TOKEN tidak punya akses ke FACEBOOK_PAGE_ID.");
    }

    applyPageToken(page.access_token);
    return {
      accessToken: page.access_token,
      pageName: page.name || ""
    };
  } catch (error) {
    throw graphError(error);
  }
}

function daysUntil(date) {
  if (!date) return null;
  return (date.getTime() - Date.now()) / DAY_MS;
}

export async function ensureFreshFacebookToken({ refreshValid = false } = {}) {
  if (!config.facebook.enabled) {
    return { checked: false, refreshed: false, reason: "facebook_disabled" };
  }

  if (!config.facebook.pageId) {
    throw new Error("FACEBOOK_PAGE_ID wajib diisi.");
  }

  let pageValid = false;
  let pageName = "";
  let pageError = null;

  if (config.facebook.accessToken) {
    try {
      const validation = await validatePageToken();
      pageValid = validation.valid;
      pageName = validation.pageName;
    } catch (error) {
      pageError = error;
      if (!isExpiredTokenError(error)) throw error;
    }
  }

  if (
    pageValid
    && (!config.facebook.autoRefreshToken || !config.facebook.userAccessToken || !refreshValid)
  ) {
    return { checked: true, refreshed: false, pageName };
  }

  if (!config.facebook.userAccessToken) {
    if (pageValid) return { checked: true, refreshed: false, pageName };
    throw new Error(
      pageError
        ? `${pageError.message}. Isi FACEBOOK_USER_ACCESS_TOKEN agar Page token bisa auto-refresh.`
        : "FACEBOOK_PAGE_ACCESS_TOKEN / FACEBOOK_USER_ACCESS_TOKEN wajib diisi."
    );
  }

  let userToken = config.facebook.userAccessToken;
  let userTokenRefreshed = false;
  const debug = await debugToken(userToken);
  const daysLeft = daysUntil(debug?.expiresAt);

  if (
    config.facebook.autoRefreshToken
    && refreshValid
    && (
      !debug?.expiresAt
      || daysLeft <= config.meta.tokenRefreshBeforeDays
    )
  ) {
    try {
      const exchanged = await exchangeUserToken(userToken);
      userToken = exchanged.accessToken;
      userTokenRefreshed = true;
    } catch (error) {
      console.warn(`Facebook user token exchange gagal, coba pakai token yang ada: ${error.message}`);
    }
  }

  const previousPageToken = config.facebook.accessToken;
  const pageToken = await getPageToken(userToken);
  const validation = await validatePageToken(pageToken.accessToken);
  return {
    checked: true,
    refreshed: pageToken.accessToken !== previousPageToken || userTokenRefreshed,
    userTokenRefreshed,
    pageName: validation.pageName || pageToken.pageName || pageName,
    userTokenExpiresAt: debug?.expiresAt ? debug.expiresAt.toISOString() : ""
  };
}
