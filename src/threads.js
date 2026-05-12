import axios from "axios";
import { config } from "./config.js";
import { ensureFreshThreadsToken } from "./threads-token.js";

function apiUrl(apiPath) {
  return `https://graph.threads.net/${config.threads.apiVersion}/${apiPath}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function positiveIntEnv(name, fallback, max = 60) {
  const value = Number(process.env[name]);
  if (!Number.isFinite(value) || value < 1) return fallback;
  return Math.min(Math.floor(value), max);
}

function userPath() {
  return config.threads.userId || "me";
}

function assertThreadsConfig() {
  const missing = [];
  if (!config.threads.accessToken) missing.push("THREADS_ACCESS_TOKEN");
  if (missing.length) {
    throw new Error(`Missing Threads config: ${missing.join(", ")}`);
  }
}

function normalizeCaption(value) {
  return String(value || "").slice(0, 500);
}

function wrapThreadsError(error, prefix) {
  const apiError = error.response?.data?.error;
  if (!apiError) {
    const detail = error.response?.data
      ? ` - ${JSON.stringify(error.response.data).slice(0, 600)}`
      : "";
    return new Error(`${prefix}: ${error.message}${detail}`);
  }

  const wrapped = new Error(
    `${prefix}: ${apiError.message} ` +
      `[code ${apiError.code || ""}${apiError.error_subcode ? `, subcode ${apiError.error_subcode}` : ""}]`
  );
  wrapped.apiCode = apiError.code;
  wrapped.apiSubcode = apiError.error_subcode;
  wrapped.apiError = apiError;
  return wrapped;
}

async function postForm(apiPath, fields) {
  const body = new URLSearchParams({
    ...fields,
    access_token: config.threads.accessToken
  });

  try {
    const response = await axios.post(apiUrl(apiPath), body, {
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      timeout: 60000
    });
    return response.data;
  } catch (error) {
    throw wrapThreadsError(error, "Threads API error");
  }
}

async function getContainerStatus(containerId) {
  try {
    const response = await axios.get(apiUrl(containerId), {
      params: {
        fields: "id,status,error_message",
        access_token: config.threads.accessToken
      },
      timeout: 30000
    });
    return response.data || {};
  } catch (error) {
    throw wrapThreadsError(error, "Threads container status failed");
  }
}

async function waitForContainerReady(containerId) {
  const maxAttempts = positiveIntEnv("THREADS_CONTAINER_MAX_ATTEMPTS", 60, 180);
  const pollMs = positiveIntEnv("THREADS_CONTAINER_POLL_SECONDS", 6, 60) * 1000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const status = await getContainerStatus(containerId);
    const code = String(status.status || "").toUpperCase();

    console.log("THREADS CONTAINER STATUS:", {
      attempt,
      containerId,
      status: status.status,
      error_message: status.error_message
    });

    if (code === "FINISHED") return status;

    if (code === "ERROR" || code === "EXPIRED") {
      throw new Error(
        `Threads container gagal diproses. container=${containerId}, status=${code}, ` +
          `error_message=${status.error_message || "(kosong)"}`
      );
    }

    await sleep(pollMs);
  }

  const waitedMinutes = Math.round((maxAttempts * pollMs) / 60000);
  throw new Error(`Threads container belum siap setelah ${waitedMinutes} menit: ${containerId}`);
}

async function fetchPermalink(publishId) {
  try {
    const response = await axios.get(apiUrl(publishId), {
      params: {
        fields: "id,permalink",
        access_token: config.threads.accessToken
      },
      timeout: 30000
    });
    return response.data?.permalink || "";
  } catch (error) {
    console.warn(`Threads permalink lookup gagal: ${wrapThreadsError(error, "Threads permalink").message}`);
    return "";
  }
}

async function createVideoContainer({ videoUrl, caption }) {
  const created = await postForm(`${userPath()}/threads`, {
    media_type: "VIDEO",
    video_url: videoUrl,
    text: normalizeCaption(caption)
  });

  if (!created.id) {
    throw new Error(`Threads container tidak mengembalikan id: ${JSON.stringify(created)}`);
  }

  console.log("THREADS CONTAINER CREATED:", created.id);
  return created;
}

async function publishContainer(containerId) {
  const published = await postForm(`${userPath()}/threads_publish`, {
    creation_id: containerId
  });

  if (!published.id) {
    throw new Error(`Threads publish tidak mengembalikan id: ${JSON.stringify(published)}`);
  }

  console.log("THREADS PUBLISHED:", published.id);
  return published;
}

export async function publishToThreads({ videoUrl, caption }) {
  if (!videoUrl) {
    throw new Error("videoUrl kosong, Threads butuh URL video publik dari remote storage.");
  }

  await ensureFreshThreadsToken();
  assertThreadsConfig();

  console.log("THREADS API VERSION:", config.threads.apiVersion);
  console.log("THREADS VIDEO URL:", videoUrl);

  const container = await createVideoContainer({ videoUrl, caption });
  await waitForContainerReady(container.id);
  const published = await publishContainer(container.id);
  const permalink = await fetchPermalink(published.id);

  return {
    mediaId: published.id,
    containerId: container.id,
    url: permalink,
    type: "threads_video"
  };
}

export async function queryThreadsUser() {
  assertThreadsConfig();
  try {
    const response = await axios.get(apiUrl(userPath()), {
      params: {
        fields: "id,username,threads_profile_picture_url",
        access_token: config.threads.accessToken
      },
      timeout: 30000
    });
    return response.data || {};
  } catch (error) {
    throw wrapThreadsError(error, "Threads user query failed");
  }
}
