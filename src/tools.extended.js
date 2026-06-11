import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { ApiError, CliError } from "./errors.js";
import { assertPerformAction } from "./action-gate.js";
import { defaultTmpDir } from "./config-store.js";
import { compactValue, ensureStringArray, mapLimit, sanitizeFileToken, toInteger } from "./utils.js";
import { collectionsOpenBatchTool, collectionsOpenTool, documentsOpenBatchTool, memoryResolveTool } from "./memory-store.js";

const CONTROL_ARG_KEYS = new Set([
  "performAction",
  "maxAttempts",
  "includePolicies",
  "concurrency",
  "question",
  "questions",
  "compact",
]);

const ACCESS_RESOLVE_ARG_KEYS = [
  "documentId",
  "collectionId",
  "documentRef",
  "documentRefs",
  "documentQuery",
  "documentQueries",
  "refs",
  "query",
  "queries",
  "shareId",
  "shareIds",
  "urlId",
  "urlIds",
  "url",
  "urls",
  "profile",
  "resolveLimit",
  "minScore",
  "maxAgeHours",
  "refresh",
  "strict",
  "strictThreshold",
  "fallbackSearch",
  "fallbackMinScore",
  "fallbackLimit",
  "fallbackMode",
  "resolveCollectionId",
  "resolveConcurrency",
  "resolveHydrateConcurrency",
  "hydrateConcurrency",
  "snippetMinWords",
  "snippetMaxWords",
];

const ENTITY_RESOLVE_ARG_KEYS = [
  "ref",
  "refs",
  "query",
  "queries",
  "userRef",
  "userRefs",
  "userQuery",
  "userQueries",
  "groupRef",
  "groupRefs",
  "groupQuery",
  "groupQueries",
  "templateRef",
  "templateRefs",
  "templateQuery",
  "templateQueries",
  "profile",
  "resolveLimit",
  "minScore",
  "maxAgeHours",
  "refresh",
  "strict",
  "strictThreshold",
  "fallbackSearch",
  "fallbackMinScore",
  "fallbackLimit",
  "fallbackMode",
  "resolveConcurrency",
  "resolveHydrateConcurrency",
  "hydrateConcurrency",
];

const ANSWER_RESOLVE_ARG_KEYS = [
  "id",
  "documentQuery",
  "documentQueries",
  "documentRef",
  "documentRefs",
  "refs",
  "shareId",
  "shareIds",
  "urlId",
  "urlIds",
  "url",
  "urls",
  "collectionQuery",
  "collectionRef",
  "collectionQueries",
  "collectionRefs",
  "userQuery",
  "userRef",
  "userQueries",
  "userRefs",
  "profile",
  "resolveLimit",
  "minScore",
  "maxAgeHours",
  "refresh",
  "strict",
  "strictThreshold",
  "fallbackSearch",
  "fallbackMinScore",
  "fallbackLimit",
  "fallbackMode",
  "resolveCollectionId",
  "resolveConcurrency",
  "resolveHydrateConcurrency",
  "hydrateConcurrency",
  "contextChars",
  "excerptChars",
  "snippetMinWords",
  "snippetMaxWords",
];

function maybeDropPolicies(payload, includePolicies) {
  if (includePolicies) {
    return payload;
  }
  if (payload && typeof payload === "object" && "policies" in payload) {
    const clone = { ...payload };
    delete clone.policies;
    return clone;
  }
  return payload;
}

function buildBody(args = {}, omit = []) {
  const omitSet = new Set([...CONTROL_ARG_KEYS, ...omit]);
  const body = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (omitSet.has(key) || value === undefined) {
      continue;
    }
    body[key] = value;
  }
  return compactValue(body) || {};
}

function appendMultipartValue(form, key, value) {
  if (value === undefined) {
    return;
  }
  if (value instanceof Blob) {
    form.append(key, value);
    return;
  }
  if (Array.isArray(value) || (value && typeof value === "object")) {
    form.append(key, JSON.stringify(value));
    return;
  }
  form.append(key, String(value));
}

const ATTACHMENT_REDIRECT_PATTERN =
  /((?:https?:\/\/[^\s)"']+)?\/api\/attachments\.redirect\?[^)\s"']*?\bid=([0-9a-fA-F-]{36})[^)\s"']*)/g;

const EXT_BY_CONTENT_TYPE = new Map([
  ["image/png", ".png"],
  ["image/jpeg", ".jpg"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["image/svg+xml", ".svg"],
  ["application/pdf", ".pdf"],
  ["text/plain", ".txt"],
  ["text/markdown", ".md"],
  ["application/json", ".json"],
  ["application/zip", ".zip"],
]);

function getHeader(headers = {}, name) {
  const target = String(name || "").toLowerCase();
  for (const [key, value] of Object.entries(headers || {})) {
    if (String(key).toLowerCase() === target) {
      return value;
    }
  }
  return undefined;
}

function contentTypeToExtension(contentType) {
  const normalized = String(contentType || "").split(";")[0].trim().toLowerCase();
  return EXT_BY_CONTENT_TYPE.get(normalized) || ".bin";
}

function parseContentDispositionFilename(value) {
  const raw = String(value || "");
  const encoded = raw.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded);
    } catch {
      return encoded;
    }
  }
  return raw.match(/filename="?([^";]+)"?/i)?.[1] || "";
}

function extractAttachmentId(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  if (/^[0-9a-fA-F-]{36}$/.test(raw)) {
    return raw.toLowerCase();
  }

  try {
    const parsed = new URL(raw, "https://outline.local");
    const id = parsed.searchParams.get("id");
    return id && /^[0-9a-fA-F-]{36}$/.test(id) ? id.toLowerCase() : "";
  } catch {
    const match = raw.match(/\bid=([0-9a-fA-F-]{36})\b/);
    return match ? match[1].toLowerCase() : "";
  }
}

function extractDocumentUrlId(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  try {
    const parsed = new URL(raw);
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";
    return last.match(/-([A-Za-z0-9]{8,})$/)?.[1] || "";
  } catch {
    return raw.match(/-([A-Za-z0-9]{8,})$/)?.[1] || "";
  }
}

function extractAttachmentRefsFromText(text, baseUrl = "") {
  const refs = [];
  const seen = new Set();
  const source = String(text || "");
  const base = String(baseUrl || "").replace(/\/+$/, "");
  const pattern = new RegExp(ATTACHMENT_REDIRECT_PATTERN.source, "g");
  let match;

  while ((match = pattern.exec(source)) !== null) {
    const id = extractAttachmentId(match[1]);
    if (!id || seen.has(id)) {
      continue;
    }
    seen.add(id);
    const url = match[1];
    refs.push({
      id,
      index: refs.length,
      source: "markdown",
      url,
      absoluteUrl: url.startsWith("http") || !base ? url : `${base}${url}`,
      position: match.index,
    });
  }

  return refs;
}

async function readDocumentForAttachments(ctx, args = {}) {
  const urlId = args.urlId || extractDocumentUrlId(args.url);
  const id = args.id || args.documentId || urlId;
  const shareId = args.shareId;
  const refArgs = compactValue({
    refs: args.refs,
    queries: args.queries || (args.query ? [args.query] : undefined),
    shareIds: shareId ? [shareId] : undefined,
    urlIds: args.urlId ? [args.urlId] : undefined,
    urls: args.url && !urlId ? [args.url] : undefined,
    profile: args.profile,
    limit: args.resolveLimit,
    minScore: args.minScore,
    maxAgeHours: args.maxAgeHours,
    refresh: args.refresh,
    strict: args.strict,
    strictThreshold: args.strictThreshold,
    fallbackSearch: args.fallbackSearch,
    fallbackMinScore: args.fallbackMinScore,
    fallbackLimit: args.fallbackLimit,
    fallbackMode: args.fallbackMode,
    collectionId: args.resolveCollectionId,
    view: "full",
    concurrency: args.resolveConcurrency,
    hydrateConcurrency: args.resolveHydrateConcurrency,
    maxAttempts: args.maxAttempts,
  }) || {};

  if (!id && !shareId && (refArgs.refs || refArgs.queries || refArgs.urlIds || refArgs.urls)) {
    const opened = await documentsOpenBatchTool(ctx, refArgs);
    const item = (opened.result?.items || []).find((row) => row?.ok && row.document?.id)
      || (opened.result?.items || [])[0]
      || null;
    if (item?.ok && item.document) {
      return {
        document: item.document,
        resolution: {
          mode: item.mode,
          index: item.index,
          kind: item.kind,
          value: item.value,
          id: item.document.id,
          title: item.document.title,
          candidate: item.candidate,
          memory: item.memory || opened.result?.memory || null,
        },
      };
    }
    return {
      document: null,
      resolution: {
        failed: item
          ? {
              index: item.index,
              kind: item.kind,
              value: item.value,
              status: item.status || "not_found",
              candidate: item.candidate,
              candidates: item.candidates,
              error: item.error,
            }
          : { status: "not_found" },
        memory: item?.memory || opened.result?.memory || null,
      },
    };
  }

  if (!id && !shareId) {
    throw new CliError("document attachment tools require args.id, args.documentId, args.url, args.shareId, or document refs");
  }

  const body = compactValue({ id, shareId }) || {};
  const res = await ctx.client.call("documents.info", body, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });
  const doc = res.body?.data || null;
  if (!doc) {
    throw new CliError("documents.info response did not include document data");
  }
  return {
    document: doc,
    resolution: {
      mode: "direct",
      id: doc?.id || id || "",
      shareId: shareId || "",
      urlId: urlId || "",
      memory: null,
    },
  };
}

function summarizeAttachmentDocument(doc) {
  return {
    id: doc?.id,
    title: doc?.title,
    url: doc?.url,
    urlId: doc?.urlId,
    collectionId: doc?.collectionId,
    parentDocumentId: doc?.parentDocumentId,
    revision: doc?.revision,
    updatedAt: doc?.updatedAt,
  };
}

function resolveAttachmentOutputPath(args, id, headers, index = null) {
  if (args.filePath) {
    return path.resolve(String(args.filePath));
  }

  const contentType = getHeader(headers, "content-type");
  const dispositionName = parseContentDispositionFilename(getHeader(headers, "content-disposition"));
  const requestedName = typeof args.fileName === "string" ? args.fileName.trim() : "";
  const baseName = requestedName || dispositionName;
  const ext = path.extname(baseName) || contentTypeToExtension(contentType);
  const prefix = index === null ? "" : `${String(index + 1).padStart(2, "0")}-`;
  const fallbackName = `${prefix}${id}${ext}`;
  const safeName = sanitizeFileToken(baseName ? `${prefix}${baseName}` : fallbackName);
  const outputDir = path.resolve(String(args.outputDir || path.join(defaultTmpDir(), "attachments")));

  return path.join(outputDir, safeName);
}

async function writeAttachmentFile(filePath, buffer, overwrite) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  try {
    await fs.writeFile(filePath, buffer, { flag: overwrite ? "w" : "wx" });
  } catch (err) {
    if (err?.code === "EEXIST") {
      throw new CliError(`Attachment file already exists: ${filePath}`, {
        code: "ATTACHMENT_FILE_EXISTS",
        filePath,
      });
    }
    throw err;
  }
}

async function downloadAttachmentToFile(ctx, args = {}, id, index = null) {
  if (!ctx.client || typeof ctx.client.download !== "function") {
    throw new CliError("Current Outline client does not support binary downloads");
  }

  const res = await ctx.client.download("attachments.redirect", { id }, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });
  const buffer = res.body;
  const filePath = resolveAttachmentOutputPath(args, id, res.headers, index);
  await writeAttachmentFile(filePath, buffer, args.overwrite === true);

  const contentType = getHeader(res.headers, "content-type") || "application/octet-stream";
  return {
    id,
    ok: true,
    filePath,
    bytes: buffer.length,
    sha256: createHash("sha256").update(buffer).digest("hex"),
    contentType,
    status: res.status,
    sourceUrl: res.url,
  };
}

function defaultUsageArgs(def) {
  const resolveConfig = normalizeResolveAccessConfig(def.resolveAccess);
  const entityConfig = normalizeResolveEntityConfig(def.resolveEntity);
  const principalConfig = normalizeResolveEntityConfig(def.resolvePrincipal);
  if (principalConfig) {
    const principalKey = principalConfig.queryKeys?.[0] || `${principalConfig.type}Query`;
    const principalValue = principalConfig.type === "group" ? "Engineering" : "Alice Example";
    if (resolveConfig?.kind === "document") {
      return {
        [resolveConfig.queryKeys?.includes("query") ? "query" : "documentQuery"]: "incident runbook",
        [principalKey]: principalValue,
        ...(def.mutating ? { performAction: true } : {}),
      };
    }
    if (resolveConfig?.kind === "collection") {
      const collectionQueryKey = resolveConfig.queryKeys?.includes("query") ? "query" : "collectionQuery";
      return {
        [collectionQueryKey]: "engineering",
        [principalKey]: principalValue,
        ...(def.mutating ? { performAction: true } : {}),
      };
    }
    if (entityConfig?.type === "group") {
      return {
        [entityConfig.queryKeys?.[0] || "groupQuery"]: "Engineering",
        [principalKey]: principalValue,
        ...(def.mutating ? { performAction: true } : {}),
      };
    }
  }
  if (entityConfig?.type === "user") {
    return {
      query: "Alice Example",
    };
  }
  if (entityConfig?.type === "group") {
    return {
      query: "Engineering",
      limit: 20,
    };
  }
  if (entityConfig?.type === "template") {
    return {
      [entityConfig.queryKeys?.[0] || "templateQuery"]: "incident postmortem",
      limit: 20,
    };
  }
  if (resolveConfig?.kind === "document") {
    return {
      [resolveConfig.queryKeys?.includes("query") ? "query" : "documentQuery"]: "incident runbook",
      limit: 20,
    };
  }
  if (resolveConfig?.kind === "collection") {
    const collectionQueryKey = resolveConfig.queryKeys?.includes("query") ? "query" : "collectionQuery";
    return {
      [collectionQueryKey]: "engineering",
      limit: 20,
    };
  }
  if (def.tool === "documents.empty_trash") {
    return def.mutating ? { performAction: true } : {};
  }
  if (def.tool === "users.invite") {
    return {
      email: "new.user@example.com",
      role: "member",
      performAction: true,
    };
  }
  if (def.tool === "users.update_role") {
    return {
      id: "user-id",
      role: "member",
      performAction: true,
    };
  }
  if (def.tool === "shares.create") {
    return {
      documentQuery: "incident runbook",
      performAction: true,
    };
  }
  if (def.tool === "shares.update") {
    return {
      id: "share-id",
      published: true,
      performAction: true,
    };
  }
  if (def.tool === "shares.revoke") {
    return {
      id: "share-id",
      performAction: true,
    };
  }
  if (def.tool === "documents.import") {
    return {
      collectionId: "collection-id",
      data: {},
      performAction: true,
    };
  }
  if (def.tool === "oauth_clients.create") {
    return {
      name: "Example OAuth App",
      redirectUris: ["https://example.com/callback"],
      performAction: true,
    };
  }
  if (def.tool === "oauth_clients.update") {
    return {
      id: "oauth-client-id",
      name: "Updated OAuth App",
      performAction: true,
    };
  }
  if (
    def.tool === "oauth_clients.rotate_secret" ||
    def.tool === "oauth_clients.delete" ||
    def.tool === "oauthClients.delete"
  ) {
    return {
      id: "oauth-client-id",
      performAction: true,
    };
  }
  if (
    def.tool === "oauth_authentications.delete" ||
    def.tool === "oauthAuthentications.delete"
  ) {
    return {
      oauthClientId: "oauth-client-id",
      performAction: true,
    };
  }
  if (
    def.tool.endsWith(".list") ||
    def.tool.endsWith(".archived") ||
    def.tool.endsWith(".deleted") ||
    def.tool.endsWith(".memberships") ||
    def.tool.endsWith(".group_memberships")
  ) {
    return {};
  }
  if (def.tool.endsWith(".add_user") || def.tool.endsWith(".remove_user")) {
    return {
      id: "resource-id",
      userId: "user-id",
      ...(def.mutating ? { performAction: true } : {}),
    };
  }
  if (def.tool.endsWith(".add_group") || def.tool.endsWith(".remove_group")) {
    return {
      id: "resource-id",
      groupId: "group-id",
      ...(def.mutating ? { performAction: true } : {}),
    };
  }
  return {
    id: "id",
    ...(def.mutating ? { performAction: true } : {}),
  };
}

function nonEmptyString(value) {
  const text = String(value || "").trim();
  return text || "";
}

function hasAccessRefInput(args = {}, kind) {
  if (nonEmptyString(args.query) || nonEmptyString(args.documentQuery) || nonEmptyString(args.urlId) || nonEmptyString(args.url)) {
    return true;
  }
  if (kind === "document" && nonEmptyString(args.shareId)) {
    return true;
  }
  return ["refs", "queries", "documentQueries", "urlIds", "urls", ...(kind === "document" ? ["shareIds"] : [])]
    .some((key) => Array.isArray(args[key]) && args[key].some((item) => nonEmptyString(item)));
}

function normalizeResolveAccessConfig(input) {
  if (!input) {
    return null;
  }
  if (typeof input === "string") {
    const aliasKey = input === "collection" ? "collectionId" : "documentId";
    const queryKeys = input === "document" ? ["query", "documentQuery"] : ["query"];
    const arrayQueryKeys = input === "document" ? ["queries", "documentQueries"] : ["queries"];
    return {
      kind: input,
      outputField: "id",
      resultField: aliasKey,
      exactKeys: ["id", aliasKey],
      required: true,
      queryKeys,
      arrayQueryKeys,
      omitKeys: ACCESS_RESOLVE_ARG_KEYS,
    };
  }
  const kind = input.kind || "document";
  const aliasKey = kind === "collection" ? "collectionId" : "documentId";
  const queryKeys = input.queryKeys || ["query"];
  const arrayQueryKeys = input.arrayQueryKeys || ["queries"];
  const outputField = input.outputField || "id";
  const resultField = input.resultField || aliasKey;
  const omitKeys = new Set([
    ...ACCESS_RESOLVE_ARG_KEYS,
    ...queryKeys,
    ...arrayQueryKeys,
    ...(input.omitKeys || []),
  ]);
  if (input.preserveQuery === true) {
    omitKeys.delete("query");
    omitKeys.delete("queries");
  }
  omitKeys.delete(outputField);
  return {
    kind,
    outputField,
    resultField,
    exactKeys: input.exactKeys || ["id", aliasKey],
    required: input.required !== false,
    queryKeys,
    arrayQueryKeys,
    omitKeys: [...omitKeys],
  };
}

function collectResolveQueries(args, config) {
  const queries = [];
  for (const key of config.queryKeys || []) {
    const value = nonEmptyString(args[key]);
    if (value) {
      queries.push(value);
    }
  }
  for (const key of config.arrayQueryKeys || []) {
    if (!Array.isArray(args[key])) {
      continue;
    }
    for (const value of args[key]) {
      const text = nonEmptyString(value);
      if (text) {
        queries.push(text);
      }
    }
  }
  return queries;
}

function firstEntityReference(args = {}, config = {}) {
  for (const key of config.queryKeys || ["query", "ref"]) {
    const value = nonEmptyString(args[key]);
    if (value) {
      return {
        key,
        value,
      };
    }
  }
  for (const key of config.arrayQueryKeys || ["refs", "queries"]) {
    if (!Array.isArray(args[key])) {
      continue;
    }
    for (const item of args[key]) {
      const value = nonEmptyString(item);
      if (value) {
        return {
          key,
          value,
        };
      }
    }
  }
  return null;
}

function normalizeResolveEntityConfig(input) {
  if (!input) {
    return null;
  }
  const type = typeof input === "string" ? input : input.type;
  if (!type) {
    return null;
  }
  const queryKeys = input.queryKeys || ["query", "ref"];
  const arrayQueryKeys = input.arrayQueryKeys || ["refs", "queries"];
  const outputField = input.outputField || "id";
  const resultField = input.resultField || `${type}Id`;
  return {
    type,
    outputField,
    resultField,
    exactKeys: input.exactKeys || ["id"],
    passthroughKeys: input.passthroughKeys || [],
    queryKeys,
    arrayQueryKeys,
    omitKeys: [...new Set([...ENTITY_RESOLVE_ARG_KEYS, ...queryKeys, ...arrayQueryKeys, ...(input.omitKeys || [])])],
    strictThreshold: input.strictThreshold,
  };
}

function resolutionFromEntityCandidate(resolved, ref, config) {
  const candidates = resolved.result?.candidates || [];
  const topCandidate = candidates[0] || null;
  const strict = ref.strict !== false;
  const strictThreshold = Math.max(0, toInteger(ref.strictThreshold ?? config.strictThreshold, 85));
  const topScore = Number(topCandidate?.score || 0);

  if (!topCandidate) {
    return {
      error: {
        failed: {
          kind: ref.key,
          value: ref.value,
          status: "not_found",
        },
        memory: resolved.result?.memory || null,
      },
    };
  }
  if (strict && topScore < strictThreshold) {
    return {
      error: {
        failed: {
          kind: ref.key,
          value: ref.value,
          status: "low_confidence",
          strictThreshold,
        },
        candidate: topCandidate,
        candidates,
        memory: resolved.result?.memory || null,
      },
    };
  }

  const live = (resolved.result?.live || []).find((item) => item?.ok && item.candidate?.id === topCandidate.id)
    || (resolved.result?.live || [])[0]
    || null;
  if (live && !live.ok) {
    return {
      error: {
        failed: {
          kind: ref.key,
          value: ref.value,
          status: "hydrate_failed",
          error: live.error,
          statusCode: live.status,
        },
        candidate: topCandidate,
        memory: resolved.result?.memory || live.memory || null,
      },
    };
  }

  return {
    id: topCandidate.id,
    resolution: compactValue({
      mode: "memory",
      kind: ref.key,
      value: ref.value,
      id: topCandidate.id,
      name: topCandidate.name,
      email: topCandidate.email,
      candidate: topCandidate,
      live,
      memory: resolved.result?.memory || null,
    }) || { id: topCandidate.id },
  };
}

