import {
  exchangeYoutubeCode,
  persistYoutubeReconnect,
  renderYoutubeCallbackPage,
  requestOrigin,
  verifyYoutubeOAuthState
} from "../../src/youtube-oauth.js";

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, requestOrigin(req.headers) || "https://dashboard.local");
    if (url.searchParams.get("error")) {
      throw new Error(url.searchParams.get("error_description") || url.searchParams.get("error"));
    }

    const state = verifyYoutubeOAuthState(url.searchParams.get("state") || "");
    const token = await exchangeYoutubeCode({
      code: url.searchParams.get("code") || "",
      redirectUri: state.redirectUri
    });
    if (!token.refreshToken) {
      throw new Error("Google tidak mengembalikan refresh_token. Ulangi Reconnect YouTube dan pastikan prompt consent muncul.");
    }

    const persist = await persistYoutubeReconnect({
      refreshToken: token.refreshToken,
      persistLocal: false,
      persistGithub: true
    });
    sendHtml(res, 200, renderYoutubeCallbackPage({ ok: true, token, persist }));
  } catch (error) {
    sendHtml(res, 400, renderYoutubeCallbackPage({
      ok: false,
      error: error.message,
      persist: {}
    }));
  }
}

function sendHtml(res, status, html) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.end(html);
}
