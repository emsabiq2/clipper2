import crypto from "node:crypto";
import { config } from "./config.js";

function partsInTimezone(date = new Date(), timeZone = config.timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function todayDate(timeZone = config.timezone) {
  const parts = partsInTimezone(new Date(), timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function createJobId(themeName = "podcast") {
  const parts = partsInTimezone();
  const theme = String(themeName || "podcast")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "")
    .slice(0, 16) || "PODCAST";
  const random = crypto.randomBytes(2).toString("hex").toUpperCase();
  return `JOB-${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}-${theme}-${random}`;
}

export function makeId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const random = crypto.randomBytes(2).toString("hex");
  return `${prefix}_${stamp}_${random}`;
}