async function resolveEntityId(ctx, args = {}, input) {
  const config = normalizeResolveEntityConfig(input);
  if (!config) {
    return null;
  }
  const exact = (config.exactKeys || [])
    .map((key) => ({ key, value: nonEmptyString(args[key]) }))
    .find((item) => item.value);
  if (exact?.value) {
    if (exact.key !== config.outputField) {
      return {
        id: exact.value,
        resolution: null,
        outputField: config.outputField,
        resultField: config.resultField,
        omitKeys: config.omitKeys,
      };
    }
    return null;
  }
  if ((config.passthroughKeys || []).some((key) => nonEmptyString(args[key]) || (Array.isArray(args[key]) && args[key].length > 0))) {
    return null;
  }

  const ref = firstEntityReference(args, config);
  if (!ref) {
    return null;
  }

  const resolved = await memoryResolveTool(ctx, {
    query: ref.value,
    type: config.type,
    profile: args.profile,
    limit: Math.max(1, toInteger(args.resolveLimit, 5)),
    hydrateLimit: 1,
    maxAgeHours: args.maxAgeHours,
    minScore: args.minScore === undefined && args.strict !== false
      ? Math.max(0, toInteger(args.strictThreshold ?? config.strictThreshold, 85))
      : args.minScore,
    strict: args.strict,
    strictThreshold: args.strictThreshold,
    fallbackSearch: args.fallbackSearch,
    fallbackMinScore: args.fallbackMinScore === undefined && args.strict !== false
      ? Math.max(0, toInteger(args.strictThreshold ?? config.strictThreshold, 85))
      : args.fallbackMinScore,
    fallbackLimit: args.fallbackLimit,
    refresh: args.refresh !== false,
  });
  return {
    ...resolutionFromEntityCandidate(resolved, { ...ref, strict: args.strict, strictThreshold: args.strictThreshold }, config),
    outputField: config.outputField,
    resultField: config.resultField,
    omitKeys: config.omitKeys,
  };
}

function successfulResolutions(resolutions) {
  return resolutions.filter((item) => item?.id);
}

function combinedResolutionPayload(resolutions) {
  const resolved = successfulResolutions(resolutions).filter((item) => item.resolution);
  if (resolved.length === 0) {
    return null;
  }
  if (resolved.length === 1) {
    return resolved[0].resolution;
  }
  const byField = {};
  for (const item of resolved) {
    byField[item.resultField || item.outputField || "id"] = item.resolution;
  }
  return compactValue(byField);
}

function hasConfiguredAccessRefInput(args = {}, config) {
  if (collectResolveQueries(args, config).length > 0) {
    return true;
  }
  if (nonEmptyString(args.urlId) || nonEmptyString(args.url)) {
    return true;
  }
  if (config.kind === "document" && nonEmptyString(args.shareId)) {
    return true;
  }
  return ["refs", "urlIds", "urls", ...(config.kind === "document" ? ["shareIds"] : [])]
    .some((key) => Array.isArray(args[key]) && args[key].some((item) => nonEmptyString(item)));
}

function resolutionFromAccessOpenItem(item, opened, kind) {
  const entity = kind === "collection" ? item?.collection : item?.document;
  if (!item?.ok || !entity?.id) {
    return {
      error: {
        failed: item
          ? {
              index: item.index,
              kind: item.kind,
              value: item.value,
              status: item.status || "not_found",
              error: item.error,
            }
          : {
              status: "not_found",
            },
        memory: opened.result?.memory || item?.memory || null,
      },
    };
  }

  return {
    id: entity.id,
    resolution: compactValue({
      mode: item.mode,
      index: item.index,
      kind: item.kind,
      value: item.value,
      id: entity.id,
      title: entity.title,
      name: entity.name,
      candidate: item.candidate,
      memory: item.memory || opened.result?.memory || null,
    }) || { id: entity.id },
  };
}

async function resolveAccessId(ctx, args = {}, input) {
  const config = normalizeResolveAccessConfig(input);
  const aliasKey = config.kind === "collection" ? "collectionId" : "documentId";
  const exactId = (config.exactKeys || []).map((key) => nonEmptyString(args[key])).find(Boolean) || "";
  if (exactId) {
    return {
      id: exactId,
      resolution: null,
      outputField: config.outputField,
      resultField: config.resultField,
      omitKeys: config.omitKeys,
    };
  }
  if (!hasConfiguredAccessRefInput(args, config)) {
    return config.required ? {
      error: {
        failed: {
          status: "missing_selector",
          message: `requires ${config.exactKeys.map((key) => `args.${key}`).join(", ")} or a resolvable reference`,
        },
      },
      outputField: config.outputField,
      resultField: config.resultField,
      omitKeys: config.omitKeys,
    } : null;
  }

  const queries = collectResolveQueries(args, config);
  const openArgs = compactValue({
    refs: args.refs,
    queries: queries.length > 0 ? queries : undefined,
    shareIds: config.kind === "document"
      ? (args.shareIds || (args.shareId ? [args.shareId] : undefined))
      : undefined,
    urlIds: args.urlIds || (args.urlId ? [args.urlId] : undefined),
    urls: args.urls || (args.url ? [args.url] : undefined),
    profile: args.profile,
    limit: args.resolveLimit,
    minScore: args.minScore,
    maxAgeHours: args.maxAgeHours,
    refresh: args.refresh,
    strict: args.strict,
    strictThreshold: args.strictThreshold,
    fallbackSearch: args.fallbackSearch,
    fallbackMinScore: args.fallbackMinScore,
    fallbackLimit: args.fallbackLimit,
    fallbackMode: args.fallbackMode,
    collectionId: config.kind === "document" ? args.resolveCollectionId : undefined,
    snippetMinWords: args.snippetMinWords,
    snippetMaxWords: args.snippetMaxWords,
    view: "summary",
    concurrency: args.resolveConcurrency,
    hydrateConcurrency: args.resolveHydrateConcurrency,
    maxAttempts: args.maxAttempts,
  }) || {};

  const opened = config.kind === "collection"
    ? await collectionsOpenBatchTool(ctx, openArgs)
    : await documentsOpenBatchTool(ctx, openArgs);
  const item = (opened.result?.items || []).find((row) => row?.ok)
    || (opened.result?.items || [])[0]
    || null;
  return {
    ...resolutionFromAccessOpenItem(item, opened, config.kind),
    outputField: config.outputField,
    resultField: config.resultField,
    omitKeys: config.omitKeys,
  };
}

function makeRpcHandler(def) {
  return async function rpcHandler(ctx, args = {}) {
    if (def.mutating) {
      assertPerformAction(args, {
        tool: def.tool,
        action: `invoke mutating method '${def.method}'`,
      });
    }

    const maxAttempts = toInteger(args.maxAttempts, def.mutating ? 1 : 2);
    const resolutions = [];
    if (def.resolveAccess) {
      resolutions.push(await resolveAccessId(ctx, args, def.resolveAccess));
    }
    if (def.resolveEntity) {
      resolutions.push(await resolveEntityId(ctx, args, def.resolveEntity));
    }
    if (def.resolvePrincipal) {
      resolutions.push(await resolveEntityId(ctx, args, def.resolvePrincipal));
    }
    const failedResolution = resolutions.find((item) => item?.error);
    if (failedResolution?.error) {
      const resultField = failedResolution.resultField || failedResolution.outputField || (def.resolveAccess === "collection" ? "collectionId" : "documentId");
      return {
        tool: def.tool,
        profile: ctx.profile.id,
        result: compactValue({
          ok: false,
          status: failedResolution.error.status || "not_found",
          [resultField]: "",
          resolution: failedResolution.error,
          data: [],
        }) || {},
      };
    }

    const bodyArgs = { ...args };
    const omitKeys = [];
    const resolvedOutputFields = new Set();
    for (const item of successfulResolutions(resolutions)) {
      const outputField = item.outputField || "id";
      bodyArgs[outputField] = item.id;
      resolvedOutputFields.add(outputField);
      omitKeys.push(...(item.omitKeys || []));
    }
    const effectiveOmitKeys = omitKeys.filter((key) => !resolvedOutputFields.has(key));
    const body = buildBody(
      bodyArgs,
      effectiveOmitKeys.length > 0
        ? effectiveOmitKeys
        : def.resolveAccess
          ? normalizeResolveAccessConfig(def.resolveAccess).omitKeys
          : []
    );
    let res;
    try {
      res = await ctx.client.call(def.method, body, { maxAttempts });
    } catch (err) {
      // Some Outline deployments require comments.update payload in data.text form.
      if (
        def.tool === "comments.update"
        && err instanceof ApiError
        && err.details?.status === 400
        && /data/i.test(String(err.message || ""))
        && typeof args?.text === "string"
        && args?.text.length > 0
        && (args?.data === undefined || args?.data === null)
      ) {
        const fallbackBody = buildBody({
          ...args,
          text: undefined,
          data: { text: args.text },
        });
        res = await ctx.client.call(def.method, fallbackBody, { maxAttempts });
      } else {
        throw err;
      }
    }

    const resolutionPayload = combinedResolutionPayload(resolutions);
    const resolvedIds = {};
    for (const item of successfulResolutions(resolutions)) {
      resolvedIds[item.resultField || item.outputField || "id"] = item.id;
    }

    return {
      tool: def.tool,
      profile: ctx.profile.id,
      result: resolutionPayload
        ? compactValue({
            ...maybeDropPolicies(res.body, !!args.includePolicies),
            ...resolvedIds,
            resolution: resolutionPayload,
          }) || {}
        : maybeDropPolicies(res.body, !!args.includePolicies),
    };
  };
}

function makeRpcContract(def) {
  const resolveConfig = normalizeResolveAccessConfig(def.resolveAccess);
  const entityConfig = normalizeResolveEntityConfig(def.resolveEntity);
  const principalConfig = normalizeResolveEntityConfig(def.resolvePrincipal);
  const isAccessResolver = !!resolveConfig;
  const isEntityResolver = !!entityConfig;
  const hasPrincipalResolver = !!principalConfig;
  const targetIdArg = resolveConfig?.kind === "collection" ? "collectionId" : "documentId";
  const exactIdArg = resolveConfig?.exactKeys?.includes("id") ? "id?: string; " : "";
  const exactTargetText = resolveConfig?.exactKeys?.includes("id") ? `${targetIdArg}/id` : targetIdArg;
  const resolverQueryArg = resolveConfig?.queryKeys?.includes("query")
    ? "query"
    : resolveConfig?.kind === "collection"
      ? "collectionQuery"
      : "documentQuery";
  const entityQueryArg = entityConfig?.queryKeys?.[0] || "query";
  const entityExactArg = entityConfig?.exactKeys?.includes("id") ? "id?: string; " : "";
  const signature = def.signature || (hasPrincipalResolver
    ? `${def.tool}(args: { ${exactIdArg}${targetIdArg}?: string; ${resolverQueryArg}?: string; userId?: string; groupId?: string; userQuery?: string; groupQuery?: string; userRefs?: string[]; groupRefs?: string[]; includePolicies?: boolean; maxAttempts?: number${def.mutating ? "; performAction?: boolean" : ""} })`
    : isAccessResolver
    ? `${def.tool}(args: { ${exactIdArg}${targetIdArg}?: string; ${resolverQueryArg}?: string; refs?: string[]; urlId?: string; url?: string; limit?: number; offset?: number; includePolicies?: boolean; maxAttempts?: number })`
    : isEntityResolver
      ? `${def.tool}(args: { ${entityExactArg}${entityQueryArg}?: string; refs?: string[]; limit?: number; offset?: number; includePolicies?: boolean; maxAttempts?: number${def.mutating ? "; performAction?: boolean" : ""} })`
    : `${def.tool}(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number${
    def.mutating ? "; performAction?: boolean" : ""
  } })`);
  const bestPractices = def.bestPractices || [
    hasPrincipalResolver
      ? `Pass exact IDs when known, or combine target refs with ${principalConfig.type}Query/${principalConfig.type}Refs to resolve remembered ${principalConfig.type}s first.`
      : isAccessResolver
      ? `Pass ${exactTargetText} for exact calls, or ${resolverQueryArg}/refs/url/urlId to resolve remembered targets first.`
      : isEntityResolver
        ? `Pass ${entityConfig.exactKeys?.includes("id") ? "id" : "exact IDs"} for exact calls, or ${entityQueryArg}/refs to resolve remembered ${entityConfig.type}s first.`
      : "Prefer minimal payloads to keep responses deterministic and token-efficient.",
    ...(def.mutating
      ? ["This tool is action-gated; set performAction=true only for explicitly confirmed mutations."]
      : ["Use includePolicies=true only when policy details are required."]),
  ];
  return {
    signature,
    description: def.description,
    usageExample: def.usageExample || {
      tool: def.tool,
      args: defaultUsageArgs(def),
    },
    bestPractices,
    handler: makeRpcHandler(def),
  };
}

