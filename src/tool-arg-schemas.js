import { CliError } from "./errors.js";

const TYPES = {
  string: (v) => typeof v === "string",
  number: (v) => typeof v === "number" && Number.isFinite(v),
  boolean: (v) => typeof v === "boolean",
  object: (v) => !!v && typeof v === "object" && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
  "string[]": (v) => Array.isArray(v) && v.every((x) => typeof x === "string"),
  "string|string[]": (v) => typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string")),
};

function fail(tool, issues) {
  throw new CliError(`Invalid args for ${tool}`, {
    code: "ARG_VALIDATION_FAILED",
    tool,
    issues,
  });
}

function ensureObject(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    fail(tool, [{ path: "args", message: "must be an object" }]);
  }
}

function validateSpec(tool, args, spec) {
  const issues = [];
  const properties = spec.properties || {};

  if (!spec.allowUnknown) {
    const allowed = new Set(Object.keys(properties));
    allowed.add("compact");
    for (const key of Object.keys(args)) {
      if (!allowed.has(key)) {
        issues.push({
          path: `args.${key}`,
          message: "is not allowed",
        });
      }
    }
  }

  for (const key of spec.required || []) {
    if (args[key] === undefined) {
      issues.push({ path: `args.${key}`, message: "is required" });
    }
  }

  for (const [key, rule] of Object.entries(properties)) {
    const value = args[key];
    if (value === undefined) {
      continue;
    }

    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    const match = types.some((type) => TYPES[type] && TYPES[type](value));
    if (!match) {
      issues.push({
        path: `args.${key}`,
        message: `must be ${types.join(" or ")}`,
      });
      continue;
    }

    if (rule.enum && !rule.enum.includes(value)) {
      issues.push({
        path: `args.${key}`,
        message: `must be one of: ${rule.enum.join(", ")}`,
      });
      continue;
    }

    if (rule.min != null && typeof value === "number" && value < rule.min) {
      issues.push({ path: `args.${key}`, message: `must be >= ${rule.min}` });
    }
  }

  if (typeof spec.custom === "function") {
    spec.custom(args, issues);
  }

  if (issues.length > 0) {
    fail(tool, issues);
  }
}

const SHARED_DOC_COMMON = {
  collectionId: { type: "string" },
  userId: { type: "string" },
  statusFilter: { type: ["string", "string[]"] },
  view: { type: "string", enum: ["ids", "summary", "full"] },
};

