import fs from "node:fs/promises";
import path from "node:path";

import { assertPerformAction } from "./action-gate.js";
import { defaultTmpDir } from "./config-store.js";
import { ApiError, CliError } from "./errors.js";
import { compactValue, ensureStringArray, mapLimit, toInteger } from "./utils.js";

const STORE_VERSION = 1;
const DEFAULT_MAX_ENTRIES_PER_PROFILE = 1000;
const MAX_SOURCE_TOOLS = 8;
const OBSERVED_TOOL_PREFIXES = [
  "documents.",
  "collections.",
  "users.",
  "groups.",
  "templates.",
  "search.",
  "federated.",
];

function defaultMemoryFile() {
  if (process.env.OUTLINE_CLI_MEMORY_FILE) {
    return path.resolve(process.env.OUTLINE_CLI_MEMORY_FILE);
  }
  if (process.env.OUTLINE_AGENT_MEMORY_FILE) {
    return path.resolve(process.env.OUTLINE_AGENT_MEMORY_FILE);
  }
  return path.join(path.dirname(defaultTmpDir()), "memory", "observations.json");
}

function blankStore() {
  return {
    version: STORE_VERSION,
    profiles: {},
  };
}

async function loadStore(file = defaultMemoryFile()) {
  try {
    const raw = await fs.readFile(file, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      return blankStore();
    }
    if (!parsed.profiles || typeof parsed.profiles !== "object") {
      parsed.profiles = {};
    }
    if (!parsed.version) {
      parsed.version = STORE_VERSION;
    }
    return parsed;
  } catch (err) {
    if (err?.code === "ENOENT") {
      return blankStore();
    }
    throw new Error(`Failed to read memory store ${file}: ${err.message}`);
  }
}

async function saveStore(store, file = defaultMemoryFile()) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
}

function profileBucket(store, profileId) {
  if (!store.profiles[profileId] || typeof store.profiles[profileId] !== "object") {
    store.profiles[profileId] = {
      entries: {},
      updatedAt: null,
    };
  }
  if (!store.profiles[profileId].entries || typeof store.profiles[profileId].entries !== "object") {
    store.profiles[profileId].entries = {};
  }
  return store.profiles[profileId];
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[\W_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value) {
  return normalizeText(value).split(" ").filter((token) => token.length >= 2);
}

function addReferenceAliases(set, value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return;
  }

  try {
    const parsed = new URL(raw, raw.startsWith("/") ? "https://outline.local" : undefined);
    const segments = parsed.pathname.split("/").filter(Boolean);
    const lowerSegments = segments.map((segment) => segment.toLowerCase());
    const docIndex = lowerSegments.indexOf("doc");
    const collectionIndex = lowerSegments.indexOf("collection");
    const shareIndex = lowerSegments.indexOf("share");
    const docSegment = docIndex >= 0 && segments[docIndex + 1] ? segments[docIndex + 1] : "";
    const collectionSegment = collectionIndex >= 0 && segments[collectionIndex + 1] ? segments[collectionIndex + 1] : "";
    const shareSegment = shareIndex >= 0 && segments[shareIndex + 1] ? segments[shareIndex + 1] : "";
    const hashUrlId = String(parsed.hash || "").match(/(?:^#|[#/])d-([A-Za-z0-9_-]{6,})/i)?.[1] || "";
    const urlSegment = docSegment || collectionSegment;
    const docSuffix = String(urlSegment || "").match(/-([A-Za-z0-9]{6,})$/)?.[1] || "";

    for (const candidate of [docSegment, collectionSegment, shareSegment, hashUrlId, docSuffix]) {
      if (candidate) {
        set.add(candidate);
      }
    }
    if (urlSegment) {
      const titleAlias = urlSegment
        .replace(docSuffix ? new RegExp(`-${docSuffix}$`) : /$/, "")
        .replace(/[-_]+/g, " ")
        .trim();
      if (titleAlias) {
        set.add(titleAlias);
      }
    }
  } catch {
    // Non-URL references are handled by the caller's raw/normalized aliases.
  }
}

function addAlias(set, value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return;
  }
  set.add(raw);
  addReferenceAliases(set, raw);
  const normalized = normalizeText(raw);
  if (normalized && normalized !== raw) {
    set.add(normalized);
  }
}

function aliasesForQuery(value) {
  const aliases = new Set();
  addAlias(aliases, value);
  return [...aliases].map((item) => String(item || "").trim()).filter(Boolean);
}

function fallbackQueryForReference(value) {
  const aliases = aliasesForQuery(value);
  const candidates = aliases.filter((item) =>
    normalizeText(item) && !/^https?:\/\//i.test(item) && !item.startsWith("/")
  );
  return candidates.find((item) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(item))
    || candidates.find((item) => /\s/.test(item))
    || candidates[0]
    || String(value || "");
}

function normalizeQueryArgs(args = {}, output = {}) {
  const bucket = [];
  if (args.query) {
    bucket.push(String(args.query));
  }
  if (args.question) {
    bucket.push(String(args.question));
  }
  if (args.queries) {
    bucket.push(...ensureStringArray(args.queries, "queries"));
  }
  if (args.questions) {
    for (const question of args.questions) {
      if (typeof question === "string") {
        bucket.push(question);
      } else if (question?.question || question?.query) {
        bucket.push(String(question.question || question.query));
      }
    }
  }
  if (output.query) {
    bucket.push(String(output.query));
  }
  if (Array.isArray(output.result?.queries)) {
    bucket.push(...output.result.queries.map((item) => String(item)));
  }
  return [...new Set(bucket.map((item) => item.trim()).filter(Boolean))];
}

function normalizeDocumentEntity(row, meta) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const source = row.document && typeof row.document === "object" ? row.document : row;
  if (!source.id || !source.title) {
    return null;
  }

  const aliases = new Set();
  addAlias(aliases, source.id);
  addAlias(aliases, source.title);
  addAlias(aliases, source.urlId);
  addAlias(aliases, source.url);

  return compactValue({
    type: "document",
    id: String(source.id),
    title: source.title,
    collectionId: source.collectionId,
    parentDocumentId: source.parentDocumentId,
    revision: source.revision,
    updatedAt: source.updatedAt,
    publishedAt: source.publishedAt,
    urlId: source.urlId,
    url: source.url,
    aliases: [...aliases],
    score: row.score,
    ranking: row.ranking,
    queries: Array.isArray(row.queries) ? row.queries.map((item) => String(item)) : meta.queries,
  });
}

function normalizeCollectionEntity(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  if (!row.id || !row.name) {
    return null;
  }

  const aliases = new Set();
  addAlias(aliases, row.id);
  addAlias(aliases, row.name);
  addAlias(aliases, row.urlId);
  addAlias(aliases, row.url);

  return compactValue({
    type: "collection",
    id: String(row.id),
    name: row.name,
    description: row.description,
    permission: row.permission,
    sharing: row.sharing,
    updatedAt: row.updatedAt,
    color: row.color,
    icon: row.icon,
    urlId: row.urlId,
    url: row.url,
    aliases: [...aliases],
  });
}

function normalizeUserEntity(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const source = row.user && typeof row.user === "object" ? row.user : row;
  if (!source.id || (!source.name && !source.email)) {
    return null;
  }

  const aliases = new Set();
  addAlias(aliases, source.id);
  addAlias(aliases, source.name);
  addAlias(aliases, source.email);

  return compactValue({
    type: "user",
    id: String(source.id),
    name: source.name,
    email: source.email,
    avatarUrl: source.avatarUrl,
    role: source.role,
    isAdmin: source.isAdmin,
    isSuspended: source.isSuspended,
    lastActiveAt: source.lastActiveAt,
    updatedAt: source.updatedAt,
    aliases: [...aliases],
  });
}

function normalizeGroupEntity(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const source = row.group && typeof row.group === "object" ? row.group : row;
  if (!source.id || !source.name) {
    return null;
  }

  const aliases = new Set();
  addAlias(aliases, source.id);
  addAlias(aliases, source.name);

  return compactValue({
    type: "group",
    id: String(source.id),
    name: source.name,
    memberCount: source.memberCount,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    aliases: [...aliases],
  });
}

function normalizeTemplateEntity(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) {
    return null;
  }
  const source = row.template && typeof row.template === "object" ? row.template : row;
  if (!source.id || !source.title) {
    return null;
  }

  const aliases = new Set();
  addAlias(aliases, source.id);
  addAlias(aliases, source.title);
  addAlias(aliases, source.name);

  return compactValue({
    type: "template",
    id: String(source.id),
    title: source.title,
    name: source.name,
    collectionId: source.collectionId,
    createdAt: source.createdAt,
    updatedAt: source.updatedAt,
    aliases: [...aliases],
  });
}