const RPC_WRAPPER_DEFS = [
  {
    tool: "shares.list",
    method: "shares.list",
    description: "List shares, optionally resolving a remembered document first.",
    resolveAccess: {
      kind: "document",
      outputField: "documentId",
      exactKeys: ["documentId"],
      required: false,
      queryKeys: ["documentQuery"],
      arrayQueryKeys: ["documentQueries"],
      preserveQuery: true,
    },
  },
  {
    tool: "shares.info",
    method: "shares.info",
    description: "Get share details by share ID, document ID, or remembered document reference.",
    resolveAccess: {
      kind: "document",
      outputField: "documentId",
      exactKeys: ["documentId"],
      required: false,
      queryKeys: ["query", "documentQuery"],
      arrayQueryKeys: ["queries", "documentQueries"],
    },
  },
  {
    tool: "shares.create",
    method: "shares.create",
    description: "Create a share for a document ID or remembered document reference.",
    signature:
      "shares.create(args: { documentId?: string; query?: string; documentQuery?: string; refs?: string[]; shareId?: string; urlId?: string; url?: string; includeChildDocuments?: boolean; published?: boolean; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })",
    usageExample: {
      tool: "shares.create",
      args: {
        documentQuery: "public handbook",
        published: true,
        performAction: true,
      },
    },
    bestPractices: [
      "Pass documentQuery/refs/url/urlId when the user names a document but the exact ID is unknown.",
      "Use documentId for deterministic automation when already known.",
      "Confirm the target document before creating public share links in high-risk workspaces.",
      "This tool is action-gated; set performAction=true only for explicitly confirmed mutations.",
    ],
    mutating: true,
    resolveAccess: {
      kind: "document",
      outputField: "documentId",
      exactKeys: ["documentId"],
      required: true,
      queryKeys: ["query", "documentQuery", "documentRef", "shareId", "urlId", "url"],
      arrayQueryKeys: ["queries", "documentQueries", "documentRefs", "refs", "shareIds", "urlIds", "urls"],
    },
  },
  { tool: "shares.update", method: "shares.update", description: "Update a share.", mutating: true },
  { tool: "shares.revoke", method: "shares.revoke", description: "Revoke a share.", mutating: true },
  {
    tool: "templates.list",
    method: "templates.list",
    description: "List templates, optionally resolving a remembered collection filter first.",
    resolveAccess: {
      kind: "collection",
      outputField: "collectionId",
      exactKeys: ["collectionId"],
      required: false,
      queryKeys: ["collectionQuery", "collectionRef"],
      arrayQueryKeys: ["collectionQueries", "collectionRefs"],
    },
  },
  {
    tool: "templates.info",
    method: "templates.info",
    description: "Get template details by ID or remembered template name.",
    resolveEntity: {
      type: "template",
      outputField: "id",
      resultField: "templateId",
      exactKeys: ["id"],
      queryKeys: ["templateQuery", "templateRef", "query"],
      arrayQueryKeys: ["templateQueries", "templateRefs", "refs", "queries"],
    },
  },
  { tool: "templates.create", method: "templates.create", description: "Create a template.", mutating: true },
  {
    tool: "templates.update",
    method: "templates.update",
    description: "Update a template by ID or remembered template name.",
    mutating: true,
    resolveEntity: {
      type: "template",
      outputField: "id",
      resultField: "templateId",
      exactKeys: ["id"],
      queryKeys: ["templateQuery", "templateRef"],
      arrayQueryKeys: ["templateQueries", "templateRefs", "refs"],
    },
  },
  {
    tool: "templates.delete",
    method: "templates.delete",
    description: "Delete a template by ID or remembered template name.",
    mutating: true,
    resolveEntity: {
      type: "template",
      outputField: "id",
      resultField: "templateId",
      exactKeys: ["id"],
      queryKeys: ["templateQuery", "templateRef"],
      arrayQueryKeys: ["templateQueries", "templateRefs", "refs"],
    },
  },
  {
    tool: "templates.restore",
    method: "templates.restore",
    description: "Restore a template by ID or remembered template name.",
    mutating: true,
    resolveEntity: {
      type: "template",
      outputField: "id",
      resultField: "templateId",
      exactKeys: ["id"],
      queryKeys: ["templateQuery", "templateRef"],
      arrayQueryKeys: ["templateQueries", "templateRefs", "refs"],
    },
  },
  {
    tool: "templates.duplicate",
    method: "templates.duplicate",
    description: "Duplicate a template by ID or remembered template name.",
    mutating: true,
    resolveEntity: {
      type: "template",
      outputField: "id",
      resultField: "templateId",
      exactKeys: ["id"],
      queryKeys: ["templateQuery", "templateRef"],
      arrayQueryKeys: ["templateQueries", "templateRefs", "refs"],
    },
  },
  { tool: "documents.templatize", method: "documents.templatize", description: "Convert a document into a template.", mutating: true },
  { tool: "documents.import", method: "documents.import", description: "Import a document from JSON payload.", mutating: true },
  {
    tool: "comments.list",
    method: "comments.list",
    description: "List comments, optionally resolving a remembered document first.",
    resolveAccess: {
      kind: "document",
      outputField: "documentId",
      exactKeys: ["documentId"],
      required: false,
      queryKeys: ["query", "documentQuery"],
      arrayQueryKeys: ["queries", "documentQueries"],
    },
  },
  { tool: "comments.info", method: "comments.info", description: "Get comment details." },
  {
    tool: "comments.create",
    method: "comments.create",
    description: "Create a comment on a document ID or remembered document reference.",
    signature:
      "comments.create(args: { documentId?: string; query?: string; documentQuery?: string; refs?: string[]; shareId?: string; urlId?: string; url?: string; text?: string; data?: object; parentCommentId?: string; includePolicies?: boolean; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean })",
    usageExample: {
      tool: "comments.create",
      args: {
        query: "incident runbook",
        text: "Looks good.",
        performAction: true,
      },
    },
    bestPractices: [
      "Pass query/refs/url/urlId when adding a comment to a remembered document without a separate lookup.",
      "Use parentCommentId for replies and text for simple comments.",
      "Inspect the returned documentId and resolution fields when the target was resolved from memory.",
      "This tool is action-gated; set performAction=true only for explicitly confirmed mutations.",
    ],
    mutating: true,
    resolveAccess: {
      kind: "document",
      outputField: "documentId",
      exactKeys: ["documentId"],
      required: true,
      queryKeys: ["query", "documentQuery", "documentRef", "shareId", "urlId", "url"],
      arrayQueryKeys: ["queries", "documentQueries", "documentRefs", "refs", "shareIds", "urlIds", "urls"],
    },
  },
  { tool: "comments.update", method: "comments.update", description: "Update a comment.", mutating: true },
  { tool: "comments.delete", method: "comments.delete", description: "Delete a comment.", mutating: true },
  {
    tool: "events.list",
    method: "events.list",
    description: "List workspace events, optionally resolving remembered document, collection, and actor filters first.",
    signature:
      "events.list(args?: { documentId?: string; documentQuery?: string; refs?: string[]; collectionId?: string; collectionQuery?: string; actorId?: string; userQuery?: string; name?: string; auditLog?: boolean; limit?: number; offset?: number; includePolicies?: boolean; maxAttempts?: number })",
    usageExample: {
      tool: "events.list",
      args: {
        documentQuery: "incident runbook",
        userQuery: "Alice Example",
        auditLog: true,
        limit: 20,
      },
    },
    bestPractices: [
      "Pass exact IDs when known, or use documentQuery/refs/url/urlId, collectionQuery/collectionRefs, and userQuery/userRefs to resolve remembered audit filters first.",
      "Use auditLog=true when you need audit-grade event context for a scoped document or actor.",
      "Keep limit small and paginate with offset for low-token history review.",
    ],
    resolveAccess: {
      kind: "document",
      outputField: "documentId",
      exactKeys: ["documentId"],
      required: false,
      queryKeys: ["documentQuery", "documentRef"],
      arrayQueryKeys: ["documentQueries", "documentRefs", "refs"],
    },
    resolveEntity: {
      type: "collection",
      outputField: "collectionId",
      resultField: "collectionId",
      exactKeys: ["collectionId"],
      queryKeys: ["collectionQuery", "collectionRef"],
      arrayQueryKeys: ["collectionQueries", "collectionRefs"],
    },
    resolvePrincipal: {
      type: "user",
      outputField: "actorId",
      resultField: "actorId",
      exactKeys: ["actorId"],
      queryKeys: ["userQuery", "userRef"],
      arrayQueryKeys: ["userQueries", "userRefs"],
    },
  },
  { tool: "oauth_clients.list", method: "oauthClients.list", description: "List OAuth clients." },
  { tool: "oauth_clients.info", method: "oauthClients.info", description: "Get OAuth client details." },
  { tool: "oauth_clients.create", method: "oauthClients.create", description: "Create an OAuth client.", mutating: true },
  { tool: "oauth_clients.update", method: "oauthClients.update", description: "Update an OAuth client.", mutating: true },
  {
    tool: "oauth_clients.rotate_secret",
    method: "oauthClients.rotate_secret",
    description: "Rotate an OAuth client secret.",
    mutating: true,
  },
  { tool: "oauth_clients.delete", method: "oauthClients.delete", description: "Delete an OAuth client.", mutating: true },
  {
    tool: "oauth_authentications.list",
    method: "oauthAuthentications.list",
    description: "List OAuth authentications.",
  },
  {
    tool: "oauth_authentications.delete",
    method: "oauthAuthentications.delete",
    description: "Delete an OAuth authentication.",
    mutating: true,
  },
  {
    tool: "oauthClients.delete",
    method: "oauthClients.delete",
    description: "Compatibility alias for oauth_clients.delete.",
    mutating: true,
  },
  {
    tool: "oauthAuthentications.delete",
    method: "oauthAuthentications.delete",
    description: "Compatibility alias for oauth_authentications.delete.",
    mutating: true,
  },
  { tool: "data_attributes.list", method: "dataAttributes.list", description: "List data attributes." },
  { tool: "data_attributes.info", method: "dataAttributes.info", description: "Get data attribute details." },
  { tool: "data_attributes.create", method: "dataAttributes.create", description: "Create a data attribute.", mutating: true },
  { tool: "data_attributes.update", method: "dataAttributes.update", description: "Update a data attribute.", mutating: true },
  { tool: "data_attributes.delete", method: "dataAttributes.delete", description: "Delete a data attribute.", mutating: true },
  { tool: "revisions.info", method: "revisions.info", description: "Get revision details." },
  {
    tool: "documents.archived",
    method: "documents.archived",
    description: "List archived documents, optionally resolving a remembered collection filter first.",
    resolveAccess: {
      kind: "collection",
      outputField: "collectionId",
      exactKeys: ["collectionId"],
      required: false,
      queryKeys: ["collectionQuery", "collectionRef"],
      arrayQueryKeys: ["collectionQueries", "collectionRefs"],
    },
  },
  {
    tool: "documents.deleted",
    method: "documents.deleted",
    description: "List deleted documents, optionally resolving a remembered collection filter first.",
    resolveAccess: {
      kind: "collection",
      outputField: "collectionId",
      exactKeys: ["collectionId"],
      required: false,
      queryKeys: ["collectionQuery", "collectionRef"],
      arrayQueryKeys: ["collectionQueries", "collectionRefs"],
    },
  },
  { tool: "documents.archive", method: "documents.archive", description: "Archive a document.", mutating: true },
  { tool: "documents.restore", method: "documents.restore", description: "Restore a document.", mutating: true },
  {
    tool: "documents.permanent_delete",
    method: "documents.permanent_delete",
    description: "Permanently delete a document.",
    mutating: true,
  },
  { tool: "documents.empty_trash", method: "documents.empty_trash", description: "Empty document trash.", mutating: true },
  { tool: "webhooks.list", method: "webhooks.list", description: "List webhooks." },
  { tool: "webhooks.info", method: "webhooks.info", description: "Get webhook details." },
  { tool: "webhooks.create", method: "webhooks.create", description: "Create a webhook.", mutating: true },
  { tool: "webhooks.update", method: "webhooks.update", description: "Update a webhook.", mutating: true },
  { tool: "webhooks.delete", method: "webhooks.delete", description: "Delete a webhook.", mutating: true },
  { tool: "users.list", method: "users.list", description: "List users." },
  {
    tool: "users.info",
    method: "users.info",
    description: "Get user details by ID/email or remembered user reference.",
    resolveEntity: {
      type: "user",
      resultField: "userId",
      passthroughKeys: ["ids", "email"],
    },
  },
  { tool: "users.invite", method: "users.invite", description: "Invite a user.", mutating: true },
  {
    tool: "users.update_role",
    method: "users.update_role",
    description: "Update a user's workspace role.",
    mutating: true,
  },
  { tool: "users.activate", method: "users.activate", description: "Activate a user.", mutating: true },
  { tool: "users.suspend", method: "users.suspend", description: "Suspend a user.", mutating: true },
  { tool: "groups.list", method: "groups.list", description: "List groups." },
  {
    tool: "groups.info",
    method: "groups.info",
    description: "Get group details by ID or remembered group reference.",
    resolveEntity: {
      type: "group",
      resultField: "groupId",
      passthroughKeys: ["ids"],
    },
  },
  {
    tool: "groups.memberships",
    method: "groups.memberships",
    description: "Resolve a group and list group user memberships.",
    resolveEntity: {
      type: "group",
      resultField: "groupId",
    },
  },
  { tool: "groups.create", method: "groups.create", description: "Create a group.", mutating: true },
  { tool: "groups.update", method: "groups.update", description: "Update a group.", mutating: true },
  { tool: "groups.delete", method: "groups.delete", description: "Delete a group.", mutating: true },
  {
    tool: "groups.add_user",
    method: "groups.add_user",
    description: "Resolve a group and user before adding the user to the group.",
    mutating: true,
    resolveEntity: {
      type: "group",
      outputField: "id",
      resultField: "groupId",
      exactKeys: ["id", "groupId"],
      queryKeys: ["groupQuery", "groupRef"],
      arrayQueryKeys: ["groupQueries", "groupRefs"],
    },
    resolvePrincipal: {
      type: "user",
      outputField: "userId",
      resultField: "userId",
      exactKeys: ["userId"],
      queryKeys: ["userQuery", "userRef"],
      arrayQueryKeys: ["userQueries", "userRefs"],
    },
  },
  {
    tool: "groups.remove_user",
    method: "groups.remove_user",
    description: "Resolve a group and user before removing the user from the group.",
    mutating: true,
    resolveEntity: {
      type: "group",
      outputField: "id",
      resultField: "groupId",
      exactKeys: ["id", "groupId"],
      queryKeys: ["groupQuery", "groupRef"],
      arrayQueryKeys: ["groupQueries", "groupRefs"],
    },
    resolvePrincipal: {
      type: "user",
      outputField: "userId",
      resultField: "userId",
      exactKeys: ["userId"],
      queryKeys: ["userQuery", "userRef"],
      arrayQueryKeys: ["userQueries", "userRefs"],
    },
  },
  {
    tool: "collections.memberships",
    method: "collections.memberships",
    description: "Resolve a collection and list collection user memberships.",
    resolveAccess: "collection",
  },
  {
    tool: "collections.group_memberships",
    method: "collections.group_memberships",
    description: "Resolve a collection and list collection group memberships.",
    resolveAccess: "collection",
  },
  {
    tool: "collections.add_user",
    method: "collections.add_user",
    description: "Resolve a collection and user before adding collection access.",
    mutating: true,
    resolveAccess: "collection",
    resolvePrincipal: {
      type: "user",
      outputField: "userId",
      resultField: "userId",
      exactKeys: ["userId"],
      queryKeys: ["userQuery", "userRef"],
      arrayQueryKeys: ["userQueries", "userRefs"],
    },
  },
  {
    tool: "collections.remove_user",
    method: "collections.remove_user",
    description: "Resolve a collection and user before removing collection access.",
    mutating: true,
    resolveAccess: "collection",
    resolvePrincipal: {
      type: "user",
      outputField: "userId",
      resultField: "userId",
      exactKeys: ["userId"],
      queryKeys: ["userQuery", "userRef"],
      arrayQueryKeys: ["userQueries", "userRefs"],
    },
  },
  {
    tool: "collections.add_group",
    method: "collections.add_group",
    description: "Resolve a collection and group before adding group collection access.",
    mutating: true,
    resolveAccess: "collection",
    resolvePrincipal: {
      type: "group",
      outputField: "groupId",
      resultField: "groupId",
      exactKeys: ["groupId"],
      queryKeys: ["groupQuery", "groupRef"],
      arrayQueryKeys: ["groupQueries", "groupRefs"],
    },
  },
  {
    tool: "collections.remove_group",
    method: "collections.remove_group",
    description: "Resolve a collection and group before removing group collection access.",
    mutating: true,
    resolveAccess: "collection",
    resolvePrincipal: {
      type: "group",
      outputField: "groupId",
      resultField: "groupId",
      exactKeys: ["groupId"],
      queryKeys: ["groupQuery", "groupRef"],
      arrayQueryKeys: ["groupQueries", "groupRefs"],
    },
  },
  {
    tool: "documents.users",
    method: "documents.users",
    description: "Resolve a document and list users with access to it.",
    resolveAccess: "document",
  },
  {
    tool: "documents.memberships",
    method: "documents.memberships",
    description: "Resolve a document and list document user memberships.",
    resolveAccess: "document",
  },
  {
    tool: "documents.group_memberships",
    method: "documents.group_memberships",
    description: "Resolve a document and list document group memberships.",
    resolveAccess: "document",
  },
  {
    tool: "documents.add_user",
    method: "documents.add_user",
    description: "Resolve a document and user before adding document access.",
    mutating: true,
    resolveAccess: "document",
    resolvePrincipal: {
      type: "user",
      outputField: "userId",
      resultField: "userId",
      exactKeys: ["userId"],
      queryKeys: ["userQuery", "userRef"],
      arrayQueryKeys: ["userQueries", "userRefs"],
    },
  },
  {
    tool: "documents.remove_user",
    method: "documents.remove_user",
    description: "Resolve a document and user before removing document access.",
    mutating: true,
    resolveAccess: "document",
    resolvePrincipal: {
      type: "user",
      outputField: "userId",
      resultField: "userId",
      exactKeys: ["userId"],
      queryKeys: ["userQuery", "userRef"],
      arrayQueryKeys: ["userQueries", "userRefs"],
    },
  },
  {
    tool: "documents.add_group",
    method: "documents.add_group",
    description: "Resolve a document and group before adding group document access.",
    mutating: true,
    resolveAccess: "document",
    resolvePrincipal: {
      type: "group",
      outputField: "groupId",
      resultField: "groupId",
      exactKeys: ["groupId"],
      queryKeys: ["groupQuery", "groupRef"],
      arrayQueryKeys: ["groupQueries", "groupRefs"],
    },
  },
  {
    tool: "documents.remove_group",
    method: "documents.remove_group",
    description: "Resolve a document and group before removing group document access.",
    mutating: true,
    resolveAccess: "document",
    resolvePrincipal: {
      type: "group",
      outputField: "groupId",
      resultField: "groupId",
      exactKeys: ["groupId"],
      queryKeys: ["groupQuery", "groupRef"],
      arrayQueryKeys: ["groupQueries", "groupRefs"],
    },
  },
  { tool: "file_operations.list", method: "fileOperations.list", description: "List file operations." },
  { tool: "file_operations.info", method: "fileOperations.info", description: "Get file operation details." },
  { tool: "file_operations.delete", method: "fileOperations.delete", description: "Delete a file operation.", mutating: true },
];

const RPC_TOOLS = Object.fromEntries(
  RPC_WRAPPER_DEFS.map((def) => [
    def.tool,
    makeRpcContract({
      ...def,
      mutating: !!def.mutating,
    }),
  ])
);

function parseQuestionItem(raw, index) {
  if (typeof raw === "string") {
    const question = raw.trim();
    if (!question) {
      throw new CliError(`questions[${index}] must not be empty`);
    }
    return {
      question,
      body: {},
      documentId: null,
    };
  }

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const question = String(raw.question ?? raw.query ?? "").trim();
    if (!question) {
      throw new CliError(`questions[${index}].question is required`);
    }
    const body = buildBody(raw, ["question", "query"]);
    return {
      question,
      body,
      documentId: body.id || body.documentId || null,
    };
  }

  throw new CliError(`questions[${index}] must be string or object`);
}

function isAnswerEndpointUnsupported(err) {
  if (!(err instanceof ApiError)) {
    return false;
  }
  if (err.details?.status !== 404) {
    return false;
  }
  const url = String(err.details?.url || "").toLowerCase();
  const message = String(err.message || "").toLowerCase();
  return url.includes("documents.answerquestion") || message.includes("answerquestion");
}

function normalizeFallbackAnswerHit(row, contextChars = 220) {
  const doc = row?.document || row || {};
  const context = typeof row?.context === "string" ? row.context : "";
  return compactValue({
    id: doc.id,
    title: doc.title,
    collectionId: doc.collectionId,
    parentDocumentId: doc.parentDocumentId,
    updatedAt: doc.updatedAt,
    publishedAt: doc.publishedAt,
    urlId: doc.urlId,
    ranking: row?.ranking,
    context: context.length > contextChars ? `${context.slice(0, contextChars)}...` : context,
  });
}

function firstAnswerReference(args = {}, keys = [], arrayKeys = []) {
  for (const key of keys) {
    const value = String(args[key] || "").trim();
    if (value) {
      return { key, value };
    }
  }
  for (const key of arrayKeys) {
    if (!Array.isArray(args[key])) {
      continue;
    }
    for (const item of args[key]) {
      const value = String(item || "").trim();
      if (value) {
        return { key, value };
      }
    }
  }
  return null;
}

function answerResolutionFromMemoryCandidate(resolved, ref, config, args = {}) {
  const candidates = resolved.result?.candidates || [];
  const topCandidate = candidates[0] || null;
  const strict = args.strict !== false;
  const strictThreshold = Math.max(0, toInteger(args.strictThreshold, 85));
  const topScore = Number(topCandidate?.score || 0);

  if (!topCandidate) {
    return {
      error: {
        failed: {
          kind: ref.key,
          value: ref.value,
          status: "not_found",
        },
        memory: resolved.result?.memory || null,
      },
    };
  }
  if (strict && topScore < strictThreshold) {
    return {
      error: {
        failed: {
          kind: ref.key,
          value: ref.value,
          status: "low_confidence",
          strictThreshold,
        },
        candidate: topCandidate,
        candidates,
        memory: resolved.result?.memory || null,
      },
    };
  }

  const live = (resolved.result?.live || []).find((item) => item?.ok && item.candidate?.id === topCandidate.id)
    || (resolved.result?.live || [])[0]
    || null;
  if (live && !live.ok) {
    return {
      error: {
        failed: {
          kind: ref.key,
          value: ref.value,
          status: "hydrate_failed",
          error: live.error,
          statusCode: live.status,
        },
        candidate: topCandidate,
        memory: resolved.result?.memory || live.memory || null,
      },
    };
  }

  return {
    id: topCandidate.id,
    resultField: config.resultField,
    resolution: compactValue({
      mode: "memory",
      kind: ref.key,
      value: ref.value,
      id: topCandidate.id,
      name: topCandidate.name,
      email: topCandidate.email,
      candidate: topCandidate,
      live,
      memory: resolved.result?.memory || null,
    }) || { id: topCandidate.id },
  };
}

async function resolveAnswerEntityFilter(ctx, args = {}, config) {
  const exact = String(args[config.idKey] || "").trim();
  if (exact) {
    return { id: exact, resultField: config.resultField };
  }
  const ref = firstAnswerReference(args, config.queryKeys, config.arrayQueryKeys);
  if (!ref) {
    return null;
  }

  const threshold = Math.max(0, toInteger(args.strictThreshold, 85));
  const resolved = await memoryResolveTool(ctx, {
    query: ref.value,
    type: config.type,
    profile: args.profile,
    limit: Math.max(1, toInteger(args.resolveLimit, 5)),
    hydrateLimit: 1,
    maxAgeHours: args.maxAgeHours,
    minScore: args.minScore === undefined && args.strict !== false ? threshold : args.minScore,
    strict: args.strict,
    strictThreshold: args.strictThreshold,
    fallbackSearch: args.fallbackSearch,
    fallbackMinScore: args.fallbackMinScore === undefined && args.strict !== false ? threshold : args.fallbackMinScore,
    fallbackLimit: args.fallbackLimit,
    refresh: args.refresh !== false,
    maxAttempts: args.maxAttempts,
  });

  return {
    ...answerResolutionFromMemoryCandidate(resolved, ref, config, args),
    resultField: config.resultField,
  };
}

async function resolveAnswerDocumentTarget(ctx, args = {}) {
  const exact = String(args.documentId || args.id || "").trim();
  if (exact) {
    return { id: exact, resultField: "documentId" };
  }

  const ref = firstAnswerReference(
    args,
    ["documentQuery", "documentRef", "shareId", "urlId", "url"],
    ["documentQueries", "documentRefs", "refs", "shareIds", "urlIds", "urls"]
  );
  if (!ref) {
    return null;
  }

  const opened = await documentsOpenBatchTool(ctx, compactValue({
    queries: ["documentQuery", "documentQueries"].includes(ref.key) ? [ref.value] : undefined,
    refs: ["documentRef", "documentRefs", "refs"].includes(ref.key) ? [ref.value] : undefined,
    shareIds: ["shareId", "shareIds"].includes(ref.key) ? [ref.value] : undefined,
    urlIds: ["urlId", "urlIds"].includes(ref.key) ? [ref.value] : undefined,
    urls: ["url", "urls"].includes(ref.key) ? [ref.value] : undefined,
    profile: args.profile,
    limit: args.resolveLimit,
    minScore: args.minScore,
    maxAgeHours: args.maxAgeHours,
    refresh: args.refresh,
    strict: args.strict,
    strictThreshold: args.strictThreshold,
    fallbackSearch: args.fallbackSearch,
    fallbackMinScore: args.fallbackMinScore,
    fallbackLimit: args.fallbackLimit,
    fallbackMode: args.fallbackMode,
    collectionId: args.resolveCollectionId || args.collectionId,
    view: "summary",
    concurrency: args.resolveConcurrency,
    hydrateConcurrency: args.resolveHydrateConcurrency,
    maxAttempts: args.maxAttempts,
  }) || {});

  const item = opened.result?.items?.[0] || null;
  if (item?.ok && item.document?.id) {
    return {
      id: item.document.id,
      resultField: "documentId",
      document: item.document,
      resolution: compactValue({
        mode: item.mode || "memory",
        kind: ref.key,
        value: ref.value,
        id: item.document.id,
        title: item.document.title,
        candidate: item.candidate,
        memory: opened.result?.memory || null,
      }) || { id: item.document.id },
    };
  }

  return {
    resultField: "documentId",
    error: compactValue({
      failed: {
        kind: ref.key,
        value: ref.value,
        status: item?.status || "not_found",
        error: item?.error,
      },
      candidate: item?.candidate,
      candidates: item?.candidates,
      memory: opened.result?.memory || null,
    }) || {
      failed: {
        kind: ref.key,
        value: ref.value,
        status: "not_found",
      },
    },
  };
}

function hasAnswerScopeSelectors(args = {}) {
  return !!firstAnswerReference(
    args,
    [
      "id",
      "documentId",
      "documentQuery",
      "documentRef",
      "shareId",
      "urlId",
      "url",
      "collectionId",
      "collectionQuery",
      "collectionRef",
      "userId",
      "userQuery",
      "userRef",
    ],
    [
      "documentQueries",
      "documentRefs",
      "refs",
      "shareIds",
      "urlIds",
      "urls",
      "collectionQueries",
      "collectionRefs",
      "userQueries",
      "userRefs",
    ]
  );
}

async function resolveAnswerScope(ctx, args = {}) {
  const collection = await resolveAnswerEntityFilter(ctx, args, {
    type: "collection",
    idKey: "collectionId",
    resultField: "collectionId",
    queryKeys: ["collectionQuery", "collectionRef"],
    arrayQueryKeys: ["collectionQueries", "collectionRefs"],
  });
  const user = await resolveAnswerEntityFilter(ctx, args, {
    type: "user",
    idKey: "userId",
    resultField: "userId",
    queryKeys: ["userQuery", "userRef"],
    arrayQueryKeys: ["userQueries", "userRefs"],
  });
  const preDocumentFilters = [collection, user].filter(Boolean);
  const failedFilter = preDocumentFilters.find((filter) => filter?.error);
  if (failedFilter) {
    return { error: failedFilter.error, resultField: failedFilter.resultField };
  }

  const document = await resolveAnswerDocumentTarget(ctx, {
    ...args,
    collectionId: collection?.id || args.collectionId,
  });

  const filters = [document, collection, user].filter(Boolean);
  const failed = filters.find((filter) => filter?.error);
  if (failed) {
    return { error: failed.error, resultField: failed.resultField };
  }

  const resolution = {};
  for (const filter of filters) {
    if (filter.resolution) {
      resolution[filter.resultField] = filter.resolution;
    }
  }

  return {
    args: compactValue({
      ...args,
      documentId: document?.id || args.documentId || args.id,
      collectionId: collection?.id || args.collectionId,
      userId: user?.id || args.userId,
    }) || {},
    document: document?.document || null,
    resolution: Object.keys(resolution).length > 0 ? resolution : null,
  };
}

function buildAnswerEndpointBody(args = {}, question) {
  return {
    ...buildBody(args, ["question", "query", "limit", ...ANSWER_RESOLVE_ARG_KEYS]),
    query: question,
  };
}

function buildAnswerResolutionMiss(tool, ctx, question, prepared) {
  return {
    tool,
    profile: ctx.profile.id,
    result: compactValue({
      ok: false,
      status: prepared.error?.failed?.status || "not_found",
      [prepared.resultField || "filterId"]: "",
      question,
      resolution: prepared.error,
      documents: [],
    }) || {},
  };
}

