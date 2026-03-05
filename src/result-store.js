import fs from "node:fs/promises";
import path from "node:path";
import { defaultTmpDir } from "./config-store.js";
import { sanitizeFileToken } from "./utils.js";

export class ResultStore {
  constructor(options = {}) {
    this.tmpDir = options.tmpDir || defaultTmpDir();
    this.mode = options.mode || "auto";
    this.inlineMaxBytes = Number(options.inlineMaxBytes || 12_000);
    this.pretty = !!options.pretty;
  }

  async emit(value, opts = {}) {
    const pretty = opts.pretty ?? this.pretty;
    const serialized = JSON.stringify(value, null, pretty ? 2 : 0);
    const bytes = Buffer.byteLength(serialized);
    const mode = opts.mode || this.mode;
    const shouldStore =
      mode === "file" || (mode === "auto" && bytes > this.inlineMaxBytes);

    if (!shouldStore) {
      process.stdout.write(`${serialized}\n`);
      return { stored: false, bytes };
    }

    const file = await this.write(value, {
      label: opts.label,
      ext: opts.ext,
      pretty,
    });
    const preview = this.preview(value);

    const envelope = {
      ok: true,
      stored: true,
      file,
      bytes,
      preview,
      hint: `Use shell tools to inspect file, e.g. jq '.' ${JSON.stringify(file)} | head`,
    };

    process.stdout.write(`${JSON.stringify(envelope, null, pretty ? 2 : 0)}\n`);
    return { stored: true, file, bytes };
  }

  async write(value, opts = {}) {
    await fs.mkdir(this.tmpDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const label = sanitizeFileToken(opts.label || "result");
    const ext = opts.ext || "json";
    const name = `${ts}-${label}.${ext}`;
    const file = path.join(this.tmpDir, name);
    const payload = JSON.stringify(value, null, opts.pretty ? 2 : 0);
    await fs.writeFile(file, `${payload}\n`, "utf8");
    return file;
  }

  async list() {
    await fs.mkdir(this.tmpDir, { recursive: true });
    const entries = await fs.readdir(this.tmpDir, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      if (!entry.isFile()) {
        continue;
      }
      const fullPath = path.join(this.tmpDir, entry.name);
      const stat = await fs.stat(fullPath);
      files.push({
        name: entry.name,
        file: fullPath,
        bytes: stat.size,
        modifiedAt: stat.mtime.toISOString(),
      });
    }

    files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
    return files;
  }

  async read(filePath) {
    const full = this.resolve(filePath);
    const content = await fs.readFile(full, "utf8");
    return { file: full, content };
  }

  async remove(filePath) {
    const full = this.resolve(filePath);
    await fs.rm(full, { force: true });
    return { file: full, removed: true };
  }

  async gc(maxAgeHours = 24) {
    const now = Date.now();
    const cutoff = now - maxAgeHours * 3600 * 1000;
    const files = await this.list();
    const removed = [];

    for (const item of files) {
      if (Date.parse(item.modifiedAt) > cutoff) {
        continue;
      }
      await fs.rm(item.file, { force: true });
      removed.push(item.file);
    }

    return {
      removed,
      removedCount: removed.length,
      keptCount: files.length - removed.length,
    };
  }

  resolve(filePath) {
    if (!filePath) {
      throw new Error("file path is required");
    }

    const root = path.resolve(this.tmpDir);
    const target = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(root, filePath);
    const relative = path.relative(root, target);
    const outsideRoot = relative.startsWith("..") || path.isAbsolute(relative);

    if (outsideRoot) {
      throw new Error(`Refusing to access path outside tmp dir: ${target}`);
    }

    return target;
  }

  preview(value, opts = {}) {
    const maxDepth = Math.max(0, Number(opts.maxDepth ?? 2));
    const maxArrayItems = Math.max(1, Number(opts.maxArrayItems ?? 3));
    const maxObjectKeys = Math.max(1, Number(opts.maxObjectKeys ?? 12));
    const maxString = Math.max(16, Number(opts.maxString ?? 160));

    const walk = (input, depth) => {
      if (input === null || input === undefined) {
        return input;
      }

      if (typeof input === "string") {
        return input.length > maxString ? `${input.slice(0, maxString)}...` : input;
      }

      if (typeof input !== "object") {
        return input;
      }

      if (Array.isArray(input)) {
        if (depth >= maxDepth) {
          return { type: "array", count: input.length };
        }
        const items = input.slice(0, maxArrayItems).map((item) => walk(item, depth + 1));
        if (input.length > maxArrayItems) {
          items.push({ truncatedItems: input.length - maxArrayItems });
        }
        return items;
      }

      const keys = Object.keys(input);
      if (depth >= maxDepth) {
        return {
          type: "object",
          keyCount: keys.length,
          keys: keys.slice(0, maxObjectKeys),
        };
      }

      const out = {};
      for (const key of keys.slice(0, maxObjectKeys)) {
        out[key] = walk(input[key], depth + 1);
      }
      if (keys.length > maxObjectKeys) {
        out.truncatedKeys = keys.length - maxObjectKeys;
      }
      return out;
    };

    return walk(value, 0);
  }
}
