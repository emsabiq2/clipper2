import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";

const dataFiles = {
  themes: "themes.json",
  videos: "videos.json",
  prompts: "prompts.json",
  jobs: "jobs.json",
  history: "history.json"
};

export async function ensureProjectDirs() {
  await fs.mkdir(config.dataDir, { recursive: true });
  await fs.mkdir(config.generatedDir, { recursive: true });
  await fs.mkdir(config.generatedVideoDir, { recursive: true });
  await fs.mkdir(config.thumbnailDir, { recursive: true });
  await fs.mkdir(config.metadataDir, { recursive: true });
  await fs.mkdir(config.logDir, { recursive: true });
  for (const filename of Object.values(dataFiles)) {
    const target = path.join(config.dataDir, filename);
    try {
      await fs.access(target);
    } catch {
      await fs.writeFile(target, "[]\n", "utf8");
    }
  }
}

function dataPath(name) {
  const filename = dataFiles[name] || name;
  return path.join(config.dataDir, filename);
}

export async function readJson(name, fallback = []) {
  try {
    const raw = await fs.readFile(dataPath(name), "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(name, data) {
  await ensureProjectDirs();
  const target = dataPath(name);
  const temp = `${target}.tmp`;
  await fs.writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  await fs.rename(temp, target);
}

export async function upsertItem(name, item, key = "id") {
  const list = await readJson(name, []);
  const index = list.findIndex((entry) => entry?.[key] === item?.[key]);
  if (index === -1) list.push(item);
  else list[index] = { ...list[index], ...item };
  await writeJson(name, list);
  return item;
}

export async function patchItem(name, id, patch) {
  const list = await readJson(name, []);
  const index = list.findIndex((entry) => entry.id === id || entry.job_id === id);
  if (index === -1) return null;
  list[index] = { ...list[index], ...patch, updated_at: new Date().toISOString() };
  await writeJson(name, list);
  return list[index];
}

export async function saveGeneratedJson(folder, filename, data) {
  const dir = path.join(config.generatedDir, folder);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, filename);
  await fs.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  return filePath;
}