async function buildAnswerFallbackResult(ctx, question, args = {}, prepared = {}) {
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const contextChars = Math.max(80, toInteger(args.contextChars, 220));
  const limit = Math.max(1, Math.min(8, toInteger(args.limit, 5)));
  const scopedDocumentId = args.documentId || args.id;

  if (scopedDocumentId) {
    if (prepared.document?.id === scopedDocumentId) {
      const document = normalizeFallbackAnswerHit(prepared.document, contextChars);
      return {
        question,
        answer: "",
        noAnswerReason: "documents.answerQuestion is unsupported by this Outline deployment; returning the scoped document as retrieval evidence instead.",
        unsupported: true,
        fallbackUsed: true,
        fallbackTool: "documents.info",
        fallbackSuggestion: {
          tool: "documents.info",
          args: compactValue({
            id: scopedDocumentId,
            view: "summary",
          }),
        },
        resolution: prepared.resolution,
        documents: document ? [document] : [],
        retrieval: {
          query: question,
          result: {
            ok: true,
            data: document,
          },
        },
      };
    }

    const res = await ctx.client.call("documents.info", { id: scopedDocumentId }, { maxAttempts });
    const document = normalizeFallbackAnswerHit(res.body?.data, contextChars);
    return {
      question,
      answer: "",
      noAnswerReason: "documents.answerQuestion is unsupported by this Outline deployment; returning the scoped document as retrieval evidence instead.",
      unsupported: true,
      fallbackUsed: true,
      fallbackTool: "documents.info",
      fallbackSuggestion: {
        tool: "documents.info",
        args: compactValue({
          id: scopedDocumentId,
          view: "summary",
        }),
      },
      documents: document ? [document] : [],
      resolution: prepared.resolution,
      retrieval: {
        query: question,
        result: compactValue({
          ...maybeDropPolicies(res.body, !!args.includePolicies),
          data: document,
        }),
      },
    };
  }

  const body = compactValue({
    query: question,
    collectionId: args.collectionId,
    userId: args.userId,
    shareId: args.shareId,
    statusFilter: args.statusFilter,
    limit,
    offset: 0,
    snippetMinWords: toInteger(args.snippetMinWords, 20),
    snippetMaxWords: toInteger(args.snippetMaxWords, 30),
  }) || {};

  const res = await ctx.client.call("documents.search", body, { maxAttempts });
  const payload = maybeDropPolicies(res.body, !!args.includePolicies);
  const hits = Array.isArray(payload?.data) ? payload.data : [];
  const documents = hits.slice(0, Math.min(5, limit)).map((row) => normalizeFallbackAnswerHit(row, contextChars));

  return {
    question,
    answer: "",
    noAnswerReason: "documents.answerQuestion is unsupported by this Outline deployment; returning ranked retrieval results instead.",
    unsupported: true,
    fallbackUsed: true,
    fallbackTool: "documents.search",
    fallbackSuggestion: {
      tool: "documents.search",
      args: compactValue({
        query: question,
        collectionId: args.collectionId,
        documentId: args.documentId || args.id,
        userId: args.userId,
        shareId: args.shareId,
        statusFilter: args.statusFilter,
        limit,
        view: "summary",
      }),
    },
    documents,
    resolution: prepared.resolution,
    retrieval: {
      query: question,
      result: compactValue({
        ...payload,
        data: hits.map((row) => normalizeFallbackAnswerHit(row, contextChars)),
      }),
    },
  };
}

async function documentsAnswerTool(ctx, args = {}) {
  const question = String(args.question ?? args.query ?? "").trim();
  if (!question) {
    throw new CliError("documents.answer requires args.question or args.query");
  }

  const prepared = await resolveAnswerScope(ctx, args);
  if (prepared.error) {
    return buildAnswerResolutionMiss("documents.answer", ctx, question, prepared);
  }

  const body = buildAnswerEndpointBody(prepared.args, question);

  try {
    const res = await ctx.client.call("documents.answerQuestion", body, {
      maxAttempts: toInteger(args.maxAttempts, 2),
    });
    const payload = maybeDropPolicies(res.body, !!args.includePolicies);

    return {
      tool: "documents.answer",
      profile: ctx.profile.id,
      result:
        payload && typeof payload === "object"
          ? compactValue({ question, resolution: prepared.resolution, ...payload }) || { question, ...payload }
          : { question, resolution: prepared.resolution, data: payload },
    };
  } catch (err) {
    if (!isAnswerEndpointUnsupported(err)) {
      throw err;
    }

    return {
      tool: "documents.answer",
      profile: ctx.profile.id,
      result: await buildAnswerFallbackResult(ctx, question, prepared.args, prepared),
    };
  }
}

async function documentsAnswerBatchTool(ctx, args = {}) {
  const rawItems = [];
  if (Array.isArray(args.questions)) {
    rawItems.push(...args.questions);
  }
  if (args.question !== undefined || args.query !== undefined) {
    rawItems.unshift(args.question ?? args.query);
  }

  if (rawItems.length === 0) {
    throw new CliError("documents.answer_batch requires args.question or args.questions[]");
  }

  const basePrepared = await resolveAnswerScope(ctx, args);
  const includePolicies = !!args.includePolicies;
  const maxAttempts = toInteger(args.maxAttempts, 2);
  const concurrency = Math.max(1, Math.min(10, toInteger(args.concurrency, 3)));

  const items = await mapLimit(rawItems, concurrency, async (raw, index) => {
    let parsed;
    let prepared;
    try {
      parsed = parseQuestionItem(raw, index);
      prepared = hasAnswerScopeSelectors(parsed.body)
        ? await resolveAnswerScope(ctx, { ...args, ...parsed.body })
        : basePrepared;
      if (prepared.error) {
        return {
          index,
          ok: false,
          question: parsed.question,
          documentId: parsed.documentId || null,
          error: "Unable to resolve answer scope",
          status: prepared.error?.failed?.status || "not_found",
          resolution: prepared.error,
        };
      }
      const answerArgs = hasAnswerScopeSelectors(parsed.body)
        ? prepared.args
        : compactValue({ ...prepared.args, ...parsed.body }) || prepared.args;
      const body = buildAnswerEndpointBody(answerArgs, parsed.question);
      const res = await ctx.client.call("documents.answerQuestion", body, {
        maxAttempts,
      });
      const payload = maybeDropPolicies(res.body, includePolicies);
      return {
        index,
        ok: true,
        question: parsed.question,
        documentId: body.documentId || parsed.documentId,
        result: compactValue({ resolution: prepared.resolution, ...payload }) || payload,
      };
    } catch (err) {
      if (parsed && isAnswerEndpointUnsupported(err)) {
        try {
          if (prepared.error) {
            return {
              index,
              ok: false,
              question: parsed.question,
              documentId: parsed.documentId || null,
              error: "Unable to resolve answer scope",
              status: prepared.error?.failed?.status || "not_found",
              resolution: prepared.error,
            };
          }
          const fallbackArgs = hasAnswerScopeSelectors(parsed.body)
            ? prepared.args
            : compactValue({ ...prepared.args, ...parsed.body }) || prepared.args;
          return {
            index,
            ok: true,
            question: parsed.question,
            documentId: fallbackArgs.documentId || parsed.documentId,
            result: await buildAnswerFallbackResult(ctx, parsed.question, fallbackArgs, prepared),
          };
        } catch (fallbackErr) {
          if (fallbackErr instanceof ApiError || fallbackErr instanceof CliError) {
            return {
              index,
              ok: false,
              question: parsed.question,
              documentId: parsed.documentId,
              error: fallbackErr.message,
              status: fallbackErr instanceof ApiError ? fallbackErr.details.status : undefined,
            };
          }
          throw fallbackErr;
        }
      }
      if (err instanceof ApiError || err instanceof CliError) {
        return {
          index,
          ok: false,
          question: parsed?.question || (typeof raw === "string" ? raw : undefined),
          documentId: parsed?.documentId || null,
          error: err.message,
          status: err instanceof ApiError ? err.details.status : undefined,
        };
      }
      throw err;
    }
  });

  const failed = items.filter((item) => !item.ok).length;

  return {
    tool: "documents.answer_batch",
    profile: ctx.profile.id,
    result: {
      total: items.length,
      succeeded: items.length - failed,
      failed,
      items,
    },
  };
}

async function documentsAttachmentsTool(ctx, args = {}) {
  const read = await readDocumentForAttachments(ctx, args);
  const doc = read.document;
  if (!doc) {
    return {
      tool: "documents.attachments",
      profile: ctx.profile.id,
      result: {
        ok: false,
        status: "not_found",
        document: null,
        resolution: read.resolution,
        total: 0,
        attachments: [],
      },
    };
  }
  const attachments = extractAttachmentRefsFromText(doc.text || "", ctx.profile?.baseUrl);

  return {
    tool: "documents.attachments",
    profile: ctx.profile.id,
    result: {
      ok: true,
      document: summarizeAttachmentDocument(doc),
      resolution: read.resolution,
      total: attachments.length,
      attachments,
    },
  };
}

async function attachmentsDownloadTool(ctx, args = {}) {
  const id = extractAttachmentId(args.id || args.attachmentId || args.url || args.path);
  if (!id) {
    throw new CliError("attachments.download requires args.id or an attachment redirect args.url/path");
  }

  return {
    tool: "attachments.download",
    profile: ctx.profile.id,
    result: await downloadAttachmentToFile(ctx, args, id),
  };
}

async function documentsDownloadAttachmentsTool(ctx, args = {}) {
  const read = await readDocumentForAttachments(ctx, args);
  const doc = read.document;
  if (!doc) {
    return {
      tool: "documents.download_attachments",
      profile: ctx.profile.id,
      result: {
        ok: false,
        status: "not_found",
        document: null,
        resolution: read.resolution,
        total: 0,
        succeeded: 0,
        failed: 0,
        outputDir: path.resolve(String(args.outputDir || path.join(defaultTmpDir(), "attachments"))),
        items: [],
      },
    };
  }
  const attachments = extractAttachmentRefsFromText(doc.text || "", ctx.profile?.baseUrl);
  const concurrency = Math.max(1, Math.min(8, toInteger(args.concurrency, 3)));
  const items = await mapLimit(attachments, concurrency, async (attachment, index) => {
    try {
      const saved = await downloadAttachmentToFile(ctx, args, attachment.id, index);
      return {
        ...attachment,
        ...saved,
      };
    } catch (err) {
      if (err instanceof ApiError || err instanceof CliError) {
        return {
          ...attachment,
          ok: false,
          error: err.message,
          status: err instanceof ApiError ? err.details.status : undefined,
        };
      }
      throw err;
    }
  });
  const failed = items.filter((item) => !item.ok).length;

  return {
    tool: "documents.download_attachments",
    profile: ctx.profile.id,
    result: {
      ok: failed === 0,
      document: summarizeAttachmentDocument(doc),
      resolution: read.resolution,
      total: attachments.length,
      succeeded: items.length - failed,
      failed,
      outputDir: path.resolve(String(args.outputDir || path.join(defaultTmpDir(), "attachments"))),
      items,
    },
  };
}

async function documentsImportFileTool(ctx, args = {}) {
  assertPerformAction(args, {
    tool: "documents.import_file",
    action: "import a document from local file content",
  });

  const requestedPath = typeof args.filePath === "string" ? args.filePath.trim() : "";
  if (!requestedPath) {
    throw new CliError("documents.import_file requires args.filePath");
  }

  const resolvedPath = path.resolve(requestedPath);
  let stat;
  try {
    stat = await fs.stat(resolvedPath);
  } catch (err) {
    if (err && err.code === "ENOENT") {
      throw new CliError(`Import file not found: ${resolvedPath}`, {
        code: "IMPORT_FILE_NOT_FOUND",
        filePath: resolvedPath,
      });
    }
    throw new CliError(`Unable to access import file: ${resolvedPath}`, {
      code: "IMPORT_FILE_ACCESS_FAILED",
      filePath: resolvedPath,
      reason: err?.message || String(err),
    });
  }

  if (!stat.isFile()) {
    throw new CliError(`Import file path must point to a regular file: ${resolvedPath}`, {
      code: "IMPORT_FILE_INVALID_PATH",
      filePath: resolvedPath,
    });
  }

  let fileBuffer;
  try {
    fileBuffer = await fs.readFile(resolvedPath);
  } catch (err) {
    throw new CliError(`Unable to read import file: ${resolvedPath}`, {
      code: "IMPORT_FILE_READ_FAILED",
      filePath: resolvedPath,
      reason: err?.message || String(err),
    });
  }

  const fileName = path.basename(resolvedPath);
  const contentType =
    typeof args.contentType === "string" && args.contentType.trim().length > 0
      ? args.contentType.trim()
      : "application/octet-stream";

  const form = new FormData();
  form.append("file", new Blob([fileBuffer], { type: contentType }), fileName);

  const body = buildBody(args, ["filePath", "contentType"]);
  for (const key of Object.keys(body).sort((a, b) => a.localeCompare(b))) {
    appendMultipartValue(form, key, body[key]);
  }

  const res = await ctx.client.call("documents.import", form, {
    maxAttempts: toInteger(args.maxAttempts, 1),
    bodyType: "multipart",
  });

  return {
    tool: "documents.import_file",
    profile: ctx.profile.id,
    result: maybeDropPolicies(res.body, !!args.includePolicies),
  };
}

const PLACEHOLDER_TOKEN_PATTERN = /\{\{\s*([A-Za-z0-9._-]+)\s*\}\}/g;

function normalizePlaceholderValues(value = {}) {
  if (value === undefined || value === null) {
    return {};
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new CliError("placeholderValues must be an object with string values");
  }

  const entries = [];
  for (const [rawKey, rawValue] of Object.entries(value)) {
    const key = String(rawKey || "").trim();
    if (!key) {
      throw new CliError("placeholderValues keys must be non-empty strings");
    }
    if (typeof rawValue !== "string") {
      throw new CliError(`placeholderValues.${key} must be a string`);
    }
    entries.push([key, rawValue]);
  }

  entries.sort(([a], [b]) => compareIdAsc(a, b));
  return Object.fromEntries(entries);
}

function collectTemplateTextNodes(root, output = [], path = "$") {
  if (Array.isArray(root)) {
    for (let i = 0; i < root.length; i += 1) {
      collectTemplateTextNodes(root[i], output, `${path}[${i}]`);
    }
    return output;
  }

  if (!root || typeof root !== "object") {
    return output;
  }

  if (root.type === "text" && typeof root.text === "string") {
    output.push({
      path,
      text: root.text,
    });
  }

  for (const key of Object.keys(root).sort((a, b) => a.localeCompare(b))) {
    if (key === "text") {
      continue;
    }
    collectTemplateTextNodes(root[key], output, `${path}.${key}`);
  }

  return output;
}

function sortPlaceholderCountRows(countMap) {
  return Array.from(countMap.entries())
    .map(([key, count]) => ({
      key,
      count,
    }))
    .sort((a, b) => compareIdAsc(a.key, b.key));
}

function collectPlaceholderStatsFromTexts(texts = []) {
  const counts = new Map();
  let tokenCount = 0;
  let textNodeCount = 0;
  let scannedCharacterCount = 0;

  for (const rawText of texts) {
    const text = String(rawText ?? "");
    textNodeCount += 1;
    scannedCharacterCount += text.length;

    const pattern = new RegExp(PLACEHOLDER_TOKEN_PATTERN.source, "g");
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const key = String(match[1] || "").trim();
      if (!key) {
        continue;
      }
      counts.set(key, (counts.get(key) || 0) + 1);
      tokenCount += 1;
    }
  }

  const countsByPlaceholder = sortPlaceholderCountRows(counts);
  const placeholders = countsByPlaceholder.map((item) => item.key);

  return {
    placeholders,
    countsByPlaceholder,
    tokenCount,
    textNodeCount,
    scannedCharacterCount,
    uniquePlaceholderCount: placeholders.length,
  };
}

function replacePlaceholdersInText(text, placeholderValues = {}) {
  const source = String(text ?? "");
  const replacedCounts = new Map();
  const pattern = new RegExp(PLACEHOLDER_TOKEN_PATTERN.source, "g");

  const replacedText = source.replace(pattern, (token, keyRaw) => {
    const key = String(keyRaw || "").trim();
    if (!Object.prototype.hasOwnProperty.call(placeholderValues, key)) {
      return token;
    }
    replacedCounts.set(key, (replacedCounts.get(key) || 0) + 1);
    return placeholderValues[key];
  });

  const replacedByPlaceholder = sortPlaceholderCountRows(replacedCounts);
  return {
    text: replacedText,
    replacedByPlaceholder,
    replacedTokenCount: replacedByPlaceholder.reduce((sum, item) => sum + item.count, 0),
  };
}

function normalizeTemplatePipelineView(view) {
  return view === "full" ? "full" : "summary";
}

function normalizeTemplatePipelineDocument(doc, view = "summary") {
  if (view === "full") {
    return doc;
  }

  return {
    id: doc?.id ? String(doc.id) : "",
    title: doc?.title ? String(doc.title) : "",
    collectionId: doc?.collectionId ? String(doc.collectionId) : "",
    parentDocumentId: doc?.parentDocumentId ? String(doc.parentDocumentId) : "",
    updatedAt: doc?.updatedAt ? String(doc.updatedAt) : "",
    publishedAt: doc?.publishedAt ? String(doc.publishedAt) : "",
    urlId: doc?.urlId ? String(doc.urlId) : "",
    emoji: doc?.emoji ? String(doc.emoji) : "",
  };
}

function stableObject(value) {
  if (Array.isArray(value)) {
    return value.map((item) => stableObject(item));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
      out[key] = stableObject(value[key]);
    }
    return out;
  }
  return value;
}

function compactText(value, maxChars = 180) {
  const trimmed = String(value || "").replace(/\s+/g, " ").trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed.length <= maxChars) {
    return trimmed;
  }
  return `${trimmed.slice(0, maxChars)}...`;
}

function normalizeIsoTimestamp(value, label) {
  if (value === undefined || value === null || value === "") {
    return "";
  }
  const parsed = Date.parse(String(value));
  if (!Number.isFinite(parsed)) {
    throw new CliError(`${label} must be a valid ISO date/time string`);
  }
  return new Date(parsed).toISOString();
}

function compareIsoDesc(a, b) {
  return String(b || "").localeCompare(String(a || ""));
}

function compareIdAsc(a, b) {
  return String(a || "").localeCompare(String(b || ""));
}

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const val = String(raw || "").trim();
    if (!val || seen.has(val)) {
      continue;
    }
    seen.add(val);
    out.push(val);
  }
  return out;
}

function normalizeGraphView(view) {
  if (view === "ids" || view === "full") {
    return view;
  }
  return "summary";
}

function normalizeGraphNode(row, view = "summary") {
  const id = row?.id ? String(row.id) : "";
  if (!id) {
    return null;
  }

  if (view === "full") {
    return row;
  }

  const summary = {
    id,
    title: row?.title ? String(row.title) : "",
    collectionId: row?.collectionId ? String(row.collectionId) : "",
    parentDocumentId: row?.parentDocumentId ? String(row.parentDocumentId) : "",
    updatedAt: row?.updatedAt ? String(row.updatedAt) : "",
    publishedAt: row?.publishedAt ? String(row.publishedAt) : "",
    urlId: row?.urlId ? String(row.urlId) : "",
    emoji: row?.emoji ? String(row.emoji) : "",
  };

  if (view === "ids") {
    return {
      id: summary.id,
      title: summary.title,
    };
  }

  return summary;
}

function scoreGraphNode(row) {
  const fields = [
    "id",
    "title",
    "collectionId",
    "parentDocumentId",
    "updatedAt",
    "publishedAt",
    "urlId",
    "emoji",
    "text",
  ];
  let score = 0;
  for (const field of fields) {
    if (row?.[field]) {
      score += 1;
    }
  }
  return score;
}

function upsertGraphNode(nodesById, row) {
  const id = row?.id ? String(row.id) : "";
  if (!id) {
    return;
  }
  const existing = nodesById.get(id);
  if (!existing) {
    nodesById.set(id, row);
    return;
  }

  const candidateScore = scoreGraphNode(row);
  const existingScore = scoreGraphNode(existing);
  if (candidateScore > existingScore) {
    nodesById.set(id, row);
    return;
  }
  if (candidateScore < existingScore) {
    return;
  }

  if (compareIsoDesc(existing?.updatedAt, row?.updatedAt) > 0) {
    nodesById.set(id, row);
  }
}

function sortGraphEdges(edges = []) {
  return edges.sort((a, b) => {
    const sourceCmp = compareIdAsc(a.sourceId, b.sourceId);
    if (sourceCmp !== 0) {
      return sourceCmp;
    }
    const targetCmp = compareIdAsc(a.targetId, b.targetId);
    if (targetCmp !== 0) {
      return targetCmp;
    }
    const typeCmp = String(a.type || "").localeCompare(String(b.type || ""));
    if (typeCmp !== 0) {
      return typeCmp;
    }
    const queryCmp = String(a.query || "").localeCompare(String(b.query || ""));
    if (queryCmp !== 0) {
      return queryCmp;
    }
    return Number(a.rank || 0) - Number(b.rank || 0);
  });
}

function sortGraphErrors(errors = []) {
  return errors.sort((a, b) => {
    const sourceCmp = compareIdAsc(a.sourceId, b.sourceId);
    if (sourceCmp !== 0) {
      return sourceCmp;
    }
    const typeCmp = String(a.type || "").localeCompare(String(b.type || ""));
    if (typeCmp !== 0) {
      return typeCmp;
    }
    const queryCmp = String(a.query || "").localeCompare(String(b.query || ""));
    if (queryCmp !== 0) {
      return queryCmp;
    }
    const statusCmp = Number(a.status || 0) - Number(b.status || 0);
    if (statusCmp !== 0) {
      return statusCmp;
    }
    return String(a.error || "").localeCompare(String(b.error || ""));
  });
}

function normalizeGraphSourceIds(args = {}) {
  const values = [];
  if (args.id !== undefined && args.id !== null) {
    values.push(args.id);
  }
  if (args.documentId !== undefined && args.documentId !== null) {
    values.push(args.documentId);
  }
  if (args.seedId !== undefined && args.seedId !== null) {
    values.push(args.seedId);
  }
  for (const id of ensureStringArray(args.ids, "ids") || []) {
    values.push(id);
  }
  for (const id of ensureStringArray(args.documentIds, "documentIds") || []) {
    values.push(id);
  }
  for (const id of ensureStringArray(args.seedIds, "seedIds") || []) {
    values.push(id);
  }
  return uniqueStrings(values).sort(compareIdAsc);
}