function collectEntities(value, meta, out = [], depth = 0) {
  if (depth > 7 || value === null || value === undefined) {
    return out;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      collectEntities(item, meta, out, depth + 1);
    }
    return out;
  }
  if (typeof value !== "object") {
    return out;
  }

  if (meta.kind === "document") {
    const doc = normalizeDocumentEntity(value, meta);
    if (doc) {
      out.push(doc);
    }
  }
  if (meta.kind === "collection") {
    const collection = normalizeCollectionEntity(value);
    if (collection) {
      out.push(collection);
    }
  }
  if (meta.kind === "user") {
    const user = normalizeUserEntity(value);
    if (user) {
      out.push(user);
    }
  }
  if (meta.kind === "group") {
    const group = normalizeGroupEntity(value);
    if (group) {
      out.push(group);
    }
  }
  if (meta.kind === "template") {
    const template = normalizeTemplateEntity(value);
    if (template) {
      out.push(template);
    }
  }

  for (const key of ["data", "items", "merged", "expanded", "candidates", "documents", "nodes", "perQuery", "result"]) {
    if (Object.prototype.hasOwnProperty.call(value, key)) {
      collectEntities(value[key], meta, out, depth + 1);
    }
  }
  if (value.document && typeof value.document === "object") {
    collectEntities(value.document, { ...meta, kind: "document" }, out, depth + 1);
  }
  if (value.user && typeof value.user === "object") {
    collectEntities(value.user, { ...meta, kind: "user" }, out, depth + 1);
  }
  if (value.group && typeof value.group === "object") {
    collectEntities(value.group, { ...meta, kind: "group" }, out, depth + 1);
  }
  if (value.template && typeof value.template === "object") {
    collectEntities(value.template, { ...meta, kind: "template" }, out, depth + 1);
  }
  return out;
}

function observationKind(toolName, output) {
  const method = output?.method || "";
  if (String(toolName).startsWith("templates.") || String(method).startsWith("templates.")) {
    return "template";
  }
  if (String(toolName).startsWith("users.") || String(method).startsWith("users.")) {
    return "user";
  }
  if (String(toolName).startsWith("groups.") || String(method).startsWith("groups.")) {
    return "group";
  }
  if (String(toolName).startsWith("collections.") || String(method).startsWith("collections.")) {
    return "collection";
  }
  if (
    String(toolName).startsWith("documents.") ||
    String(toolName).startsWith("search.") ||
    String(toolName).startsWith("federated.") ||
    String(method).startsWith("documents.")
  ) {
    return "document";
  }
  return null;
}

function observationName(toolName, output = {}) {
  return String(output?.method || toolName || "");
}

function isAuthoritativeObservation(toolName, output = {}) {
  const name = observationName(toolName, output);
  return /(^|\.)(info|create|update|safe_update|restore|apply_patch|apply_patch_safe|create_from_template)$/.test(name);
}

function isDeleteObservation(toolName, output = {}) {
  const name = observationName(toolName, output);
  return /(^|\.)(delete|permanent_delete|empty_trash)$/.test(name);
}

function shouldObserve(ctx, toolName) {
  if (ctx?.memory?.enabled !== true) {
    return false;
  }
  if (!ctx?.profile?.id) {
    return false;
  }
  if (String(toolName || "").startsWith("memory.")) {
    return false;
  }
  return OBSERVED_TOOL_PREFIXES.some((prefix) => String(toolName || "").startsWith(prefix)) || toolName === "api.call";
}

function mergeEntry(existing = {}, next, meta) {
  const now = meta.observedAt;
  const aliases = new Set([...(existing.aliases || []), ...(next.aliases || [])]);
  const queries = new Set([...(existing.queries || []), ...(next.queries || []), ...meta.queries]);
  const sourceTools = [
    {
      tool: meta.tool,
      observedAt: now,
      ...(meta.method ? { method: meta.method } : {}),
    },
    ...(existing.sourceTools || []),
  ];

  return compactValue({
    ...existing,
    ...next,
    aliases: [...aliases].slice(0, 40),
    queries: [...queries].slice(0, 40),
    sourceTools: sourceTools
      .filter((item, index, arr) => arr.findIndex((candidate) => candidate.tool === item.tool && candidate.method === item.method) === index)
      .slice(0, MAX_SOURCE_TOOLS),
    firstObservedAt: existing.firstObservedAt || now,
    lastObservedAt: now,
    observedCount: Number(existing.observedCount || 0) + 1,
    deletedAt: existing.deletedAt && !meta.authoritative ? existing.deletedAt : undefined,
    deletedBy: existing.deletedAt && !meta.authoritative ? existing.deletedBy : undefined,
  });
}

function pruneProfile(bucket, maxEntries = DEFAULT_MAX_ENTRIES_PER_PROFILE) {
  const entries = Object.entries(bucket.entries || {});
  if (entries.length <= maxEntries) {
    return;
  }
  entries.sort((a, b) => String(b[1].lastObservedAt || "").localeCompare(String(a[1].lastObservedAt || "")));
  bucket.entries = Object.fromEntries(entries.slice(0, maxEntries));
}

function operationSucceeded(output = {}) {
  const result = output.result && typeof output.result === "object" ? output.result : {};
  if (result.success === false || result.ok === false) {
    return false;
  }
  if (output.result?.deleted === false) {
    return false;
  }
  return true;
}

function deletedObservationIds(args = {}, output = {}) {
  const ids = [];
  if (args.id) {
    ids.push(String(args.id));
  }
  if (args.ids) {
    ids.push(...ensureStringArray(args.ids, "ids"));
  }
  if (args.body?.id) {
    ids.push(String(args.body.id));
  }
  if (args.body?.ids) {
    ids.push(...ensureStringArray(args.body.ids, "body.ids"));
  }
  if (output.result?.id) {
    ids.push(String(output.result.id));
  }
  if (output.result?.documentId) {
    ids.push(String(output.result.documentId));
  }
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

function markDeletedEntries(bucket, ids, meta) {
  const now = meta.observedAt;
  let count = 0;
  for (const id of ids) {
    const key = `${meta.kind}:${id}`;
    const existing = bucket.entries[key] || {
      type: meta.kind,
      id,
      aliases: [id],
      firstObservedAt: now,
      observedCount: 0,
    };
    bucket.entries[key] = compactValue({
      ...existing,
      type: meta.kind,
      id,
      aliases: existing.aliases || [id],
      deletedAt: now,
      deletedBy: meta.tool,
      lastObservedAt: now,
      observedCount: Number(existing.observedCount || 0) + 1,
      sourceTools: [
        {
          tool: meta.tool,
          observedAt: now,
          ...(meta.method ? { method: meta.method } : {}),
        },
        ...(existing.sourceTools || []),
      ].slice(0, MAX_SOURCE_TOOLS),
    }) || {};
    count += 1;
  }
  return count;
}

function isStaleHydrationStatus(status) {
  return [403, 404, 410].includes(Number(status));
}

async function tombstoneHydrationMiss(ctx, candidate, endpoint, status) {
  if (!ctx?.profile?.id || !candidate?.id || !isStaleHydrationStatus(status)) {
    return { tombstoned: false };
  }

  const file = ctx.memory?.file || defaultMemoryFile();
  const store = await loadStore(file);
  const bucket = profileBucket(store, ctx.profile.id);
  const meta = {
    kind: ["collection", "user", "group", "template"].includes(candidate.type) ? candidate.type : "document",
    tool: "memory.resolve",
    method: endpoint,
    observedAt: new Date().toISOString(),
  };
  const count = markDeletedEntries(bucket, [candidate.id], meta);
  if (count > 0) {
    bucket.updatedAt = meta.observedAt;
    await saveStore(store, file);
  }
  return { tombstoned: count > 0, file, updatedAt: bucket.updatedAt };
}

export async function recordToolObservation(ctx, toolName, args = {}, output = {}) {
  if (!shouldObserve(ctx, toolName)) {
    return { observed: false, count: 0 };
  }
  const kind = observationKind(toolName, output);
  if (!kind) {
    return { observed: false, count: 0 };
  }

  const meta = {
    kind,
    tool: toolName,
    method: output?.method,
    queries: normalizeQueryArgs(args, output),
    observedAt: new Date().toISOString(),
    authoritative: isAuthoritativeObservation(toolName, output),
  };

  const file = ctx.memory?.file || defaultMemoryFile();
  const store = await loadStore(file);
  const bucket = profileBucket(store, ctx.profile.id);

  if (isDeleteObservation(toolName, output) && operationSucceeded(output)) {
    const deletedIds = deletedObservationIds(args, output);
    const count = markDeletedEntries(bucket, deletedIds, meta);
    if (count > 0) {
      bucket.updatedAt = meta.observedAt;
      await saveStore(store, file);
      return { observed: true, count, tombstoned: true };
    }
  }

  const entities = collectEntities(output, meta);
  if (entities.length === 0) {
    return { observed: false, count: 0 };
  }
  const seenKeys = new Set();

  for (const entity of entities) {
    const key = `${entity.type}:${entity.id}`;
    if (seenKeys.has(key)) {
      continue;
    }
    seenKeys.add(key);
    bucket.entries[key] = mergeEntry(bucket.entries[key], entity, meta);
  }

  bucket.updatedAt = meta.observedAt;
  pruneProfile(bucket, toInteger(ctx.memory?.maxEntriesPerProfile, DEFAULT_MAX_ENTRIES_PER_PROFILE));
  await saveStore(store, file);
  return { observed: true, count: seenKeys.size };
}

function scoreEntry(entry, query) {
  const rawQuery = String(query || "").trim();
  const queryAliases = aliasesForQuery(rawQuery);
  const queryNorms = queryAliases.map((item) => normalizeText(item)).filter(Boolean);
  const primaryQueryNorm = queryNorms[0] || normalizeText(rawQuery);
  const aliases = [entry.id, entry.urlId, entry.url, entry.title, entry.name, entry.email, ...(entry.aliases || [])]
    .map((item) => String(item || "").trim())
    .filter(Boolean);
  const normalizedAliases = aliases.map((item) => normalizeText(item)).filter(Boolean);

  if (queryAliases.some((queryAlias) => aliases.includes(queryAlias))) {
    return 100;
  }
  if (queryNorms.some((queryNorm) => normalizedAliases.includes(queryNorm))) {
    return 100;
  }
  if (queryAliases.some((queryAlias) => entry.id === queryAlias || entry.urlId === queryAlias || entry.url === queryAlias)) {
    return 100;
  }

  let best = 0;
  for (const alias of normalizedAliases) {
    for (const queryNorm of queryNorms) {
      if (!alias || !queryNorm) {
        continue;
      }
      if (alias.includes(queryNorm) || queryNorm.includes(alias)) {
        best = Math.max(best, 82);
        continue;
      }
      const queryTokens = tokenize(queryNorm);
      if (queryTokens.length > 0) {
        const aliasTokens = new Set(tokenize(alias));
        const matched = queryTokens.filter((token) => aliasTokens.has(token)).length;
        if (matched > 0) {
          best = Math.max(best, 45 + Math.round((matched / queryTokens.length) * 35));
        }
      }
    }
  }

  const queryHits = (entry.queries || []).map((item) => normalizeText(item));
  if (queryHits.some((item) => item.includes(primaryQueryNorm) || primaryQueryNorm.includes(item))) {
    best = Math.max(best, 70);
  }

  return best;
}

function shapeEntry(entry, score) {
  return compactValue({
    type: entry.type,
    id: entry.id,
    title: entry.title,
    name: entry.name,
    email: entry.email,
    avatarUrl: entry.avatarUrl,
    role: entry.role,
    isAdmin: entry.isAdmin,
    isSuspended: entry.isSuspended,
    memberCount: entry.memberCount,
    createdAt: entry.createdAt,
    urlId: entry.urlId,
    collectionId: entry.collectionId,
    parentDocumentId: entry.parentDocumentId,
    revision: entry.revision,
    updatedAt: entry.updatedAt,
    publishedAt: entry.publishedAt,
    url: entry.url,
    lastObservedAt: entry.lastObservedAt,
    observedCount: entry.observedCount,
    score,
    sourceTools: entry.sourceTools,
    queries: entry.queries,
  });
}

async function findMemoryMatches(ctx, args) {
  const query = args.query || args.id || args.urlId || args.url;
  if (!query) {
    throw new CliError("memory.lookup requires args.query, args.id, args.urlId, or args.url");
  }
  const file = ctx.memory?.file || defaultMemoryFile();
  const store = await loadStore(file);
  const profileId = args.profile || ctx.profile?.id;
  const bucket = profileId ? store.profiles?.[profileId] : null;
  const limit = Math.max(1, toInteger(args.limit, 10));
  const minScore = Math.max(0, toInteger(args.minScore, 1));
  const maxAgeHours = args.maxAgeHours === undefined ? null : Math.max(0, Number(args.maxAgeHours));
  const cutoff = maxAgeHours === null ? null : Date.now() - maxAgeHours * 3600 * 1000;

  const rows = [];
  for (const entry of Object.values(bucket?.entries || {})) {
    if (!entry || entry.deletedAt) {
      continue;
    }
    if (args.type && entry.type !== args.type) {
      continue;
    }
    if (cutoff !== null) {
      const observedAt = Date.parse(entry.lastObservedAt || "");
      if (!Number.isFinite(observedAt) || observedAt < cutoff) {
        continue;
      }
    }
    const score = scoreEntry(entry, query);
    if (score >= minScore) {
      rows.push(shapeEntry(entry, score));
    }
  }

  rows.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return String(b.lastObservedAt || "").localeCompare(String(a.lastObservedAt || ""));
  });

  return {
    query,
    file,
    profileId,
    bucket,
    total: rows.length,
    items: rows.slice(0, limit),
  };
}

