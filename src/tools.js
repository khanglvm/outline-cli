import { ApiError, CliError } from "./errors.js";
import {
  assertPerformAction,
  consumeDocumentDeleteReadReceipt,
  getDocumentDeleteReadReceipt,
  isLikelyDeleteMethod,
  isLikelyMutatingMethod,
  issueDocumentDeleteReadReceipt,
} from "./action-gate.js";
import { NAVIGATION_TOOLS } from "./tools.navigation.js";
import { MUTATION_TOOLS } from "./tools.mutation.js";
import { PLATFORM_TOOLS } from "./tools.platform.js";
import { validateToolArgs } from "./tool-arg-schemas.js";
import {
  compactValue,
  ensureStringArray,
  mapLimit,
  parseCsv,
  projectObject,
  toInteger,
} from "./utils.js";

function normalizeStatusFilter(statusFilter) {
  if (statusFilter === undefined || statusFilter === null) {
    return undefined;
  }
  if (Array.isArray(statusFilter)) {
    return statusFilter;
  }
  if (typeof statusFilter === "string") {
    return parseCsv(statusFilter);
  }
  throw new CliError("statusFilter must be string or string[]");
}

function normalizeIds(args) {
  const ids = [];
  if (args.id) {
    ids.push(String(args.id));
  }
  if (args.ids) {
    ids.push(...ensureStringArray(args.ids, "ids"));
  }
  return [...new Set(ids)];
}

function normalizeSearchRow(row, view = "summary", contextChars = 320) {
  if (view === "full") {
    return row;
  }

  const doc = row.document || row;
  const context = row.context || "";
  const summary = {
    id: doc.id,
    title: doc.title,
    collectionId: doc.collectionId,
    parentDocumentId: doc.parentDocumentId,
    updatedAt: doc.updatedAt,
    publishedAt: doc.publishedAt,
    urlId: doc.urlId,
    ranking: row.ranking,
    context: context.length > contextChars ? `${context.slice(0, contextChars)}...` : context,
  };

  if (view === "ids") {
    return {
      id: summary.id,
      title: summary.title,
      ranking: summary.ranking,
    };
  }

  return summary;
}

function normalizeDocumentRow(row, view = "summary", excerptChars = 280) {
  if (view === "full") {
    return row;
  }

  const summary = {
    id: row.id,
    title: row.title,
    collectionId: row.collectionId,
    parentDocumentId: row.parentDocumentId,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    urlId: row.urlId,
    emoji: row.emoji,
  };

  if (view === "ids") {
    return {
      id: summary.id,
      title: summary.title,
    };
  }

  if (row.text) {
    summary.excerpt = row.text.length > excerptChars ? `${row.text.slice(0, excerptChars)}...` : row.text;
  }

  return summary;
}

function normalizeCollectionRow(row, view = "summary") {
  if (view === "full") {
    return row;
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    permission: row.permission,
    sharing: row.sharing,
    updatedAt: row.updatedAt,
    color: row.color,
    icon: row.icon,
    urlId: row.urlId,
  };
}

function applyViewToList(data, mapper) {
  if (!Array.isArray(data)) {
    return data;
  }
  return data.map((item) => mapper(item));
}

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

function applySelectToData(payload, select) {
  if (!select || select.length === 0) {
    return payload;
  }

  if (payload && typeof payload === "object" && Array.isArray(payload.data)) {
    return {
      ...payload,
      data: payload.data.map((item) => projectObject(item, select)),
    };
  }

  if (payload && typeof payload === "object" && payload.data && typeof payload.data === "object") {
    return {
      ...payload,
      data: projectObject(payload.data, select),
    };
  }

  return projectObject(payload, select);
}