function normalizeDocumentRefValues(args = {}) {
  const queries = [];
  if (args.query !== undefined && args.query !== null) {
    queries.push(args.query);
  }
  if (args.seedQuery !== undefined && args.seedQuery !== null) {
    queries.push(args.seedQuery);
  }
  queries.push(...(ensureStringArray(args.queries, "queries") || []));
  queries.push(...(ensureStringArray(args.seedQueries, "seedQueries") || []));

  const shareIds = [];
  if (args.shareId !== undefined && args.shareId !== null) {
    shareIds.push(args.shareId);
  }
  if (args.seedShareId !== undefined && args.seedShareId !== null) {
    shareIds.push(args.seedShareId);
  }
  shareIds.push(...(ensureStringArray(args.shareIds, "shareIds") || []));
  shareIds.push(...(ensureStringArray(args.seedShareIds, "seedShareIds") || []));

  const urlIds = [];
  if (args.urlId !== undefined && args.urlId !== null) {
    urlIds.push(args.urlId);
  }
  if (args.seedUrlId !== undefined && args.seedUrlId !== null) {
    urlIds.push(args.seedUrlId);
  }
  urlIds.push(...(ensureStringArray(args.urlIds, "urlIds") || []));
  urlIds.push(...(ensureStringArray(args.seedUrlIds, "seedUrlIds") || []));

  const urls = [];
  if (args.url !== undefined && args.url !== null) {
    urls.push(args.url);
  }
  if (args.seedUrl !== undefined && args.seedUrl !== null) {
    urls.push(args.seedUrl);
  }
  urls.push(...(ensureStringArray(args.urls, "urls") || []));
  urls.push(...(ensureStringArray(args.seedUrls, "seedUrls") || []));

  return {
    refs: [
      ...(ensureStringArray(args.refs, "refs") || []),
      ...(ensureStringArray(args.seedRefs, "seedRefs") || []),
    ],
    queries,
    shareIds,
    urlIds,
    urls,
  };
}

function hasDocumentRefValues(refs) {
  return Object.values(refs).some((items) =>
    Array.isArray(items) && items.some((item) => String(item || "").trim())
  );
}

async function resolveDocumentIdsForRead(ctx, args = {}) {
  const exactIds = normalizeGraphSourceIds(args);
  const refs = normalizeDocumentRefValues(args);
  const resolution = {
    exactIds,
    requested: {
      refs: refs.refs.filter((item) => String(item || "").trim()),
      queries: refs.queries.filter((item) => String(item || "").trim()),
      shareIds: refs.shareIds.filter((item) => String(item || "").trim()),
      urlIds: refs.urlIds.filter((item) => String(item || "").trim()),
      urls: refs.urls.filter((item) => String(item || "").trim()),
    },
    resolved: [],
    failed: [],
    memory: null,
  };

  if (hasDocumentRefValues(refs)) {
    const opened = await documentsOpenBatchTool(ctx, compactValue({
      refs: refs.refs,
      queries: refs.queries,
      shareIds: refs.shareIds,
      urlIds: refs.urlIds,
      urls: refs.urls,
      profile: args.profile,
      limit: args.resolveLimit,
      minScore: args.minScore,
      maxAgeHours: args.maxAgeHours,
      refresh: args.refresh,
      strict: args.strict,
      strictThreshold: args.strictThreshold,
      fallbackSearch: args.fallbackSearch,
      fallbackMinScore: args.fallbackMinScore,
      fallbackLimit: args.fallbackLimit,
      fallbackMode: args.fallbackMode,
      collectionId: args.resolveCollectionId,
      view: "summary",
      concurrency: args.resolveConcurrency,
      hydrateConcurrency: args.resolveHydrateConcurrency,
      maxAttempts: args.maxAttempts,
    }) || {});
    resolution.memory = opened.result?.memory || null;
    for (const item of opened.result?.items || []) {
      if (item?.ok && item.document?.id) {
        resolution.resolved.push({
          index: item.index,
          kind: item.kind,
          value: item.value,
          id: item.document.id,
          title: item.document.title,
          mode: item.mode,
          candidate: item.candidate,
        });
        continue;
      }
      resolution.failed.push({
        index: item?.index,
        kind: item?.kind,
        value: item?.value,
        status: item?.status || "not_found",
        candidate: item?.candidate,
        candidates: item?.candidates,
        error: item?.error,
      });
    }
  }

  const ids = uniqueStrings([
    ...exactIds,
    ...resolution.resolved.map((item) => item.id),
  ]).sort(compareIdAsc);

  return {
    ids,
    resolution,
  };
}

async function resolveCollectionIdForRead(ctx, args = {}) {
  const exactId = args.collectionId ? String(args.collectionId).trim() : "";
  if (exactId) {
    return {
      id: exactId,
      resolution: {
        exactId,
        resolved: null,
        failed: null,
        memory: null,
      },
    };
  }

  const refArgs = compactValue({
    query: args.collectionQuery,
    id: args.collectionRefId,
    urlId: args.collectionUrlId,
    url: args.collectionUrl,
    profile: args.profile,
    limit: args.collectionResolveLimit || args.resolveLimit,
    minScore: args.collectionMinScore ?? args.minScore,
    maxAgeHours: args.collectionMaxAgeHours ?? args.maxAgeHours,
    refresh: args.refresh,
    strict: args.strict,
    strictThreshold: args.collectionStrictThreshold ?? args.strictThreshold,
    fallbackSearch: args.fallbackSearch,
    fallbackMinScore: args.collectionFallbackMinScore ?? args.fallbackMinScore,
    fallbackLimit: args.collectionFallbackLimit ?? args.fallbackLimit,
    view: "summary",
    maxAttempts: args.maxAttempts,
  }) || {};

  if (!refArgs.query && !refArgs.id && !refArgs.urlId && !refArgs.url) {
    return {
      id: "",
      resolution: {
        exactId: "",
        resolved: null,
        failed: null,
        memory: null,
      },
    };
  }

  const opened = await collectionsOpenTool(ctx, refArgs);
  if (opened.result?.ok && opened.result?.collection?.id) {
    return {
      id: opened.result.collection.id,
      resolution: {
        exactId: "",
        resolved: {
          id: opened.result.collection.id,
          name: opened.result.collection.name,
          mode: opened.result.mode,
          candidate: opened.result.candidate,
        },
        failed: null,
        memory: opened.result.memory || null,
      },
    };
  }

  return {
    id: "",
    resolution: {
      exactId: "",
      resolved: null,
      failed: {
        status: opened.result?.status || "not_found",
        candidate: opened.result?.candidate,
        candidates: opened.result?.candidates,
      },
      memory: opened.result?.memory || null,
    },
  };
}

function normalizeGraphSearchQueries(value) {
  return uniqueStrings(ensureStringArray(value, "searchQueries") || []);
}

const DEFAULT_ISSUE_KEY_PATTERN = "[A-Z][A-Z0-9]+-\\d+";
const ISSUE_LINK_PATTERN = /https?:\/\/[^\s<>"'`]+/gi;
const ISSUE_LINK_TRAILING_PUNCTUATION = /[),.;!?]+$/;

function normalizeIssueDomains(value) {
  const raw = ensureStringArray(value, "issueDomains") || [];
  const out = [];
  const seen = new Set();

  for (const item of raw) {
    const normalized = String(item || "")
      .trim()
      .toLowerCase()
      .replace(/^\*\./, "")
      .replace(/\.$/, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }

  return out.sort(compareIdAsc);
}

function normalizeIssueKeyPatternSource(value) {
  if (value === undefined || value === null || value === "") {
    return DEFAULT_ISSUE_KEY_PATTERN;
  }

  const source = String(value).trim();
  if (!source) {
    return DEFAULT_ISSUE_KEY_PATTERN;
  }
  try {
    // Validate custom pattern once and always run with global matching.
    // eslint-disable-next-line no-new
    new RegExp(source, "g");
  } catch (err) {
    throw new CliError(`Invalid keyPattern regex: ${err.message}`);
  }
  return source;
}

function collectIssueKeyMatches(text, keyPatternSource) {
  const sourceText = String(text || "");
  if (!sourceText) {
    return [];
  }

  const out = [];
  const regex = new RegExp(keyPatternSource, "g");
  let match;
  while ((match = regex.exec(sourceText)) !== null) {
    const raw = String(match[0] || "").trim();
    if (raw) {
      out.push(raw.toUpperCase());
    }
    if (match[0] === "") {
      regex.lastIndex += 1;
    }
  }
  return out;
}

function collectIssueLinkMatches(text) {
  const sourceText = String(text || "");
  if (!sourceText) {
    return [];
  }

  const out = [];
  const regex = new RegExp(ISSUE_LINK_PATTERN.source, "gi");
  let match;
  while ((match = regex.exec(sourceText)) !== null) {
    const matchedValue = String(match[0] || "");
    if (!matchedValue) {
      if (match[0] === "") {
        regex.lastIndex += 1;
      }
      continue;
    }

    const sanitized = matchedValue.replace(ISSUE_LINK_TRAILING_PUNCTUATION, "");
    if (!sanitized) {
      continue;
    }

    out.push({
      url: sanitized,
      start: match.index,
      end: match.index + sanitized.length,
    });

    if (match[0] === "") {
      regex.lastIndex += 1;
    }
  }

  return out;
}

function maskIssueLinkRanges(text, ranges = []) {
  const sourceText = String(text || "");
  if (!sourceText || ranges.length === 0) {
    return sourceText;
  }

  const sorted = [...ranges].sort((a, b) => Number(a.start || 0) - Number(b.start || 0));
  let cursor = 0;
  let output = "";

  for (const range of sorted) {
    const start = Math.max(0, Math.min(sourceText.length, Number(range.start || 0)));
    const end = Math.max(start, Math.min(sourceText.length, Number(range.end || start)));
    if (start > cursor) {
      output += sourceText.slice(cursor, start);
    }
    if (end > start) {
      output += " ".repeat(end - start);
    }
    cursor = Math.max(cursor, end);
  }

  if (cursor < sourceText.length) {
    output += sourceText.slice(cursor);
  }
  return output;
}

function normalizeIssueUrl(raw) {
  try {
    const parsed = new URL(String(raw || ""));
    if (!/^https?:$/.test(parsed.protocol)) {
      return null;
    }
    return {
      url: parsed.toString(),
      domain: parsed.hostname.toLowerCase(),
    };
  } catch {
    return null;
  }
}

function matchesIssueDomain(hostname, issueDomains = []) {
  if (!hostname) {
    return false;
  }
  if (!Array.isArray(issueDomains) || issueDomains.length === 0) {
    return true;
  }
  const host = String(hostname).toLowerCase();
  return issueDomains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function sortIssueRefs(rows = []) {
  return rows.sort((a, b) => {
    const keyCmp = compareIdAsc(a.key, b.key);
    if (keyCmp !== 0) {
      return keyCmp;
    }
    const domainCmp = compareIdAsc(a.domain, b.domain);
    if (domainCmp !== 0) {
      return domainCmp;
    }
    const urlCmp = compareIdAsc(a.url, b.url);
    if (urlCmp !== 0) {
      return urlCmp;
    }
    const sourcesCmp = String(a.sources?.join(",") || "").localeCompare(String(b.sources?.join(",") || ""));
    if (sourcesCmp !== 0) {
      return sourcesCmp;
    }
    return Number(a.count || 0) - Number(b.count || 0);
  });
}

function extractIssueRefsFromText(text, options = {}) {
  const sourceText = String(text || "");
  const issueDomains = Array.isArray(options.issueDomains) ? options.issueDomains : [];
  const keyPatternSource = normalizeIssueKeyPatternSource(options.keyPattern);
  const linkMatches = collectIssueLinkMatches(sourceText);
  const maskedText = maskIssueLinkRanges(
    sourceText,
    linkMatches.map((item) => ({
      start: item.start,
      end: item.end,
    }))
  );
  const refMap = new Map();

  const upsertRef = ({ key = "", url = "", domain = "", fromUrl = false, fromKeyPattern = false }) => {
    const normalizedKey = key ? String(key).trim().toUpperCase() : "";
    const normalizedUrl = url ? String(url).trim() : "";
    const normalizedDomain = domain ? String(domain).trim().toLowerCase() : "";
    const rowKey = [normalizedKey, normalizedDomain, normalizedUrl].join("\u0000");

    const existing = refMap.get(rowKey);
    if (!existing) {
      refMap.set(rowKey, {
        key: normalizedKey,
        url: normalizedUrl,
        domain: normalizedDomain,
        fromUrl: fromUrl === true,
        fromKeyPattern: fromKeyPattern === true,
        count: 1,
      });
      return;
    }

    existing.fromUrl = existing.fromUrl || fromUrl === true;
    existing.fromKeyPattern = existing.fromKeyPattern || fromKeyPattern === true;
    existing.count += 1;
  };

  const standaloneKeys = collectIssueKeyMatches(maskedText, keyPatternSource);
  for (const key of standaloneKeys) {
    upsertRef({
      key,
      fromKeyPattern: true,
    });
  }

  for (const match of linkMatches) {
    const normalized = normalizeIssueUrl(match.url);
    if (!normalized || !matchesIssueDomain(normalized.domain, issueDomains)) {
      continue;
    }

    const linkedKeys = uniqueStrings(collectIssueKeyMatches(normalized.url, keyPatternSource));
    if (linkedKeys.length === 0) {
      upsertRef({
        url: normalized.url,
        domain: normalized.domain,
        fromUrl: true,
      });
      continue;
    }

    for (const key of linkedKeys) {
      upsertRef({
        key,
        url: normalized.url,
        domain: normalized.domain,
        fromUrl: true,
        fromKeyPattern: true,
      });
    }
  }

  const refs = sortIssueRefs(
    Array.from(refMap.values()).map((row) => ({
      key: row.key,
      url: row.url,
      domain: row.domain,
      sources: [
        ...(row.fromKeyPattern ? ["key_pattern"] : []),
        ...(row.fromUrl ? ["url"] : []),
      ],
      count: row.count,
    }))
  );

  const keys = uniqueStrings(refs.map((row) => row.key).filter(Boolean)).sort(compareIdAsc);
  return {
    refs,
    keys,
    summary: {
      refCount: refs.length,
      urlRefCount: refs.filter((row) => row.sources.includes("url")).length,
      keyRefCount: refs.filter((row) => row.sources.includes("key_pattern")).length,
      keyCount: keys.length,
      mentionCount: refs.reduce((sum, row) => sum + Number(row.count || 0), 0),
      textLength: sourceText.length,
    },
  };
}

function normalizeIssueDocumentView(view) {
  return normalizeGraphView(view);
}

function normalizeIssueDocument(row, fallbackId, view = "summary") {
  const source = row && typeof row === "object" ? row : {};
  const merged = source.id ? source : { ...source, id: fallbackId };
  return normalizeGraphNode(merged, view);
}

function extractDocumentTextForIssueRefs(row) {
  if (typeof row?.text === "string") {
    return row.text;
  }
  if (row?.data && typeof row.data === "object") {
    const textNodes = collectTemplateTextNodes(row.data);
    return textNodes.map((node) => node.text).join("\n");
  }
  return "";
}

function sortIssueRefErrors(errors = []) {
  return errors.sort((a, b) => {
    const idCmp = compareIdAsc(a.id, b.id);
    if (idCmp !== 0) {
      return idCmp;
    }
    const statusCmp = Number(a.status || 0) - Number(b.status || 0);
    if (statusCmp !== 0) {
      return statusCmp;
    }
    return String(a.error || "").localeCompare(String(b.error || ""));
  });
}

function normalizeIssueRefIds(args = {}) {
  const values = [];
  if (args.id !== undefined && args.id !== null) {
    values.push(args.id);
  }
  for (const id of ensureStringArray(args.ids, "ids") || []) {
    values.push(id);
  }
  return uniqueStrings(values).sort(compareIdAsc);
}

async function collectIssueRefsByIds(ctx, ids, options = {}) {
  const documentIds = uniqueStrings(ids).sort(compareIdAsc);
  const maxAttempts = Math.max(1, toInteger(options.maxAttempts, 2));
  const view = normalizeIssueDocumentView(options.view);
  const issueDomains = normalizeIssueDomains(options.issueDomains);
  const keyPattern = normalizeIssueKeyPatternSource(options.keyPattern);
  const concurrency = Math.min(4, Math.max(1, documentIds.length || 1));

  const items = await mapLimit(documentIds, concurrency, async (id) => {
    try {
      const infoRes = await ctx.client.call("documents.info", { id }, { maxAttempts });
      const row = infoRes.body?.data || { id };
      const text = extractDocumentTextForIssueRefs(row);
      const extraction = extractIssueRefsFromText(text, {
        issueDomains,
        keyPattern,
      });
      return {
        id,
        ok: true,
        document: normalizeIssueDocument(row, id, view),
        refs: extraction.refs,
        keys: extraction.keys,
        summary: extraction.summary,
      };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          id,
          ok: false,
          error: err.message,
          status: err.details.status,
        };
      }
      throw err;
    }
  });

  const documents = items
    .filter((item) => item.ok)
    .sort((a, b) => compareIdAsc(a.id, b.id))
    .map((item) => ({
      document: item.document,
      summary: item.summary,
      keys: item.keys,
      refs: item.refs,
    }));
  const errors = sortIssueRefErrors(
    items
      .filter((item) => !item.ok)
      .map((item) => ({
        id: item.id,
        error: item.error,
        status: item.status,
      }))
  );
  const allKeys = uniqueStrings(
    documents.flatMap((item) => item.keys || []).filter(Boolean)
  ).sort(compareIdAsc);
  const totalMentions = documents.reduce(
    (sum, item) => sum + Number(item.summary?.mentionCount || 0),
    0
  );
  const totalRefCount = documents.reduce((sum, item) => sum + Number(item.summary?.refCount || 0), 0);
  const documentsWithRefs = documents.filter((item) => Number(item.summary?.refCount || 0) > 0).length;

  return {
    issueDomains,
    keyPattern,
    requestedIds: documentIds,
    documents,
    errors,
    summary: {
      documentCount: documents.length,
      documentsWithRefs,
      refCount: totalRefCount,
      keyCount: allKeys.length,
      mentionCount: totalMentions,
    },
    keys: allKeys,
  };
}

async function resolveIssueReportCandidates(ctx, args = {}) {
  const queries = normalizeProbeQueries(args);
  if (queries.length === 0) {
    throw new CliError("documents.issue_ref_report requires args.query or args.queries[]");
  }

  const limit = Math.max(1, Math.min(100, toInteger(args.limit, 10)));
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const collectionId = args.collectionId ? String(args.collectionId) : "";
  const queryConcurrency = Math.min(3, Math.max(1, queries.length));

  const perQuery = await mapLimit(queries, queryConcurrency, async (query) => {
    const hits = [];
    const errors = [];
    const baseBody = compactValue({
      query,
      collectionId: collectionId || undefined,
      limit,
      offset: 0,
    }) || {};

    try {
      const titlesRes = await ctx.client.call("documents.search_titles", baseBody, { maxAttempts });
      const rows = Array.isArray(titlesRes.body?.data) ? titlesRes.body.data : [];
      for (let i = 0; i < rows.length; i += 1) {
        const normalized = normalizeProbeTitleHit(rows[i], i);
        if (normalized) {
          hits.push(normalized);
        }
      }
    } catch (err) {
      if (err instanceof ApiError) {
        errors.push({
          source: "titles",
          error: err.message,
          status: err.details.status,
        });
      } else {
        throw err;
      }
    }

    try {
      const semanticRes = await ctx.client.call(
        "documents.search",
        {
          ...baseBody,
          snippetMinWords: 16,
          snippetMaxWords: 24,
        },
        { maxAttempts }
      );
      const rows = Array.isArray(semanticRes.body?.data) ? semanticRes.body.data : [];
      for (let i = 0; i < rows.length; i += 1) {
        const normalized = normalizeProbeSemanticHit(rows[i], i);
        if (normalized) {
          hits.push(normalized);
        }
      }
    } catch (err) {
      if (err instanceof ApiError) {
        errors.push({
          source: "semantic",
          error: err.message,
          status: err.details.status,
        });
      } else {
        throw err;
      }
    }

    const rankedHits = mergeProbeHits(hits, limit);
    return {
      query,
      hitCount: rankedHits.length,
      hits: rankedHits,
      errors,
    };
  });

  const candidateMap = new Map();
  for (const [queryIndex, queryResult] of perQuery.entries()) {
    for (const hit of queryResult.hits) {
      const existing = candidateMap.get(hit.id);
      if (!existing) {
        candidateMap.set(hit.id, {
          id: hit.id,
          title: hit.title,
          collectionId: hit.collectionId,
          updatedAt: hit.updatedAt,
          publishedAt: hit.publishedAt,
          urlId: hit.urlId,
          ranking: hit.ranking,
          sources: [...(Array.isArray(hit.sources) ? hit.sources : [])].sort((a, b) => a.localeCompare(b)),
          queries: [queryResult.query],
          bestRank: hit.rank,
          firstQueryIndex: queryIndex,
        });
        continue;
      }

      existing.ranking = Math.max(existing.ranking, hit.ranking);
      if (compareIsoDesc(existing.updatedAt, hit.updatedAt) > 0) {
        existing.updatedAt = hit.updatedAt;
        existing.publishedAt = hit.publishedAt;
      }
      if (!existing.queries.includes(queryResult.query)) {
        existing.queries.push(queryResult.query);
        existing.queries.sort((a, b) => a.localeCompare(b));
      }
      for (const source of hit.sources || []) {
        if (!existing.sources.includes(source)) {
          existing.sources.push(source);
        }
      }
      existing.sources.sort((a, b) => a.localeCompare(b));
      existing.bestRank = Math.min(existing.bestRank, hit.rank);
      existing.firstQueryIndex = Math.min(existing.firstQueryIndex, queryIndex);
    }
  }

  const candidates = Array.from(candidateMap.values())
    .sort((a, b) => {
      if (b.ranking !== a.ranking) {
        return b.ranking - a.ranking;
      }
      const updatedCmp = compareIsoDesc(a.updatedAt, b.updatedAt);
      if (updatedCmp !== 0) {
        return updatedCmp;
      }
      if (a.firstQueryIndex !== b.firstQueryIndex) {
        return a.firstQueryIndex - b.firstQueryIndex;
      }
      if (a.bestRank !== b.bestRank) {
        return a.bestRank - b.bestRank;
      }
      return compareIdAsc(a.id, b.id);
    })
    .slice(0, limit)
    .map((candidate, index) => ({
      rank: index + 1,
      id: candidate.id,
      title: candidate.title,
      collectionId: candidate.collectionId,
      updatedAt: candidate.updatedAt,
      publishedAt: candidate.publishedAt,
      urlId: candidate.urlId,
      ranking: candidate.ranking,
      sources: candidate.sources,
      queries: candidate.queries,
    }));

  return {
    queries,
    collectionId,
    limit,
    perQuery,
    candidates,
    candidateIds: candidates.map((item) => item.id),
  };
}

