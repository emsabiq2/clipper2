import { config } from "./config.js";
import { getYoutubeAccessToken } from "./youtube-publisher.js";

if (!config.youtube.enabled) {
  console.log("YOUTUBE_UPLOAD_ENABLED=false. Aktifkan dulu jika ingin cek token YouTube.");
  process.exit(0);
}

getYoutubeAccessToken()
  .then((accessToken) => {
    console.log(JSON.stringify({
      ok: true,
      token: accessToken ? "refresh_token_valid" : "empty"
    }, null, 2));
  })
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