async function apiCallTool(ctx, args) {
  const method = args.method || args.endpoint;
  if (!method) {
    throw new CliError("api.call requires args.method");
  }
  const body = args.body && typeof args.body === "object" ? args.body : {};
  const maxAttempts = toInteger(args.maxAttempts, 1);

  if (isLikelyMutatingMethod(method)) {
    assertPerformAction(args, {
      tool: "api.call",
      action: `invoke mutating method '${method}'`,
    });
  }

  let deleteGate = null;
  if (isLikelyDeleteMethod(method)) {
    const targetId = body?.id;
    if (!targetId) {
      throw new CliError("Delete via api.call requires body.id", {
        code: "DELETE_TARGET_REQUIRED",
        method,
      });
    }

    const receipt = await getDocumentDeleteReadReceipt({
      token: args.readToken,
      profileId: ctx.profile.id,
      documentId: String(targetId),
    });

    const latest = await ctx.client.call("documents.info", { id: String(targetId) }, {
      maxAttempts: Math.max(1, maxAttempts),
    });
    const actualRevision = Number(latest.body?.data?.revision);
    const expectedRevision = Number(receipt.revision);
    if (
      Number.isFinite(expectedRevision) &&
      Number.isFinite(actualRevision) &&
      actualRevision !== expectedRevision
    ) {
      throw new CliError("Delete read confirmation is stale; re-read the document with armDelete=true", {
        code: "DELETE_READ_TOKEN_STALE",
        method,
        id: String(targetId),
        expectedRevision,
        actualRevision,
      });
    }

    deleteGate = {
      token: args.readToken,
      id: String(targetId),
      expectedRevision,
      actualRevision,
    };
  }

  const res = await ctx.client.call(method, body, { maxAttempts });
  if (deleteGate && res.body?.success !== false) {
    await consumeDocumentDeleteReadReceipt(deleteGate.token);
  }
  let payload = res.body;
  payload = maybeDropPolicies(payload, !!args.includePolicies);

  if (args.select) {
    payload = applySelectToData(payload, ensureStringArray(args.select, "select"));
  }

  return {
    tool: "api.call",
    profile: ctx.profile.id,
    method,
    result: payload,
  };
}

async function authInfoTool(ctx, args) {
  const res = await ctx.client.call("auth.info", {});
  let payload = res.body;
  payload = maybeDropPolicies(payload, !!args.includePolicies);

  if (args.view === "summary") {
    payload = {
      data: {
        user: payload?.data?.user,
        team: payload?.data?.team,
      },
      policies: payload?.policies,
    };
    payload = maybeDropPolicies(payload, !!args.includePolicies);
  }

  return {
    tool: "auth.info",
    profile: ctx.profile.id,
    result: payload,
  };
}

async function documentsSearchTool(ctx, args) {
  const mode = args.mode === "titles" ? "titles" : "semantic";
  const endpoint = mode === "titles" ? "documents.search_titles" : "documents.search";
  const queries = ensureStringArray(args.queries, "queries") || (args.query ? [String(args.query)] : []);

  if (queries.length === 0) {
    throw new CliError("documents.search requires args.query or args.queries[]");
  }

  const baseBody = compactValue({
    collectionId: args.collectionId,
    documentId: args.documentId,
    userId: args.userId,
    statusFilter: normalizeStatusFilter(args.statusFilter),
    dateFilter: args.dateFilter,
    shareId: args.shareId,
    limit: toInteger(args.limit, 25),
    offset: toInteger(args.offset, 0),
    snippetMinWords: mode === "semantic" ? toInteger(args.snippetMinWords, 20) : undefined,
    snippetMaxWords: mode === "semantic" ? toInteger(args.snippetMaxWords, 30) : undefined,
    sort: args.sort,
    direction: args.direction,
  }) || {};

  const concurrency = toInteger(args.concurrency, 4);
  const view = args.view || "summary";
  const contextChars = toInteger(args.contextChars, 320);

  const perQuery = await mapLimit(queries, concurrency, async (query) => {
    const body = {
      ...baseBody,
      query,
    };
    const res = await ctx.client.call(endpoint, body, {
      maxAttempts: toInteger(args.maxAttempts, 2),
    });

    let payload = res.body;
    if (view !== "full") {
      payload = {
        ...payload,
        data: applyViewToList(payload.data, (item) => normalizeSearchRow(item, view, contextChars)),
      };
    }

    payload = maybeDropPolicies(payload, !!args.includePolicies);
    if (args.select) {
      payload = applySelectToData(payload, ensureStringArray(args.select, "select"));
    }

    return {
      query,
      ...payload,
    };
  });

  const mergeResults = args.merge !== false;
  let merged = undefined;

  if (mergeResults) {
    const byId = new Map();
    for (const q of perQuery) {
      for (const item of q.data || []) {
        const id = item.id || item?.document?.id;
        if (!id) {
          continue;
        }
        const ranking = Number(item.ranking ?? 0);
        const previous = byId.get(id);
        if (!previous || ranking > previous.ranking) {
          byId.set(id, {
            ...item,
            queries: [q.query],
            ranking,
          });
        } else {
          previous.queries = [...new Set([...(previous.queries || []), q.query])];
        }
      }
    }
    merged = Array.from(byId.values()).sort((a, b) => (b.ranking || 0) - (a.ranking || 0));
  }

  if (queries.length === 1 && !args.forceGroupedResult) {
    return {
      tool: "documents.search",
      mode,
      profile: ctx.profile.id,
      query: queries[0],
      result: {
        ...perQuery[0],
        merged,
      },
    };
  }

  return {
    tool: "documents.search",
    mode,
    profile: ctx.profile.id,
    queryCount: queries.length,
    result: {
      perQuery,
      merged,
    },
  };
}