export async function memoryLookupTool(ctx, args) {
  const matches = await findMemoryMatches(ctx, args);

  return {
    tool: "memory.lookup",
    profile: matches.profileId,
    result: {
      query: matches.query,
      total: matches.total,
      items: matches.items,
      memory: {
        file: matches.file,
        updatedAt: matches.bucket?.updatedAt || null,
        liveUpdate: "updated opportunistically after successful CLI read/search/list/info calls",
      },
    },
  };
}

function baseUrlFromProfile(profile) {
  const baseUrl = String(profile?.baseUrl || "").trim();
  return baseUrl ? baseUrl.replace(/\/+$/, "") : "";
}

function sourceUrlFromDocument(profile, row) {
  if (!row || typeof row !== "object") {
    return undefined;
  }
  const url = String(row.url || "").trim();
  if (/^https?:\/\//i.test(url)) {
    return url;
  }
  const baseUrl = baseUrlFromProfile(profile);
  if (!baseUrl) {
    return undefined;
  }
  if (url) {
    return `${baseUrl}${url.startsWith("/") ? url : `/${url}`}`;
  }
  const urlId = String(row.urlId || "").trim();
  if (urlId) {
    return `${baseUrl}/doc/${urlId}`;
  }
  return undefined;
}

function normalizeLiveDocument(row, view = "summary", profile = null) {
  if (!row || typeof row !== "object") {
    return row;
  }
  const sourceUrl = sourceUrlFromDocument(profile, row);
  if (view === "full") {
    return compactValue({
      ...row,
      sourceUrl,
    }) || row;
  }
  const out = {
    id: row.id,
    title: row.title,
    collectionId: row.collectionId,
    parentDocumentId: row.parentDocumentId,
    revision: row.revision,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    urlId: row.urlId,
    url: row.url,
    sourceUrl,
    emoji: row.emoji,
  };
  if (view === "ids") {
    return compactValue({
      id: out.id,
      title: out.title,
      sourceUrl,
    }) || {};
  }
  return compactValue(out) || {};
}

function normalizeLiveCollection(row, view = "summary") {
  if (!row || typeof row !== "object") {
    return row;
  }
  if (view === "full") {
    return row;
  }
  return compactValue({
    id: row.id,
    name: row.name,
    description: view === "ids" ? undefined : row.description,
    permission: view === "ids" ? undefined : row.permission,
    sharing: view === "ids" ? undefined : row.sharing,
    updatedAt: view === "ids" ? undefined : row.updatedAt,
    color: view === "ids" ? undefined : row.color,
    icon: view === "ids" ? undefined : row.icon,
    urlId: row.urlId,
  }) || {};
}

function normalizeLiveUser(row, view = "summary") {
  if (!row || typeof row !== "object") {
    return row;
  }
  if (view === "full") {
    return row;
  }
  return compactValue({
    id: row.id,
    name: row.name,
    email: row.email,
    avatarUrl: view === "ids" ? undefined : row.avatarUrl,
    role: view === "ids" ? undefined : row.role,
    isAdmin: view === "ids" ? undefined : row.isAdmin,
    isSuspended: view === "ids" ? undefined : row.isSuspended,
    lastActiveAt: view === "ids" ? undefined : row.lastActiveAt,
  }) || {};
}

function normalizeLiveGroup(row, view = "summary") {
  if (!row || typeof row !== "object") {
    return row;
  }
  if (view === "full") {
    return row;
  }
  return compactValue({
    id: row.id,
    name: row.name,
    memberCount: view === "ids" ? undefined : row.memberCount,
    createdAt: view === "ids" ? undefined : row.createdAt,
    updatedAt: view === "ids" ? undefined : row.updatedAt,
  }) || {};
}

function normalizeLiveTemplate(row, view = "summary") {
  if (!row || typeof row !== "object") {
    return row;
  }
  if (view === "full") {
    return row;
  }
  return compactValue({
    id: row.id,
    title: row.title,
    name: row.name,
    collectionId: row.collectionId,
    createdAt: view === "ids" ? undefined : row.createdAt,
    updatedAt: view === "ids" ? undefined : row.updatedAt,
  }) || {};
}

function maybeDropPolicies(payload, includePolicies) {
  if (includePolicies) {
    return payload;
  }
  if (!payload || typeof payload !== "object") {
    return payload;
  }
  const next = { ...payload };
  delete next.policies;
  if (next.data && typeof next.data === "object" && !Array.isArray(next.data)) {
    next.data = { ...next.data };
    delete next.data.policies;
  }
  return next;
}