async function fetchGraphSourceDocs(ctx, sourceIds, maxAttempts) {
  const ids = uniqueStrings(sourceIds).sort(compareIdAsc);
  const byId = new Map();
  const errors = [];

  const items = await mapLimit(ids, Math.min(4, Math.max(1, ids.length || 1)), async (id) => {
    try {
      const res = await ctx.client.call("documents.info", { id }, { maxAttempts });
      return {
        id,
        row: res.body?.data || { id },
      };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          id,
          row: { id },
          error: err.message,
          status: err.details.status,
        };
      }
      throw err;
    }
  });

  for (const item of items) {
    byId.set(item.id, item.row);
    if (item.error) {
      errors.push({
        sourceId: item.id,
        type: "source_info",
        query: "",
        status: item.status,
        error: item.error,
      });
    }
  }

  return {
    byId,
    errors: sortGraphErrors(errors),
  };
}

function buildGraphNodeList(nodesById, view = "summary") {
  return Array.from(nodesById.entries())
    .sort(([a], [b]) => compareIdAsc(a, b))
    .map(([id, row]) => {
      const normalized = normalizeGraphNode(row || { id }, view);
      if (normalized) {
        return normalized;
      }
      return normalizeGraphNode({ id }, view);
    })
    .filter(Boolean);
}

async function collectGraphNeighbors(ctx, sourceIds, options = {}) {
  const sortedSourceIds = uniqueStrings(sourceIds).sort(compareIdAsc);
  const includeBacklinks = options.includeBacklinks !== false;
  const includeSearchNeighbors = options.includeSearchNeighbors === true;
  const limitPerSource = Math.max(1, Math.min(100, toInteger(options.limitPerSource, 10)));
  const maxAttempts = Math.max(1, toInteger(options.maxAttempts, 2));
  const explicitSearchQueries = normalizeGraphSearchQueries(options.searchQueries);
  const hydrateSources =
    options.hydrateSources === true ||
    includeSearchNeighbors ||
    options.view === "summary" ||
    options.view === "full";

  const sourceDocsById =
    options.sourceDocsById instanceof Map ? new Map(options.sourceDocsById) : new Map();
  const nodesById = new Map();
  const edgeMap = new Map();
  const errors = [];

  if (hydrateSources) {
    const missing = sortedSourceIds.filter((id) => !sourceDocsById.has(id));
    if (missing.length > 0) {
      const hydrated = await fetchGraphSourceDocs(ctx, missing, maxAttempts);
      for (const [id, row] of hydrated.byId.entries()) {
        sourceDocsById.set(id, row);
      }
      errors.push(...hydrated.errors);
    }
  }

  for (const sourceId of sortedSourceIds) {
    const sourceNode = sourceDocsById.get(sourceId) || { id: sourceId };
    upsertGraphNode(nodesById, sourceNode);

    if (includeBacklinks) {
      try {
        const backlinksRes = await ctx.client.call(
          "documents.list",
          {
            backlinkDocumentId: sourceId,
            limit: limitPerSource,
            offset: 0,
            sort: "updatedAt",
            direction: "DESC",
          },
          { maxAttempts }
        );
        const rows = Array.isArray(backlinksRes.body?.data) ? backlinksRes.body.data : [];

        for (let i = 0; i < rows.length; i += 1) {
          const row = rows[i];
          const targetId = row?.id ? String(row.id) : "";
          if (!targetId || targetId === sourceId) {
            continue;
          }

          upsertGraphNode(nodesById, row);
          const key = `${sourceId}\u0000${targetId}\u0000backlink`;
          const edge = {
            sourceId,
            targetId,
            type: "backlink",
            query: "",
            rank: i + 1,
          };
          const existing = edgeMap.get(key);
          if (!existing || edge.rank < existing.rank) {
            edgeMap.set(key, edge);
          }
        }
      } catch (err) {
        if (err instanceof ApiError) {
          errors.push({
            sourceId,
            type: "backlink",
            query: "",
            status: err.details.status,
            error: err.message,
          });
        } else {
          throw err;
        }
      }
    }

    if (includeSearchNeighbors) {
      let queries = explicitSearchQueries;
      if (queries.length === 0) {
        const inferred = String(sourceNode?.title || "").trim();
        queries = inferred ? [inferred] : [];
      }
      if (queries.length === 0) {
        continue;
      }

      const searchCandidates = new Map();
      for (const query of queries) {
        try {
          const searchRes = await ctx.client.call(
            "documents.search_titles",
            {
              query,
              limit: limitPerSource,
              offset: 0,
            },
            { maxAttempts }
          );
          const rows = Array.isArray(searchRes.body?.data) ? searchRes.body.data : [];

          for (let i = 0; i < rows.length; i += 1) {
            const row = rows[i];
            const targetId = row?.id ? String(row.id) : "";
            if (!targetId || targetId === sourceId) {
              continue;
            }
            upsertGraphNode(nodesById, row);

            const ranking = normalizeProbeRanking(row?.ranking, i);
            const updatedAt = row?.updatedAt ? String(row.updatedAt) : "";
            const existing = searchCandidates.get(targetId);
            if (!existing) {
              searchCandidates.set(targetId, {
                targetId,
                ranking,
                query,
                updatedAt,
              });
              continue;
            }

            if (ranking > existing.ranking) {
              searchCandidates.set(targetId, {
                targetId,
                ranking,
                query,
                updatedAt,
              });
              continue;
            }

            if (
              ranking === existing.ranking &&
              compareIsoDesc(existing.updatedAt, updatedAt) > 0
            ) {
              searchCandidates.set(targetId, {
                targetId,
                ranking,
                query,
                updatedAt,
              });
            }
          }
        } catch (err) {
          if (err instanceof ApiError) {
            errors.push({
              sourceId,
              type: "search",
              query,
              status: err.details.status,
              error: err.message,
            });
          } else {
            throw err;
          }
        }
      }

      const ranked = Array.from(searchCandidates.values())
        .sort((a, b) => {
          if (b.ranking !== a.ranking) {
            return b.ranking - a.ranking;
          }
          const updatedCmp = compareIsoDesc(a.updatedAt, b.updatedAt);
          if (updatedCmp !== 0) {
            return updatedCmp;
          }
          return compareIdAsc(a.targetId, b.targetId);
        })
        .slice(0, limitPerSource);

      for (let i = 0; i < ranked.length; i += 1) {
        const item = ranked[i];
        const key = `${sourceId}\u0000${item.targetId}\u0000search`;
        const edge = {
          sourceId,
          targetId: item.targetId,
          type: "search",
          query: item.query,
          rank: i + 1,
        };
        const existing = edgeMap.get(key);
        if (
          !existing ||
          edge.rank < existing.rank ||
          (edge.rank === existing.rank && edge.query.localeCompare(existing.query) < 0)
        ) {
          edgeMap.set(key, edge);
        }
      }
    }
  }

  return {
    nodesById,
    edges: sortGraphEdges(Array.from(edgeMap.values())),
    errors: sortGraphErrors(errors),
    sourceDocsById,
  };
}

async function documentsBacklinksTool(ctx, args = {}) {
  const resolved = await resolveDocumentIdsForRead(ctx, args);
  const id = resolved.ids[0] || "";
  if (!id) {
    return {
      tool: "documents.backlinks",
      profile: ctx.profile.id,
      result: {
        ok: false,
        status: "not_found",
        data: [],
        resolution: resolved.resolution,
      },
    };
  }

  const view = normalizeGraphView(args.view);
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));

  const res = await ctx.client.call(
    "documents.list",
    compactValue({
      backlinkDocumentId: id,
      limit: toInteger(args.limit, 25),
      offset: toInteger(args.offset, 0),
      sort: args.sort,
      direction: args.direction,
    }) || {},
    { maxAttempts }
  );

  let payload = res.body;
  if (view !== "full" && payload && typeof payload === "object") {
    payload = {
      ...payload,
      data: Array.isArray(payload.data) ? payload.data.map((row) => normalizeGraphNode(row, view)) : [],
    };
  }
  payload = maybeDropPolicies(payload, !!args.includePolicies);
  payload = compactValue({
    ...payload,
    ok: payload?.ok,
    resolution: (resolved.resolution.resolved.length > 0 || resolved.resolution.failed.length > 0)
      ? resolved.resolution
      : undefined,
  }) || {};

  return {
    tool: "documents.backlinks",
    profile: ctx.profile.id,
    result: payload,
  };
}

async function documentsGraphNeighborsTool(ctx, args = {}) {
  const resolved = await resolveDocumentIdsForRead(ctx, args);
  const sourceIds = resolved.ids;
  if (sourceIds.length === 0) {
    return {
      tool: "documents.graph_neighbors",
      profile: ctx.profile.id,
      result: {
        ok: false,
        status: "not_found",
        sourceIds: [],
        resolution: resolved.resolution,
        nodeCount: 0,
        edgeCount: 0,
        nodes: [],
        edges: [],
        errors: [],
      },
    };
  }

  const includeBacklinks = args.includeBacklinks !== false;
  const includeSearchNeighbors = args.includeSearchNeighbors === true;
  if (!includeBacklinks && !includeSearchNeighbors) {
    throw new CliError("documents.graph_neighbors requires includeBacklinks or includeSearchNeighbors");
  }

  const view = normalizeGraphView(args.view);
  const limitPerSource = Math.max(1, Math.min(100, toInteger(args.limitPerSource, 10)));
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const searchQueries = normalizeGraphSearchQueries(args.searchQueries);

  const collected = await collectGraphNeighbors(ctx, sourceIds, {
    includeBacklinks,
    includeSearchNeighbors,
    searchQueries,
    limitPerSource,
    maxAttempts,
    hydrateSources: view !== "ids" || includeSearchNeighbors,
    view,
  });

  const nodes = buildGraphNodeList(collected.nodesById, view);
  const edges = sortGraphEdges(collected.edges);
  const resolution = resolved.resolution.resolved.length > 0 || resolved.resolution.failed.length > 0
    ? resolved.resolution
    : undefined;

  return {
    tool: "documents.graph_neighbors",
    profile: ctx.profile.id,
    result: {
      sourceIds,
      ...(resolution ? { resolution } : {}),
      includeBacklinks,
      includeSearchNeighbors,
      searchQueries,
      limitPerSource,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes,
      edges,
      errors: collected.errors,
    },
  };
}

async function documentsGraphReportTool(ctx, args = {}) {
  const resolved = await resolveDocumentIdsForRead(ctx, args);
  const requestedSeedIds = resolved.ids;
  if (requestedSeedIds.length === 0) {
    return {
      tool: "documents.graph_report",
      profile: ctx.profile.id,
      result: {
        ok: false,
        status: "not_found",
        seedIds: [],
        requestedSeedCount: 0,
        resolution: resolved.resolution,
        depth: Math.max(0, Math.min(6, toInteger(args.depth, 2))),
        exploredDepth: 0,
        maxNodes: Math.max(1, Math.min(500, toInteger(args.maxNodes, 120))),
        includeBacklinks: args.includeBacklinks !== false,
        includeSearchNeighbors: args.includeSearchNeighbors === true,
        limitPerSource: Math.max(1, Math.min(100, toInteger(args.limitPerSource, 10))),
        truncated: false,
        nodeCount: 0,
        edgeCount: 0,
        nodes: [],
        edges: [],
        errors: [],
      },
    };
  }

  const includeBacklinks = args.includeBacklinks !== false;
  const includeSearchNeighbors = args.includeSearchNeighbors === true;
  if (!includeBacklinks && !includeSearchNeighbors) {
    throw new CliError("documents.graph_report requires includeBacklinks or includeSearchNeighbors");
  }

  const depth = Math.max(0, Math.min(6, toInteger(args.depth, 2)));
  const maxNodes = Math.max(1, Math.min(500, toInteger(args.maxNodes, 120)));
  const limitPerSource = Math.max(1, Math.min(100, toInteger(args.limitPerSource, 10)));
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const view = normalizeGraphView(args.view);

  const seedIds = requestedSeedIds.slice(0, maxNodes);
  const visited = new Set(seedIds);
  const nodesById = new Map(seedIds.map((id) => [id, { id }]));
  const edgeMap = new Map();
  const errors = [];

  let sourceDocsById = new Map();
  let frontier = [...seedIds];
  let exploredDepth = 0;
  let truncated = seedIds.length < requestedSeedIds.length;

  for (let level = 0; level < depth && frontier.length > 0; level += 1) {
    const hop = await collectGraphNeighbors(ctx, frontier, {
      includeBacklinks,
      includeSearchNeighbors,
      searchQueries: [],
      limitPerSource,
      maxAttempts,
      sourceDocsById,
      hydrateSources: view !== "ids" || includeSearchNeighbors,
      view,
    });
    sourceDocsById = hop.sourceDocsById;

    for (const [id, row] of hop.nodesById.entries()) {
      if (visited.has(id)) {
        upsertGraphNode(nodesById, row);
      }
    }

    const next = new Set();
    for (const edge of hop.edges) {
      if (!visited.has(edge.sourceId)) {
        continue;
      }

      if (!visited.has(edge.targetId)) {
        if (visited.size >= maxNodes) {
          truncated = true;
          continue;
        }
        visited.add(edge.targetId);
        next.add(edge.targetId);
        upsertGraphNode(nodesById, hop.nodesById.get(edge.targetId) || { id: edge.targetId });
      }

      const key = `${edge.sourceId}\u0000${edge.targetId}\u0000${edge.type}`;
      const existing = edgeMap.get(key);
      if (
        !existing ||
        edge.rank < existing.rank ||
        (edge.rank === existing.rank && String(edge.query || "").localeCompare(String(existing.query || "")) < 0)
      ) {
        edgeMap.set(key, edge);
      }
    }

    for (const error of hop.errors) {
      errors.push({
        ...error,
        hop: level + 1,
      });
    }

    exploredDepth = level + 1;
    frontier = Array.from(next).sort(compareIdAsc);
  }

  for (const id of visited) {
    if (!nodesById.has(id)) {
      upsertGraphNode(nodesById, sourceDocsById.get(id) || { id });
    }
  }

  const allowedIds = new Set(visited);
  const filteredNodes = new Map(
    Array.from(nodesById.entries()).filter(([id]) => allowedIds.has(id))
  );
  const nodes = buildGraphNodeList(filteredNodes, view);
  const edges = sortGraphEdges(
    Array.from(edgeMap.values()).filter(
      (edge) => allowedIds.has(edge.sourceId) && allowedIds.has(edge.targetId)
    )
  );
  const resolution = resolved.resolution.resolved.length > 0 || resolved.resolution.failed.length > 0
    ? resolved.resolution
    : undefined;

  return {
    tool: "documents.graph_report",
    profile: ctx.profile.id,
    result: {
      seedIds,
      requestedSeedCount: requestedSeedIds.length,
      ...(resolution ? { resolution } : {}),
      depth,
      exploredDepth,
      maxNodes,
      includeBacklinks,
      includeSearchNeighbors,
      limitPerSource,
      truncated,
      nodeCount: nodes.length,
      edgeCount: edges.length,
      nodes,
      edges,
      errors: sortGraphErrors(errors),
    },
  };
}

async function documentsIssueRefsTool(ctx, args = {}) {
  const resolved = await resolveDocumentIdsForRead(ctx, args);
  const ids = resolved.ids;
  if (ids.length === 0) {
    return {
      tool: "documents.issue_refs",
      profile: ctx.profile.id,
      result: {
        ok: false,
        status: "not_found",
        requestedIds: [],
        resolution: resolved.resolution,
        documentCount: 0,
        documentsWithRefs: 0,
        refCount: 0,
        keyCount: 0,
        mentionCount: 0,
        keys: [],
        documents: [],
        errors: [],
      },
    };
  }

  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const view = normalizeIssueDocumentView(args.view);

  const extracted = await collectIssueRefsByIds(ctx, ids, {
    issueDomains: args.issueDomains,
    keyPattern: args.keyPattern,
    maxAttempts,
    view,
  });
  const resolution = resolved.resolution.resolved.length > 0 || resolved.resolution.failed.length > 0
    ? resolved.resolution
    : undefined;

  return {
    tool: "documents.issue_refs",
    profile: ctx.profile.id,
    result: {
      requestedIds: extracted.requestedIds,
      ...(resolution ? { resolution } : {}),
      issueDomains: extracted.issueDomains,
      keyPattern: extracted.keyPattern,
      ...extracted.summary,
      keys: extracted.keys,
      documents: extracted.documents,
      errors: extracted.errors,
    },
  };
}

async function documentsIssueRefReportTool(ctx, args = {}) {
  const resolved = await resolveIssueReportCandidates(ctx, args);
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const view = normalizeIssueDocumentView(args.view);
  const extracted = await collectIssueRefsByIds(ctx, resolved.candidateIds, {
    issueDomains: args.issueDomains,
    keyPattern: args.keyPattern,
    maxAttempts,
    view,
  });

  return {
    tool: "documents.issue_ref_report",
    profile: ctx.profile.id,
    result: {
      queries: resolved.queries,
      collectionId: resolved.collectionId,
      limit: resolved.limit,
      candidateCount: resolved.candidates.length,
      candidates: resolved.candidates,
      perQuery: resolved.perQuery,
      issueDomains: extracted.issueDomains,
      keyPattern: extracted.keyPattern,
      ...extracted.summary,
      keys: extracted.keys,
      documents: extracted.documents,
      errors: extracted.errors,
    },
  };
}

async function resolveTemplateSelector(ctx, args = {}, options = {}) {
  const resolved = await resolveEntityId(ctx, args, {
    type: "template",
    outputField: options.outputField || "id",
    resultField: "templateId",
    exactKeys: options.exactKeys || [options.outputField || "id"],
    queryKeys: ["templateQuery", "templateRef", "query"],
    arrayQueryKeys: ["templateQueries", "templateRefs", "refs", "queries"],
  });
  if (resolved?.error) {
    return resolved;
  }
  if (resolved?.id) {
    return resolved;
  }
  const exact = (options.exactKeys || [options.outputField || "id"])
    .map((key) => String(args[key] || "").trim())
    .find(Boolean);
  return exact ? { id: exact, resolution: null } : { id: "" };
}

async function templatesExtractPlaceholdersTool(ctx, args = {}) {
  const resolvedTemplate = await resolveTemplateSelector(ctx, args, {
    outputField: "id",
    exactKeys: ["id"],
  });
  if (resolvedTemplate.error) {
    throw new CliError("templates.extract_placeholders could not resolve template", {
      resolution: resolvedTemplate.error,
    });
  }
  const id = String(resolvedTemplate.id || "").trim();
  if (!id) {
    throw new CliError("templates.extract_placeholders requires args.id or args.templateQuery");
  }

  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const templateRes = await ctx.client.call("templates.info", { id }, { maxAttempts });
  const template = templateRes.body?.data || {};
  const textNodes = collectTemplateTextNodes(template?.data || {});
  const stats = collectPlaceholderStatsFromTexts(textNodes.map((node) => node.text));

  return {
    tool: "templates.extract_placeholders",
    profile: ctx.profile.id,
    result: {
      id: template?.id ? String(template.id) : id,
      templateId: id,
      title: template?.title ? String(template.title) : "",
      resolution: resolvedTemplate.resolution,
      placeholders: stats.placeholders,
      counts: stats.countsByPlaceholder,
      meta: {
        placeholderTokenCount: stats.tokenCount,
        uniquePlaceholderCount: stats.uniquePlaceholderCount,
        textNodeCount: stats.textNodeCount,
        scannedCharacterCount: stats.scannedCharacterCount,
      },
    },
  };
}

