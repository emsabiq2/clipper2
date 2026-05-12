import { ensureFreshInstagramToken } from "./instagram-token.js";

try {
  const result = await ensureFreshInstagramToken();
  console.log(JSON.stringify({ ok: true, ...result }, null, 2));
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    error: error.message,
    apiCode: error.apiCode || "",
    apiSubcode: error.apiSubcode || ""
  }, null, 2));
  process.exitCode = 1;
}