async function hydrateMemoryCandidate(ctx, candidate, args) {
  const maxAttempts = toInteger(args.maxAttempts, 2);
  const view = args.view || "summary";
  const endpoint = candidate.type === "collection"
    ? "collections.info"
    : candidate.type === "user"
      ? "users.info"
      : candidate.type === "group"
        ? "groups.info"
        : candidate.type === "template"
          ? "templates.info"
          : "documents.info";
  try {
    const res = await ctx.client.call(endpoint, { id: candidate.id }, { maxAttempts });
    const raw = res.body?.data;
    const data = candidate.type === "collection"
      ? normalizeLiveCollection(raw, view)
      : candidate.type === "user"
        ? normalizeLiveUser(raw, view)
        : candidate.type === "group"
          ? normalizeLiveGroup(raw, view)
          : candidate.type === "template"
            ? normalizeLiveTemplate(raw, view)
            : normalizeLiveDocument(raw, view, ctx.profile);

    await recordToolObservation(ctx, endpoint, { id: candidate.id, view }, {
      tool: endpoint,
      profile: ctx.profile?.id,
      result: res.body,
    });

    return {
      candidate,
      ok: true,
      endpoint,
      result: compactValue({
        ...res.body,
        data,
      }) || {},
    };
  } catch (err) {
    if (err instanceof ApiError) {
      const stale = await tombstoneHydrationMiss(ctx, candidate, endpoint, err.details?.status);
      return {
        candidate,
        ok: false,
        endpoint,
        error: err.message,
        status: err.details?.status,
        memory: stale.tombstoned ? stale : undefined,
      };
    }
    throw err;
  }
}

async function openDocumentByDirectInfo(ctx, args) {
  const maxAttempts = toInteger(args.maxAttempts, 2);
  const view = args.view || "summary";
  const body = compactValue({
    id: args.id,
    shareId: args.shareId,
  }) || {};
  const res = await ctx.client.call("documents.info", body, { maxAttempts });
  const payload = maybeDropPolicies(res.body, !!args.includePolicies);
  const data = normalizeLiveDocument(payload?.data, view, ctx.profile);
  const response = compactValue({
    ...payload,
    data,
  }) || {};

  await recordToolObservation(ctx, "documents.info", { ...body, view }, {
    tool: "documents.info",
    profile: ctx.profile?.id,
    result: res.body,
  });

  return {
    tool: "documents.open",
    profile: ctx.profile?.id,
    result: {
      ok: true,
      mode: args.id ? "id" : "shareId",
      query: args.id || args.shareId,
      document: data,
      response,
      memory: {
        refreshed: true,
        strategy: "direct documents.info",
      },
    },
  };
}

async function openCollectionByDirectInfo(ctx, args) {
  const maxAttempts = toInteger(args.maxAttempts, 2);
  const view = args.view || "summary";
  const res = await ctx.client.call("collections.info", { id: args.id }, { maxAttempts });
  const payload = maybeDropPolicies(res.body, !!args.includePolicies);
  const data = normalizeLiveCollection(payload?.data, view);
  const response = compactValue({
    ...payload,
    data,
  }) || {};

  await recordToolObservation(ctx, "collections.info", { id: args.id, view }, {
    tool: "collections.info",
    profile: ctx.profile?.id,
    result: res.body,
  });

  return {
    tool: "collections.open",
    profile: ctx.profile?.id,
    result: {
      ok: true,
      mode: "id",
      query: args.id,
      collection: data,
      response,
      memory: {
        refreshed: true,
        strategy: "direct collections.info",
      },
    },
  };
}

function assertHydrationProfileMatches(ctx, args) {
  if (args.refresh === false || !args.profile) {
    return;
  }
  if (args.profile === ctx.profile?.id) {
    return;
  }
  throw new CliError(
    "memory.resolve live refresh requires args.profile to match the selected CLI profile; set refresh=false for cross-profile local lookup"
  );
}

function shouldFallbackSearch(args, refresh) {
  return refresh && args.fallbackSearch !== false;
}

function shouldFallbackForMatches(args, refresh, matches) {
  if (!shouldFallbackSearch(args, refresh)) {
    return false;
  }
  if (!matches?.items?.length) {
    return true;
  }
  if (args.fallbackMinScore === undefined) {
    return false;
  }
  const threshold = Math.max(0, toInteger(args.fallbackMinScore, 0));
  return Number(matches.items[0]?.score || 0) < threshold;
}

function normalizeFallbackMode(args) {
  const mode = String(args.fallbackMode || "titles").trim().toLowerCase();
  if (["titles", "semantic", "both"].includes(mode)) {
    return mode;
  }
  return "titles";
}

async function runFallbackSearch(ctx, args, query) {
  if (!shouldFallbackSearch(args, args.refresh !== false)) {
    return null;
  }

  const maxAttempts = toInteger(args.maxAttempts, 2);
  const limit = Math.max(1, toInteger(args.fallbackLimit, Math.min(toInteger(args.limit, 10), 10)));
  const searchQuery = fallbackQueryForReference(query);
  const common = compactValue({
    query: searchQuery,
    limit,
    offset: 0,
    collectionId: args.collectionId,
  }) || {};
  const calls = [];
  const errors = [];
  let observed = 0;

  const callAndObserve = async (endpoint, body) => {
    try {
      const res = await ctx.client.call(endpoint, body, { maxAttempts });
      const count = Array.isArray(res.body?.data) ? res.body.data.length : 0;
      calls.push({ endpoint, count });
      await recordToolObservation(ctx, endpoint, body, {
        tool: endpoint,
        method: endpoint,
        profile: ctx.profile?.id,
        result: res.body,
      });
      observed += count;
    } catch (err) {
      if (err instanceof ApiError) {
        errors.push({
          endpoint,
          error: err.message,
          status: err.details?.status,
        });
        return;
      }
      throw err;
    }
  };

  if (args.type === "collection") {
    await callAndObserve("collections.list", common);
  } else if (args.type === "user") {
    await callAndObserve("users.list", common);
  } else if (args.type === "group") {
    await callAndObserve("groups.list", common);
  } else if (args.type === "template") {
    await callAndObserve("templates.list", common);
  } else {
    const mode = normalizeFallbackMode(args);
    if (mode === "titles" || mode === "both") {
      await callAndObserve("documents.search_titles", common);
    }
    if (mode === "semantic" || mode === "both") {
      await callAndObserve("documents.search", compactValue({
        ...common,
        snippetMinWords: toInteger(args.snippetMinWords, 16),
        snippetMaxWords: toInteger(args.snippetMaxWords, 24),
      }) || common);
    }
  }

  return compactValue({
    attempted: true,
    query,
    searchQuery,
    limit,
    mode: args.type === "collection"
      ? "collections"
      : args.type === "user"
        ? "users"
        : args.type === "group"
          ? "groups"
          : args.type === "template"
            ? "templates"
            : normalizeFallbackMode(args),
    calls,
    observed,
    errors,
  }) || { attempted: true, query, calls, observed };
}

export async function memoryResolveTool(ctx, args) {
  assertHydrationProfileMatches(ctx, args);
  let matches = await findMemoryMatches(ctx, args);
  const refresh = args.refresh !== false;
  let fallback = null;
  if (shouldFallbackForMatches(args, refresh, matches)) {
    fallback = await runFallbackSearch(ctx, args, matches.query);
    if (fallback?.observed > 0) {
      matches = await findMemoryMatches(ctx, args);
    }
  }
  const hydrateLimit = Math.max(1, toInteger(args.hydrateLimit, Math.min(matches.items.length || 1, 3)));
  const selected = refresh ? matches.items.slice(0, hydrateLimit) : [];
  const live = [];

  for (const candidate of selected) {
    live.push(await hydrateMemoryCandidate(ctx, candidate, args));
  }

  return {
    tool: "memory.resolve",
    profile: matches.profileId,
    result: {
      query: matches.query,
      total: matches.total,
      candidates: matches.items,
      live,
      memory: {
        file: matches.file,
        updatedAt: matches.bucket?.updatedAt || null,
        refreshed: refresh,
        hydrateLimit: selected.length,
        fallback,
      },
    },
  };
}

function normalizeBatchReferences(args) {
  const refs = [];
  if (args.queries) {
    refs.push(...ensureStringArray(args.queries, "queries"));
  }
  if (args.ids) {
    refs.push(...ensureStringArray(args.ids, "ids"));
  }
  if (args.urlIds) {
    refs.push(...ensureStringArray(args.urlIds, "urlIds"));
  }
  if (args.urls) {
    refs.push(...ensureStringArray(args.urls, "urls"));
  }
  return [...new Set(refs.map((item) => String(item || "").trim()).filter(Boolean))];
}