async function documentsListTool(ctx, args) {
  const body = compactValue({
    limit: toInteger(args.limit, 25),
    offset: toInteger(args.offset, 0),
    sort: args.sort,
    direction: args.direction,
    collectionId: args.collectionId,
    userId: args.userId,
    backlinkDocumentId: args.backlinkDocumentId,
    parentDocumentId: Object.prototype.hasOwnProperty.call(args, "parentDocumentId")
      ? args.parentDocumentId
      : undefined,
    statusFilter: normalizeStatusFilter(args.statusFilter),
  }) || {};

  const res = await ctx.client.call("documents.list", body, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });

  const view = args.view || "summary";
  const excerptChars = toInteger(args.excerptChars, 220);
  let payload = res.body;
  if (view !== "full") {
    payload = {
      ...payload,
      data: applyViewToList(payload.data, (item) => normalizeDocumentRow(item, view, excerptChars)),
    };
  }

  payload = maybeDropPolicies(payload, !!args.includePolicies);
  if (args.select) {
    payload = applySelectToData(payload, ensureStringArray(args.select, "select"));
  }

  return {
    tool: "documents.list",
    profile: ctx.profile.id,
    result: payload,
  };
}

async function documentsInfoTool(ctx, args) {
  const ids = normalizeIds(args);
  const view = args.view || "summary";
  const excerptChars = toInteger(args.excerptChars, 280);
  const armDelete = args.armDelete === true;
  const readTokenTtlSeconds = toInteger(args.readTokenTtlSeconds, 900);

  if (ids.length === 0 && !args.shareId) {
    throw new CliError("documents.info requires args.id, args.ids, or args.shareId");
  }

  const maxAttempts = toInteger(args.maxAttempts, 2);

  if (ids.length <= 1 && !args.ids) {
    const body = compactValue({
      id: ids[0],
      shareId: args.shareId,
    }) || {};

    const res = await ctx.client.call("documents.info", body, { maxAttempts });
    const rawDoc = res.body?.data;
    let payload = res.body;
    if (view !== "full" && payload.data) {
      payload = {
        ...payload,
        data: normalizeDocumentRow(payload.data, view, excerptChars),
      };
    }
    payload = maybeDropPolicies(payload, !!args.includePolicies);

    if (args.select) {
      payload = applySelectToData(payload, ensureStringArray(args.select, "select"));
    }

    let deleteReadReceipt = undefined;
    if (armDelete && rawDoc?.id) {
      deleteReadReceipt = await issueDocumentDeleteReadReceipt({
        profileId: ctx.profile.id,
        documentId: rawDoc.id,
        revision: rawDoc.revision,
        title: rawDoc.title,
        ttlSeconds: readTokenTtlSeconds,
      });
    }

    const result = compactValue({
      ...payload,
      deleteReadReceipt,
    });

    return {
      tool: "documents.info",
      profile: ctx.profile.id,
      result,
    };
  }

  const concurrency = toInteger(args.concurrency, 4);
  const results = await mapLimit(ids, concurrency, async (id) => {
    try {
      const res = await ctx.client.call("documents.info", { id }, { maxAttempts });
      let payload = res.body;
      if (view !== "full" && payload.data) {
        payload = {
          ...payload,
          data: normalizeDocumentRow(payload.data, view, excerptChars),
        };
      }
      payload = maybeDropPolicies(payload, !!args.includePolicies);

      let deleteReadReceipt = undefined;
      if (armDelete && res.body?.data?.id) {
        deleteReadReceipt = await issueDocumentDeleteReadReceipt({
          profileId: ctx.profile.id,
          documentId: res.body.data.id,
          revision: res.body.data.revision,
          title: res.body.data.title,
          ttlSeconds: readTokenTtlSeconds,
        });
      }
      return {
        id,
        ok: true,
        ...payload,
        ...(deleteReadReceipt ? { deleteReadReceipt } : {}),
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

  return {
    tool: "documents.info",
    profile: ctx.profile.id,
    batched: true,
    result: {
      total: ids.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      items: results,
    },
  };
}

async function documentsCreateTool(ctx, args) {
  const body = compactValue({
    id: args.id,
    title: args.title,
    text: args.text,
    icon: args.icon,
    color: args.color,
    collectionId: args.collectionId,
    parentDocumentId: args.parentDocumentId,
    templateId: args.templateId,
    publish: args.publish,
    fullWidth: args.fullWidth,
    createdAt: args.createdAt,
    dataAttributes: args.dataAttributes,
  }) || {};

  const res = await ctx.client.call("documents.create", body, {
    maxAttempts: toInteger(args.maxAttempts, 1),
  });

  let payload = res.body;
  payload = maybeDropPolicies(payload, !!args.includePolicies);

  const view = args.view || "summary";
  if (view !== "full" && payload.data) {
    payload = {
      ...payload,
      data: normalizeDocumentRow(payload.data, view, toInteger(args.excerptChars, 220)),
    };
  }

  return {
    tool: "documents.create",
    profile: ctx.profile.id,
    result: payload,
  };
}

async function documentsUpdateTool(ctx, args) {
  if (!args.id) {
    throw new CliError("documents.update requires args.id");
  }
  assertPerformAction(args, {
    tool: "documents.update",
    action: "update a document",
  });

  const body = compactValue({
    id: args.id,
    title: args.title,
    text: args.text,
    icon: args.icon,
    color: args.color,
    fullWidth: args.fullWidth,
    templateId: args.templateId,
    collectionId: args.collectionId,
    insightsEnabled: args.insightsEnabled,
    editMode: args.editMode,
    publish: args.publish,
    dataAttributes: args.dataAttributes,
  }) || {};

  const res = await ctx.client.call("documents.update", body, {
    maxAttempts: toInteger(args.maxAttempts, 1),
  });

  let payload = res.body;
  payload = maybeDropPolicies(payload, !!args.includePolicies);

  const view = args.view || "summary";
  if (view !== "full" && payload.data) {
    payload = {
      ...payload,
      data: normalizeDocumentRow(payload.data, view, toInteger(args.excerptChars, 220)),
    };
  }

  return {
    tool: "documents.update",
    profile: ctx.profile.id,
    result: payload,
  };
}

async function collectionsListTool(ctx, args) {
  const body = compactValue({
    limit: toInteger(args.limit, 25),
    offset: toInteger(args.offset, 0),
    sort: args.sort,
    direction: args.direction,
    query: args.query,
    statusFilter: normalizeStatusFilter(args.statusFilter),
  }) || {};

  const res = await ctx.client.call("collections.list", body, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });

  const view = args.view || "summary";
  let payload = res.body;
  if (view !== "full") {
    payload = {
      ...payload,
      data: applyViewToList(payload.data, (item) => normalizeCollectionRow(item, view)),
    };
  }
  payload = maybeDropPolicies(payload, !!args.includePolicies);

  if (args.select) {
    payload = applySelectToData(payload, ensureStringArray(args.select, "select"));
  }

  return {
    tool: "collections.list",
    profile: ctx.profile.id,
    result: payload,
  };
}

async function collectionsInfoTool(ctx, args) {
  const ids = normalizeIds(args);
  if (ids.length === 0) {
    throw new CliError("collections.info requires args.id or args.ids");
  }

  const view = args.view || "summary";
  const maxAttempts = toInteger(args.maxAttempts, 2);

  if (ids.length === 1 && !args.ids) {
    const res = await ctx.client.call("collections.info", { id: ids[0] }, { maxAttempts });
    let payload = res.body;
    if (view !== "full" && payload.data) {
      payload = {
        ...payload,
        data: normalizeCollectionRow(payload.data, view),
      };
    }
    payload = maybeDropPolicies(payload, !!args.includePolicies);
    return {
      tool: "collections.info",
      profile: ctx.profile.id,
      result: payload,
    };
  }

  const concurrency = toInteger(args.concurrency, 4);
  const results = await mapLimit(ids, concurrency, async (id) => {
    try {
      const res = await ctx.client.call("collections.info", { id }, { maxAttempts });
      let payload = res.body;
      if (view !== "full" && payload.data) {
        payload = {
          ...payload,
          data: normalizeCollectionRow(payload.data, view),
        };
      }
      payload = maybeDropPolicies(payload, !!args.includePolicies);
      return {
        id,
        ok: true,
        ...payload,
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

  return {
    tool: "collections.info",
    profile: ctx.profile.id,
    batched: true,
    result: {
      total: ids.length,
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      items: results,
    },
  };
}

async function collectionsCreateTool(ctx, args) {
  if (!args.name) {
    throw new CliError("collections.create requires args.name");
  }

  const body = compactValue({
    name: args.name,
    description: args.description,
    permission: args.permission,
    icon: args.icon,
    color: args.color,
    sharing: args.sharing,
  }) || {};

  const res = await ctx.client.call("collections.create", body, {
    maxAttempts: toInteger(args.maxAttempts, 1),
  });

  let payload = maybeDropPolicies(res.body, !!args.includePolicies);
  if ((args.view || "summary") !== "full" && payload.data) {
    payload = {
      ...payload,
      data: normalizeCollectionRow(payload.data, args.view || "summary"),
    };
  }

  return {
    tool: "collections.create",
    profile: ctx.profile.id,
    result: payload,
  };
}

async function collectionsUpdateTool(ctx, args) {
  if (!args.id) {
    throw new CliError("collections.update requires args.id");
  }
  assertPerformAction(args, {
    tool: "collections.update",
    action: "update a collection",
  });

  const body = compactValue({
    id: args.id,
    name: args.name,
    description: args.description,
    permission: args.permission,
    icon: args.icon,
    color: args.color,
    sharing: args.sharing,
  }) || {};

  const res = await ctx.client.call("collections.update", body, {
    maxAttempts: toInteger(args.maxAttempts, 1),
  });

  let payload = maybeDropPolicies(res.body, !!args.includePolicies);
  if ((args.view || "summary") !== "full" && payload.data) {
    payload = {
      ...payload,
      data: normalizeCollectionRow(payload.data, args.view || "summary"),
    };
  }

  return {
    tool: "collections.update",
    profile: ctx.profile.id,
    result: payload,
  };
}

export const TOOLS = {
  "api.call": {
    signature:
      "api.call(args: { method?: string; endpoint?: string; body?: object; includePolicies?: boolean; maxAttempts?: number; select?: string[]; performAction?: boolean; readToken?: string })",
    description: "Call any Outline API RPC endpoint directly.",
    usageExample: {
      tool: "api.call",
      args: {
        method: "documents.info",
        body: {
          id: "outline-api-NTpezNwhUP",
        },
      },
    },
    bestPractices: [
      "Use this for endpoints not yet wrapped as dedicated tools.",
      "Send only the fields you need in `body` and use `select` to reduce tokens.",
      "Pass either `method` or `endpoint`; both are accepted aliases.",
      "Set maxAttempts=2 for read endpoints to absorb transient 429/5xx.",
      "Mutating methods are action-gated; set performAction=true intentionally.",
    ],
    handler: apiCallTool,
  },
  "auth.info": {
    signature: "auth.info(args?: { includePolicies?: boolean; view?: 'summary' | 'full' })",
    description: "Return authenticated user and team info to confirm profile permissions.",
    usageExample: {
      tool: "auth.info",
      args: {
        view: "summary",
      },
    },
    bestPractices: [
      "Call this once per session before mutating data.",
      "Use summary view first, then full only when needed.",
      "Inspect policies only when making capability decisions.",
    ],
    handler: authInfoTool,
  },
  "documents.search": {
    signature:
      "documents.search(args: { query?: string; queries?: string[]; mode?: 'semantic' | 'titles'; limit?: number; offset?: number; collectionId?: string; documentId?: string; userId?: string; statusFilter?: string[]; dateFilter?: 'day'|'week'|'month'|'year'; snippetMinWords?: number; snippetMaxWords?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'summary'|'ids'|'full'; includePolicies?: boolean; merge?: boolean; concurrency?: number; })",
    description: "Search documents with single or multi-query batch in one invocation.",
    usageExample: {
      tool: "documents.search",
      args: {
        queries: ["deployment runbook", "oncall escalation"],
        mode: "semantic",
        limit: 8,
        view: "summary",
        merge: true,
      },
    },
    bestPractices: [
      "Prefer `queries[]` batch mode to reduce round trips.",
      "Use `view=ids` for planning and follow with documents.info only on selected IDs.",
      "Tune snippetMinWords/snippetMaxWords to control context window size.",
    ],
    handler: documentsSearchTool,
  },
  "documents.list": {
    signature:
      "documents.list(args?: { limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; collectionId?: string; parentDocumentId?: string | null; userId?: string; statusFilter?: string[]; view?: 'ids'|'summary'|'full'; includePolicies?: boolean })",
    description: "List documents with filtering and pagination.",
    usageExample: {
      tool: "documents.list",
      args: {
        collectionId: "6f35e6db-5930-4db8-9c31-66fe12f9f4aa",
        limit: 20,
        statusFilter: ["published"],
        view: "summary",
      },
    },
    bestPractices: [
      "Use small page sizes (10-25) and iterate with offset.",
      "Set parentDocumentId=null to list only collection root pages.",
      "Use summary view unless the full document body is required.",
    ],
    handler: documentsListTool,
  },
  "documents.info": {
    signature:
      "documents.info(args: { id?: string; ids?: string[]; shareId?: string; view?: 'summary'|'full'; includePolicies?: boolean; concurrency?: number; armDelete?: boolean; readTokenTtlSeconds?: number })",
    description: "Read one or many documents by ID.",
    usageExample: {
      tool: "documents.info",
      args: {
        ids: ["doc-1", "doc-2", "doc-3"],
        view: "summary",
        concurrency: 3,
      },
    },
    bestPractices: [
      "Use `ids[]` batch mode to fetch multiple docs in one CLI call.",
      "Use summary view first; only request full for final chosen docs.",
      "Handle partial failures by checking each item.ok in batched result.",
      "Set armDelete=true when you need a short-lived delete read token for a safe delete flow.",
    ],
    handler: documentsInfoTool,
  },
  "documents.create": {
    signature:
      "documents.create(args: { title?: string; text?: string; collectionId?: string; parentDocumentId?: string; publish?: boolean; icon?: string; color?: string; templateId?: string; fullWidth?: boolean; view?: 'summary'|'full' })",
    description: "Create a new document in Outline.",
    usageExample: {
      tool: "documents.create",
      args: {
        title: "Incident 2026-03-04",
        text: "# Incident\n\nSummary...",
        collectionId: "collection-id",
        publish: true,
      },
    },
    bestPractices: [
      "Set publish=true only when collection/parent is known.",
      "Use templates when available to standardize structure.",
      "Store long markdown in a file and pass via args-file to avoid shell escaping issues.",
    ],
    handler: documentsCreateTool,
  },
  "documents.update": {
    signature:
      "documents.update(args: { id: string; title?: string; text?: string; editMode?: 'replace'|'append'|'prepend'; publish?: boolean; collectionId?: string; templateId?: string; fullWidth?: boolean; insightsEnabled?: boolean; view?: 'summary'|'full'; performAction?: boolean })",
    description: "Update an existing document.",
    usageExample: {
      tool: "documents.update",
      args: {
        id: "doc-id",
        text: "\n\n## Follow-up\n- Added RCA",
        editMode: "append",
      },
    },
    bestPractices: [
      "For append/prepend, include only incremental text instead of full document body.",
      "Read the document first when multiple agents may edit concurrently.",
      "Use publish=true only when transitioning drafts to published state intentionally.",
      "This tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: documentsUpdateTool,
  },
  "collections.list": {
    signature:
      "collections.list(args?: { query?: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; statusFilter?: string[]; view?: 'summary'|'full'; includePolicies?: boolean })",
    description: "List collections visible to the current profile.",
    usageExample: {
      tool: "collections.list",
      args: {
        query: "engineering",
        limit: 10,
        view: "summary",
      },
    },
    bestPractices: [
      "Resolve collection IDs once and reuse them in later calls.",
      "Use summary view for navigation and planning.",
      "Include policies only when checking write privileges.",
    ],
    handler: collectionsListTool,
  },
  "collections.info": {
    signature:
      "collections.info(args: { id?: string; ids?: string[]; view?: 'summary'|'full'; includePolicies?: boolean; concurrency?: number })",
    description: "Read one or many collections by ID.",
    usageExample: {
      tool: "collections.info",
      args: {
        ids: ["col-1", "col-2"],
        view: "summary",
      },
    },
    bestPractices: [
      "Use ids[] to batch collection hydration in one request.",
      "Treat missing collections as permission or existence issues.",
      "Use full view only for collection metadata you actually need.",
    ],
    handler: collectionsInfoTool,
  },
  "collections.create": {
    signature:
      "collections.create(args: { name: string; description?: string; permission?: string; icon?: string; color?: string; sharing?: boolean; view?: 'summary'|'full' })",
    description: "Create a collection.",
    usageExample: {
      tool: "collections.create",
      args: {
        name: "Agent Notes",
        description: "Working area for AI-assisted drafts",
        permission: "read_write",
        sharing: false,
      },
    },
    bestPractices: [
      "Prefer explicit permission values to avoid ambiguous defaults.",
      "Create collection first, then create documents under it.",
      "Use summary output in autonomous loops.",
    ],
    handler: collectionsCreateTool,
  },
  "collections.update": {
    signature:
      "collections.update(args: { id: string; name?: string; description?: string; permission?: string; icon?: string; color?: string; sharing?: boolean; view?: 'summary'|'full'; performAction?: boolean })",
    description: "Update collection metadata.",
    usageExample: {
      tool: "collections.update",
      args: {
        id: "col-id",
        description: "Updated description",
        sharing: true,
      },
    },
    bestPractices: [
      "Read collection first when coordinating changes across agents.",
      "Apply minimal field diffs rather than resending all properties.",
      "Keep sharing changes explicit and auditable.",
      "This tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: collectionsUpdateTool,
  },
  ...NAVIGATION_TOOLS,
  ...MUTATION_TOOLS,
  ...PLATFORM_TOOLS,
};

export function listTools() {
  return Object.entries(TOOLS).map(([name, def]) => ({
    name,
    signature: def.signature,
    description: def.description,
  }));
}

export function getToolContract(name) {
  if (name === "all") {
    return Object.entries(TOOLS).map(([toolName, def]) => ({
      name: toolName,
      signature: def.signature,
      description: def.description,
      usageExample: def.usageExample,
      bestPractices: def.bestPractices,
    }));
  }

  const def = TOOLS[name];
  if (!def) {
    throw new CliError(`Unknown tool: ${name}`);
  }

  return {
    name,
    signature: def.signature,
    description: def.description,
    usageExample: def.usageExample,
    bestPractices: def.bestPractices,
  };
}

export async function invokeTool(ctx, name, args = {}) {
  const tool = TOOLS[name];
  if (!tool) {
    throw new CliError(`Unknown tool: ${name}`);
  }

  validateToolArgs(name, args);

  const result = await tool.handler(ctx, args);
  if (args.compact ?? true) {
    return compactValue(result) || {};
  }
  return result;
}
