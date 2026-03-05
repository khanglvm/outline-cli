import { ApiError, CliError } from "./errors.js";
import { assertPerformAction } from "./action-gate.js";
import { compactValue, mapLimit, toInteger } from "./utils.js";

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
};

