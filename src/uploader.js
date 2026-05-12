import fs from "node:fs/promises";
import path from "node:path";
import { Client as FtpClient } from "basic-ftp";
import SftpClient from "ssh2-sftp-client";
import {
  config,
  publicMetadataUrl,
  publicThumbnailUrl,
  publicVideoUrl,
  shouldUploadToRemote
} from "./config.js";

function remoteLabel() {
  return config.ftp.label || "Remote";
}

function requireRemoteConfig() {
  const prefix = config.ftp.envPrefix || "FTP";
  const missing = [];
  if (!config.ftp.host) missing.push(`${prefix}_HOST`);
  if (!config.ftp.user) missing.push(`${prefix}_USER`);
  if (!config.ftp.password && !config.ftp.privateKey) missing.push(`${prefix}_PASSWORD`);
  if (!config.ftp.remoteDir) missing.push(`${prefix}_REMOTE_DIR`);
  if (missing.length) throw new Error(`${remoteLabel()} config belum lengkap: ${missing.join(", ")}`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetriableRemoteError(error) {
  const code = String(error?.code || "");
  const message = String(error?.message || error || "");
  const text = `${code} ${message}`;
  if (/\b(530|550|553)\b|auth|authentication|permission denied|login incorrect/i.test(text)) return false;
  return /timeout|timed out|closed|socket|econn|etimedout|econnreset|econnrefused|epipe|no control connection|connection lost|421|425|426|450|451/i.test(text);
}

function retryDelayMs(attempt) {
  return Math.min(45000, 5000 * attempt);
}

async function localFileSize(filePath) {
  const stat = await fs.stat(filePath);
  return stat.size;
}

async function remoteSize(client, remoteName) {
  try {
    return await client.size(remoteName);
  } catch {
    return -1;
  }
}

async function remoteFileMatches(fullRemotePath, expectedSize) {
  try {
    return await withRemoteClient(async (client) => {
      return await remoteSize(client, fullRemotePath) === expectedSize;
    }, { timeoutMs: config.ftp.stateTimeoutMs, retries: 1 });
  } catch {
    return false;
  }
}

async function uploadFromVerified(client, localPath, remoteName, remoteDir) {
  const expectedSize = await localFileSize(localPath);
  const fullRemotePath = path.posix.join(remoteDir, remoteName);

  if (await remoteSize(client, remoteName) === expectedSize) {
    console.log(`${remoteLabel()} skip, remote sudah lengkap: ${fullRemotePath}`);
    return;
  }

  try {
    await client.uploadFrom(localPath, remoteName);
  } catch (error) {
    if (isRetriableRemoteError(error) && await remoteFileMatches(fullRemotePath, expectedSize)) {
      console.warn(`${remoteLabel()} upload timeout, tapi file remote lengkap. Lanjut: ${fullRemotePath}`);
      return;
    }
    throw error;
  }
}

class SftpRemoteClient {
  constructor(client) {
    this.client = client;
    this.cwd = "/";
  }

  resolve(remotePath = ".") {
    const target = String(remotePath || ".");
    if (target === ".") return this.cwd;
    return path.posix.isAbsolute(target) ? target : path.posix.join(this.cwd, target);
  }

  async ensureDir(remoteDir) {
    const dir = this.resolve(remoteDir);
    await this.client.mkdir(dir, true);
    this.cwd = dir;
  }

  async cd(remoteDir) {
    const dir = this.resolve(remoteDir);
    const stat = await this.client.stat(dir);
    if (stat.type && stat.type !== "d") throw new Error(`${dir} bukan direktori`);
    if (stat.isDirectory === false) throw new Error(`${dir} bukan direktori`);
    this.cwd = dir;
  }

  async list(remoteDir = ".") {
    const items = await this.client.list(this.resolve(remoteDir));
    return items.map((item) => ({
      name: item.name,
      isFile: item.type === "-" || item.type === "f" || item.isFile === true,
      size: item.size || 0,
      modifiedAt: item.modifyTime ? new Date(item.modifyTime) : null
    }));
  }

  async uploadFrom(source, remoteName) {
    await this.client.put(source, this.resolve(remoteName));
  }

  async downloadTo(localPath, remoteName) {
    await this.client.fastGet(this.resolve(remoteName), localPath);
  }

  async size(remoteName) {
    const stat = await this.client.stat(this.resolve(remoteName));
    return stat.size || 0;
  }

  async remove(remoteName) {
    await this.client.delete(this.resolve(remoteName));
  }

  async close() {
    await this.client.end();
  }
}

async function connectRemoteClient(timeoutMs) {
  if (config.uploadDriver === "sftp") {
    const client = new SftpClient();
    const readyTimeout = Math.max(Number(timeoutMs || config.ftp.timeoutMs || 0), 5000);
    await client.connect({
      host: config.ftp.host,
      port: config.ftp.port,
      username: config.ftp.user,
      password: config.ftp.password || undefined,
      privateKey: config.ftp.privateKey || undefined,
      passphrase: config.ftp.passphrase || undefined,
      readyTimeout,
      keepaliveInterval: 10000,
      keepaliveCountMax: 12
    });
    return new SftpRemoteClient(client);
  }

  const client = new FtpClient(timeoutMs || config.ftp.timeoutMs);
  await client.access({
    host: config.ftp.host,
    port: config.ftp.port,
    user: config.ftp.user,
    password: config.ftp.password,
    secure: false
  });
  return client;
}

async function closeRemoteClient(client) {
  if (!client) return;
  if (typeof client.close === "function") {
    try {
      await client.close();
    } catch {
      // Ignore close errors so the original remote error remains visible.
    }
  }
}

export async function withRemoteClient(callback, options = {}) {
  requireRemoteConfig();
  const maxAttempts = Math.max(1, Number(options.retries || config.ftp.retries || 3));
  let lastError;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let client = null;
    try {
      client = await connectRemoteClient(options.timeoutMs || config.ftp.timeoutMs);
      return await callback(client, attempt);
    } catch (error) {
      lastError = error;
      const canRetry = attempt < maxAttempts && isRetriableRemoteError(error);
      if (!canRetry) throw error;
      console.warn(`${remoteLabel()} gagal attempt ${attempt}/${maxAttempts}, reconnect lalu retry: ${error.message || error}`);
      await sleep(retryDelayMs(attempt));
    } finally {
      await closeRemoteClient(client);
    }
  }

  throw lastError;
}

export async function withFtpClient(callback, options = {}) {
  return withRemoteClient(callback, options);
}

export async function uploadJobFiles({ job, videoPath, thumbnailPath, metadataPath }) {
  const videoName = `${job.job_id}.mp4`;
  const thumbnailName = `${job.job_id}-thumbnail.jpg`;
  const metadataName = `${job.job_id}.json`;

  if (!shouldUploadToRemote()) {
    return {
      videoUrl: "",
      thumbnailUrl: "",
      metadataUrl: "",
      videoName,
      thumbnailName,
      metadataName
    };
  }

  await withRemoteClient(async (client) => {
    const videosDir = path.posix.join(config.ftp.remoteDir, "videos");
    const thumbnailsDir = path.posix.join(config.ftp.remoteDir, "thumbnails");
    const metadataDir = path.posix.join(config.ftp.remoteDir, "metadata");

    await client.ensureDir(videosDir);
    await uploadFromVerified(client, videoPath, videoName, videosDir);

    await client.ensureDir(thumbnailsDir);
    await uploadFromVerified(client, thumbnailPath, thumbnailName, thumbnailsDir);

    await client.ensureDir(metadataDir);
    await uploadFromVerified(client, metadataPath, metadataName, metadataDir);
  }, { timeoutMs: config.ftp.uploadTimeoutMs, retries: config.ftp.retries });

  return {
    videoUrl: publicVideoUrl(videoName),
    thumbnailUrl: publicThumbnailUrl(thumbnailName),
    metadataUrl: publicMetadataUrl(metadataName),
    videoName,
    thumbnailName,
    metadataName
  };
}

export async function uploadVideoFile({ videoPath, videoName }) {
  if (!shouldUploadToRemote()) return "";

  await withRemoteClient(async (client) => {
    const videosDir = path.posix.join(config.ftp.remoteDir, "videos");
    await client.ensureDir(videosDir);
    await uploadFromVerified(client, videoPath, videoName, videosDir);
  }, { timeoutMs: config.ftp.uploadTimeoutMs, retries: config.ftp.retries });

  return publicVideoUrl(videoName);
}

export async function uploadHistoryFile(historyFile) {
  if (!shouldUploadToRemote()) return "";
  await withRemoteClient(async (client) => {
    await client.ensureDir(path.posix.join(config.ftp.remoteDir, "history"));
    await client.uploadFrom(historyFile, path.basename(historyFile));
  }, { timeoutMs: config.ftp.stateTimeoutMs });
  return `${config.publicBaseUrl}/history/${encodeURIComponent(path.basename(historyFile))}`;
}

export async function validatePublicUrl(url) {
  if (!url) return false;

  for (let attempt = 1; attempt <= config.ftp.publicUrlRetries; attempt += 1) {
    try {
      const cacheBustUrl = `${url}${url.includes("?") ? "&" : "?"}v=${Date.now()}`;
      let response = await fetch(cacheBustUrl, { method: "HEAD", cache: "no-store" });
      if (response.ok) return true;
      response = await fetch(cacheBustUrl, {
        method: "GET",
        cache: "no-store",
        headers: { Range: "bytes=0-1000" }
      });
      if (response.ok || response.status === 206) return true;
    } catch {
      // Public hosting can lag a few seconds after remote upload.
    }
    if (attempt < config.ftp.publicUrlRetries) await sleep(config.ftp.publicUrlRetryDelayMs);
  }

  return false;
}

export async function fileExists(filePath) {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}