async function documentsCreateFromTemplateTool(ctx, args = {}) {
  assertPerformAction(args, {
    tool: "documents.create_from_template",
    action: "create and optionally update a document from template",
  });

  const resolvedTemplate = await resolveTemplateSelector(ctx, args, {
    outputField: "templateId",
    exactKeys: ["templateId"],
  });
  if (resolvedTemplate.error) {
    throw new CliError("documents.create_from_template could not resolve template", {
      resolution: resolvedTemplate.error,
    });
  }
  const templateId = String(resolvedTemplate.id || "").trim();
  if (!templateId) {
    throw new CliError("documents.create_from_template requires args.templateId or args.templateQuery");
  }

  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 1));
  const view = normalizeTemplatePipelineView(args.view);
  const strictPlaceholders = args.strictPlaceholders === true;
  const publishRequested = args.publish === true;
  const placeholderValues = normalizePlaceholderValues(args.placeholderValues);
  const providedPlaceholderKeys = Object.keys(placeholderValues).sort(compareIdAsc);
  const requiresPlaceholderPass = strictPlaceholders || providedPlaceholderKeys.length > 0;
  const createBody = compactValue({
    templateId,
    title: args.title,
    collectionId: args.collectionId,
    parentDocumentId: args.parentDocumentId,
    publish: requiresPlaceholderPass ? false : publishRequested,
  }) || {};

  const createRes = await ctx.client.call("documents.create", createBody, { maxAttempts });
  const createPayload = maybeDropPolicies(createRes.body, !!args.includePolicies);
  let finalPayload = createPayload;
  const createdDoc = createRes.body?.data || {};
  const documentId = createdDoc?.id ? String(createdDoc.id) : "";
  if (!documentId) {
    throw new CliError("documents.create_from_template could not resolve created document id");
  }

  if (!requiresPlaceholderPass) {
    return {
      tool: "documents.create_from_template",
      profile: ctx.profile.id,
      result: {
        success: true,
        strictPlaceholders,
        publishRequested,
        published: publishRequested,
        templateId,
        resolution: resolvedTemplate.resolution,
        document: normalizeTemplatePipelineDocument(finalPayload?.data || createdDoc, view),
        placeholders: {
          providedKeys: [],
          unresolved: [],
          unresolvedCount: 0,
          totalBefore: 0,
          totalAfter: 0,
          replacedByPlaceholder: [],
        },
        actions: {
          create: true,
          updateText: false,
          publish: false,
        },
      },
    };
  }

  let workingDoc = createdDoc;
  if (typeof workingDoc.text !== "string") {
    const infoRes = await ctx.client.call("documents.info", { id: documentId }, { maxAttempts });
    workingDoc = infoRes.body?.data || workingDoc;
  }

  const sourceText = String(workingDoc?.text ?? "");
  const before = collectPlaceholderStatsFromTexts([sourceText]);
  const replaced = replacePlaceholdersInText(sourceText, placeholderValues);
  const after = collectPlaceholderStatsFromTexts([replaced.text]);
  const unresolved = [...after.placeholders];
  const hasUnresolved = unresolved.length > 0;

  let updatedDoc = workingDoc;
  let textUpdated = false;
  if (replaced.text !== sourceText) {
    const updateTextRes = await ctx.client.call(
      "documents.update",
      {
        id: documentId,
        text: replaced.text,
        publish: false,
      },
      { maxAttempts }
    );
    finalPayload = maybeDropPolicies(updateTextRes.body, !!args.includePolicies);
    updatedDoc = updateTextRes.body?.data || updatedDoc;
    textUpdated = true;
  }

  if (strictPlaceholders && hasUnresolved) {
    return {
      tool: "documents.create_from_template",
      profile: ctx.profile.id,
      result: {
        success: false,
        code: "STRICT_PLACEHOLDERS_UNRESOLVED",
        message: "strictPlaceholders=true and unresolved placeholders remain; document left unpublished",
        strictPlaceholders: true,
        publishRequested,
        published: false,
        safeBehavior: "left_unpublished_draft",
        templateId,
        resolution: resolvedTemplate.resolution,
        document: normalizeTemplatePipelineDocument(updatedDoc, view),
        placeholders: {
          providedKeys: providedPlaceholderKeys,
          unresolved,
          unresolvedCount: unresolved.length,
          totalBefore: before.tokenCount,
          totalAfter: after.tokenCount,
          replacedByPlaceholder: replaced.replacedByPlaceholder,
          beforeCounts: before.countsByPlaceholder,
          afterCounts: after.countsByPlaceholder,
        },
        actions: {
          create: true,
          updateText: textUpdated,
          publish: false,
        },
      },
    };
  }

  let published = false;
  let publishApplied = false;
  if (publishRequested) {
    const publishRes = await ctx.client.call(
      "documents.update",
      {
        id: documentId,
        publish: true,
      },
      { maxAttempts }
    );
    finalPayload = maybeDropPolicies(publishRes.body, !!args.includePolicies);
    updatedDoc = publishRes.body?.data || updatedDoc;
    published = true;
    publishApplied = true;
  }

  return {
    tool: "documents.create_from_template",
    profile: ctx.profile.id,
    result: {
      success: true,
      strictPlaceholders,
      publishRequested,
      published,
      templateId,
      resolution: resolvedTemplate.resolution,
      document: normalizeTemplatePipelineDocument(finalPayload?.data || updatedDoc, view),
      placeholders: {
        providedKeys: providedPlaceholderKeys,
        unresolved,
        unresolvedCount: unresolved.length,
        totalBefore: before.tokenCount,
        totalAfter: after.tokenCount,
        replacedByPlaceholder: replaced.replacedByPlaceholder,
      },
      actions: {
        create: true,
        updateText: textUpdated,
        publish: publishApplied,
      },
    },
  };
}

function normalizeCommentContent(row, maxChars = 200) {
  const direct = [row?.text, row?.content, row?.anchorText];
  for (const value of direct) {
    const compacted = compactText(value, maxChars);
    if (compacted) {
      return compacted;
    }
  }

  if (Object.prototype.hasOwnProperty.call(row || {}, "data")) {
    try {
      return compactText(JSON.stringify(stableObject(row?.data ?? null)), maxChars);
    } catch {
      return "";
    }
  }

  return "";
}

function normalizeCommentQueueRow(row, contentChars = 200) {
  const parentCommentId = row?.parentCommentId ? String(row.parentCommentId) : "";
  const createdAt = row?.createdAt ? String(row.createdAt) : "";
  const updatedAt = row?.updatedAt ? String(row.updatedAt) : createdAt;
  return {
    commentId: row?.id ? String(row.id) : "",
    documentId: row?.documentId ? String(row.documentId) : row?.document?.id ? String(row.document.id) : "",
    parentCommentId,
    createdAt,
    updatedAt,
    isReply: parentCommentId.length > 0,
    content: normalizeCommentContent(row, contentChars),
  };
}

function normalizeManifestRow(doc) {
  return {
    id: doc?.id ? String(doc.id) : "",
    title: doc?.title ? String(doc.title) : "",
    updatedAt: doc?.updatedAt ? String(doc.updatedAt) : "",
    publishedAt: doc?.publishedAt ? String(doc.publishedAt) : "",
    collectionId: doc?.collectionId ? String(doc.collectionId) : "",
    urlId: doc?.urlId ? String(doc.urlId) : "",
  };
}

function normalizeProbeRanking(value, index) {
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return Math.max(0, 1000 - index);
}

function normalizeProbeTitleHit(row, index) {
  const doc = normalizeManifestRow(row);
  if (!doc.id) {
    return null;
  }
  return {
    ...doc,
    ranking: normalizeProbeRanking(row?.ranking, index),
    source: "titles",
    context: "",
  };
}

function normalizeProbeSemanticHit(row, index) {
  const doc = normalizeManifestRow(row?.document || row);
  if (!doc.id) {
    return null;
  }
  return {
    ...doc,
    ranking: normalizeProbeRanking(row?.ranking, index),
    source: "semantic",
    context: compactText(row?.context || "", 280),
  };
}

function mergeProbeHits(hits, hitLimit) {
  const byId = new Map();

  for (const hit of hits) {
    if (!hit?.id) {
      continue;
    }
    const existing = byId.get(hit.id);
    if (!existing) {
      byId.set(hit.id, {
        id: hit.id,
        title: hit.title,
        collectionId: hit.collectionId,
        updatedAt: hit.updatedAt,
        publishedAt: hit.publishedAt,
        urlId: hit.urlId,
        ranking: hit.ranking,
        sources: [hit.source],
        context: hit.context,
      });
      continue;
    }

    existing.ranking = Math.max(existing.ranking, hit.ranking);
    if (!existing.sources.includes(hit.source)) {
      existing.sources.push(hit.source);
      existing.sources.sort((a, b) => a.localeCompare(b));
    }
    if (compareIsoDesc(existing.updatedAt, hit.updatedAt) > 0) {
      existing.updatedAt = hit.updatedAt;
      existing.publishedAt = hit.publishedAt;
    }
    if (!existing.context && hit.context) {
      existing.context = hit.context;
    }
  }

  return Array.from(byId.values())
    .sort((a, b) => {
      if (b.ranking !== a.ranking) {
        return b.ranking - a.ranking;
      }
      const updatedCmp = compareIsoDesc(a.updatedAt, b.updatedAt);
      if (updatedCmp !== 0) {
        return updatedCmp;
      }
      return compareIdAsc(a.id, b.id);
    })
    .slice(0, hitLimit)
    .map((hit, index) => ({
      rank: index + 1,
      ...hit,
    }));
}

function summarizePolicies(policies = []) {
  const truthy = new Set();
  const falsy = new Set();

  for (const policy of policies || []) {
    const abilities = policy?.abilities;
    if (!abilities || typeof abilities !== "object") {
      continue;
    }
    for (const [ability, enabled] of Object.entries(abilities)) {
      if (enabled) {
        truthy.add(String(ability));
      } else {
        falsy.add(String(ability));
      }
    }
  }

  return {
    policyCount: Array.isArray(policies) ? policies.length : 0,
    truthyAbilities: Array.from(truthy).sort((a, b) => a.localeCompare(b)),
    falsyAbilities: Array.from(falsy).sort((a, b) => a.localeCompare(b)),
  };
}

function normalizeUserMembershipRow(row) {
  return {
    id: row?.id ? String(row.id) : "",
    userId: row?.userId ? String(row.userId) : row?.user?.id ? String(row.user.id) : "",
    permission: row?.permission ? String(row.permission) : "",
    name: row?.user?.name ? String(row.user.name) : "",
    email: row?.user?.email ? String(row.user.email) : "",
    updatedAt: row?.updatedAt ? String(row.updatedAt) : "",
  };
}

function normalizeGroupMembershipRow(row) {
  return {
    id: row?.id ? String(row.id) : "",
    groupId: row?.groupId ? String(row.groupId) : row?.group?.id ? String(row.group.id) : "",
    permission: row?.permission ? String(row.permission) : "",
    name: row?.group?.name ? String(row.group.name) : "",
    updatedAt: row?.updatedAt ? String(row.updatedAt) : "",
  };
}

function sortMembershipRows(rows) {
  return rows.sort((a, b) => {
    const permissionCmp = String(a.permission || "").localeCompare(String(b.permission || ""));
    if (permissionCmp !== 0) {
      return permissionCmp;
    }
    const principalCmp = String(a.userId || a.groupId || "").localeCompare(String(b.userId || b.groupId || ""));
    if (principalCmp !== 0) {
      return principalCmp;
    }
    return compareIdAsc(a.id, b.id);
  });
}

async function listCollectionDocumentIds(ctx, collectionId, maxAttempts) {
  const pageLimit = 100;
  const maxDocuments = 200;
  const ids = [];
  const seen = new Set();
  let offset = 0;
  let truncated = false;

  while (ids.length < maxDocuments) {
    const res = await ctx.client.call(
      "documents.list",
      {
        collectionId,
        limit: pageLimit,
        offset,
        sort: "updatedAt",
        direction: "DESC",
      },
      { maxAttempts }
    );

    const rows = Array.isArray(res.body?.data) ? res.body.data : [];
    for (const row of rows) {
      const id = row?.id ? String(row.id) : "";
      if (!id || seen.has(id)) {
        continue;
      }
      seen.add(id);
      ids.push(id);
      if (ids.length >= maxDocuments) {
        truncated = true;
        break;
      }
    }

    if (rows.length < pageLimit || truncated) {
      break;
    }

    offset += pageLimit;
  }

  return {
    ids,
    truncated,
  };
}

async function commentsReviewQueueTool(ctx, args = {}) {
  const resolvedDocuments = await resolveDocumentIdsForRead(ctx, args);
  const documentResolution = resolvedDocuments.resolution.resolved.length > 0 || resolvedDocuments.resolution.failed.length > 0
    ? resolvedDocuments.resolution
    : undefined;
  const resolvedCollection = await resolveCollectionIdForRead(ctx, args);
  const collectionResolution = resolvedCollection.resolution.resolved || resolvedCollection.resolution.failed
    ? resolvedCollection.resolution
    : undefined;
  const collectionId = resolvedCollection.id;
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const includeReplies = args.includeReplies !== false;
  const includeAnchorText = !!args.includeAnchorText;
  const limitPerDocument = Math.max(1, Math.min(200, toInteger(args.limitPerDocument, 30)));
  const view = args.view === "full" ? "full" : "summary";

  const requestedDocumentRefs = documentResolution || resolvedDocuments.resolution.exactIds.length > 0;
  const requestedCollectionRef = !!args.collectionId || !!args.collectionQuery || !!args.collectionRefId
    || !!args.collectionUrlId || !!args.collectionUrl;
  if (!requestedDocumentRefs && !requestedCollectionRef) {
    throw new CliError("comments.review_queue requires args.documentIds[], document refs, args.collectionId, or collection refs");
  }

  let documentIds = resolvedDocuments.ids;
  let collectionScopeTruncated = false;
  if (documentIds.length === 0 && collectionId) {
    const resolved = await listCollectionDocumentIds(ctx, collectionId, maxAttempts);
    documentIds = resolved.ids;
    collectionScopeTruncated = resolved.truncated;
  }
  if (documentIds.length === 0) {
    return {
      tool: "comments.review_queue",
      profile: ctx.profile.id,
      result: {
        ok: false,
        status: "not_found",
        scope: {
          documentIds: [],
          collectionId,
          ...(documentResolution ? { documentResolution } : {}),
          ...(collectionResolution ? { collectionResolution } : {}),
        },
        includeReplies,
        includeAnchorText,
        limitPerDocument,
        documentCount: 0,
        rowCount: 0,
        failedDocumentCount: 0,
        truncated: false,
        rows: [],
        failures: [],
      },
    };
  }

  const perDocument = await mapLimit(documentIds, Math.min(6, Math.max(1, documentIds.length || 1)), async (documentId) => {
    try {
      const res = await ctx.client.call(
        "comments.list",
        {
          documentId,
          includeAnchorText,
          includeReplies,
          limit: limitPerDocument,
          offset: 0,
          sort: "updatedAt",
          direction: "DESC",
        },
        { maxAttempts }
      );
      const sourceRows = Array.isArray(res.body?.data) ? res.body.data : [];
      const rows = sourceRows
        .map((row) => normalizeCommentQueueRow(row, 220))
        .filter((row) => row.commentId && row.documentId);
      return {
        documentId,
        ok: true,
        rowCount: rows.length,
        truncated: sourceRows.length >= limitPerDocument,
        rows,
        sourceRows: view === "full" ? sourceRows : undefined,
      };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          documentId,
          ok: false,
          error: err.message,
          status: err.details.status,
        };
      }
      throw err;
    }
  });

  const failures = perDocument.filter((item) => !item.ok);
  const successRows = perDocument.filter((item) => item.ok);
  const deduped = new Map();
  for (const item of successRows) {
    for (const row of item.rows) {
      const existing = deduped.get(row.commentId);
      if (!existing || compareIsoDesc(existing.updatedAt, row.updatedAt) > 0) {
        deduped.set(row.commentId, row);
      }
    }
  }

  const rows = Array.from(deduped.values()).sort((a, b) => {
    const updatedCmp = compareIsoDesc(a.updatedAt, b.updatedAt);
    if (updatedCmp !== 0) {
      return updatedCmp;
    }
    const createdCmp = compareIsoDesc(a.createdAt, b.createdAt);
    if (createdCmp !== 0) {
      return createdCmp;
    }
    return compareIdAsc(a.commentId, b.commentId);
  });

  return {
    tool: "comments.review_queue",
    profile: ctx.profile.id,
    result: {
      scope: {
        documentIds,
        collectionId,
        ...(documentResolution ? { documentResolution } : {}),
        ...(collectionResolution ? { collectionResolution } : {}),
      },
      includeReplies,
      includeAnchorText,
      limitPerDocument,
      documentCount: documentIds.length,
      rowCount: rows.length,
      failedDocumentCount: failures.length,
      truncated: collectionScopeTruncated || successRows.some((item) => item.truncated),
      rows,
      failures: failures.map((item) => ({
        documentId: item.documentId,
        error: item.error,
        status: item.status,
      })),
      perDocument:
        view === "full"
          ? successRows.map((item) => ({
              documentId: item.documentId,
              rowCount: item.rowCount,
              truncated: item.truncated,
              comments: item.sourceRows,
            }))
          : undefined,
    },
  };
}

async function federatedSyncManifestTool(ctx, args = {}) {
  const query = typeof args.query === "string" ? args.query.trim() : "";
  const collectionId = args.collectionId ? String(args.collectionId) : "";
  const includeDrafts = args.includeDrafts === true;
  const limit = Math.max(1, Math.min(250, toInteger(args.limit, 50)));
  const offset = Math.max(0, toInteger(args.offset, 0));
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const since = normalizeIsoTimestamp(args.since, "since");

  const method = query ? "documents.search_titles" : "documents.list";
  const body = compactValue({
    query: query || undefined,
    collectionId: collectionId || undefined,
    limit,
    offset,
    sort: "updatedAt",
    direction: "DESC",
    statusFilter: includeDrafts ? undefined : ["published"],
  }) || {};

  const res = await ctx.client.call(method, body, { maxAttempts });
  const rawRows = Array.isArray(res.body?.data) ? res.body.data : [];
  let rows = rawRows.map((row) => normalizeManifestRow(row)).filter((row) => row.id);

  if (since) {
    rows = rows.filter((row) => row.updatedAt && row.updatedAt >= since);
  }

  rows.sort((a, b) => {
    const updatedCmp = compareIsoDesc(a.updatedAt, b.updatedAt);
    if (updatedCmp !== 0) {
      return updatedCmp;
    }
    return compareIdAsc(a.id, b.id);
  });

  const hasMore = rawRows.length === limit;
  return {
    tool: "federated.sync_manifest",
    profile: ctx.profile.id,
    result: {
      mode: query ? "search_titles" : "documents.list",
      query,
      collectionId,
      since,
      includeDrafts,
      pagination: {
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : offset + rawRows.length,
      },
      rowCount: rows.length,
      rows,
    },
  };
}

function normalizeProbeQueries(args = {}) {
  const rawQueries = [];
  if (args.query != null) {
    rawQueries.push(args.query);
  }
  for (const query of ensureStringArray(args.queries, "queries") || []) {
    rawQueries.push(query);
  }
  return uniqueStrings(rawQueries);
}

async function federatedSyncProbeTool(ctx, args = {}) {
  const queries = normalizeProbeQueries(args);
  if (queries.length === 0) {
    throw new CliError("federated.sync_probe requires args.query or args.queries[]");
  }

  const mode = args.mode === "titles" || args.mode === "semantic" ? args.mode : "both";
  const limit = Math.max(1, Math.min(100, toInteger(args.limit, 10)));
  const offset = Math.max(0, toInteger(args.offset, 0));
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const collectionId = args.collectionId ? String(args.collectionId) : "";
  const includeTitles = mode === "titles" || mode === "both";
  const includeSemantic = mode === "semantic" || mode === "both";
  const queryConcurrency = Math.min(4, Math.max(1, queries.length));

  const perQuery = await mapLimit(queries, queryConcurrency, async (query) => {
    const hits = [];
    const errors = [];
    const baseBody = compactValue({
      query,
      collectionId: collectionId || undefined,
      limit,
      offset,
    }) || {};

    if (includeTitles) {
      try {
        const titlesRes = await ctx.client.call("documents.search_titles", baseBody, { maxAttempts });
        const rows = Array.isArray(titlesRes.body?.data) ? titlesRes.body.data : [];
        for (let i = 0; i < rows.length; i += 1) {
          const normalized = normalizeProbeTitleHit(rows[i], i);
          if (normalized) {
            hits.push(normalized);
          }
        }
      } catch (err) {
        if (err instanceof ApiError) {
          errors.push({
            source: "titles",
            error: err.message,
            status: err.details.status,
          });
        } else {
          throw err;
        }
      }
    }

    if (includeSemantic) {
      try {
        const semanticRes = await ctx.client.call(
          "documents.search",
          {
            ...baseBody,
            snippetMinWords: toInteger(args.snippetMinWords, 16),
            snippetMaxWords: toInteger(args.snippetMaxWords, 24),
          },
          { maxAttempts }
        );
        const rows = Array.isArray(semanticRes.body?.data) ? semanticRes.body.data : [];
        for (let i = 0; i < rows.length; i += 1) {
          const normalized = normalizeProbeSemanticHit(rows[i], i);
          if (normalized) {
            hits.push(normalized);
          }
        }
      } catch (err) {
        if (err instanceof ApiError) {
          errors.push({
            source: "semantic",
            error: err.message,
            status: err.details.status,
          });
        } else {
          throw err;
        }
      }
    }

    const rankedHits = mergeProbeHits(hits, limit);
    return {
      query,
      found: rankedHits.length > 0,
      missing: rankedHits.length === 0,
      hitCount: rankedHits.length,
      hits: rankedHits,
      errors,
    };
  });

  const found = perQuery.filter((item) => item.found).map((item) => item.query);
  const missing = perQuery.filter((item) => item.missing).map((item) => item.query);

  return {
    tool: "federated.sync_probe",
    profile: ctx.profile.id,
    result: {
      mode,
      collectionId,
      limit,
      offset,
      queryCount: queries.length,
      found,
      missing,
      perQuery,
    },
  };
}

function normalizePermissionIds(args = {}) {
  const ids = [];
  if (args.id != null) {
    ids.push(args.id);
  }
  for (const id of ensureStringArray(args.ids, "ids") || []) {
    ids.push(id);
  }
  return uniqueStrings(ids);
}

