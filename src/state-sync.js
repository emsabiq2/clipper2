import fs from "node:fs/promises";
import path from "node:path";
import { config, shouldUploadToRemote } from "./config.js";
import { ensureProjectDirs } from "./storage.js";
import { withRemoteClient } from "./uploader.js";

const stateFiles = [
  "themes.json",
  "videos.json",
  "prompts.json",
  "jobs.json",
  "history.json",
  "discovery-cache.json"
];

function remoteStateDir() {
  return path.posix.join(config.ftp.remoteDir, "state");
}

export async function downloadStateFromRemote() {
  if (!shouldUploadToRemote()) return { skipped: true };
  await ensureProjectDirs();
  const downloaded = [];

  await withRemoteClient(async (client) => {
    await client.ensureDir(remoteStateDir());
    const items = await client.list();
    const names = new Set(items.filter((item) => item.isFile).map((item) => item.name));
    for (const file of stateFiles) {
      if (!names.has(file)) continue;
      await client.downloadTo(path.join(config.dataDir, file), file);
      downloaded.push(file);
    }
  }, { timeoutMs: config.ftp.stateTimeoutMs });

  return { skipped: false, downloaded };
}

export async function uploadStateToRemote() {
  if (!shouldUploadToRemote()) return { skipped: true };
  await ensureProjectDirs();
  const uploaded = [];

  await withRemoteClient(async (client) => {
    await client.ensureDir(remoteStateDir());
    for (const file of stateFiles) {
      const localPath = path.join(config.dataDir, file);
      try {
        await fs.access(localPath);
        await client.uploadFrom(localPath, file);
        uploaded.push(file);
      } catch {
        // Missing state file is allowed during first setup.
      }
    }
  }, { timeoutMs: config.ftp.stateTimeoutMs });

  return { skipped: false, uploaded };
}