export async function memoryResolveBatchTool(ctx, args) {
  assertHydrationProfileMatches(ctx, args);
  const references = normalizeBatchReferences(args);
  if (references.length === 0) {
    throw new CliError("memory.resolve_batch requires args.queries[], args.ids[], args.urlIds[], or args.urls[]");
  }

  const concurrency = Math.max(1, toInteger(args.concurrency, 4));
  const hydrateConcurrency = Math.max(1, toInteger(args.hydrateConcurrency, 4));
  const hydrateLimit = Math.max(1, toInteger(args.hydrateLimit, 1));
  const refresh = args.refresh !== false;

  let resolved = await mapLimit(references, concurrency, async (query, index) => {
    const matches = await findMemoryMatches(ctx, {
      ...args,
      query,
    });
    const selected = refresh ? matches.items.slice(0, hydrateLimit) : [];
    return {
      index,
      query,
      profile: matches.profileId,
      total: matches.total,
      candidates: matches.items,
      selected,
      memory: {
        file: matches.file,
        updatedAt: matches.bucket?.updatedAt || null,
      },
    };
  });

  if (shouldFallbackSearch(args, refresh)) {
    const fallbackByQuery = new Map();
    for (const item of resolved.filter((row) => shouldFallbackForMatches(args, refresh, { items: row.candidates }))) {
      const refreshedMatches = await findMemoryMatches(ctx, {
        ...args,
        query: item.query,
      });
      if (!shouldFallbackForMatches(args, refresh, refreshedMatches)) {
        continue;
      }
      const fallback = await runFallbackSearch(ctx, args, item.query);
      if (fallback) {
        fallbackByQuery.set(item.query, fallback);
      }
    }

    if (fallbackByQuery.size > 0) {
      resolved = await mapLimit(references, concurrency, async (query, index) => {
        const matches = await findMemoryMatches(ctx, {
          ...args,
          query,
        });
        const selected = refresh ? matches.items.slice(0, hydrateLimit) : [];
        return {
          index,
          query,
          profile: matches.profileId,
          total: matches.total,
          candidates: matches.items,
          selected,
          memory: {
            file: matches.file,
            updatedAt: matches.bucket?.updatedAt || null,
            fallback: fallbackByQuery.get(query) || null,
          },
        };
      });
    }
  }

  const hydrationTargets = [];
  const targetKeys = new Set();
  for (const item of resolved) {
    for (const candidate of item.selected) {
      const key = `${candidate.type}:${candidate.id}`;
      if (targetKeys.has(key)) {
        continue;
      }
      targetKeys.add(key);
      hydrationTargets.push(candidate);
    }
  }

  const hydrated = new Map();
  if (refresh && hydrationTargets.length > 0) {
    const rows = await mapLimit(hydrationTargets, hydrateConcurrency, async (candidate) =>
      hydrateMemoryCandidate(ctx, candidate, args)
    );
    for (const row of rows) {
      hydrated.set(`${row.candidate.type}:${row.candidate.id}`, row);
    }
  }

  const items = resolved.map((item) => ({
    index: item.index,
    query: item.query,
    total: item.total,
    candidates: item.candidates,
    live: item.selected
      .map((candidate) => hydrated.get(`${candidate.type}:${candidate.id}`))
      .filter(Boolean),
    memory: item.memory,
  }));
  const failedHydrations = [...hydrated.values()].filter((item) => !item.ok).length;

  return {
    tool: "memory.resolve_batch",
    profile: args.profile || ctx.profile?.id,
    result: {
      queryCount: references.length,
      totalCandidates: items.reduce((sum, item) => sum + item.total, 0),
      hydrationRequested: hydrationTargets.length,
      hydrationFailed: failedHydrations,
      items,
      memory: {
        refreshed: refresh,
        hydrateLimit,
        concurrency,
        hydrateConcurrency,
      },
    },
  };
}

export async function documentsOpenTool(ctx, args) {
  if (args.id || args.shareId) {
    if (args.profile && args.profile !== ctx.profile?.id) {
      throw new CliError(
        "documents.open live read requires args.profile to match the selected CLI profile"
      );
    }
    return openDocumentByDirectInfo(ctx, args);
  }

  assertHydrationProfileMatches(ctx, args);
  const strict = args.strict !== false;
  const strictThreshold = Math.max(0, toInteger(args.strictThreshold, 85));
  const resolveArgs = {
    ...args,
    type: "document",
    minScore: args.minScore === undefined ? (strict ? strictThreshold : 1) : args.minScore,
    fallbackMinScore: args.fallbackMinScore === undefined && strict ? strictThreshold : args.fallbackMinScore,
    hydrateLimit: 1,
    limit: Math.max(1, toInteger(args.limit, 5)),
    refresh: args.refresh !== false,
  };
  const resolved = await memoryResolveTool(ctx, resolveArgs);
  const candidates = resolved.result?.candidates || [];
  const topCandidate = candidates[0] || null;
  const topScore = Number(topCandidate?.score || 0);

  if (!topCandidate) {
    return {
      tool: "documents.open",
      profile: resolved.profile,
      result: {
        ok: false,
        status: "not_found",
        query: resolved.result?.query || args.query || args.urlId || args.url,
        document: null,
        candidates,
        memory: resolved.result?.memory,
      },
    };
  }

  if (strict && topScore < strictThreshold) {
    return {
      tool: "documents.open",
      profile: resolved.profile,
      result: {
        ok: false,
        status: "low_confidence",
        query: resolved.result?.query,
        strictThreshold,
        document: null,
        candidate: topCandidate,
        candidates,
        memory: resolved.result?.memory,
      },
    };
  }

  const live = (resolved.result?.live || []).find((item) => item?.ok && item.candidate?.id === topCandidate.id)
    || (resolved.result?.live || [])[0]
    || null;
  if (!live?.ok) {
    return {
      tool: "documents.open",
      profile: resolved.profile,
      result: {
        ok: false,
        status: live ? "hydrate_failed" : "not_hydrated",
        query: resolved.result?.query,
        document: null,
        candidate: topCandidate,
        candidates,
        live,
        memory: resolved.result?.memory,
      },
    };
  }

  return {
    tool: "documents.open",
    profile: resolved.profile,
    result: {
      ok: true,
      mode: "memory",
      query: resolved.result?.query,
      document: live.result?.data || null,
      response: live.result,
      candidate: topCandidate,
      candidates,
      memory: resolved.result?.memory,
    },
  };
}

export async function collectionsOpenTool(ctx, args) {
  if (args.id) {
    if (args.profile && args.profile !== ctx.profile?.id) {
      throw new CliError(
        "collections.open live read requires args.profile to match the selected CLI profile"
      );
    }
    return openCollectionByDirectInfo(ctx, args);
  }

  assertHydrationProfileMatches(ctx, args);
  const strict = args.strict !== false;
  const strictThreshold = Math.max(0, toInteger(args.strictThreshold, 85));
  const resolveArgs = {
    ...args,
    type: "collection",
    minScore: args.minScore === undefined ? (strict ? strictThreshold : 1) : args.minScore,
    fallbackMinScore: args.fallbackMinScore === undefined && strict ? strictThreshold : args.fallbackMinScore,
    hydrateLimit: 1,
    limit: Math.max(1, toInteger(args.limit, 5)),
    refresh: args.refresh !== false,
  };
  const resolved = await memoryResolveTool(ctx, resolveArgs);
  const candidates = resolved.result?.candidates || [];
  const topCandidate = candidates[0] || null;
  const topScore = Number(topCandidate?.score || 0);

  if (!topCandidate) {
    return {
      tool: "collections.open",
      profile: resolved.profile,
      result: {
        ok: false,
        status: "not_found",
        query: resolved.result?.query || args.query || args.urlId || args.url,
        collection: null,
        candidates,
        memory: resolved.result?.memory,
      },
    };
  }

  if (strict && topScore < strictThreshold) {
    return {
      tool: "collections.open",
      profile: resolved.profile,
      result: {
        ok: false,
        status: "low_confidence",
        query: resolved.result?.query,
        strictThreshold,
        collection: null,
        candidate: topCandidate,
        candidates,
        memory: resolved.result?.memory,
      },
    };
  }

  const live = (resolved.result?.live || []).find((item) => item?.ok && item.candidate?.id === topCandidate.id)
    || (resolved.result?.live || [])[0]
    || null;
  if (!live?.ok) {
    return {
      tool: "collections.open",
      profile: resolved.profile,
      result: {
        ok: false,
        status: live ? "hydrate_failed" : "not_hydrated",
        query: resolved.result?.query,
        collection: null,
        candidate: topCandidate,
        candidates,
        live,
        memory: resolved.result?.memory,
      },
    };
  }

  return {
    tool: "collections.open",
    profile: resolved.profile,
    result: {
      ok: true,
      mode: "memory",
      query: resolved.result?.query,
      collection: live.result?.data || null,
      response: live.result,
      candidate: topCandidate,
      candidates,
      memory: resolved.result?.memory,
    },
  };
}

function normalizeOpenBatchReferences(args) {
  const refs = [];
  const pushMany = (kind, values) => {
    for (const value of ensureStringArray(values, kind === "query" ? "queries" : `${kind}s`) || []) {
      const text = String(value || "").trim();
      if (text) {
        refs.push({ index: refs.length, kind, value: text });
      }
    }
  };

  if (args.refs) {
    for (const value of ensureStringArray(args.refs, "refs") || []) {
      const text = String(value || "").trim();
      if (!text) {
        continue;
      }
      refs.push({
        index: refs.length,
        kind: /^https?:\/\//i.test(text) ? "url" : "query",
        value: text,
      });
    }
  }
  pushMany("query", args.queries);
  pushMany("id", args.ids);
  pushMany("shareId", args.shareIds);
  pushMany("urlId", args.urlIds);
  pushMany("url", args.urls);

  return refs.map((ref, index) => ({ ...ref, index }));
}