async function resolvePermissionIdsFromQueries(ctx, args, maxAttempts) {
  const queries = normalizeProbeQueries(args);
  if (queries.length === 0) {
    return {
      queries: [],
      ids: [],
      perQuery: [],
    };
  }

  const limitPerQuery = Math.max(1, Math.min(50, toInteger(args.limitPerQuery, 10)));
  const offset = Math.max(0, toInteger(args.offset, 0));
  const collectionId = args.collectionId ? String(args.collectionId) : "";
  const ids = [];
  const seen = new Set();
  const perQuery = [];

  for (const query of queries) {
    try {
      const res = await ctx.client.call(
        "documents.search_titles",
        compactValue({
          query,
          collectionId: collectionId || undefined,
          limit: limitPerQuery,
          offset,
        }) || {},
        { maxAttempts }
      );
      const rows = Array.isArray(res.body?.data) ? res.body.data : [];
      const hits = rows.map((row) => normalizeManifestRow(row)).filter((row) => row.id);
      for (const hit of hits) {
        if (seen.has(hit.id)) {
          continue;
        }
        seen.add(hit.id);
        ids.push(hit.id);
      }
      perQuery.push({
        query,
        hitCount: hits.length,
        hits,
      });
    } catch (err) {
      if (err instanceof ApiError) {
        perQuery.push({
          query,
          hitCount: 0,
          hits: [],
          error: err.message,
          status: err.details.status,
        });
      } else {
        throw err;
      }
    }
  }

  return {
    queries,
    ids,
    perQuery,
  };
}

async function safeMembershipCall(ctx, method, body, maxAttempts, normalizer) {
  try {
    const res = await ctx.client.call(method, body, { maxAttempts });
    const rows = Array.isArray(res.body?.data) ? res.body.data.map(normalizer) : [];
    return {
      ok: true,
      count: rows.length,
      rows: sortMembershipRows(rows),
    };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        count: 0,
        rows: [],
        error: err.message,
        status: err.details.status,
      };
    }
    throw err;
  }
}

async function federatedPermissionSnapshotTool(ctx, args = {}) {
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const includeDocumentMemberships = args.includeDocumentMemberships !== false;
  const includeCollectionMemberships = args.includeCollectionMemberships !== false;
  const membershipLimit = Math.max(1, Math.min(250, toInteger(args.membershipLimit, 100)));
  const readConcurrency = Math.max(1, Math.min(8, toInteger(args.concurrency, 3)));

  const explicitIds = normalizePermissionIds(args);
  const resolved = explicitIds.length > 0 ? { queries: [], ids: [], perQuery: [] } : await resolvePermissionIdsFromQueries(ctx, args, maxAttempts);
  const targetIds = uniqueStrings([...explicitIds, ...(resolved.ids || [])]);

  if (targetIds.length === 0) {
    throw new CliError("federated.permission_snapshot requires args.id/args.ids or query/queries resolving to documents");
  }

  const items = await mapLimit(targetIds, readConcurrency, async (id) => {
    try {
      const info = await ctx.client.call("documents.info", { id }, { maxAttempts });
      const doc = info.body?.data || {};
      const document = normalizeManifestRow(doc);
      document.title = doc?.title ? String(doc.title) : "";

      const policies = summarizePolicies(Array.isArray(info.body?.policies) ? info.body.policies : []);
      const collectionId = document.collectionId;

      const documentUsers = includeDocumentMemberships
        ? await safeMembershipCall(
            ctx,
            "documents.memberships",
            { id, limit: membershipLimit, offset: 0 },
            maxAttempts,
            normalizeUserMembershipRow
          )
        : { ok: true, count: 0, rows: [] };

      const documentGroups = includeDocumentMemberships
        ? await safeMembershipCall(
            ctx,
            "documents.group_memberships",
            { id, limit: membershipLimit, offset: 0 },
            maxAttempts,
            normalizeGroupMembershipRow
          )
        : { ok: true, count: 0, rows: [] };

      const collectionUsers = includeCollectionMemberships && collectionId
        ? await safeMembershipCall(
            ctx,
            "collections.memberships",
            { id: collectionId, limit: membershipLimit, offset: 0 },
            maxAttempts,
            normalizeUserMembershipRow
          )
        : { ok: true, count: 0, rows: [] };

      const collectionGroups = includeCollectionMemberships && collectionId
        ? await safeMembershipCall(
            ctx,
            "collections.group_memberships",
            { id: collectionId, limit: membershipLimit, offset: 0 },
            maxAttempts,
            normalizeGroupMembershipRow
          )
        : { ok: true, count: 0, rows: [] };

      const errors = [];
      for (const [scope, payload] of Object.entries({
        documentUsers,
        documentGroups,
        collectionUsers,
        collectionGroups,
      })) {
        if (!payload.ok) {
          errors.push({
            scope,
            error: payload.error,
            status: payload.status,
          });
        }
      }

      return {
        id,
        ok: errors.length === 0,
        document,
        policySnapshot: policies,
        memberships: {
          documentUsers: {
            count: documentUsers.count,
            rows: documentUsers.rows,
          },
          documentGroups: {
            count: documentGroups.count,
            rows: documentGroups.rows,
          },
          collectionUsers: {
            count: collectionUsers.count,
            rows: collectionUsers.rows,
          },
          collectionGroups: {
            count: collectionGroups.count,
            rows: collectionGroups.rows,
          },
        },
        errors,
      };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          id,
          ok: false,
          error: err.message,
          status: err.details.status,
        };
      }
      throw err;
    }
  });

  const failed = items.filter((item) => !item.ok).length;

  return {
    tool: "federated.permission_snapshot",
    profile: ctx.profile.id,
    result: {
      requestedIds: explicitIds,
      resolvedQueryCount: resolved.queries?.length || 0,
      resolvedFromQueries: resolved.perQuery,
      total: items.length,
      succeeded: items.length - failed,
      failed,
      items,
    },
  };
}

export const EXTENDED_TOOLS = {
  ...RPC_TOOLS,
  "documents.answer": {
    signature:
      "documents.answer(args: { question?: string; query?: string; documentId?: string; documentQuery?: string; refs?: string[]; collectionId?: string; collectionQuery?: string; userId?: string; userQuery?: string; limit?: number; ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })",
    description: "Answer a question using Outline AI over the selected document scope.",
    usageExample: {
      tool: "documents.answer",
      args: {
        question: "What changed in our onboarding checklist?",
        collectionQuery: "engineering",
      },
    },
    bestPractices: [
      "Use question text that is specific enough to resolve citations quickly.",
      "Scope by documentQuery, refs, collectionQuery, or userQuery when callers have remembered titles, URLs, collection names, or emails instead of exact IDs.",
      "Use exact collectionId, documentId, or userId when already known to avoid a memory resolution step.",
      "If the deployment lacks documents.answerQuestion, this wrapper returns fallback retrieval evidence and a concrete search suggestion instead of a raw 404.",
    ],
    handler: documentsAnswerTool,
  },
  "documents.answer_batch": {
    signature:
      "documents.answer_batch(args: { question?: string; questions?: Array<string | { question?: string; query?: string; documentQuery?: string; collectionQuery?: string; userQuery?: string; ...endpointArgs }>; limit?: number; ...endpointArgs; concurrency?: number; includePolicies?: boolean; maxAttempts?: number })",
    description: "Run multiple documents.answerQuestion calls with per-item isolation.",
    usageExample: {
      tool: "documents.answer_batch",
      args: {
        questions: [
          "Where is the release checklist?",
          "Who owns incident postmortems?",
        ],
        collectionQuery: "engineering",
        concurrency: 2,
      },
    },
    bestPractices: [
      "Prefer small batches and low concurrency for predictable token and latency budgets.",
      "Use top-level collectionQuery/userQuery to resolve shared scope once, or per-item documentQuery when each question targets a different remembered document.",
      "Use per-item statuses to retry only failures.",
      "Unsupported answer endpoints degrade to per-item retrieval evidence rather than failing the whole batch.",
    ],
    handler: documentsAnswerBatchTool,
  },
  "documents.backlinks": {
    signature:
      "documents.backlinks(args: { id?: string; query?: string; shareId?: string; urlId?: string; url?: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'ids'|'summary'|'full'; includePolicies?: boolean; maxAttempts?: number })",
    description: "List backlinks for a document by exact ID or by resolving a remembered title, share ID, URL id, or URL first.",
    usageExample: {
      tool: "documents.backlinks",
      args: {
        id: "doc-1",
        limit: 20,
        view: "summary",
      },
    },
    bestPractices: [
      "Pass query/url/urlId directly when you know the document reference but not its exact ID.",
      "Use view=ids for low-token planning loops, then hydrate specific documents separately.",
      "Use limit/offset pagination for deterministic traversal over large backlink sets.",
    ],
    handler: documentsBacklinksTool,
  },
  "documents.graph_neighbors": {
    signature:
      "documents.graph_neighbors(args: { id?: string; ids?: string[]; refs?: string[]; query?: string; queries?: string[]; shareId?: string; shareIds?: string[]; urlId?: string; urlIds?: string[]; url?: string; urls?: string[]; includeBacklinks?: boolean; includeSearchNeighbors?: boolean; searchQueries?: string[]; limitPerSource?: number; view?: 'ids'|'summary'|'full'; maxAttempts?: number })",
    description: "Collect one-hop graph neighbors and deterministic edge rows for source documents, resolving titles or URLs when needed.",
    usageExample: {
      tool: "documents.graph_neighbors",
      args: {
        id: "doc-1",
        includeBacklinks: true,
        includeSearchNeighbors: true,
        searchQueries: ["incident response"],
        limitPerSource: 8,
      },
    },
    bestPractices: [
      "Use refs[] for mixed document titles and URLs; use ids[] when exact document IDs are already known.",
      "Start with a single source id and small limitPerSource, then expand incrementally.",
      "Enable includeSearchNeighbors only when additional semantic neighborhood expansion is needed.",
    ],
    handler: documentsGraphNeighborsTool,
  },
  "documents.graph_report": {
    signature:
      "documents.graph_report(args: { seedIds?: string[]; seedRefs?: string[]; seedQuery?: string; seedQueries?: string[]; seedUrl?: string; seedUrls?: string[]; depth?: number; maxNodes?: number; includeBacklinks?: boolean; includeSearchNeighbors?: boolean; limitPerSource?: number; view?: 'ids'|'summary'|'full'; maxAttempts?: number })",
    description: "Build a bounded BFS graph report with stable nodes[] and edges[] output, resolving seed titles or URLs when needed.",
    usageExample: {
      tool: "documents.graph_report",
      args: {
        seedIds: ["doc-1", "doc-2"],
        depth: 2,
        maxNodes: 120,
        includeBacklinks: true,
        includeSearchNeighbors: false,
        limitPerSource: 10,
      },
    },
    bestPractices: [
      "Use seedRefs[] for mixed seed titles and URLs; use seedIds[] when exact document IDs are already known.",
      "Cap maxNodes and depth to keep traversal deterministic and cost-bounded.",
      "Prefer view=ids for graph planning and fetch full nodes only for selected IDs.",
    ],
    handler: documentsGraphReportTool,
  },
  "documents.issue_refs": {
    signature:
      "documents.issue_refs(args: { id?: string; ids?: string[]; refs?: string[]; query?: string; queries?: string[]; shareId?: string; shareIds?: string[]; urlId?: string; urlIds?: string[]; url?: string; urls?: string[]; issueDomains?: string[]; keyPattern?: string; view?: 'ids'|'summary'|'full'; maxAttempts?: number })",
    description:
      "Extract deterministic issue references (URL links and key-pattern matches) from one or more documents, resolving titles or URLs when needed.",
    usageExample: {
      tool: "documents.issue_refs",
      args: {
        ids: ["doc-1", "doc-2"],
        issueDomains: ["jira.example.com", "github.com"],
        keyPattern: "[A-Z][A-Z0-9]+-\\\\d+",
        view: "summary",
      },
    },
    bestPractices: [
      "Use refs[] for mixed document titles and URLs; exact IDs can still go through ids[].",
      "Start with view=ids for low-token audits, then re-run selected docs with summary/full views.",
      "Provide issueDomains to reduce non-issue URL noise and keep outputs focused.",
      "Tune keyPattern when your tracker uses custom issue key formats.",
    ],
    handler: documentsIssueRefsTool,
  },
  "documents.issue_ref_report": {
    signature:
      "documents.issue_ref_report(args: { query?: string; queries?: string[]; collectionId?: string; issueDomains?: string[]; keyPattern?: string; limit?: number; view?: 'ids'|'summary'|'full'; maxAttempts?: number })",
    description:
      "Resolve candidate documents from title+semantic search, then extract deterministic issue reference summaries.",
    usageExample: {
      tool: "documents.issue_ref_report",
      args: {
        queries: ["incident response", "release checklist"],
        collectionId: "collection-id",
        issueDomains: ["jira.example.com"],
        limit: 12,
        view: "summary",
      },
    },
    bestPractices: [
      "Use specific queries to keep the candidate set small and deterministic.",
      "Scope by collectionId when possible to avoid cross-workspace noise.",
      "Review perQuery errors before treating missing issue refs as definitive.",
    ],
    handler: documentsIssueRefReportTool,
  },
  "documents.attachments": {
    signature:
      "documents.attachments(args: { id?: string; documentId?: string; refs?: string[]; query?: string; queries?: string[]; url?: string; urlId?: string; urlIds?: string[]; urls?: string[]; shareId?: string; shareIds?: string[]; maxAttempts?: number })",
    description:
      "Extract embedded Outline attachment references from a document body, including images rendered through /api/attachments.redirect, resolving remembered document refs when needed.",
    usageExample: {
      tool: "documents.attachments",
      args: {
        query: "example title",
      },
    },
    bestPractices: [
      "Pass query, refs, url, urlId, or shareId directly when you need to enumerate embedded images or file links without a separate document open step.",
      "Use strict=true defaults for remembered titles so weak fuzzy matches return a structured miss instead of guessing.",
      "Follow with attachments.download or documents.download_attachments to save files locally.",
    ],
    handler: documentsAttachmentsTool,
  },
  "attachments.download": {
    signature:
      "attachments.download(args: { id?: string; attachmentId?: string; url?: string; path?: string; outputDir?: string; filePath?: string; fileName?: string; overwrite?: boolean; maxAttempts?: number })",
    description:
      "Download one Outline attachment or embedded image through the authenticated attachments.redirect endpoint and save it locally.",
    usageExample: {
      tool: "attachments.download",
      args: {
        id: "15831936-7fef-4a58-b17b-121a65c3d787",
        outputDir: "./outline-attachments",
        overwrite: true,
      },
    },
    bestPractices: [
      "Prefer id for deterministic downloads; url/path may be an /api/attachments.redirect?id=... value copied from document markdown.",
      "Use outputDir for generated names or filePath when the caller needs an exact path.",
      "Inspect returned sha256, bytes, and contentType before handing the file to downstream tools.",
    ],
    handler: attachmentsDownloadTool,
  },
  "documents.download_attachments": {
    signature:
      "documents.download_attachments(args: { id?: string; documentId?: string; refs?: string[]; query?: string; queries?: string[]; url?: string; urlId?: string; urlIds?: string[]; urls?: string[]; shareId?: string; shareIds?: string[]; outputDir?: string; overwrite?: boolean; concurrency?: number; maxAttempts?: number })",
    description:
      "Resolve a document, extract all embedded Outline attachment references, and save each referenced file locally.",
    usageExample: {
      tool: "documents.download_attachments",
      args: {
        query: "example title",
        outputDir: "./outline-attachments",
        overwrite: true,
      },
    },
    bestPractices: [
      "Run documents.attachments first when you only need metadata or want to choose a subset.",
      "Pass query, refs, url, urlId, or shareId directly when the agent has a remembered document title or pasted URL.",
      "Keep concurrency modest for large image-heavy documents to avoid rate limits.",
      "Use overwrite=true for repeatable automation into a scratch directory.",
    ],
    handler: documentsDownloadAttachmentsTool,
  },
  "documents.import_file": {
    signature:
      "documents.import_file(args: { filePath: string; collectionId?: string; parentDocumentId?: string; publish?: boolean; contentType?: string; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean; ...endpointArgs })",
    description:
      "Upload a local file as multipart/form-data to documents.import while preserving deterministic output envelopes.",
    usageExample: {
      tool: "documents.import_file",
      args: {
        filePath: "./tmp/wiki-export.md",
        collectionId: "collection-id",
        publish: false,
        performAction: true,
      },
    },
    bestPractices: [
      "Provide exactly one placement target when needed: collectionId or parentDocumentId.",
      "Use file_operations.info to poll async import status after documents.import_file returns.",
      "This tool is action-gated; set performAction=true only for explicitly confirmed mutations.",
    ],
    handler: documentsImportFileTool,
  },
  "templates.extract_placeholders": {
    signature: "templates.extract_placeholders(args: { id?: string; templateQuery?: string; refs?: string[]; refresh?: boolean; maxAttempts?: number })",
    description: "Resolve a template by ID or remembered name and extract sorted unique placeholder keys ({{key}}) from template text nodes.",
    usageExample: {
      tool: "templates.extract_placeholders",
      args: {
        templateQuery: "incident postmortem",
      },
    },
    bestPractices: [
      "Pass templateQuery/templateRef/refs when the user names a template but exact ID is unknown.",
      "Run this before document creation to validate required placeholder keys.",
      "Use counts to catch repeated placeholders for deterministic pipeline checks.",
    ],
    handler: templatesExtractPlaceholdersTool,
  },
  "documents.create_from_template": {
    signature:
      "documents.create_from_template(args: { templateId?: string; templateQuery?: string; refs?: string[]; title?: string; collectionId?: string; parentDocumentId?: string; publish?: boolean; placeholderValues?: Record<string,string>; strictPlaceholders?: boolean; view?: 'summary'|'full'; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })",
    description:
      "Create from template, optionally inject placeholder values, and enforce strict unresolved-placeholder safety.",
    usageExample: {
      tool: "documents.create_from_template",
      args: {
        templateQuery: "incident postmortem",
        title: "Service A - Incident Postmortem",
        placeholderValues: {
          service_name: "Service A",
          owner: "SRE Team",
        },
        strictPlaceholders: true,
        publish: true,
        performAction: true,
      },
    },
    bestPractices: [
      "Pass templateQuery/templateRef/refs when only the template name is known; local memory can resolve and refresh the template in the same call.",
      "Keep strictPlaceholders=true in automation to prevent publishing unresolved template tokens.",
      "Provide placeholderValues as exact key-value strings and inspect unresolvedCount on every run.",
      "This tool is action-gated; set performAction=true only for explicitly confirmed mutations.",
    ],
    handler: documentsCreateFromTemplateTool,
  },
  "comments.review_queue": {
    signature:
      "comments.review_queue(args: { documentIds?: string[]; documentId?: string; refs?: string[]; query?: string; queries?: string[]; shareId?: string; shareIds?: string[]; urlId?: string; urlIds?: string[]; url?: string; urls?: string[]; collectionId?: string; collectionQuery?: string; collectionRefId?: string; collectionUrlId?: string; collectionUrl?: string; includeAnchorText?: boolean; includeReplies?: boolean; limitPerDocument?: number; view?: 'summary'|'full'; maxAttempts?: number })",
    description: "Build a deterministic comment review queue from comments.list responses, resolving remembered document or collection references when needed.",
    usageExample: {
      tool: "comments.review_queue",
      args: {
        refs: ["incident runbook", "https://handbook.example.com/doc/oncall-escalation-AbCdEf12"],
        includeReplies: true,
        limitPerDocument: 20,
      },
    },
    bestPractices: [
      "Use explicit documentIds for maximum predictability, or pass refs/query/url when the agent only has a remembered title or pasted Outline URL.",
      "Use collectionQuery, collectionRefId, collectionUrlId, or collectionUrl when the review queue should cover a remembered collection without a separate collections.open turn.",
      "Use includeReplies=true to capture full threaded review context.",
      "Treat truncated=true as a signal to re-run with a higher limitPerDocument.",
    ],
    handler: commentsReviewQueueTool,
  },
  "federated.sync_manifest": {
    signature:
      "federated.sync_manifest(args?: { collectionId?: string; query?: string; since?: string; limit?: number; offset?: number; includeDrafts?: boolean; maxAttempts?: number })",
    description: "Generate deterministic document manifest rows for federated index sync workflows.",
    usageExample: {
      tool: "federated.sync_manifest",
      args: {
        collectionId: "collection-id",
        since: "2026-03-01T00:00:00.000Z",
        limit: 100,
        offset: 0,
      },
    },
    bestPractices: [
      "Use `since` + pagination for incremental sync jobs.",
      "Use includeDrafts=false for published-only downstream indexes.",
      "Persist pagination.nextOffset and resume deterministically.",
    ],
    handler: federatedSyncManifestTool,
  },
  "federated.sync_probe": {
    signature:
      "federated.sync_probe(args: { query?: string; queries?: string[]; mode?: 'titles'|'semantic'|'both'; collectionId?: string; limit?: number; offset?: number; maxAttempts?: number })",
    description: "Probe document findability across title and semantic search with per-query ranked hits.",
    usageExample: {
      tool: "federated.sync_probe",
      args: {
        queries: ["runbook escalation", "incident policy"],
        mode: "both",
        limit: 8,
      },
    },
    bestPractices: [
      "Use both mode when validating search behavior before external index reconciliation.",
      "Inspect perQuery[].errors for partial-mode failures before alerting.",
      "Track missing[] over time for regression detection.",
    ],
    handler: federatedSyncProbeTool,
  },
  "federated.permission_snapshot": {
    signature:
      "federated.permission_snapshot(args: { id?: string; ids?: string[]; query?: string; queries?: string[]; collectionId?: string; includeDocumentMemberships?: boolean; includeCollectionMemberships?: boolean; limitPerQuery?: number; membershipLimit?: number; concurrency?: number; maxAttempts?: number })",
    description: "Capture per-document permission and membership snapshots for federated ACL reconciliation.",
    usageExample: {
      tool: "federated.permission_snapshot",
      args: {
        ids: ["doc-1", "doc-2"],
        includeDocumentMemberships: true,
        includeCollectionMemberships: true,
      },
    },
    bestPractices: [
      "Pass explicit ids for deterministic ACL snapshots.",
      "Use query/queries only when you need dynamic resolution before snapshotting.",
      "Inspect item.errors for scoped permission gaps instead of failing whole runs.",
    ],
    handler: federatedPermissionSnapshotTool,
  },
};
