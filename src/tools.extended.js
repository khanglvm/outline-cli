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

function defaultUsageArgs(def) {
  if (def.tool === "documents.empty_trash") {
    return def.mutating ? { performAction: true } : {};
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
  { tool: "documents.memberships", method: "documents.memberships", description: "List document user memberships." },
  { tool: "documents.group_memberships", method: "documents.group_memberships", description: "List document group memberships." },
  { tool: "documents.add_user", method: "documents.add_user", description: "Add a user to a document.", mutating: true },
  { tool: "documents.remove_user", method: "documents.remove_user", description: "Remove a user from a document.", mutating: true },
  { tool: "documents.add_group", method: "documents.add_group", description: "Add a group to a document.", mutating: true },
  { tool: "documents.remove_group", method: "documents.remove_group", description: "Remove a group from a document.", mutating: true },
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