export const TOOL_ARG_SCHEMAS = {
  "api.call": {
    properties: {
      method: { type: "string" },
      endpoint: { type: "string" },
      body: { type: "object" },
      includePolicies: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
      select: { type: ["string", "string[]"] },
      performAction: { type: "boolean" },
      readToken: { type: "string" },
    },
    custom(args, issues) {
      if (!args.method && !args.endpoint) {
        issues.push({ path: "args.method", message: "or args.endpoint is required" });
      }
    },
  },
  "auth.info": {
    properties: {
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
    },
  },
  "documents.search": {
    properties: {
      query: { type: "string" },
      queries: { type: "string[]" },
      mode: { type: "string", enum: ["semantic", "titles"] },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      documentId: { type: "string" },
      shareId: { type: "string" },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      merge: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      ...SHARED_DOC_COMMON,
    },
    custom(args, issues) {
      if (!args.query && !args.queries) {
        issues.push({ path: "args.query", message: "or args.queries[] is required" });
      }
    },
  },
  "documents.list": {
    properties: {
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      parentDocumentId: { type: ["string", "null"] },
      backlinkDocumentId: { type: "string" },
      includePolicies: { type: "boolean" },
      ...SHARED_DOC_COMMON,
    },
  },
  "documents.info": {
    properties: {
      id: { type: "string" },
      ids: { type: "string[]" },
      shareId: { type: "string" },
      includePolicies: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      armDelete: { type: "boolean" },
      readTokenTtlSeconds: { type: "number", min: 60 },
    },
    custom(args, issues) {
      if (!args.id && !args.ids && !args.shareId) {
        issues.push({ path: "args.id", message: "or args.ids[] or args.shareId is required" });
      }
    },
  },
  "documents.create": {
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      text: { type: "string" },
      icon: { type: "string" },
      color: { type: "string" },
      collectionId: { type: "string" },
      parentDocumentId: { type: "string" },
      templateId: { type: "string" },
      publish: { type: "boolean" },
      fullWidth: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
    },
  },
  "documents.update": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      text: { type: "string" },
      icon: { type: "string" },
      color: { type: "string" },
      fullWidth: { type: "boolean" },
      templateId: { type: "string" },
      collectionId: { type: "string" },
      insightsEnabled: { type: "boolean" },
      editMode: { type: "string", enum: ["replace", "append", "prepend"] },
      publish: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      performAction: { type: "boolean" },
    },
  },
  "collections.list": {
    properties: {
      query: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      statusFilter: { type: ["string", "string[]"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
    },
  },
  "collections.info": {
    properties: {
      id: { type: "string" },
      ids: { type: "string[]" },
      includePolicies: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
    },
    custom(args, issues) {
      if (!args.id && !args.ids) {
        issues.push({ path: "args.id", message: "or args.ids[] is required" });
      }
    },
  },
  "collections.create": {
    required: ["name"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      permission: { type: "string" },
      icon: { type: "string" },
      color: { type: "string" },
      sharing: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
    },
  },
  "collections.update": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      permission: { type: "string" },
      icon: { type: "string" },
      color: { type: "string" },
      sharing: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      performAction: { type: "boolean" },
    },
  },
  "documents.resolve": {
    properties: {
      query: { type: "string" },
      queries: { type: "string[]" },
      collectionId: { type: "string" },
      limit: { type: "number", min: 1 },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      concurrency: { type: "number", min: 1 },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      excerptChars: { type: "number", min: 1 },
      forceGroupedResult: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (!args.query && !args.queries) {
        issues.push({ path: "args.query", message: "or args.queries[] is required" });
      }
      if (typeof args.strictThreshold === "number" && args.strictThreshold > 1) {
        issues.push({ path: "args.strictThreshold", message: "must be <= 1" });
      }
    },
  },
  "collections.tree": {
    required: ["collectionId"],
    properties: {
      collectionId: { type: "string" },
      includeDrafts: { type: "boolean" },
      maxDepth: { type: "number", min: 0 },
      view: { type: "string", enum: ["summary", "full"] },
      pageSize: { type: "number", min: 1 },
      maxPages: { type: "number", min: 1 },
      statusFilter: { type: ["string", "string[]"] },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "search.expand": {
    properties: {
      query: { type: "string" },
      queries: { type: "string[]" },
      mode: { type: "string", enum: ["semantic", "titles"] },
      limit: { type: "number", min: 1 },
      expandLimit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      concurrency: { type: "number", min: 1 },
      hydrateConcurrency: { type: "number", min: 1 },
      collectionId: { type: "string" },
      documentId: { type: "string" },
      userId: { type: "string" },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      contextChars: { type: "number", min: 1 },
      excerptChars: { type: "number", min: 1 },
      forceGroupedResult: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (!args.query && !args.queries) {
        issues.push({ path: "args.query", message: "or args.queries[] is required" });
      }
    },
  },
  "search.research": {
    properties: {
      question: { type: "string" },
      query: { type: "string" },
      queries: { type: "string[]" },
      collectionId: { type: "string" },
      limitPerQuery: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      includeTitleSearch: { type: "boolean" },
      includeSemanticSearch: { type: "boolean" },
      expandLimit: { type: "number", min: 1 },
      maxDocuments: { type: "number", min: 1 },
      seenIds: { type: "string[]" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      concurrency: { type: "number", min: 1 },
      hydrateConcurrency: { type: "number", min: 1 },
      contextChars: { type: "number", min: 1 },
      excerptChars: { type: "number", min: 1 },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (!args.question && !args.query && !args.queries) {
        issues.push({ path: "args.question", message: "or args.query or args.queries[] is required" });
      }
      if (args.includeTitleSearch === false && args.includeSemanticSearch === false) {
        issues.push({
          path: "args.includeTitleSearch",
          message: "and includeSemanticSearch cannot both be false",
        });
      }
    },
  },
  "documents.safe_update": {
    required: ["id", "expectedRevision"],
    properties: {
      id: { type: "string" },
      expectedRevision: { type: "number", min: 0 },
      title: { type: "string" },
      text: { type: "string" },
      icon: { type: "string" },
      color: { type: "string" },
      fullWidth: { type: "boolean" },
      templateId: { type: "string" },
      collectionId: { type: "string" },
      insightsEnabled: { type: "boolean" },
      editMode: { type: "string", enum: ["replace", "append", "prepend"] },
      publish: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      excerptChars: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.diff": {
    required: ["id", "proposedText"],
    properties: {
      id: { type: "string" },
      proposedText: { type: "string" },
      includeFullHunks: { type: "boolean" },
      hunkLimit: { type: "number", min: 1 },
      hunkLineLimit: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "documents.apply_patch": {
    required: ["id", "patch"],
    properties: {
      id: { type: "string" },
      patch: { type: "string" },
      mode: { type: "string", enum: ["unified", "replace"] },
      title: { type: "string" },
      view: { type: "string", enum: ["summary", "full"] },
      excerptChars: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.batch_update": {
    required: ["updates"],
    properties: {
      updates: { type: "array" },
      concurrency: { type: "number", min: 1 },
      continueOnError: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (!Array.isArray(args.updates) || args.updates.length === 0) {
        issues.push({ path: "args.updates", message: "must be a non-empty array" });
        return;
      }
      for (let i = 0; i < args.updates.length; i += 1) {
        const update = args.updates[i];
        if (!update || typeof update !== "object" || Array.isArray(update)) {
          issues.push({ path: `args.updates[${i}]`, message: "must be an object" });
          continue;
        }
        if (!update.id || typeof update.id !== "string") {
          issues.push({ path: `args.updates[${i}].id`, message: "is required and must be a string" });
        }
        if (
          Object.prototype.hasOwnProperty.call(update, "expectedRevision") &&
          !(typeof update.expectedRevision === "number" && Number.isFinite(update.expectedRevision))
        ) {
          issues.push({ path: `args.updates[${i}].expectedRevision`, message: "must be a number" });
        }
        if (
          Object.prototype.hasOwnProperty.call(update, "editMode") &&
          !["replace", "append", "prepend"].includes(update.editMode)
        ) {
          issues.push({ path: `args.updates[${i}].editMode`, message: "must be replace, append, or prepend" });
        }
      }
    },
  },
  "documents.plan_batch_update": {
    properties: {
      id: { type: "string" },
      ids: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      collectionId: { type: "string" },
      rules: { type: "array" },
      find: { type: "string" },
      replace: { type: "string" },
      field: { type: "string", enum: ["title", "text", "both"] },
      caseSensitive: { type: "boolean" },
      wholeWord: { type: "boolean" },
      all: { type: "boolean" },
      includeTitleSearch: { type: "boolean" },
      includeSemanticSearch: { type: "boolean" },
      limitPerQuery: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      maxDocuments: { type: "number", min: 1 },
      readConcurrency: { type: "number", min: 1 },
      includeUnchanged: { type: "boolean" },
      hunkLimit: { type: "number", min: 1 },
      hunkLineLimit: { type: "number", min: 1 },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
      concurrency: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (!args.id && !args.ids && !args.query && !args.queries) {
        issues.push({
          path: "args.ids",
          message: "or args.query/args.queries[] is required",
        });
      }
      if (!args.rules && !args.find) {
        issues.push({ path: "args.rules", message: "or args.find is required" });
      }
      if (args.includeTitleSearch === false && args.includeSemanticSearch === false) {
        issues.push({
          path: "args.includeTitleSearch",
          message: "and includeSemanticSearch cannot both be false",
        });
      }
    },
  },
  "documents.delete": {
    required: ["id", "readToken"],
    properties: {
      id: { type: "string" },
      readToken: { type: "string" },
      performAction: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "documents.apply_batch_plan": {
    required: ["plan", "confirmHash"],
    properties: {
      plan: { type: "object" },
      confirmHash: { type: "string" },
      dryRun: { type: "boolean" },
      continueOnError: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      excerptChars: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "revisions.list": {
    required: ["documentId"],
    properties: {
      documentId: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "revisions.restore": {
    required: ["id", "revisionId"],
    properties: {
      id: { type: "string" },
      revisionId: { type: "string" },
      collectionId: { type: "string" },
      view: { type: "string", enum: ["summary", "full"] },
      excerptChars: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "capabilities.map": {
    properties: {
      includePolicies: { type: "boolean" },
      includeRaw: { type: "boolean" },
    },
  },
  "documents.cleanup_test": {
    properties: {
      markerPrefix: { type: "string" },
      olderThanHours: { type: "number", min: 0 },
      dryRun: { type: "boolean" },
      maxPages: { type: "number", min: 1 },
      pageLimit: { type: "number", min: 1 },
      concurrency: { type: "number", min: 1 },
      allowUnsafePrefix: { type: "boolean" },
      includeErrors: { type: "boolean" },
      performAction: { type: "boolean" },
    },
  },
};

export function validateToolArgs(toolName, args = {}) {
  const spec = TOOL_ARG_SCHEMAS[toolName];
  if (!spec) {
    return;
  }

  ensureObject(toolName, args);
  validateSpec(toolName, args, spec);
}
