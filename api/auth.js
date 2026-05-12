import {
  clean,
  clearPinCookie,
  methodAllowed,
  readBody,
  sendJson,
  setPinCookie
} from "./_utils.js";

export default async function handler(req, res) {
  if (!methodAllowed(req, res, ["POST", "DELETE"])) return;

  if (req.method === "DELETE") {
    clearPinCookie(res);
    sendJson(res, 200, { ok: true });
    return;
  }

  const expected = clean(process.env.AUTO_DASHBOARD_PIN);
  if (!expected) {
    sendJson(res, 403, { error: "AUTO_DASHBOARD_PIN belum diset di Vercel Environment." });
    return;
  }

  const body = await readBody(req);
  const pin = clean(body.pin);
  if (pin !== expected) {
    sendJson(res, 401, { error: "PIN dashboard salah." });
    return;
  }

  setPinCookie(res, pin);
  sendJson(res, 200, { ok: true });
}
