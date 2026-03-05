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

const DATA_ATTRIBUTE_DATA_TYPES = ["string", "number", "boolean", "list"];
const USER_ROLE_TYPES = ["admin", "member", "viewer", "guest"];

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
  "documents.backlinks": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      includePolicies: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (typeof args.id === "string" && args.id.trim().length === 0) {
        issues.push({ path: "args.id", message: "must be a non-empty string" });
      }
      if (typeof args.limit === "number" && args.limit > 250) {
        issues.push({ path: "args.limit", message: "must be <= 250" });
      }
    },
  },
  "documents.graph_neighbors": {
    properties: {
      id: { type: "string" },
      ids: { type: "string[]" },
      includeBacklinks: { type: "boolean" },
      includeSearchNeighbors: { type: "boolean" },
      searchQueries: { type: "string[]" },
      limitPerSource: { type: "number", min: 1 },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.trim().length > 0;
      const hasIds = Array.isArray(args.ids) && args.ids.length > 0;

      if (!hasId && !hasIds) {
        issues.push({ path: "args.id", message: "or args.ids[] is required" });
      }
      if (Array.isArray(args.ids) && args.ids.length === 0) {
        issues.push({ path: "args.ids", message: "must be a non-empty string[] when provided" });
      }
      if (hasId && Array.isArray(args.ids)) {
        issues.push({ path: "args.ids", message: "cannot be combined with args.id" });
      }
      if (args.includeBacklinks === false && args.includeSearchNeighbors === false) {
        issues.push({
          path: "args.includeBacklinks",
          message: "and includeSearchNeighbors cannot both be false",
        });
      }
      if (Array.isArray(args.searchQueries)) {
        if (args.searchQueries.length === 0) {
          issues.push({ path: "args.searchQueries", message: "must be a non-empty string[] when provided" });
        }
        for (let i = 0; i < args.searchQueries.length; i += 1) {
          if (typeof args.searchQueries[i] === "string" && args.searchQueries[i].trim().length === 0) {
            issues.push({ path: `args.searchQueries[${i}]`, message: "must be a non-empty string" });
          }
        }
        if (args.includeSearchNeighbors === false) {
          issues.push({
            path: "args.includeSearchNeighbors",
            message: "must be true when args.searchQueries is provided",
          });
        }
      }
      if (typeof args.limitPerSource === "number" && args.limitPerSource > 100) {
        issues.push({ path: "args.limitPerSource", message: "must be <= 100" });
      }
    },
  },
  "documents.graph_report": {
    required: ["seedIds"],
    properties: {
      seedIds: { type: "string[]" },
      depth: { type: "number", min: 0 },
      maxNodes: { type: "number", min: 1 },
      includeBacklinks: { type: "boolean" },
      includeSearchNeighbors: { type: "boolean" },
      limitPerSource: { type: "number", min: 1 },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (Array.isArray(args.seedIds) && args.seedIds.length === 0) {
        issues.push({ path: "args.seedIds", message: "must be a non-empty string[]" });
      }
      if (Array.isArray(args.seedIds)) {
        for (let i = 0; i < args.seedIds.length; i += 1) {
          if (typeof args.seedIds[i] === "string" && args.seedIds[i].trim().length === 0) {
            issues.push({ path: `args.seedIds[${i}]`, message: "must be a non-empty string" });
          }
        }
      }
      if (typeof args.depth === "number" && args.depth > 6) {
        issues.push({ path: "args.depth", message: "must be <= 6" });
      }
      if (typeof args.maxNodes === "number" && args.maxNodes > 500) {
        issues.push({ path: "args.maxNodes", message: "must be <= 500" });
      }
      if (typeof args.limitPerSource === "number" && args.limitPerSource > 100) {
        issues.push({ path: "args.limitPerSource", message: "must be <= 100" });
      }
      if (args.includeBacklinks === false && args.includeSearchNeighbors === false) {
        issues.push({
          path: "args.includeBacklinks",
          message: "and includeSearchNeighbors cannot both be false",
        });
      }
    },
  },
  "documents.issue_refs": {
    properties: {
      id: { type: "string" },
      ids: { type: "string[]" },
      issueDomains: { type: "string[]" },
      keyPattern: { type: "string" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.trim().length > 0;
      const hasIds = Array.isArray(args.ids) && args.ids.length > 0;

      if (!hasId && !hasIds) {
        issues.push({ path: "args.id", message: "or args.ids[] is required" });
      }
      if (typeof args.id === "string" && args.id.trim().length === 0) {
        issues.push({ path: "args.id", message: "must be a non-empty string" });
      }
      if (Array.isArray(args.ids)) {
        if (args.ids.length === 0) {
          issues.push({ path: "args.ids", message: "must be a non-empty string[] when provided" });
        }
        for (let i = 0; i < args.ids.length; i += 1) {
          if (typeof args.ids[i] === "string" && args.ids[i].trim().length === 0) {
            issues.push({ path: `args.ids[${i}]`, message: "must be a non-empty string" });
          }
        }
      }
      if (Array.isArray(args.issueDomains)) {
        if (args.issueDomains.length === 0) {
          issues.push({ path: "args.issueDomains", message: "must be a non-empty string[] when provided" });
        }
        for (let i = 0; i < args.issueDomains.length; i += 1) {
          if (
            typeof args.issueDomains[i] === "string" &&
            args.issueDomains[i].trim().length === 0
          ) {
            issues.push({ path: `args.issueDomains[${i}]`, message: "must be a non-empty string" });
          }
        }
      }
      if (typeof args.keyPattern === "string") {
        if (args.keyPattern.trim().length === 0) {
          issues.push({ path: "args.keyPattern", message: "must be a non-empty string when provided" });
        } else {
          try {
            // eslint-disable-next-line no-new
            new RegExp(args.keyPattern.trim(), "g");
          } catch {
            issues.push({ path: "args.keyPattern", message: "must be a valid regex pattern" });
          }
        }
      }
    },
  },
  "documents.issue_ref_report": {
    properties: {
      query: { type: "string" },
      queries: { type: "string[]" },
      collectionId: { type: "string" },
      issueDomains: { type: "string[]" },
      keyPattern: { type: "string" },
      limit: { type: "number", min: 1 },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasQuery = typeof args.query === "string" && args.query.trim().length > 0;
      const hasQueries = Array.isArray(args.queries) && args.queries.length > 0;

      if (!hasQuery && !hasQueries) {
        issues.push({ path: "args.query", message: "or args.queries[] is required" });
      }
      if (typeof args.query === "string" && args.query.trim().length === 0) {
        issues.push({ path: "args.query", message: "must be a non-empty string when provided" });
      }
      if (Array.isArray(args.queries)) {
        if (args.queries.length === 0) {
          issues.push({ path: "args.queries", message: "must be a non-empty string[] when provided" });
        }
        for (let i = 0; i < args.queries.length; i += 1) {
          if (typeof args.queries[i] === "string" && args.queries[i].trim().length === 0) {
            issues.push({ path: `args.queries[${i}]`, message: "must be a non-empty string" });
          }
        }
      }
      if (typeof args.collectionId === "string" && args.collectionId.trim().length === 0) {
        issues.push({ path: "args.collectionId", message: "must be a non-empty string when provided" });
      }
      if (Array.isArray(args.issueDomains)) {
        if (args.issueDomains.length === 0) {
          issues.push({ path: "args.issueDomains", message: "must be a non-empty string[] when provided" });
        }
        for (let i = 0; i < args.issueDomains.length; i += 1) {
          if (
            typeof args.issueDomains[i] === "string" &&
            args.issueDomains[i].trim().length === 0
          ) {
            issues.push({ path: `args.issueDomains[${i}]`, message: "must be a non-empty string" });
          }
        }
      }
      if (typeof args.keyPattern === "string") {
        if (args.keyPattern.trim().length === 0) {
          issues.push({ path: "args.keyPattern", message: "must be a non-empty string when provided" });
        } else {
          try {
            // eslint-disable-next-line no-new
            new RegExp(args.keyPattern.trim(), "g");
          } catch {
            issues.push({ path: "args.keyPattern", message: "must be a valid regex pattern" });
          }
        }
      }
      if (typeof args.limit === "number" && args.limit > 100) {
        issues.push({ path: "args.limit", message: "must be <= 100" });
      }
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
      dataAttributes: { type: "array" },
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
      dataAttributes: { type: "array" },
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
      dataAttributes: { type: "array" },
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
      expectedRevision: { type: "number", min: 0 },
      mode: { type: "string", enum: ["unified", "replace"] },
      title: { type: "string" },
      view: { type: "string", enum: ["summary", "full"] },
      excerptChars: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.apply_patch_safe": {
    required: ["id", "expectedRevision", "patch"],
    properties: {
      id: { type: "string" },
      patch: { type: "string" },
      expectedRevision: { type: "number", min: 0 },
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
        if (
          Object.prototype.hasOwnProperty.call(update, "dataAttributes") &&
          !Array.isArray(update.dataAttributes)
        ) {
          issues.push({ path: `args.updates[${i}].dataAttributes`, message: "must be an array" });
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
  "revisions.diff": {
    required: ["id", "baseRevisionId", "targetRevisionId"],
    properties: {
      id: { type: "string" },
      baseRevisionId: { type: "string" },
      targetRevisionId: { type: "string" },
      includeFullHunks: { type: "boolean" },
      hunkLimit: { type: "number", min: 1 },
      hunkLineLimit: { type: "number", min: 1 },
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
  "revisions.info": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "shares.list": {
    properties: {
      query: { type: "string" },
      documentId: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "shares.info": {
    properties: {
      id: { type: "string" },
      documentId: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (!args.id && !args.documentId) {
        issues.push({ path: "args.id", message: "or args.documentId is required" });
      }
      if (args.id && args.documentId) {
        issues.push({ path: "args.documentId", message: "cannot be combined with args.id" });
      }
    },
  },
  "shares.create": {
    required: ["documentId"],
    properties: {
      documentId: { type: "string" },
      includeChildDocuments: { type: "boolean" },
      published: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "shares.update": {
    required: ["id", "published"],
    properties: {
      id: { type: "string" },
      includeChildDocuments: { type: "boolean" },
      published: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "shares.revoke": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "templates.list": {
    properties: {
      collectionId: { type: "string" },
      query: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "templates.info": {
    properties: {
      id: { type: "string" },
      ids: { type: "string[]" },
      includePolicies: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (!args.id && !args.ids) {
        issues.push({ path: "args.id", message: "or args.ids[] is required" });
      }
    },
  },
  "templates.extract_placeholders": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (typeof args.id === "string" && args.id.trim().length === 0) {
        issues.push({ path: "args.id", message: "must be a non-empty string" });
      }
    },
  },
  "templates.create": {
    required: ["title", "data"],
    properties: {
      title: { type: "string" },
      data: { type: "object" },
      icon: { type: "string" },
      color: { type: "string" },
      collectionId: { type: "string" },
      fullWidth: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "templates.update": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      data: { type: "object" },
      icon: { type: ["string", "null"] },
      color: { type: ["string", "null"] },
      collectionId: { type: ["string", "null"] },
      fullWidth: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "templates.delete": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "templates.restore": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "templates.duplicate": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      title: { type: "string" },
      collectionId: { type: ["string", "null"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.templatize": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      collectionId: { type: ["string", "null"] },
      publish: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.import": {
    allowUnknown: true,
    properties: {
      collectionId: { type: "string" },
      parentDocumentId: { type: "string" },
      includePolicies: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      const hasCollectionId =
        typeof args.collectionId === "string" && args.collectionId.trim().length > 0;
      const hasParentDocumentId =
        typeof args.parentDocumentId === "string" && args.parentDocumentId.trim().length > 0;

      if (typeof args.collectionId === "string" && args.collectionId.trim().length === 0) {
        issues.push({ path: "args.collectionId", message: "must be a non-empty string when provided" });
      }
      if (
        typeof args.parentDocumentId === "string" &&
        args.parentDocumentId.trim().length === 0
      ) {
        issues.push({
          path: "args.parentDocumentId",
          message: "must be a non-empty string when provided",
        });
      }
      if (hasCollectionId && hasParentDocumentId) {
        issues.push({
          path: "args.parentDocumentId",
          message: "cannot be combined with args.collectionId",
        });
      }
    },
  },
  "documents.import_file": {
    allowUnknown: true,
    required: ["filePath"],
    properties: {
      filePath: { type: "string" },
      collectionId: { type: "string" },
      parentDocumentId: { type: "string" },
      publish: { type: "boolean" },
      contentType: { type: "string" },
      includePolicies: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      const hasCollectionId =
        typeof args.collectionId === "string" && args.collectionId.trim().length > 0;
      const hasParentDocumentId =
        typeof args.parentDocumentId === "string" && args.parentDocumentId.trim().length > 0;

      if (typeof args.filePath === "string" && args.filePath.trim().length === 0) {
        issues.push({ path: "args.filePath", message: "must be a non-empty string" });
      }
      if (typeof args.collectionId === "string" && args.collectionId.trim().length === 0) {
        issues.push({ path: "args.collectionId", message: "must be a non-empty string when provided" });
      }
      if (
        typeof args.parentDocumentId === "string" &&
        args.parentDocumentId.trim().length === 0
      ) {
        issues.push({
          path: "args.parentDocumentId",
          message: "must be a non-empty string when provided",
        });
      }
      if (hasCollectionId && hasParentDocumentId) {
        issues.push({
          path: "args.parentDocumentId",
          message: "cannot be combined with args.collectionId",
        });
      }
    },
  },
  "file_operations.list": {
    allowUnknown: true,
    properties: {
      includePolicies: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "file_operations.info": {
    allowUnknown: true,
    required: ["id"],
    properties: {
      id: { type: "string" },
      includePolicies: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (typeof args.id === "string" && args.id.trim().length === 0) {
        issues.push({ path: "args.id", message: "must be a non-empty string" });
      }
    },
  },
  "file_operations.delete": {
    allowUnknown: true,
    required: ["id"],
    properties: {
      id: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (typeof args.id === "string" && args.id.trim().length === 0) {
        issues.push({ path: "args.id", message: "must be a non-empty string" });
      }
    },
  },
  "documents.create_from_template": {
    required: ["templateId"],
    properties: {
      templateId: { type: "string" },
      title: { type: "string" },
      collectionId: { type: "string" },
      parentDocumentId: { type: "string" },
      publish: { type: "boolean" },
      placeholderValues: { type: "object" },
      strictPlaceholders: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      includePolicies: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (typeof args.templateId === "string" && args.templateId.trim().length === 0) {
        issues.push({ path: "args.templateId", message: "must be a non-empty string" });
      }

      for (const key of ["title", "collectionId", "parentDocumentId"]) {
        if (typeof args[key] === "string" && args[key].trim().length === 0) {
          issues.push({ path: `args.${key}`, message: "must be a non-empty string when provided" });
        }
      }

      if (args.placeholderValues && typeof args.placeholderValues === "object" && !Array.isArray(args.placeholderValues)) {
        for (const [rawKey, rawValue] of Object.entries(args.placeholderValues)) {
          if (String(rawKey || "").trim().length === 0) {
            issues.push({
              path: "args.placeholderValues",
              message: "must not contain empty keys",
            });
          }
          if (typeof rawValue !== "string") {
            const keyPath = rawKey ? `args.placeholderValues.${rawKey}` : "args.placeholderValues";
            issues.push({ path: keyPath, message: "must be a string" });
          }
        }
      }
    },
  },
  "comments.list": {
    properties: {
      documentId: { type: "string" },
      collectionId: { type: "string" },
      parentCommentId: { type: "string" },
      includeAnchorText: { type: "boolean" },
      includeReplies: { type: "boolean" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "comments.info": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      includeAnchorText: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "comments.create": {
    required: ["documentId"],
    properties: {
      documentId: { type: "string" },
      text: { type: "string" },
      data: { type: "object" },
      parentCommentId: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (!args.text && !args.data) {
        issues.push({ path: "args.text", message: "or args.data is required" });
      }
    },
  },
  "comments.update": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      text: { type: "string" },
      data: { type: "object" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (!args.text && !args.data) {
        issues.push({ path: "args.text", message: "or args.data is required" });
      }
    },
  },
  "comments.delete": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "data_attributes.list": {
    properties: {
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (typeof args.limit === "number" && args.limit > 250) {
        issues.push({ path: "args.limit", message: "must be <= 250" });
      }
    },
  },
  "data_attributes.info": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "data_attributes.create": {
    required: ["name", "dataType"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      dataType: { type: "string", enum: DATA_ATTRIBUTE_DATA_TYPES },
      options: { type: "object" },
      pinned: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (typeof args.name === "string" && args.name.trim().length === 0) {
        issues.push({ path: "args.name", message: "must be a non-empty string" });
      }
    },
  },
  "data_attributes.update": {
    required: ["id", "name"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      options: { type: "object" },
      pinned: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (typeof args.name === "string" && args.name.trim().length === 0) {
        issues.push({ path: "args.name", message: "must be a non-empty string" });
      }
    },
  },
  "data_attributes.delete": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "comments.review_queue": {
    properties: {
      documentIds: { type: "string[]" },
      collectionId: { type: "string" },
      includeAnchorText: { type: "boolean" },
      includeReplies: { type: "boolean" },
      limitPerDocument: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasDocumentIds = Array.isArray(args.documentIds) && args.documentIds.length > 0;
      const hasCollectionId = typeof args.collectionId === "string" && args.collectionId.length > 0;
      if (!hasDocumentIds && !hasCollectionId) {
        issues.push({ path: "args.documentIds", message: "or args.collectionId is required" });
      }
      if (Array.isArray(args.documentIds) && args.documentIds.length === 0) {
        issues.push({ path: "args.documentIds", message: "must be a non-empty string[] when provided" });
      }
    },
  },
  "federated.sync_manifest": {
    properties: {
      collectionId: { type: "string" },
      query: { type: "string" },
      since: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      includeDrafts: { type: "boolean" },
      includeMemberships: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (typeof args.since === "string") {
        const parsed = Date.parse(args.since);
        if (!Number.isFinite(parsed) || !args.since.includes("T")) {
          issues.push({ path: "args.since", message: "must be an ISO-8601 timestamp" });
        }
      }
    },
  },
  "federated.sync_probe": {
    properties: {
      ids: { type: "string[]" },
      queries: { type: "string[]" },
      mode: { type: "string", enum: ["titles", "semantic", "both"] },
      collectionId: { type: "string" },
      limit: { type: "number", min: 1 },
      freshnessHours: { type: "number", min: 1 },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
      const hasQueries = Array.isArray(args.queries) && args.queries.length > 0;
      if (!hasIds && !hasQueries) {
        issues.push({ path: "args.ids", message: "or args.queries[] is required" });
      }
      if (Array.isArray(args.ids) && args.ids.length === 0) {
        issues.push({ path: "args.ids", message: "must be a non-empty string[] when provided" });
      }
      if (Array.isArray(args.queries) && args.queries.length === 0) {
        issues.push({ path: "args.queries", message: "must be a non-empty string[] when provided" });
      }
    },
  },
  "federated.permission_snapshot": {
    required: ["ids"],
    properties: {
      ids: { type: "string[]" },
      includeCollectionMemberships: { type: "boolean" },
      includeDocumentMemberships: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (Array.isArray(args.ids) && args.ids.length === 0) {
        issues.push({ path: "args.ids", message: "must be a non-empty string[]" });
      }
    },
  },
  "documents.plan_terminology_refactor": {
    required: ["glossary"],
    properties: {
      glossary: { type: "array" },
      id: { type: "string" },
      ids: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      collectionId: { type: "string" },
      includeTitleSearch: { type: "boolean" },
      includeSemanticSearch: { type: "boolean" },
      limitPerQuery: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      maxDocuments: { type: "number", min: 1 },
      readConcurrency: { type: "number", min: 1 },
      includeUnchanged: { type: "boolean" },
      hunkLimit: { type: "number", min: 1 },
      hunkLineLimit: { type: "number", min: 1 },
      excludeDocIds: { type: "string[]" },
      excludePatterns: { type: "string[]" },
      excludeCodeBlocks: { type: "boolean" },
      excludeInlineCode: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (!Array.isArray(args.glossary) || args.glossary.length === 0) {
        issues.push({ path: "args.glossary", message: "must be a non-empty array" });
      } else {
        const seenFind = new Set();
        for (let i = 0; i < args.glossary.length; i += 1) {
          const item = args.glossary[i];
          if (!item || typeof item !== "object" || Array.isArray(item)) {
            issues.push({ path: `args.glossary[${i}]`, message: "must be an object" });
            continue;
          }
          const find = typeof item.find === "string" ? item.find.trim() : "";
          const replace = typeof item.replace === "string" ? item.replace.trim() : "";
          if (!find) {
            issues.push({ path: `args.glossary[${i}].find`, message: "is required and must be a non-empty string" });
          }
          if (typeof item.replace !== "string") {
            issues.push({ path: `args.glossary[${i}].replace`, message: "is required and must be a string" });
          }
          if (find && replace && find === replace) {
            issues.push({ path: `args.glossary[${i}].replace`, message: "must differ from find" });
          }
          if (find) {
            if (seenFind.has(find)) {
              issues.push({ path: `args.glossary[${i}].find`, message: "must be unique across glossary entries" });
            } else {
              seenFind.add(find);
            }
          }
          if (
            item.field !== undefined &&
            !["title", "text", "both"].includes(item.field)
          ) {
            issues.push({
              path: `args.glossary[${i}].field`,
              message: "must be one of: title, text, both",
            });
          }
        }
      }

      const hasScopeId = typeof args.id === "string" && args.id.length > 0;
      const hasScopeIds = Array.isArray(args.ids) && args.ids.length > 0;
      const hasScopeQuery = typeof args.query === "string" && args.query.trim().length > 0;
      const hasScopeQueries = Array.isArray(args.queries) && args.queries.length > 0;
      if (!hasScopeId && !hasScopeIds && !hasScopeQuery && !hasScopeQueries) {
        issues.push({ path: "args.ids", message: "or args.query/args.queries[] is required" });
      }
      if (Array.isArray(args.ids) && args.ids.length === 0) {
        issues.push({ path: "args.ids", message: "must be a non-empty string[] when provided" });
      }
      if (Array.isArray(args.queries) && args.queries.length === 0) {
        issues.push({ path: "args.queries", message: "must be a non-empty string[] when provided" });
      }
      if (args.includeTitleSearch === false && args.includeSemanticSearch === false) {
        issues.push({
          path: "args.includeTitleSearch",
          message: "and includeSemanticSearch cannot both be false",
        });
      }
      if (Array.isArray(args.excludePatterns)) {
        for (let i = 0; i < args.excludePatterns.length; i += 1) {
          const pattern = args.excludePatterns[i];
          try {
            // Validate that each pattern is a compilable JS regex source string.
            new RegExp(pattern);
          } catch {
            issues.push({
              path: `args.excludePatterns[${i}]`,
              message: "must be a valid regex source string",
            });
          }
        }
      }
    },
  },
  "events.list": {
    properties: {
      actorId: { type: "string" },
      documentId: { type: "string" },
      collectionId: { type: "string" },
      name: { type: "string" },
      auditLog: { type: "boolean" },
      ip: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "documents.archived": {
    properties: {
      collectionId: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "documents.deleted": {
    properties: {
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "documents.archive": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.restore": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      collectionId: { type: "string" },
      revisionId: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.permanent_delete": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.empty_trash": {
    properties: {
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "webhooks.list": {
    properties: {
      event: { type: "string" },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      includeSubscriptions: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "webhooks.info": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      includeSubscriptions: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "webhooks.create": {
    required: ["name", "url", "events"],
    properties: {
      name: { type: "string" },
      url: { type: "string" },
      events: { type: "string[]" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (Array.isArray(args.events) && args.events.length === 0) {
        issues.push({ path: "args.events", message: "must be a non-empty array" });
      }
    },
  },
  "webhooks.update": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      url: { type: "string" },
      events: { type: "string[]" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (
        args.name === undefined &&
        args.url === undefined &&
        args.events === undefined
      ) {
        issues.push({ path: "args.name", message: "or args.url or args.events is required" });
      }
      if (Array.isArray(args.events) && args.events.length === 0) {
        issues.push({ path: "args.events", message: "must be a non-empty array" });
      }
    },
  },
  "webhooks.delete": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "users.list": {
    properties: {
      query: { type: "string" },
      role: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "users.info": {
    properties: {
      id: { type: "string" },
      ids: { type: "string[]" },
      email: { type: "string" },
      includePolicies: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.length > 0;
      const hasIds = Array.isArray(args.ids) && args.ids.length > 0;

      if (!hasId && !hasIds && !args.email) {
        issues.push({ path: "args.id", message: "or args.ids[] or args.email is required" });
      }
      if (Array.isArray(args.ids) && args.ids.length === 0) {
        issues.push({ path: "args.ids", message: "must be a non-empty string[] when provided" });
      }
      if (hasId && Array.isArray(args.ids)) {
        issues.push({ path: "args.ids", message: "cannot be combined with args.id" });
      }
    },
  },
  "users.invite": {
    required: ["email"],
    properties: {
      email: { type: "string" },
      name: { type: "string" },
      role: { type: "string", enum: USER_ROLE_TYPES },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (typeof args.email === "string" && args.email.trim().length === 0) {
        issues.push({ path: "args.email", message: "must be a non-empty string" });
      }
    },
  },
  "users.update_role": {
    required: ["id", "role"],
    properties: {
      id: { type: "string" },
      role: { type: "string", enum: USER_ROLE_TYPES },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "users.activate": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "users.suspend": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "groups.list": {
    properties: {
      query: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "groups.info": {
    properties: {
      id: { type: "string" },
      ids: { type: "string[]" },
      includePolicies: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.length > 0;
      const hasIds = Array.isArray(args.ids) && args.ids.length > 0;

      if (!hasId && !hasIds) {
        issues.push({ path: "args.id", message: "or args.ids[] is required" });
      }
      if (Array.isArray(args.ids) && args.ids.length === 0) {
        issues.push({ path: "args.ids", message: "must be a non-empty string[] when provided" });
      }
      if (hasId && Array.isArray(args.ids)) {
        issues.push({ path: "args.ids", message: "cannot be combined with args.id" });
      }
    },
  },
  "groups.memberships": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "groups.create": {
    required: ["name"],
    properties: {
      name: { type: "string" },
      memberIds: { type: "string[]" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (Array.isArray(args.memberIds) && args.memberIds.length === 0) {
        issues.push({ path: "args.memberIds", message: "must be a non-empty string[] when provided" });
      }
    },
  },
  "groups.update": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "groups.delete": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "groups.add_user": {
    required: ["id", "userId"],
    properties: {
      id: { type: "string" },
      userId: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "groups.remove_user": {
    required: ["id", "userId"],
    properties: {
      id: { type: "string" },
      userId: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "collections.memberships": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "collections.group_memberships": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "collections.add_user": {
    required: ["id", "userId"],
    properties: {
      id: { type: "string" },
      userId: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "collections.remove_user": {
    required: ["id", "userId"],
    properties: {
      id: { type: "string" },
      userId: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "collections.add_group": {
    required: ["id", "groupId"],
    properties: {
      id: { type: "string" },
      groupId: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "collections.remove_group": {
    required: ["id", "groupId"],
    properties: {
      id: { type: "string" },
      groupId: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.memberships": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "documents.users": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "documents.group_memberships": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
  },
  "documents.add_user": {
    required: ["id", "userId"],
    properties: {
      id: { type: "string" },
      userId: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.remove_user": {
    required: ["id", "userId"],
    properties: {
      id: { type: "string" },
      userId: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.add_group": {
    required: ["id", "groupId"],
    properties: {
      id: { type: "string" },
      groupId: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.remove_group": {
    required: ["id", "groupId"],
    properties: {
      id: { type: "string" },
      groupId: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
  },
  "documents.answer": {
    properties: {
      question: { type: "string" },
      query: { type: "string" },
      collectionId: { type: "string" },
      documentId: { type: "string" },
      userId: { type: "string" },
      statusFilter: { type: ["string", "string[]"] },
      dateFilter: { type: "string", enum: ["day", "week", "month", "year"] },
      includePolicies: { type: "boolean" },
      includeEvidenceDocs: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const selected = args.question ?? args.query;
      if (typeof selected !== "string" || selected.trim().length === 0) {
        issues.push({ path: "args.question", message: "or args.query is required and must be non-empty" });
      }
    },
  },
  "documents.answer_batch": {
    properties: {
      question: { type: "string" },
      query: { type: "string" },
      questions: { type: "array" },
      collectionId: { type: "string" },
      documentId: { type: "string" },
      userId: { type: "string" },
      statusFilter: { type: ["string", "string[]"] },
      dateFilter: { type: "string", enum: ["day", "week", "month", "year"] },
      includePolicies: { type: "boolean" },
      includeEvidenceDocs: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      concurrency: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasSingle = args.question !== undefined || args.query !== undefined;
      const singleQuestion = args.question ?? args.query;
      const questionCount = Array.isArray(args.questions) ? args.questions.length : 0;

      if (hasSingle && (typeof singleQuestion !== "string" || singleQuestion.trim().length === 0)) {
        issues.push({ path: "args.question", message: "or args.query must be a non-empty string when provided" });
      }

      if (!hasSingle && questionCount === 0) {
        issues.push({ path: "args.questions", message: "or args.question or args.query is required" });
      }

      if (args.questions === undefined) {
        return;
      }

      if (!Array.isArray(args.questions)) {
        return;
      }

      for (let i = 0; i < args.questions.length; i += 1) {
        const item = args.questions[i];
        if (typeof item === "string") {
          if (item.trim().length === 0) {
            issues.push({ path: `args.questions[${i}]`, message: "must be a non-empty string" });
          }
          continue;
        }

        if (!item || typeof item !== "object" || Array.isArray(item)) {
          issues.push({ path: `args.questions[${i}]`, message: "must be a string or object" });
          continue;
        }

        const itemQuestion = item.question ?? item.query;
        if (typeof itemQuestion !== "string" || itemQuestion.trim().length === 0) {
          issues.push({ path: `args.questions[${i}].question`, message: "or .query must be a non-empty string" });
        }
      }
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
      deleteMode: { type: "string", enum: ["safe", "direct"] },
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
