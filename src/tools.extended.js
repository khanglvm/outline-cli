import fs from "node:fs/promises";
import path from "node:path";
import { ApiError, CliError } from "./errors.js";
import { assertPerformAction } from "./action-gate.js";
import { compactValue, ensureStringArray, mapLimit, toInteger } from "./utils.js";

const CONTROL_ARG_KEYS = new Set([
  "performAction",
  "maxAttempts",
  "includePolicies",
  "concurrency",
  "question",
  "questions",
  "compact",
]);

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

function defaultUsageArgs(def) {
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
      documentId: "document-id",
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

function makeRpcHandler(def) {
  return async function rpcHandler(ctx, args = {}) {
    if (def.mutating) {
      assertPerformAction(args, {
        tool: def.tool,
        action: `invoke mutating method '${def.method}'`,
      });
    }

    const res = await ctx.client.call(def.method, buildBody(args), {
      maxAttempts: toInteger(args.maxAttempts, def.mutating ? 1 : 2),
    });

    return {
      tool: def.tool,
      profile: ctx.profile.id,
      result: maybeDropPolicies(res.body, !!args.includePolicies),
    };
  };
}

function makeRpcContract(def) {
  return {
    signature: `${def.tool}(args?: { ...endpointArgs; includePolicies?: boolean; maxAttempts?: number${
      def.mutating ? "; performAction?: boolean" : ""
    } })`,
    description: def.description,
    usageExample: {
      tool: def.tool,
      args: defaultUsageArgs(def),
    },
    bestPractices: [
      "Prefer minimal payloads to keep responses deterministic and token-efficient.",
      ...(def.mutating
        ? ["This tool is action-gated; set performAction=true only for explicitly confirmed mutations."]
        : ["Use includePolicies=true only when policy details are required."]),
    ],
    handler: makeRpcHandler(def),
  };
}

const RPC_WRAPPER_DEFS = [
  { tool: "shares.list", method: "shares.list", description: "List shares." },
  { tool: "shares.info", method: "shares.info", description: "Get share details." },
  { tool: "shares.create", method: "shares.create", description: "Create a share.", mutating: true },
  { tool: "shares.update", method: "shares.update", description: "Update a share.", mutating: true },
  { tool: "shares.revoke", method: "shares.revoke", description: "Revoke a share.", mutating: true },
  { tool: "templates.list", method: "templates.list", description: "List templates." },
  { tool: "templates.info", method: "templates.info", description: "Get template details." },
  { tool: "templates.create", method: "templates.create", description: "Create a template.", mutating: true },
  { tool: "templates.update", method: "templates.update", description: "Update a template.", mutating: true },
  { tool: "templates.delete", method: "templates.delete", description: "Delete a template.", mutating: true },
  { tool: "templates.restore", method: "templates.restore", description: "Restore a template.", mutating: true },
  { tool: "templates.duplicate", method: "templates.duplicate", description: "Duplicate a template.", mutating: true },
  { tool: "documents.templatize", method: "documents.templatize", description: "Convert a document into a template.", mutating: true },
  { tool: "documents.import", method: "documents.import", description: "Import a document from JSON payload.", mutating: true },
  { tool: "comments.list", method: "comments.list", description: "List comments." },
  { tool: "comments.info", method: "comments.info", description: "Get comment details." },
  { tool: "comments.create", method: "comments.create", description: "Create a comment.", mutating: true },
  { tool: "comments.update", method: "comments.update", description: "Update a comment.", mutating: true },
  { tool: "comments.delete", method: "comments.delete", description: "Delete a comment.", mutating: true },
  { tool: "events.list", method: "events.list", description: "List workspace events." },
  { tool: "data_attributes.list", method: "dataAttributes.list", description: "List data attributes." },
  { tool: "data_attributes.info", method: "dataAttributes.info", description: "Get data attribute details." },
  { tool: "data_attributes.create", method: "dataAttributes.create", description: "Create a data attribute.", mutating: true },
  { tool: "data_attributes.update", method: "dataAttributes.update", description: "Update a data attribute.", mutating: true },
  { tool: "data_attributes.delete", method: "dataAttributes.delete", description: "Delete a data attribute.", mutating: true },
  { tool: "revisions.info", method: "revisions.info", description: "Get revision details." },
  { tool: "documents.archived", method: "documents.archived", description: "List archived documents." },
  { tool: "documents.deleted", method: "documents.deleted", description: "List deleted documents." },
  { tool: "documents.archive", method: "documents.archive", description: "Archive a document.", mutating: true },
  { tool: "documents.restore", method: "documents.restore", description: "Restore a document.", mutating: true },
  { tool: "documents.empty_trash", method: "documents.empty_trash", description: "Empty document trash.", mutating: true },
  { tool: "webhooks.list", method: "webhooks.list", description: "List webhooks." },
  { tool: "webhooks.info", method: "webhooks.info", description: "Get webhook details." },
  { tool: "webhooks.create", method: "webhooks.create", description: "Create a webhook.", mutating: true },
  { tool: "webhooks.update", method: "webhooks.update", description: "Update a webhook.", mutating: true },
  { tool: "webhooks.delete", method: "webhooks.delete", description: "Delete a webhook.", mutating: true },
  { tool: "users.list", method: "users.list", description: "List users." },
  { tool: "users.info", method: "users.info", description: "Get user details." },
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
  { tool: "groups.info", method: "groups.info", description: "Get group details." },
  { tool: "groups.memberships", method: "groups.memberships", description: "List group user memberships." },
  { tool: "groups.create", method: "groups.create", description: "Create a group.", mutating: true },
  { tool: "groups.update", method: "groups.update", description: "Update a group.", mutating: true },
  { tool: "groups.delete", method: "groups.delete", description: "Delete a group.", mutating: true },
  { tool: "groups.add_user", method: "groups.add_user", description: "Add a user to a group.", mutating: true },
  { tool: "groups.remove_user", method: "groups.remove_user", description: "Remove a user from a group.", mutating: true },
  { tool: "collections.memberships", method: "collections.memberships", description: "List collection user memberships." },
  { tool: "collections.group_memberships", method: "collections.group_memberships", description: "List collection group memberships." },
  { tool: "collections.add_user", method: "collections.add_user", description: "Add a user to a collection.", mutating: true },
  { tool: "collections.remove_user", method: "collections.remove_user", description: "Remove a user from a collection.", mutating: true },
  { tool: "collections.add_group", method: "collections.add_group", description: "Add a group to a collection.", mutating: true },
  { tool: "collections.remove_group", method: "collections.remove_group", description: "Remove a group from a collection.", mutating: true },
  { tool: "documents.users", method: "documents.users", description: "List users with access to a document." },
  { tool: "documents.memberships", method: "documents.memberships", description: "List document user memberships." },
  { tool: "documents.group_memberships", method: "documents.group_memberships", description: "List document group memberships." },
  { tool: "documents.add_user", method: "documents.add_user", description: "Add a user to a document.", mutating: true },
  { tool: "documents.remove_user", method: "documents.remove_user", description: "Remove a user from a document.", mutating: true },
  { tool: "documents.add_group", method: "documents.add_group", description: "Add a group to a document.", mutating: true },
  { tool: "documents.remove_group", method: "documents.remove_group", description: "Remove a group from a document.", mutating: true },
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

async function documentsAnswerTool(ctx, args = {}) {
  const question = String(args.question ?? args.query ?? "").trim();
  if (!question) {
    throw new CliError("documents.answer requires args.question or args.query");
  }

  const body = {
    ...buildBody(args, ["question", "query"]),
    query: question,
  };

  const res = await ctx.client.call("documents.answerQuestion", body, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });
  const payload = maybeDropPolicies(res.body, !!args.includePolicies);

  return {
    tool: "documents.answer",
    profile: ctx.profile.id,
    result:
      payload && typeof payload === "object"
        ? { question, ...payload }
        : { question, data: payload },
  };
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

  const baseBody = buildBody(args, ["question", "questions", "query", "concurrency"]);
  const includePolicies = !!args.includePolicies;
  const maxAttempts = toInteger(args.maxAttempts, 2);
  const concurrency = Math.max(1, Math.min(10, toInteger(args.concurrency, 3)));

  const items = await mapLimit(rawItems, concurrency, async (raw, index) => {
    let parsed;
    try {
      parsed = parseQuestionItem(raw, index);
      const body = {
        ...baseBody,
        ...parsed.body,
        query: parsed.question,
      };
      const res = await ctx.client.call("documents.answerQuestion", body, {
        maxAttempts,
      });
      const payload = maybeDropPolicies(res.body, includePolicies);
      return {
        index,
        ok: true,
        question: parsed.question,
        documentId: parsed.documentId,
        result: payload,
      };
    } catch (err) {
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
  for (const id of ensureStringArray(args.ids, "ids") || []) {
    values.push(id);
  }
  return uniqueStrings(values).sort(compareIdAsc);
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
  const id = String(args.id || "").trim();
  if (!id) {
    throw new CliError("documents.backlinks requires args.id");
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

  return {
    tool: "documents.backlinks",
    profile: ctx.profile.id,
    result: payload,
  };
}

async function documentsGraphNeighborsTool(ctx, args = {}) {
  const sourceIds = normalizeGraphSourceIds(args);
  if (sourceIds.length === 0) {
    throw new CliError("documents.graph_neighbors requires args.id or args.ids[]");
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

  return {
    tool: "documents.graph_neighbors",
    profile: ctx.profile.id,
    result: {
      sourceIds,
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
  const requestedSeedIds = uniqueStrings(ensureStringArray(args.seedIds, "seedIds") || []).sort(compareIdAsc);
  if (requestedSeedIds.length === 0) {
    throw new CliError("documents.graph_report requires args.seedIds[]");
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

  return {
    tool: "documents.graph_report",
    profile: ctx.profile.id,
    result: {
      seedIds,
      requestedSeedCount: requestedSeedIds.length,
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
  const ids = normalizeIssueRefIds(args);
  if (ids.length === 0) {
    throw new CliError("documents.issue_refs requires args.id or args.ids[]");
  }

  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const view = normalizeIssueDocumentView(args.view);

  const extracted = await collectIssueRefsByIds(ctx, ids, {
    issueDomains: args.issueDomains,
    keyPattern: args.keyPattern,
    maxAttempts,
    view,
  });

  return {
    tool: "documents.issue_refs",
    profile: ctx.profile.id,
    result: {
      requestedIds: extracted.requestedIds,
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

async function templatesExtractPlaceholdersTool(ctx, args = {}) {
  const id = String(args.id || "").trim();
  if (!id) {
    throw new CliError("templates.extract_placeholders requires args.id");
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
      title: template?.title ? String(template.title) : "",
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
  const templateId = String(args.templateId || "").trim();
  if (!templateId) {
    throw new CliError("documents.create_from_template requires args.templateId");
  }

  assertPerformAction(args, {
    tool: "documents.create_from_template",
    action: "create and optionally update a document from template",
  });

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
  const explicitIds = uniqueStrings(ensureStringArray(args.documentIds, "documentIds") || []);
  const collectionId = args.collectionId ? String(args.collectionId) : "";
  const maxAttempts = Math.max(1, toInteger(args.maxAttempts, 2));
  const includeReplies = args.includeReplies !== false;
  const includeAnchorText = !!args.includeAnchorText;
  const limitPerDocument = Math.max(1, Math.min(200, toInteger(args.limitPerDocument, 30)));
  const view = args.view === "full" ? "full" : "summary";

  if (explicitIds.length === 0 && !collectionId) {
    throw new CliError("comments.review_queue requires args.documentIds[] or args.collectionId");
  }

  let documentIds = explicitIds;
  let collectionScopeTruncated = false;
  if (documentIds.length === 0 && collectionId) {
    const resolved = await listCollectionDocumentIds(ctx, collectionId, maxAttempts);
    documentIds = resolved.ids;
    collectionScopeTruncated = resolved.truncated;
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
      "documents.answer(args: { question?: string; query?: string; ...endpointArgs; includePolicies?: boolean; maxAttempts?: number })",
    description: "Answer a question using Outline AI over the selected document scope.",
    usageExample: {
      tool: "documents.answer",
      args: {
        question: "What changed in our onboarding checklist?",
        collectionId: "collection-id",
      },
    },
    bestPractices: [
      "Use question text that is specific enough to resolve citations quickly.",
      "Scope by collectionId or documentId to reduce latency and hallucination risk.",
    ],
    handler: documentsAnswerTool,
  },
  "documents.answer_batch": {
    signature:
      "documents.answer_batch(args: { question?: string; questions?: Array<string | { question?: string; query?: string; ...endpointArgs }>; ...endpointArgs; concurrency?: number; includePolicies?: boolean; maxAttempts?: number })",
    description: "Run multiple documents.answerQuestion calls with per-item isolation.",
    usageExample: {
      tool: "documents.answer_batch",
      args: {
        questions: [
          "Where is the release checklist?",
          "Who owns incident postmortems?",
        ],
        collectionId: "collection-id",
        concurrency: 2,
      },
    },
    bestPractices: [
      "Prefer small batches and low concurrency for predictable token and latency budgets.",
      "Use per-item statuses to retry only failures.",
    ],
    handler: documentsAnswerBatchTool,
  },
  "documents.backlinks": {
    signature:
      "documents.backlinks(args: { id: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'ids'|'summary'|'full'; includePolicies?: boolean; maxAttempts?: number })",
    description: "List backlinks for a document via documents.list(backlinkDocumentId=id).",
    usageExample: {
      tool: "documents.backlinks",
      args: {
        id: "doc-1",
        limit: 20,
        view: "summary",
      },
    },
    bestPractices: [
      "Use view=ids for low-token planning loops, then hydrate specific documents separately.",
      "Use limit/offset pagination for deterministic traversal over large backlink sets.",
    ],
    handler: documentsBacklinksTool,
  },
  "documents.graph_neighbors": {
    signature:
      "documents.graph_neighbors(args: { id?: string; ids?: string[]; includeBacklinks?: boolean; includeSearchNeighbors?: boolean; searchQueries?: string[]; limitPerSource?: number; view?: 'ids'|'summary'|'full'; maxAttempts?: number })",
    description: "Collect one-hop graph neighbors and deterministic edge rows for source document IDs.",
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
      "Start with a single source id and small limitPerSource, then expand incrementally.",
      "Enable includeSearchNeighbors only when additional semantic neighborhood expansion is needed.",
    ],
    handler: documentsGraphNeighborsTool,
  },
  "documents.graph_report": {
    signature:
      "documents.graph_report(args: { seedIds: string[]; depth?: number; maxNodes?: number; includeBacklinks?: boolean; includeSearchNeighbors?: boolean; limitPerSource?: number; view?: 'ids'|'summary'|'full'; maxAttempts?: number })",
    description: "Build a bounded BFS graph report with stable nodes[] and edges[] output.",
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
      "Cap maxNodes and depth to keep traversal deterministic and cost-bounded.",
      "Prefer view=ids for graph planning and fetch full nodes only for selected IDs.",
    ],
    handler: documentsGraphReportTool,
  },
  "documents.issue_refs": {
    signature:
      "documents.issue_refs(args: { id?: string; ids?: string[]; issueDomains?: string[]; keyPattern?: string; view?: 'ids'|'summary'|'full'; maxAttempts?: number })",
    description:
      "Extract deterministic issue references (URL links and key-pattern matches) from one or more documents.",
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
    signature: "templates.extract_placeholders(args: { id: string; maxAttempts?: number })",
    description: "Extract sorted unique placeholder keys ({{key}}) from template text nodes.",
    usageExample: {
      tool: "templates.extract_placeholders",
      args: {
        id: "template-id",
      },
    },
    bestPractices: [
      "Run this before document creation to validate required placeholder keys.",
      "Use counts to catch repeated placeholders for deterministic pipeline checks.",
    ],
    handler: templatesExtractPlaceholdersTool,
  },
  "documents.create_from_template": {
    signature:
      "documents.create_from_template(args: { templateId: string; title?: string; collectionId?: string; parentDocumentId?: string; publish?: boolean; placeholderValues?: Record<string,string>; strictPlaceholders?: boolean; view?: 'summary'|'full'; includePolicies?: boolean; maxAttempts?: number; performAction?: boolean })",
    description:
      "Create from template, optionally inject placeholder values, and enforce strict unresolved-placeholder safety.",
    usageExample: {
      tool: "documents.create_from_template",
      args: {
        templateId: "template-id",
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
      "Keep strictPlaceholders=true in automation to prevent publishing unresolved template tokens.",
      "Provide placeholderValues as exact key-value strings and inspect unresolvedCount on every run.",
      "This tool is action-gated; set performAction=true only for explicitly confirmed mutations.",
    ],
    handler: documentsCreateFromTemplateTool,
  },
  "comments.review_queue": {
    signature:
      "comments.review_queue(args: { documentIds?: string[]; collectionId?: string; includeAnchorText?: boolean; includeReplies?: boolean; limitPerDocument?: number; view?: 'summary'|'full'; maxAttempts?: number })",
    description: "Build a deterministic comment review queue from comments.list responses.",
    usageExample: {
      tool: "comments.review_queue",
      args: {
        documentIds: ["doc-1", "doc-2"],
        includeReplies: true,
        limitPerDocument: 20,
      },
    },
    bestPractices: [
      "Scope to explicit documentIds whenever possible for predictable queue size.",
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
