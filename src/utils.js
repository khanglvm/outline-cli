import fs from "node:fs/promises";

export async function parseJsonArg({ json, file, name }) {
  if (json && file) {
    throw new Error(`Provide either --${name} or --${name}-file, not both`);
  }

  let raw;
  if (file) {
    raw = await fs.readFile(file, "utf8");
  } else if (json) {
    raw = json;
  } else {
    return undefined;
  }

  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Invalid JSON for ${name}: ${err.message}`);
  }
}

export function compactValue(value) {
  if (Array.isArray(value)) {
    return value
      .map((item) => compactValue(item))
      .filter((item) => item !== undefined);
  }

  if (value && typeof value === "object") {
    const result = {};
    for (const [key, child] of Object.entries(value)) {
      const compacted = compactValue(child);
      if (compacted === undefined) {
        continue;
      }
      if (Array.isArray(compacted) && compacted.length === 0) {
        continue;
      }
      if (
        compacted &&
        typeof compacted === "object" &&
        !Array.isArray(compacted) &&
        Object.keys(compacted).length === 0
      ) {
        continue;
      }
      result[key] = compacted;
    }
    if (Object.keys(result).length === 0) {
      return undefined;
    }
    return result;
  }

  if (value === null || value === undefined) {
    return undefined;
  }
  return value;
}

export function parseCsv(input) {
  if (!input) {
    return [];
  }
  return input
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function pickPath(obj, path) {
  if (!path) {
    return undefined;
  }
  const chunks = path.split(".").filter(Boolean);
  let cur = obj;
  for (const chunk of chunks) {
    if (cur == null || typeof cur !== "object") {
      return undefined;
    }
    cur = cur[chunk];
  }
  return cur;
}

export function projectObject(obj, fields) {
  if (!fields || fields.length === 0) {
    return obj;
  }
  const result = {};
  for (const field of fields) {
    const value = pickPath(obj, field);
    if (value !== undefined) {
      result[field] = value;
    }
  }
  return result;
}

export function ensureStringArray(value, label) {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((item) => String(item));
  }

  if (typeof value === "string") {
    return [value];
  }

  throw new Error(`${label} must be a string or string[]`);
}

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function sanitizeFileToken(input) {
  return String(input || "result").replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function toInteger(value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid number: ${value}`);
  }
  return Math.trunc(parsed);
}

export function toBoolean(value, fallback = undefined) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  if (typeof value === "boolean") {
    return value;
  }
  const normalized = String(value).toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  throw new Error(`Invalid boolean value: ${value}`);
}

export async function mapLimit(items, limit, fn) {
  if (!Array.isArray(items) || items.length === 0) {
    return [];
  }
  const concurrency = Math.max(1, Math.min(limit || 1, items.length));
  const out = new Array(items.length);
  let idx = 0;

  async function worker() {
    while (idx < items.length) {
      const current = idx;
      idx += 1;
      out[current] = await fn(items[current], current);
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return out;
}