function openBatchItemFromResolved(row, ref, args) {
  const strict = args.strict !== false;
  const strictThreshold = Math.max(0, toInteger(args.strictThreshold, 85));
  const candidates = row?.candidates || [];
  const topCandidate = candidates[0] || null;
  const topScore = Number(topCandidate?.score || 0);

  if (!topCandidate) {
    return {
      index: ref.index,
      kind: ref.kind,
      value: ref.value,
      ok: false,
      status: "not_found",
      document: null,
      candidates,
      memory: row?.memory,
    };
  }

  if (strict && topScore < strictThreshold) {
    return {
      index: ref.index,
      kind: ref.kind,
      value: ref.value,
      ok: false,
      status: "low_confidence",
      strictThreshold,
      document: null,
      candidate: topCandidate,
      candidates,
      memory: row?.memory,
    };
  }

  const live = (row?.live || []).find((item) => item?.ok && item.candidate?.id === topCandidate.id)
    || (row?.live || [])[0]
    || null;
  if (!live?.ok) {
    return {
      index: ref.index,
      kind: ref.kind,
      value: ref.value,
      ok: false,
      status: live ? "hydrate_failed" : "not_hydrated",
      document: null,
      candidate: topCandidate,
      candidates,
      live,
      memory: row?.memory,
    };
  }

  return {
    index: ref.index,
    kind: ref.kind,
    value: ref.value,
    ok: true,
    mode: "memory",
    document: live.result?.data || null,
    response: live.result,
    candidate: topCandidate,
    candidates,
    memory: row?.memory,
  };
}

function openCollectionBatchItemFromResolved(row, ref, args) {
  const strict = args.strict !== false;
  const strictThreshold = Math.max(0, toInteger(args.strictThreshold, 85));
  const candidates = row?.candidates || [];
  const topCandidate = candidates[0] || null;
  const topScore = Number(topCandidate?.score || 0);

  if (!topCandidate) {
    return {
      index: ref.index,
      kind: ref.kind,
      value: ref.value,
      ok: false,
      status: "not_found",
      collection: null,
      candidates,
      memory: row?.memory,
    };
  }

  if (strict && topScore < strictThreshold) {
    return {
      index: ref.index,
      kind: ref.kind,
      value: ref.value,
      ok: false,
      status: "low_confidence",
      strictThreshold,
      collection: null,
      candidate: topCandidate,
      candidates,
      memory: row?.memory,
    };
  }

  const live = (row?.live || []).find((item) => item?.ok && item.candidate?.id === topCandidate.id)
    || (row?.live || [])[0]
    || null;
  if (!live?.ok) {
    return {
      index: ref.index,
      kind: ref.kind,
      value: ref.value,
      ok: false,
      status: live ? "hydrate_failed" : "not_hydrated",
      collection: null,
      candidate: topCandidate,
      candidates,
      live,
      memory: row?.memory,
    };
  }

  return {
    index: ref.index,
    kind: ref.kind,
    value: ref.value,
    ok: true,
    mode: "memory",
    collection: live.result?.data || null,
    response: live.result,
    candidate: topCandidate,
    candidates,
    memory: row?.memory,
  };
}

export async function documentsOpenBatchTool(ctx, args) {
  const references = normalizeOpenBatchReferences(args);
  if (references.length === 0) {
    throw new CliError("documents.open_batch requires args.refs[], args.queries[], args.ids[], args.shareIds[], args.urlIds[], or args.urls[]");
  }

  const directRefs = references.filter((ref) => ref.kind === "id" || ref.kind === "shareId");
  const fuzzyRefs = references.filter((ref) => ref.kind !== "id" && ref.kind !== "shareId");

  if (directRefs.length > 0 && args.profile && args.profile !== ctx.profile?.id) {
    throw new CliError(
      "documents.open_batch live reads require args.profile to match the selected CLI profile"
    );
  }
  if (fuzzyRefs.length > 0) {
    assertHydrationProfileMatches(ctx, args);
  }

  const concurrency = Math.max(1, toInteger(args.concurrency, 4));
  const itemsByIndex = new Map();

  if (directRefs.length > 0) {
    const uniqueDirectRefs = [];
    const seen = new Set();
    for (const ref of directRefs) {
      const key = `${ref.kind}:${ref.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueDirectRefs.push(ref);
      }
    }
    const opened = await mapLimit(uniqueDirectRefs, concurrency, async (ref) => {
      try {
        const result = await openDocumentByDirectInfo(ctx, {
          ...args,
          id: ref.kind === "id" ? ref.value : undefined,
          shareId: ref.kind === "shareId" ? ref.value : undefined,
        });
        return {
          key: `${ref.kind}:${ref.value}`,
          item: {
            kind: ref.kind,
            value: ref.value,
            ok: true,
            mode: result.result.mode,
            document: result.result.document,
            response: result.result.response,
            memory: result.result.memory,
          },
        };
      } catch (err) {
        if (err instanceof ApiError) {
          return {
            key: `${ref.kind}:${ref.value}`,
            item: {
              kind: ref.kind,
              value: ref.value,
              ok: false,
              status: "hydrate_failed",
              document: null,
              error: err.message,
              statusCode: err.details?.status,
            },
          };
        }
        throw err;
      }
    });
    const directByKey = new Map(opened.map((row) => [row.key, row.item]));
    for (const ref of directRefs) {
      itemsByIndex.set(ref.index, {
        index: ref.index,
        ...directByKey.get(`${ref.kind}:${ref.value}`),
      });
    }
  }

  let fuzzyMemory = null;
  if (fuzzyRefs.length > 0) {
    const resolved = await memoryResolveBatchTool(ctx, {
      ...args,
      queries: fuzzyRefs.filter((ref) => ref.kind === "query").map((ref) => ref.value),
      urlIds: fuzzyRefs.filter((ref) => ref.kind === "urlId").map((ref) => ref.value),
      urls: fuzzyRefs.filter((ref) => ref.kind === "url").map((ref) => ref.value),
      ids: undefined,
      type: "document",
      hydrateLimit: 1,
      minScore: args.minScore === undefined && args.strict !== false
        ? Math.max(0, toInteger(args.strictThreshold, 85))
        : args.minScore,
      fallbackMinScore: args.fallbackMinScore === undefined && args.strict !== false
        ? Math.max(0, toInteger(args.strictThreshold, 85))
        : args.fallbackMinScore,
      refresh: args.refresh !== false,
    });
    fuzzyMemory = resolved.result?.memory || null;
    const rowsByValue = new Map((resolved.result?.items || []).map((row) => [row.query, row]));
    for (const ref of fuzzyRefs) {
      itemsByIndex.set(ref.index, openBatchItemFromResolved(rowsByValue.get(ref.value), ref, args));
    }
  }

  const items = references.map((ref) => itemsByIndex.get(ref.index)).filter(Boolean);
  const ok = items.filter((item) => item.ok).length;

  return {
    tool: "documents.open_batch",
    profile: args.profile || ctx.profile?.id,
    result: {
      referenceCount: references.length,
      ok,
      failed: items.length - ok,
      items,
      memory: {
        refreshed: args.refresh !== false,
        directCount: directRefs.length,
        fuzzyCount: fuzzyRefs.length,
        concurrency,
        fuzzy: fuzzyMemory,
      },
    },
  };
}

export async function collectionsOpenBatchTool(ctx, args) {
  const references = normalizeOpenBatchReferences(args);
  if (references.length === 0) {
    throw new CliError("collections.open_batch requires args.refs[], args.queries[], args.ids[], args.urlIds[], or args.urls[]");
  }

  const directRefs = references.filter((ref) => ref.kind === "id");
  const fuzzyRefs = references.filter((ref) => ref.kind !== "id" && ref.kind !== "shareId");
  if (references.some((ref) => ref.kind === "shareId")) {
    throw new CliError("collections.open_batch does not support shareIds[]");
  }

  if (directRefs.length > 0 && args.profile && args.profile !== ctx.profile?.id) {
    throw new CliError(
      "collections.open_batch live reads require args.profile to match the selected CLI profile"
    );
  }
  if (fuzzyRefs.length > 0) {
    assertHydrationProfileMatches(ctx, args);
  }

  const concurrency = Math.max(1, toInteger(args.concurrency, 4));
  const itemsByIndex = new Map();

  if (directRefs.length > 0) {
    const uniqueDirectRefs = [];
    const seen = new Set();
    for (const ref of directRefs) {
      const key = `${ref.kind}:${ref.value}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueDirectRefs.push(ref);
      }
    }
    const opened = await mapLimit(uniqueDirectRefs, concurrency, async (ref) => {
      try {
        const result = await openCollectionByDirectInfo(ctx, {
          ...args,
          id: ref.value,
        });
        return {
          key: `${ref.kind}:${ref.value}`,
          item: {
            kind: ref.kind,
            value: ref.value,
            ok: true,
            mode: result.result.mode,
            collection: result.result.collection,
            response: result.result.response,
            memory: result.result.memory,
          },
        };
      } catch (err) {
        if (err instanceof ApiError) {
          return {
            key: `${ref.kind}:${ref.value}`,
            item: {
              kind: ref.kind,
              value: ref.value,
              ok: false,
              status: "hydrate_failed",
              collection: null,
              error: err.message,
              statusCode: err.details?.status,
            },
          };
        }
        throw err;
      }
    });
    const directByKey = new Map(opened.map((row) => [row.key, row.item]));
    for (const ref of directRefs) {
      itemsByIndex.set(ref.index, {
        index: ref.index,
        ...directByKey.get(`${ref.kind}:${ref.value}`),
      });
    }
  }

  let fuzzyMemory = null;
  if (fuzzyRefs.length > 0) {
    const resolved = await memoryResolveBatchTool(ctx, {
      ...args,
      queries: fuzzyRefs.filter((ref) => ref.kind === "query").map((ref) => ref.value),
      urlIds: fuzzyRefs.filter((ref) => ref.kind === "urlId").map((ref) => ref.value),
      urls: fuzzyRefs.filter((ref) => ref.kind === "url").map((ref) => ref.value),
      ids: undefined,
      type: "collection",
      hydrateLimit: 1,
      minScore: args.minScore === undefined && args.strict !== false
        ? Math.max(0, toInteger(args.strictThreshold, 85))
        : args.minScore,
      fallbackMinScore: args.fallbackMinScore === undefined && args.strict !== false
        ? Math.max(0, toInteger(args.strictThreshold, 85))
        : args.fallbackMinScore,
      refresh: args.refresh !== false,
    });
    fuzzyMemory = resolved.result?.memory || null;
    const rowsByValue = new Map((resolved.result?.items || []).map((row) => [row.query, row]));
    for (const ref of fuzzyRefs) {
      itemsByIndex.set(ref.index, openCollectionBatchItemFromResolved(rowsByValue.get(ref.value), ref, args));
    }
  }

  const items = references.map((ref) => itemsByIndex.get(ref.index)).filter(Boolean);
  const ok = items.filter((item) => item.ok).length;

  return {
    tool: "collections.open_batch",
    profile: args.profile || ctx.profile?.id,
    result: {
      referenceCount: references.length,
      ok,
      failed: items.length - ok,
      items,
      memory: {
        refreshed: args.refresh !== false,
        directCount: directRefs.length,
        fuzzyCount: fuzzyRefs.length,
        concurrency,
        fuzzy: fuzzyMemory,
      },
    },
  };
}

