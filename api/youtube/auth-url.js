import { methodAllowed, requireAuth, sendJson } from "../_utils.js";
import { buildYoutubeAuthUrl, requestOrigin } from "../../src/youtube-oauth.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["GET", "POST"])) return;
  if (!requireAuth(req, res)) return;

  try {
    const auth = buildYoutubeAuthUrl({ origin: requestOrigin(req.headers) });
    sendJson(res, 200, {
      url: auth.url,
      redirectUri: auth.redirectUri,
      scope: auth.scope
    });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}