export async function memoryRecentTool(ctx, args = {}) {
  const file = ctx.memory?.file || defaultMemoryFile();
  const store = await loadStore(file);
  const profileId = args.profile || ctx.profile?.id;
  const bucket = profileId ? store.profiles?.[profileId] : null;
  const limit = Math.max(1, toInteger(args.limit, 20));
  const maxAgeHours = args.maxAgeHours === undefined ? null : Math.max(0, Number(args.maxAgeHours));
  const cutoff = maxAgeHours === null ? null : Date.now() - maxAgeHours * 3600 * 1000;

  const rows = [];
  for (const entry of Object.values(bucket?.entries || {})) {
    if (!entry || (!args.includeDeleted && entry.deletedAt)) {
      continue;
    }
    if (args.type && entry.type !== args.type) {
      continue;
    }
    if (cutoff !== null) {
      const observedAt = Date.parse(entry.lastObservedAt || "");
      if (!Number.isFinite(observedAt) || observedAt < cutoff) {
        continue;
      }
    }
    rows.push(shapeEntry(entry));
  }

  rows.sort((a, b) => String(b.lastObservedAt || "").localeCompare(String(a.lastObservedAt || "")));

  return {
    tool: "memory.recent",
    profile: profileId,
    result: {
      total: rows.length,
      items: rows.slice(0, limit),
      memory: {
        file,
        updatedAt: bucket?.updatedAt || null,
      },
    },
  };
}

export async function memoryRememberTool(ctx, args) {
  assertPerformAction(args, {
    tool: "memory.remember",
    action: "write a local Outline CLI memory mapping",
  });

  const type = args.type;
  if (!["document", "collection", "user", "group", "template"].includes(type)) {
    throw new CliError("memory.remember requires args.type to be 'document', 'collection', 'user', 'group', or 'template'");
  }
  if (!args.id) {
    throw new CliError("memory.remember requires args.id");
  }

  const file = ctx.memory?.file || defaultMemoryFile();
  const store = await loadStore(file);
  const profileId = args.profile || ctx.profile?.id;
  if (!profileId) {
    throw new CliError("memory.remember requires a selected profile or args.profile");
  }

  const now = new Date().toISOString();
  const aliases = new Set();
  addAlias(aliases, args.id);
  addAlias(aliases, args.title);
  addAlias(aliases, args.name);
  addAlias(aliases, args.email);
  addAlias(aliases, args.urlId);
  addAlias(aliases, args.url);
  for (const alias of ensureStringArray(args.aliases || [], "aliases")) {
    addAlias(aliases, alias);
  }

  const queries = [
    ...ensureStringArray(args.queries || [], "queries"),
    ...(args.query ? [String(args.query)] : []),
  ].map((item) => item.trim()).filter(Boolean);

  const bucket = profileBucket(store, profileId);
  const key = `${type}:${args.id}`;
  bucket.entries[key] = mergeEntry(bucket.entries[key], compactValue({
    type,
    id: String(args.id),
    title: ["document", "template"].includes(type) ? args.title : undefined,
    name: ["collection", "user", "group", "template"].includes(type) ? (args.name || args.title) : undefined,
    email: type === "user" ? args.email : undefined,
    urlId: args.urlId,
    url: args.url,
    aliases: [...aliases],
    queries,
  }) || { type, id: String(args.id), aliases: [...aliases], queries }, {
    kind: type,
    tool: "memory.remember",
    method: "memory.remember",
    queries,
    observedAt: now,
    authoritative: true,
  });
  bucket.updatedAt = now;
  pruneProfile(bucket, toInteger(ctx.memory?.maxEntriesPerProfile, DEFAULT_MAX_ENTRIES_PER_PROFILE));
  await saveStore(store, file);

  return {
    tool: "memory.remember",
    profile: profileId,
    result: {
      item: shapeEntry(bucket.entries[key], 100),
      memory: {
        file,
        updatedAt: bucket.updatedAt,
      },
    },
  };
}

export async function memoryStatsTool(ctx) {
  const file = ctx.memory?.file || defaultMemoryFile();
  const store = await loadStore(file);
  const profiles = Object.entries(store.profiles || {}).map(([profileId, bucket]) => {
    const entries = Object.values(bucket.entries || {});
    const byType = {};
    const tombstonedByType = {};
    for (const entry of entries) {
      byType[entry.type] = (byType[entry.type] || 0) + 1;
      if (entry.deletedAt) {
        tombstonedByType[entry.type] = (tombstonedByType[entry.type] || 0) + 1;
      }
    }
    return {
      profile: profileId,
      total: entries.length,
      active: entries.filter((entry) => !entry.deletedAt).length,
      tombstoned: entries.filter((entry) => entry.deletedAt).length,
      byType,
      tombstonedByType,
      updatedAt: bucket.updatedAt || null,
    };
  });

  return {
    tool: "memory.stats",
    profile: ctx.profile?.id,
    result: {
      file,
      profiles,
    },
  };
}

export async function memoryClearTool(ctx, args) {
  assertPerformAction(args, {
    tool: "memory.clear",
    action: "clear local Outline CLI memory",
  });

  const file = ctx.memory?.file || defaultMemoryFile();
  const store = await loadStore(file);
  const profileId = args.profile || ctx.profile?.id;
  const beforeProfiles = Object.keys(store.profiles || {}).length;
  let clearedProfiles = [];

  if (args.allProfiles === true) {
    clearedProfiles = Object.keys(store.profiles || {});
    store.profiles = {};
  } else if (profileId && store.profiles?.[profileId]) {
    clearedProfiles = [profileId];
    delete store.profiles[profileId];
  }

  await saveStore(store, file);

  return {
    tool: "memory.clear",
    profile: profileId,
    result: {
      file,
      clearedProfiles,
      beforeProfiles,
      afterProfiles: Object.keys(store.profiles || {}).length,
    },
  };
}

export const MEMORY_TOOLS = {
  "collections.open": {
    signature:
      "collections.open(args: { query?: string; id?: string; urlId?: string; url?: string; profile?: string; limit?: number; minScore?: number; maxAgeHours?: number; refresh?: boolean; strict?: boolean; strictThreshold?: number; fallbackSearch?: boolean; fallbackMinScore?: number; fallbackLimit?: number; view?: 'summary'|'full'; includePolicies?: boolean; maxAttempts?: number })",
    description: "Open one collection by ID or resolve a remembered collection name, URL id, or URL through local memory plus bounded live fallback.",
    usageExample: {
      tool: "collections.open",
      args: {
        query: "engineering",
        view: "summary",
      },
    },
    bestPractices: [
      "Use this for direct one-call collection reads when the user gives a collection name, alias, URL id, URL, or known collection id.",
      "Keep strict=true for automation so weak fuzzy matches return candidates instead of a guessed collection.",
      "Use collections.info ids[] when you already have several exact collection IDs.",
    ],
    handler: collectionsOpenTool,
  },
  "collections.open_batch": {
    signature:
      "collections.open_batch(args: { refs?: string[]; queries?: string[]; ids?: string[]; urlIds?: string[]; urls?: string[]; profile?: string; limit?: number; minScore?: number; maxAgeHours?: number; refresh?: boolean; strict?: boolean; strictThreshold?: number; fallbackSearch?: boolean; fallbackMinScore?: number; fallbackLimit?: number; view?: 'summary'|'full'; includePolicies?: boolean; concurrency?: number; hydrateConcurrency?: number; maxAttempts?: number })",
    description: "Open several collections by mixed IDs, remembered names, URL ids, or full URLs while deduplicating live hydration inside one CLI call.",
    usageExample: {
      tool: "collections.open_batch",
      args: {
        refs: ["engineering", "product"],
        ids: ["collection-id"],
        view: "summary",
      },
    },
    bestPractices: [
      "Use this when a task names multiple collections and you need ordered hydrated rows in one CLI invocation.",
      "Use refs[] for mixed names and URLs; use ids[] for exact server identifiers.",
      "Keep strict=true so low-confidence fuzzy references return candidates instead of guessed collections.",
    ],
    handler: collectionsOpenBatchTool,
  },
  "documents.open": {
    signature:
      "documents.open(args: { query?: string; id?: string; shareId?: string; urlId?: string; url?: string; profile?: string; limit?: number; minScore?: number; maxAgeHours?: number; refresh?: boolean; strict?: boolean; strictThreshold?: number; fallbackSearch?: boolean; fallbackMinScore?: number; fallbackLimit?: number; fallbackMode?: 'titles'|'semantic'|'both'; collectionId?: string; view?: 'summary'|'full'; includePolicies?: boolean; maxAttempts?: number })",
    description: "Open one document by ID/share ID or resolve a remembered title, URL, or URL id through local memory plus bounded live fallback.",
    usageExample: {
      tool: "documents.open",
      args: {
        query: "incident runbook",
        view: "summary",
      },
    },
    bestPractices: [
      "Use this for direct one-call reads when the user gives a title, alias, URL, URL id, share id, or known document id.",
      "Keep strict=true for automation so weak fuzzy matches return candidates instead of a guessed document.",
      "Set view=full only for the final document body you actually need.",
      "Use documents.info ids[] when you already have several exact document IDs.",
    ],
    handler: documentsOpenTool,
  },
  "documents.open_batch": {
    signature:
      "documents.open_batch(args: { refs?: string[]; queries?: string[]; ids?: string[]; shareIds?: string[]; urlIds?: string[]; urls?: string[]; profile?: string; limit?: number; minScore?: number; maxAgeHours?: number; refresh?: boolean; strict?: boolean; strictThreshold?: number; fallbackSearch?: boolean; fallbackMinScore?: number; fallbackLimit?: number; fallbackMode?: 'titles'|'semantic'|'both'; collectionId?: string; view?: 'summary'|'full'; includePolicies?: boolean; concurrency?: number; hydrateConcurrency?: number; maxAttempts?: number })",
    description: "Open several documents by mixed IDs, share IDs, remembered titles, URL ids, or full URLs while deduplicating live hydration inside one CLI call.",
    usageExample: {
      tool: "documents.open_batch",
      args: {
        refs: ["incident runbook", "https://handbook.example.com/doc/oncall-AbCdEf12"],
        ids: ["doc-id"],
        view: "summary",
      },
    },
    bestPractices: [
      "Use this when a task names multiple documents and you need direct hydrated results in one CLI invocation.",
      "Use refs[] for mixed titles and URLs; use ids[] or shareIds[] for exact server identifiers.",
      "Keep strict=true so low-confidence fuzzy references return candidates instead of guessed documents.",
      "Set view=full only when the final answer needs full document bodies.",
    ],
    handler: documentsOpenBatchTool,
  },
  "memory.lookup": {
    signature:
      "memory.lookup(args: { query?: string; id?: string; urlId?: string; url?: string; type?: 'document'|'collection'|'user'|'group'|'template'; profile?: string; limit?: number; minScore?: number; maxAgeHours?: number })",
    description: "Resolve recently observed documents, collections, users, groups, or templates from local profile-scoped memory without a network call, including remembered URL references.",
    usageExample: {
      tool: "memory.lookup",
      args: {
        query: "incident runbook",
        type: "document",
        limit: 5,
      },
    },
    bestPractices: [
      "Use this as a zero-network first pass for IDs, titles, names, emails, template names, and recently observed results.",
      "Treat results as hints; re-read with the matching info tool before decisions that require freshness.",
      "Use maxAgeHours when stale local matches would be worse than another live lookup.",
    ],
    handler: memoryLookupTool,
  },
  "memory.resolve": {
    signature:
      "memory.resolve(args: { query?: string; id?: string; urlId?: string; url?: string; type?: 'document'|'collection'|'user'|'group'|'template'; profile?: string; limit?: number; minScore?: number; maxAgeHours?: number; refresh?: boolean; hydrateLimit?: number; fallbackSearch?: boolean; fallbackMinScore?: number; fallbackLimit?: number; fallbackMode?: 'titles'|'semantic'|'both'; collectionId?: string; view?: 'ids'|'summary'|'full'; maxAttempts?: number })",
    description: "Resolve from local memory, fall back to a bounded live search on misses, and optionally live-hydrate top matches in one call.",
    usageExample: {
      tool: "memory.resolve",
      args: {
        query: "incident runbook",
        type: "document",
        refresh: true,
        hydrateLimit: 1,
        view: "summary",
      },
    },
    bestPractices: [
      "Use this when you likely saw a title, name, email, or ID before but need fresh metadata in the same turn.",
      "Keep hydrateLimit small to avoid turning a memory lookup into broad live hydration.",
      "Leave fallbackSearch enabled for cold-start direct results; set fallbackSearch=false for memory-only behavior.",
      "Set fallbackMinScore when weak fuzzy memory matches should still trigger one bounded live search.",
      "When using args.profile to inspect another profile's local memory, set refresh=false unless that profile is selected.",
      "Use memory.lookup instead when zero-network behavior is more important than freshness.",
    ],
    handler: memoryResolveTool,
  },
  "memory.resolve_batch": {
    signature:
      "memory.resolve_batch(args: { queries?: string[]; ids?: string[]; urlIds?: string[]; urls?: string[]; type?: 'document'|'collection'|'user'|'group'|'template'; profile?: string; limit?: number; minScore?: number; maxAgeHours?: number; refresh?: boolean; hydrateLimit?: number; fallbackSearch?: boolean; fallbackMinScore?: number; fallbackLimit?: number; fallbackMode?: 'titles'|'semantic'|'both'; collectionId?: string; view?: 'ids'|'summary'|'full'; concurrency?: number; hydrateConcurrency?: number; maxAttempts?: number })",
    description: "Resolve multiple references from local memory, fall back to bounded live search for misses, and deduplicate optional live hydration in one call.",
    usageExample: {
      tool: "memory.resolve_batch",
      args: {
        queries: ["incident runbook", "oncall escalation"],
        type: "document",
        refresh: true,
        hydrateLimit: 1,
        view: "summary",
      },
    },
    bestPractices: [
      "Use this when a task mentions several documents, collections, users, groups, or templates from prior sessions.",
      "Keep hydrateLimit=1 for low-call workflows; duplicate live targets are hydrated once per batch.",
      "Leave fallbackSearch enabled to resolve cold misses without a separate search tool call.",
      "Set fallbackMinScore when low-score remembered candidates should not suppress live search.",
      "When using args.profile to inspect another profile's local memory, set refresh=false unless that profile is selected.",
      "Set refresh=false when the caller only needs remembered IDs and titles.",
    ],
    handler: memoryResolveBatchTool,
  },
  "memory.recent": {
    signature:
      "memory.recent(args?: { type?: 'document'|'collection'|'user'|'group'|'template'; profile?: string; limit?: number; maxAgeHours?: number; includeDeleted?: boolean })",
    description: "List recently observed local memory entries for the selected profile without a network call.",
    usageExample: {
      tool: "memory.recent",
      args: {
        type: "document",
        limit: 10,
      },
    },
    bestPractices: [
      "Use this as a zero-network history view before searching again.",
      "Keep includeDeleted=false unless auditing local tombstones.",
      "Hydrate selected IDs with memory.resolve or documents.info when freshness matters.",
    ],
    handler: memoryRecentTool,
  },
  "memory.remember": {
    signature:
      "memory.remember(args: { type: 'document'|'collection'|'user'|'group'|'template'; id: string; title?: string; name?: string; email?: string; urlId?: string; url?: string; aliases?: string[]; query?: string; queries?: string[]; profile?: string; performAction?: boolean })",
    description: "Manually store a local profile-scoped memory alias for a known document, collection, user, group, or template.",
    usageExample: {
      tool: "memory.remember",
      args: {
        type: "document",
        id: "doc-id",
        title: "Incident Runbook",
        aliases: ["runbook"],
        performAction: true,
      },
    },
    bestPractices: [
      "Use this for stable human aliases that agents should resolve in later sessions.",
      "Prefer real document or collection IDs from Outline reads before remembering a mapping.",
      "This only changes the local memory file and is action-gated with performAction=true.",
    ],
    handler: memoryRememberTool,
  },
  "memory.stats": {
    signature: "memory.stats(args?: {})",
    description: "Summarize the local profile-scoped observation index.",
    usageExample: {
      tool: "memory.stats",
      args: {},
    },
    bestPractices: [
      "Use this to verify whether previous calls populated local memory.",
      "Inspect per-profile counts before relying on memory.lookup across multiple workspaces.",
    ],
    handler: memoryStatsTool,
  },
  "memory.clear": {
    signature:
      "memory.clear(args?: { profile?: string; allProfiles?: boolean; performAction?: boolean })",
    description: "Clear local Outline CLI memory for the selected profile or all profiles.",
    usageExample: {
      tool: "memory.clear",
      args: {
        performAction: true,
      },
    },
    bestPractices: [
      "Clear the current profile when local lookup results are stale or from a retired workspace.",
      "Use allProfiles=true only when intentionally resetting the whole local observation index.",
      "This tool is action-gated; set performAction=true only after confirming local cache deletion.",
    ],
    handler: memoryClearTool,
  },
};
