import { CliError } from "./errors.js";

const MEMORY_ENTITY_TYPES = ["document", "collection", "user", "group", "template"];

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

function fail(tool, issues, spec = {}, args = undefined) {
  throw new CliError(`Invalid args for ${tool}`, buildValidationDetails(tool, spec, issues, args));
}

function ensureObject(tool, args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    fail(tool, [{ path: "args", message: "must be an object" }]);
  }
}

function levenshteinDistance(a, b) {
  const left = String(a || "");
  const right = String(b || "");
  const rows = left.length + 1;
  const cols = right.length + 1;
  const matrix = Array.from({ length: rows }, () => Array(cols).fill(0));

  for (let i = 0; i < rows; i += 1) {
    matrix[i][0] = i;
  }
  for (let j = 0; j < cols; j += 1) {
    matrix[0][j] = j;
  }

  for (let i = 1; i < rows; i += 1) {
    for (let j = 1; j < cols; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost
      );
    }
  }

  return matrix[rows - 1][cols - 1];
}

function buildAcceptedArgList(spec = {}) {
  const accepted = new Set(Object.keys(spec.properties || {}));
  accepted.add("compact");
  return [...accepted].sort();
}

function suggestClosestArgNames(key, acceptedArgs) {
  const raw = String(key || "").trim();
  if (!raw) {
    return [];
  }

  return acceptedArgs
    .map((candidate) => ({
      candidate,
      distance: levenshteinDistance(raw.toLowerCase(), String(candidate).toLowerCase()),
    }))
    .filter((row) => row.distance <= 3)
    .sort((a, b) => a.distance - b.distance || a.candidate.localeCompare(b.candidate))
    .slice(0, 3)
    .map((row) => row.candidate);
}

function enrichIssuesWithArgSuggestions(issues, acceptedArgs) {
  return issues.map((issue) => {
    if (!issue || issue.message !== "is not allowed" || typeof issue.path !== "string") {
      return issue;
    }
    const key = issue.path.startsWith("args.") ? issue.path.slice(5) : issue.path;
    const suggestions = suggestClosestArgNames(key, acceptedArgs);
    return suggestions.length > 0 ? { ...issue, suggestions } : issue;
  });
}

function extractArgKeyFromIssue(issue) {
  if (!issue || typeof issue.path !== "string") {
    return null;
  }
  return issue.path.startsWith("args.") ? issue.path.slice(5) : issue.path;
}

function applySuggestedArgFixes(args, issues) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    return undefined;
  }

  const next = { ...args };
  let changed = false;

  for (const issue of issues) {
    if (!issue || issue.message !== "is not allowed") {
      continue;
    }
    const key = extractArgKeyFromIssue(issue);
    const target = Array.isArray(issue.suggestions) && issue.suggestions.length > 0
      ? issue.suggestions[0]
      : null;
    if (!key || !target || !(key in next) || key === target) {
      continue;
    }
    if (target in next && next[target] !== next[key]) {
      continue;
    }
    if (!(target in next)) {
      next[target] = next[key];
    }
    delete next[key];
    changed = true;
  }

  return changed ? next : undefined;
}

function buildSuggestedArgs(spec, args, enrichedIssues) {
  const candidate = applySuggestedArgFixes(args, enrichedIssues);
  if (!candidate) {
    return undefined;
  }

  const normalized = normalizeArgsForSpec(candidate, spec);
  const remainingIssues = collectValidationIssues(normalized, spec);
  return remainingIssues.length === 0 ? normalized : undefined;
}

function buildValidationDetails(tool, spec, issues, args = undefined) {
  const acceptedArgs = buildAcceptedArgList(spec);
  const enrichedIssues = enrichIssuesWithArgSuggestions(issues, acceptedArgs);
  const requiredArgs = [...new Set(spec.required || [])].sort();
  const unknownArgs = enrichedIssues
    .filter((issue) => issue?.message === "is not allowed" && typeof issue.path === "string")
    .map((issue) => issue.path.replace(/^args\./, ""));
  const suggestedArgs = buildSuggestedArgs(spec, args, enrichedIssues);

  return {
    code: "ARG_VALIDATION_FAILED",
    tool,
    issues: enrichedIssues,
    acceptedArgs,
    requiredArgs,
    unknownArgs,
    suggestedArgs,
    validationHint:
      acceptedArgs.length > 0 ? `Accepted args: ${acceptedArgs.join(", ")}` : undefined,
  };
}

const ACCESS_RESOLVE_COMMON_PROPERTIES = {
  refs: { type: "string[]" },
  queries: { type: "string[]" },
  documentQueries: { type: "string[]" },
  profile: { type: "string" },
  resolveLimit: { type: "number", min: 1 },
  minScore: { type: "number", min: 0 },
  maxAgeHours: { type: "number", min: 0 },
  refresh: { type: "boolean" },
  strict: { type: "boolean" },
  strictThreshold: { type: "number", min: 0 },
  fallbackSearch: { type: "boolean" },
  fallbackMinScore: { type: "number", min: 0 },
  fallbackLimit: { type: "number", min: 1 },
  fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
  resolveConcurrency: { type: "number", min: 1 },
  resolveHydrateConcurrency: { type: "number", min: 1 },
};

const DOCUMENT_ACCESS_RESOLVE_PROPERTIES = {
  id: { type: "string" },
  documentId: { type: "string" },
  query: { type: "string" },
  documentQuery: { type: "string" },
  shareId: { type: "string" },
  shareIds: { type: "string[]" },
  urlId: { type: "string" },
  urlIds: { type: "string[]" },
  url: { type: "string" },
  urls: { type: "string[]" },
  resolveCollectionId: { type: "string" },
  snippetMinWords: { type: "number", min: 1 },
  snippetMaxWords: { type: "number", min: 1 },
  ...ACCESS_RESOLVE_COMMON_PROPERTIES,
};

const COLLECTION_ACCESS_RESOLVE_PROPERTIES = {
  id: { type: "string" },
  collectionId: { type: "string" },
  query: { type: "string" },
  urlId: { type: "string" },
  urlIds: { type: "string[]" },
  url: { type: "string" },
  urls: { type: "string[]" },
  ...ACCESS_RESOLVE_COMMON_PROPERTIES,
};

const PRINCIPAL_RESOLVE_PROPERTIES = {
  query: { type: "string" },
  refs: { type: "string[]" },
  queries: { type: "string[]" },
  profile: { type: "string" },
  resolveLimit: { type: "number", min: 1 },
  minScore: { type: "number", min: 0 },
  maxAgeHours: { type: "number", min: 0 },
  refresh: { type: "boolean" },
  strict: { type: "boolean" },
  strictThreshold: { type: "number", min: 0 },
  fallbackSearch: { type: "boolean" },
  fallbackMinScore: { type: "number", min: 0 },
  fallbackLimit: { type: "number", min: 1 },
  resolveConcurrency: { type: "number", min: 1 },
  resolveHydrateConcurrency: { type: "number", min: 1 },
};

const PRINCIPAL_RESOLVE_OPTION_PROPERTIES = {
  profile: { type: "string" },
  resolveLimit: { type: "number", min: 1 },
  minScore: { type: "number", min: 0 },
  maxAgeHours: { type: "number", min: 0 },
  refresh: { type: "boolean" },
  strict: { type: "boolean" },
  strictThreshold: { type: "number", min: 0 },
  fallbackSearch: { type: "boolean" },
  fallbackMinScore: { type: "number", min: 0 },
  fallbackLimit: { type: "number", min: 1 },
  resolveConcurrency: { type: "number", min: 1 },
  resolveHydrateConcurrency: { type: "number", min: 1 },
};

const USER_PRINCIPAL_RESOLVE_PROPERTIES = {
  userQuery: { type: "string" },
  userRef: { type: "string" },
  userQueries: { type: "string[]" },
  userRefs: { type: "string[]" },
  ...PRINCIPAL_RESOLVE_OPTION_PROPERTIES,
};

const GROUP_PRINCIPAL_RESOLVE_PROPERTIES = {
  groupQuery: { type: "string" },
  groupRef: { type: "string" },
  groupQueries: { type: "string[]" },
  groupRefs: { type: "string[]" },
  ...PRINCIPAL_RESOLVE_OPTION_PROPERTIES,
};

const TEMPLATE_RESOLVE_PROPERTIES = {
  templateQuery: { type: "string" },
  templateRef: { type: "string" },
  templateQueries: { type: "string[]" },
  templateRefs: { type: "string[]" },
  refs: { type: "string[]" },
  queries: { type: "string[]" },
  profile: { type: "string" },
  resolveLimit: { type: "number", min: 1 },
  minScore: { type: "number", min: 0 },
  maxAgeHours: { type: "number", min: 0 },
  refresh: { type: "boolean" },
  strict: { type: "boolean" },
  strictThreshold: { type: "number", min: 0 },
  fallbackSearch: { type: "boolean" },
  fallbackMinScore: { type: "number", min: 0 },
  fallbackLimit: { type: "number", min: 1 },
  resolveConcurrency: { type: "number", min: 1 },
  resolveHydrateConcurrency: { type: "number", min: 1 },
};

const DOCUMENT_TARGET_RESOLVE_PROPERTIES = {
  documentId: { type: "string" },
  query: { type: "string" },
  documentQuery: { type: "string" },
  documentRef: { type: "string" },
  queries: { type: "string[]" },
  documentQueries: { type: "string[]" },
  documentRefs: { type: "string[]" },
  refs: { type: "string[]" },
  shareId: { type: "string" },
  shareIds: { type: "string[]" },
  urlId: { type: "string" },
  urlIds: { type: "string[]" },
  url: { type: "string" },
  urls: { type: "string[]" },
  profile: { type: "string" },
  resolveLimit: { type: "number", min: 1 },
  minScore: { type: "number", min: 0 },
  maxAgeHours: { type: "number", min: 0 },
  refresh: { type: "boolean" },
  strict: { type: "boolean" },
  strictThreshold: { type: "number", min: 0 },
  fallbackSearch: { type: "boolean" },
  fallbackMinScore: { type: "number", min: 0 },
  fallbackLimit: { type: "number", min: 1 },
  fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
  resolveCollectionId: { type: "string" },
  resolveConcurrency: { type: "number", min: 1 },
  resolveHydrateConcurrency: { type: "number", min: 1 },
  snippetMinWords: { type: "number", min: 1 },
  snippetMaxWords: { type: "number", min: 1 },
};

const DOCUMENT_MUTATION_TARGET_RESOLVE_PROPERTIES = {
  id: { type: "string" },
  ...DOCUMENT_TARGET_RESOLVE_PROPERTIES,
};

function hasNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyStringArray(value) {
  return Array.isArray(value) && value.some((item) => hasNonEmptyString(item));
}

function validateAccessResolveConcurrency(args, issues) {
  if (typeof args.resolveConcurrency === "number" && args.resolveConcurrency > 8) {
    issues.push({ path: "args.resolveConcurrency", message: "must be <= 8" });
  }
  if (typeof args.resolveHydrateConcurrency === "number" && args.resolveHydrateConcurrency > 8) {
    issues.push({ path: "args.resolveHydrateConcurrency", message: "must be <= 8" });
  }
}

function validateDocumentAccessSelector(args, issues) {
  const hasScalar = ["id", "documentId", "query", "documentQuery", "shareId", "urlId", "url"].some((key) =>
    hasNonEmptyString(args[key])
  );
  const hasArray = ["refs", "queries", "documentQueries", "shareIds", "urlIds", "urls"].some((key) =>
    hasNonEmptyStringArray(args[key])
  );
  if (!hasScalar && !hasArray) {
    issues.push({ path: "args.id", message: "or args.documentId, args.query, args.refs, args.shareId, args.urlId, or args.url is required" });
  }
  if (args.id && args.documentId) {
    issues.push({ path: "args.documentId", message: "cannot be combined with args.id" });
  }
  validateAccessResolveConcurrency(args, issues);
}

function hasDocumentResolveSelector(args, { includeQuery = true } = {}) {
  const scalarKeys = [
    "documentId",
    "documentQuery",
    "documentRef",
    "shareId",
    "urlId",
    "url",
    ...(includeQuery ? ["query"] : []),
  ];
  const arrayKeys = [
    "refs",
    "documentRefs",
    "documentQueries",
    "shareIds",
    "urlIds",
    "urls",
    ...(includeQuery ? ["queries"] : []),
  ];
  return scalarKeys.some((key) => hasNonEmptyString(args[key]))
    || arrayKeys.some((key) => hasNonEmptyStringArray(args[key]));
}

function validateOptionalDocumentResolveArgs(args, issues) {
  validateAccessResolveConcurrency(args, issues);
}

function validateRequiredDocumentResolveArgs(args, issues) {
  if (!hasDocumentResolveSelector(args)) {
    issues.push({ path: "args.documentId", message: "or args.query, args.documentQuery, args.refs, args.shareId, args.urlId, or args.url is required" });
  }
  const hasExact = hasNonEmptyString(args.documentId);
  const hasRef = [
    "query",
    "documentQuery",
    "documentRef",
    "shareId",
    "urlId",
    "url",
  ].some((key) => hasNonEmptyString(args[key]))
    || ["refs", "queries", "documentQueries", "documentRefs", "shareIds", "urlIds", "urls"].some((key) => hasNonEmptyStringArray(args[key]));
  if (hasExact && hasRef) {
    issues.push({ path: "args.documentQuery", message: "cannot be combined with args.documentId" });
  }
  validateAccessResolveConcurrency(args, issues);
}

function validateRequiredDocumentMutationTargetArgs(args, issues) {
  const hasId = hasNonEmptyString(args.id);
  const hasDocumentId = hasNonEmptyString(args.documentId);
  const hasRef = [
    "query",
    "documentQuery",
    "documentRef",
    "shareId",
    "urlId",
    "url",
  ].some((key) => hasNonEmptyString(args[key]))
    || ["refs", "queries", "documentQueries", "documentRefs", "shareIds", "urlIds", "urls"].some((key) => hasNonEmptyStringArray(args[key]));

  if (!hasId && !hasDocumentId && !hasRef) {
    issues.push({ path: "args.id", message: "or args.documentId, args.query, args.refs, args.shareId, args.urlId, or args.url is required" });
  }
  if (hasId && hasDocumentId) {
    issues.push({ path: "args.documentId", message: "cannot be combined with args.id" });
  }
  if ((hasId || hasDocumentId) && hasRef) {
    issues.push({ path: "args.query", message: "cannot be combined with args.id or args.documentId" });
  }
  validateAccessResolveConcurrency(args, issues);
}

function validateExpectedRevisionGuard(args, issues) {
  if (typeof args.expectedRevision === "string" && args.expectedRevision.trim().toLowerCase() !== "latest") {
    issues.push({ path: "args.expectedRevision", message: "must be a number or latest" });
  }
}

function validateRequiredDocumentMutationTargetAndExpectedRevision(args, issues) {
  validateRequiredDocumentMutationTargetArgs(args, issues);
  validateExpectedRevisionGuard(args, issues);
}

function validateBatchUpdateDocumentTarget(update, issues, path) {
  const hasId = hasNonEmptyString(update.id);
  const hasDocumentId = hasNonEmptyString(update.documentId);
  const hasRef = [
    "query",
    "documentQuery",
    "documentRef",
    "shareId",
    "urlId",
    "url",
  ].some((key) => hasNonEmptyString(update[key]))
    || ["refs", "queries", "documentQueries", "documentRefs", "shareIds", "urlIds", "urls"].some((key) => hasNonEmptyStringArray(update[key]));

  if (!hasId && !hasDocumentId && !hasRef) {
    issues.push({ path: `${path}.id`, message: "or document refs are required" });
  }
  if (hasId && hasDocumentId) {
    issues.push({ path: `${path}.documentId`, message: "cannot be combined with id" });
  }
  if ((hasId || hasDocumentId) && hasRef) {
    issues.push({ path: `${path}.query`, message: "cannot be combined with id or documentId" });
  }
  if (hasRef && !Object.prototype.hasOwnProperty.call(update, "expectedRevision")) {
    issues.push({ path: `${path}.expectedRevision`, message: "is required when using document refs" });
  }
}

function validateEventsListResolveSelectors(args, issues) {
  const hasDocumentRef = ["documentQuery", "documentRef", "shareId", "urlId", "url"].some((key) => hasNonEmptyString(args[key]))
    || ["documentQueries", "documentRefs", "refs", "shareIds", "urlIds", "urls"].some((key) => hasNonEmptyStringArray(args[key]));
  if (hasNonEmptyString(args.documentId) && hasDocumentRef) {
    issues.push({ path: "args.documentQuery", message: "cannot be combined with args.documentId" });
  }
  if (hasNonEmptyString(args.collectionId) && hasDocumentFilterResolveSelector(args, "collection")) {
    issues.push({ path: "args.collectionQuery", message: "cannot be combined with args.collectionId" });
  }
  if (hasNonEmptyString(args.actorId) && hasDocumentFilterResolveSelector(args, "user")) {
    issues.push({ path: "args.userQuery", message: "cannot be combined with args.actorId" });
  }
  validateAccessResolveConcurrency(args, issues);
}

function validateOptionalCollectionFilterResolveArgs(args, issues) {
  if (hasNonEmptyString(args.collectionId) && hasDocumentFilterResolveSelector(args, "collection")) {
    issues.push({ path: "args.collectionQuery", message: "cannot be combined with args.collectionId" });
  }
  validateAccessResolveConcurrency(args, issues);
}

function validateShareInfoSelector(args, issues) {
  const hasShareId = hasNonEmptyString(args.id);
  const hasDocumentRef = hasDocumentResolveSelector(args);
  if (!hasShareId && !hasDocumentRef) {
    issues.push({ path: "args.id", message: "or args.documentId, args.query, args.documentQuery, args.refs, args.urlId, or args.url is required" });
  }
  if (hasShareId && hasDocumentRef) {
    issues.push({ path: "args.documentId", message: "cannot be combined with args.id" });
  }
  validateAccessResolveConcurrency(args, issues);
}

function validateCollectionAccessSelector(args, issues) {
  const hasScalar = ["id", "collectionId", "query", "urlId", "url"].some((key) =>
    hasNonEmptyString(args[key])
  );
  const hasArray = ["refs", "queries", "urlIds", "urls"].some((key) =>
    hasNonEmptyStringArray(args[key])
  );
  if (!hasScalar && !hasArray) {
    issues.push({ path: "args.id", message: "or args.collectionId, args.query, args.refs, args.urlId, or args.url is required" });
  }
  if (args.id && args.collectionId) {
    issues.push({ path: "args.collectionId", message: "cannot be combined with args.id" });
  }
  validateAccessResolveConcurrency(args, issues);
}

function hasPrincipalResolveSelector(args) {
  return ["query"].some((key) => hasNonEmptyString(args[key]))
    || ["refs", "queries"].some((key) => hasNonEmptyStringArray(args[key]));
}

function validatePrincipalResolveConcurrency(args, issues) {
  validateAccessResolveConcurrency(args, issues);
}

function hasNamedPrincipalSelector(args, type) {
  const prefix = type === "group" ? "group" : "user";
  return [`${prefix}Query`, `${prefix}Ref`].some((key) => hasNonEmptyString(args[key]))
    || [`${prefix}Queries`, `${prefix}Refs`].some((key) => hasNonEmptyStringArray(args[key]));
}

function validateNamedPrincipalSelector(args, issues, type) {
  const idKey = type === "group" ? "groupId" : "userId";
  const prefix = type === "group" ? "group" : "user";
  const hasId = hasNonEmptyString(args[idKey]);
  const hasResolvedRef = hasNamedPrincipalSelector(args, type);
  if (!hasId && !hasResolvedRef) {
    issues.push({ path: `args.${idKey}`, message: `or args.${prefix}Query/args.${prefix}Refs is required` });
  }
  if (hasId && hasResolvedRef) {
    issues.push({ path: `args.${prefix}Query`, message: `cannot be combined with args.${idKey}` });
  }
  validatePrincipalResolveConcurrency(args, issues);
}

function hasGroupTargetSelector(args) {
  return ["id", "groupId", "groupQuery", "groupRef"].some((key) => hasNonEmptyString(args[key]))
    || ["groupQueries", "groupRefs"].some((key) => hasNonEmptyStringArray(args[key]));
}

function hasTemplateResolveSelector(args, { includeQuery = true } = {}) {
  return ["templateQuery", "templateRef", ...(includeQuery ? ["query"] : [])].some((key) => hasNonEmptyString(args[key]))
    || ["templateQueries", "templateRefs", "refs", ...(includeQuery ? ["queries"] : [])].some((key) => hasNonEmptyStringArray(args[key]));
}

function validateTemplateTargetSelector(args, issues, options = {}) {
  const idKeys = options.idKeys || ["id"];
  const hasId = idKeys.some((key) => hasNonEmptyString(args[key]));
  const hasIds = hasNonEmptyStringArray(args.ids);
  const hasResolvedRef = hasTemplateResolveSelector(args, { includeQuery: options.includeQuery !== false });
  if (!hasId && !hasIds && !hasResolvedRef) {
    issues.push({ path: `args.${idKeys[0]}`, message: "or args.templateQuery/args.templateRefs is required" });
  }
  if ((hasId || hasIds) && hasResolvedRef) {
    issues.push({ path: "args.templateQuery", message: `cannot be combined with args.${hasIds ? "ids" : idKeys[0]}` });
  }
  validatePrincipalResolveConcurrency(args, issues);
}

function validateGroupTargetSelector(args, issues) {
  if (!hasGroupTargetSelector(args)) {
    issues.push({ path: "args.id", message: "or args.groupId/args.groupQuery/args.groupRefs is required" });
  }
  const hasId = hasNonEmptyString(args.id) || hasNonEmptyString(args.groupId);
  const hasResolvedRef = hasNamedPrincipalSelector(args, "group");
  if (hasNonEmptyString(args.id) && hasNonEmptyString(args.groupId)) {
    issues.push({ path: "args.groupId", message: "cannot be combined with args.id" });
  }
  if (hasId && hasResolvedRef) {
    issues.push({ path: "args.groupQuery", message: "cannot be combined with args.id or args.groupId" });
  }
  validatePrincipalResolveConcurrency(args, issues);
}

function validateGroupUserMutationSelector(args, issues) {
  validateGroupTargetSelector(args, issues);
  validateNamedPrincipalSelector(args, issues, "user");
}

function validateCollectionUserMutationSelector(args, issues) {
  validateCollectionAccessSelector(args, issues);
  validateNamedPrincipalSelector(args, issues, "user");
}

function validateCollectionGroupMutationSelector(args, issues) {
  validateCollectionAccessSelector(args, issues);
  validateNamedPrincipalSelector(args, issues, "group");
}

function validateDocumentUserMutationSelector(args, issues) {
  validateDocumentAccessSelector(args, issues);
  validateNamedPrincipalSelector(args, issues, "user");
}

function validateDocumentGroupMutationSelector(args, issues) {
  validateDocumentAccessSelector(args, issues);
  validateNamedPrincipalSelector(args, issues, "group");
}

function looksNumeric(value) {
  return /^-?(?:\d+|\d+\.\d+)$/.test(String(value || "").trim());
}

function coerceScalarValue(types, value) {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return value;
  }

  if (types.includes("boolean") && /^(true|false)$/i.test(trimmed)) {
    return trimmed.toLowerCase() === "true";
  }
  if (types.includes("null") && /^null$/i.test(trimmed)) {
    return null;
  }
  if (types.includes("number") && looksNumeric(trimmed)) {
    return Number(trimmed);
  }
  if (types.includes("object") && /^[{]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }
  if (types.includes("array") && /^[[]/.test(trimmed)) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return value;
    }
  }

  return value;
}

function coerceArrayValue(types, value) {
  if (!Array.isArray(value)) {
    if (types.includes("string[]") && typeof value === "string") {
      return [value];
    }
    return value;
  }

  if (types.includes("string[]")) {
    return value.map((item) => (typeof item === "string" ? item : String(item)));
  }

  return value;
}

function normalizeCrossFieldAliases(args, properties) {
  const next = { ...args };

  if (Array.isArray(next.query) && properties.queries && next.queries === undefined) {
    next.queries = next.query.map((item) => String(item));
    delete next.query;
  }
  if (Array.isArray(next.question) && properties.questions && next.questions === undefined) {
    next.questions = next.question.map((item) => String(item));
    delete next.question;
  }
  if (Array.isArray(next.id) && properties.ids && next.ids === undefined) {
    next.ids = next.id.map((item) => String(item));
    delete next.id;
  }
  if (typeof next.ids === "string" && properties.id && !properties.ids && next.id === undefined) {
    next.id = next.ids;
    delete next.ids;
  }
  if (typeof next.queries === "string" && properties.query && !properties.queries && next.query === undefined) {
    next.query = next.queries;
    delete next.queries;
  }

  return next;
}

function normalizeArgsForSpec(args, spec) {
  const properties = spec.properties || {};
  const next = normalizeCrossFieldAliases(args, properties);

  for (const [key, rule] of Object.entries(properties)) {
    if (!(key in next)) {
      continue;
    }

    const types = Array.isArray(rule.type) ? rule.type : [rule.type];
    let value = next[key];
    value = coerceArrayValue(types, value);
    value = coerceScalarValue(types, value);

    if (Array.isArray(value) && types.includes("string[]")) {
      value = value.map((item) => (typeof item === "string" ? item : String(item)));
    }

    next[key] = value;
  }

  return next;
}

function collectValidationIssues(args, spec) {
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

  return issues;
}

function validateSpec(tool, args, spec) {
  const issues = collectValidationIssues(args, spec);

  if (issues.length > 0) {
    fail(tool, issues, spec, args);
  }
}

const SHARED_DOC_COMMON = {
  collectionId: { type: "string" },
  collectionQuery: { type: "string" },
  collectionRef: { type: "string" },
  collectionQueries: { type: "string[]" },
  collectionRefs: { type: "string[]" },
  userId: { type: "string" },
  userQuery: { type: "string" },
  userRef: { type: "string" },
  userQueries: { type: "string[]" },
  userRefs: { type: "string[]" },
  profile: { type: "string" },
  resolveLimit: { type: "number", min: 1 },
  minScore: { type: "number", min: 0 },
  maxAgeHours: { type: "number", min: 0 },
  refresh: { type: "boolean" },
  strict: { type: "boolean" },
  strictThreshold: { type: "number", min: 0 },
  fallbackSearch: { type: "boolean" },
  fallbackMinScore: { type: "number", min: 0 },
  fallbackLimit: { type: "number", min: 1 },
  statusFilter: { type: ["string", "string[]"] },
  view: { type: "string", enum: ["ids", "summary", "full"] },
};

function hasDocumentFilterResolveSelector(args, prefix) {
  return [`${prefix}Query`, `${prefix}Ref`].some((key) => hasNonEmptyString(args[key]))
    || [`${prefix}Queries`, `${prefix}Refs`].some((key) => hasNonEmptyStringArray(args[key]));
}

function validateDocumentFilterSelectors(args, issues) {
  if (hasNonEmptyString(args.collectionId) && hasDocumentFilterResolveSelector(args, "collection")) {
    issues.push({ path: "args.collectionQuery", message: "cannot be combined with args.collectionId" });
  }
  if (hasNonEmptyString(args.userId) && hasDocumentFilterResolveSelector(args, "user")) {
    issues.push({ path: "args.userQuery", message: "cannot be combined with args.userId" });
  }
}

function hasAnswerDocumentResolveSelector(args) {
  return ["documentQuery", "documentRef", "shareId", "urlId", "url"].some((key) => hasNonEmptyString(args[key]))
    || ["documentQueries", "documentRefs", "refs", "shareIds", "urlIds", "urls"].some((key) => hasNonEmptyStringArray(args[key]));
}

function validateAnswerScopeSelectors(args, issues) {
  validateDocumentFilterSelectors(args, issues);
  if (hasNonEmptyString(args.id) && hasNonEmptyString(args.documentId)) {
    issues.push({ path: "args.documentId", message: "cannot be combined with args.id" });
  }
  if ((hasNonEmptyString(args.id) || hasNonEmptyString(args.documentId)) && hasAnswerDocumentResolveSelector(args)) {
    issues.push({ path: "args.documentQuery", message: "cannot be combined with args.id or args.documentId" });
  }
}

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
      validateDocumentFilterSelectors(args, issues);
    },
  },
  "documents.list": {
    properties: {
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      parentDocumentId: { type: ["string", "null"] },
      rootOnly: { type: "boolean" },
      backlinkDocumentId: { type: "string" },
      includePolicies: { type: "boolean" },
      ...SHARED_DOC_COMMON,
    },
    custom(args, issues) {
      if (args.rootOnly === true && Object.prototype.hasOwnProperty.call(args, "parentDocumentId") && args.parentDocumentId !== null) {
        issues.push({
          path: "args.rootOnly",
          message: "cannot be combined with a non-null args.parentDocumentId",
        });
      }
      validateDocumentFilterSelectors(args, issues);
    },
  },
  "documents.backlinks": {
    properties: {
      id: { type: "string" },
      query: { type: "string" },
      shareId: { type: "string" },
      urlId: { type: "string" },
      url: { type: "string" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      includePolicies: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const refs = ["id", "query", "shareId", "urlId", "url"].filter((key) => args[key]);
      if (refs.length === 0) {
        issues.push({ path: "args.id", message: "or args.query, args.shareId, args.urlId, or args.url is required" });
      }
      if (refs.length > 1) {
        issues.push({ path: "args.id", message: "provide only one of args.id, args.query, args.shareId, args.urlId, or args.url" });
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
      refs: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
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
      const hasRefs = ["refs", "queries", "shareIds", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      const hasSingularRef = ["query", "shareId", "urlId", "url"].some((key) =>
        typeof args[key] === "string" && args[key].trim().length > 0
      );

      if (!hasId && !hasIds && !hasRefs && !hasSingularRef) {
        issues.push({ path: "args.id", message: "or args.ids[], args.refs[], args.query, args.queries[], args.shareId(s), args.urlId(s), or args.url(s) is required" });
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
      if (typeof args.resolveConcurrency === "number" && args.resolveConcurrency > 8) {
        issues.push({ path: "args.resolveConcurrency", message: "must be <= 8" });
      }
      if (typeof args.resolveHydrateConcurrency === "number" && args.resolveHydrateConcurrency > 8) {
        issues.push({ path: "args.resolveHydrateConcurrency", message: "must be <= 8" });
      }
    },
  },
  "documents.graph_report": {
    properties: {
      seedIds: { type: "string[]" },
      seedRefs: { type: "string[]" },
      seedQuery: { type: "string" },
      seedQueries: { type: "string[]" },
      seedShareId: { type: "string" },
      seedShareIds: { type: "string[]" },
      seedUrlId: { type: "string" },
      seedUrlIds: { type: "string[]" },
      seedUrl: { type: "string" },
      seedUrls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      depth: { type: "number", min: 0 },
      maxNodes: { type: "number", min: 1 },
      includeBacklinks: { type: "boolean" },
      includeSearchNeighbors: { type: "boolean" },
      limitPerSource: { type: "number", min: 1 },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasSeedIds = Array.isArray(args.seedIds) && args.seedIds.length > 0;
      const hasSeedArrays = ["seedRefs", "seedQueries", "seedShareIds", "seedUrlIds", "seedUrls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      const hasSeedSingle = ["seedQuery", "seedShareId", "seedUrlId", "seedUrl"].some((key) =>
        typeof args[key] === "string" && args[key].trim().length > 0
      );

      if (!hasSeedIds && !hasSeedArrays && !hasSeedSingle) {
        issues.push({ path: "args.seedIds", message: "or args.seedRefs[], args.seedQuery, args.seedQueries[], args.seedShareId(s), args.seedUrlId(s), or args.seedUrl(s) is required" });
      }
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
      if (typeof args.resolveConcurrency === "number" && args.resolveConcurrency > 8) {
        issues.push({ path: "args.resolveConcurrency", message: "must be <= 8" });
      }
      if (typeof args.resolveHydrateConcurrency === "number" && args.resolveHydrateConcurrency > 8) {
        issues.push({ path: "args.resolveHydrateConcurrency", message: "must be <= 8" });
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
      refs: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      issueDomains: { type: "string[]" },
      keyPattern: { type: "string" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.trim().length > 0;
      const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
      const hasRefs = ["refs", "queries", "shareIds", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      const hasSingularRef = ["query", "shareId", "urlId", "url"].some((key) =>
        typeof args[key] === "string" && args[key].trim().length > 0
      );

      if (!hasId && !hasIds && !hasRefs && !hasSingularRef) {
        issues.push({ path: "args.id", message: "or args.ids[], args.refs[], args.query, args.queries[], args.shareId(s), args.urlId(s), or args.url(s) is required" });
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
      if (typeof args.resolveConcurrency === "number" && args.resolveConcurrency > 8) {
        issues.push({ path: "args.resolveConcurrency", message: "must be <= 8" });
      }
      if (typeof args.resolveHydrateConcurrency === "number" && args.resolveHydrateConcurrency > 8) {
        issues.push({ path: "args.resolveHydrateConcurrency", message: "must be <= 8" });
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
  "documents.attachments": {
    properties: {
      id: { type: "string" },
      documentId: { type: "string" },
      refs: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      url: { type: "string" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      urls: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasArrays = ["refs", "queries", "shareIds", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      const hasSingle = ["query", "urlId"].some((key) =>
        typeof args[key] === "string" && args[key].trim().length > 0
      );
      if (!args.id && !args.documentId && !args.url && !args.shareId && !hasArrays && !hasSingle) {
        issues.push({ path: "args.id", message: "or args.documentId, args.url, args.shareId, or document refs are required" });
      }
      if (typeof args.resolveConcurrency === "number" && args.resolveConcurrency > 8) {
        issues.push({ path: "args.resolveConcurrency", message: "must be <= 8" });
      }
      if (typeof args.resolveHydrateConcurrency === "number" && args.resolveHydrateConcurrency > 8) {
        issues.push({ path: "args.resolveHydrateConcurrency", message: "must be <= 8" });
      }
    },
  },
  "attachments.download": {
    properties: {
      id: { type: "string" },
      attachmentId: { type: "string" },
      url: { type: "string" },
      path: { type: "string" },
      outputDir: { type: "string" },
      filePath: { type: "string" },
      fileName: { type: "string" },
      overwrite: { type: "boolean" },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (!args.id && !args.attachmentId && !args.url && !args.path) {
        issues.push({ path: "args.id", message: "or args.attachmentId, args.url, or args.path is required" });
      }
      if (args.filePath && (args.outputDir || args.fileName)) {
        issues.push({ path: "args.filePath", message: "cannot be combined with args.outputDir or args.fileName" });
      }
    },
  },
  "documents.download_attachments": {
    properties: {
      id: { type: "string" },
      documentId: { type: "string" },
      refs: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      url: { type: "string" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      urls: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      outputDir: { type: "string" },
      overwrite: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasArrays = ["refs", "queries", "shareIds", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      const hasSingle = ["query", "urlId"].some((key) =>
        typeof args[key] === "string" && args[key].trim().length > 0
      );
      if (!args.id && !args.documentId && !args.url && !args.shareId && !hasArrays && !hasSingle) {
        issues.push({ path: "args.id", message: "or args.documentId, args.url, args.shareId, or document refs are required" });
      }
      if (typeof args.concurrency === "number" && args.concurrency > 8) {
        issues.push({ path: "args.concurrency", message: "must be <= 8" });
      }
      if (typeof args.resolveConcurrency === "number" && args.resolveConcurrency > 8) {
        issues.push({ path: "args.resolveConcurrency", message: "must be <= 8" });
      }
      if (typeof args.resolveHydrateConcurrency === "number" && args.resolveHydrateConcurrency > 8) {
        issues.push({ path: "args.resolveHydrateConcurrency", message: "must be <= 8" });
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
  "documents.open": {
    properties: {
      query: { type: "string" },
      id: { type: "string" },
      shareId: { type: "string" },
      urlId: { type: "string" },
      url: { type: "string" },
      profile: { type: "string" },
      limit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      collectionId: { type: "string" },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const refs = ["query", "id", "shareId", "urlId", "url"].filter((key) => args[key]);
      if (refs.length === 0) {
        issues.push({ path: "args.query", message: "or args.id, args.shareId, args.urlId, or args.url is required" });
      }
      if (refs.length > 1) {
        issues.push({ path: "args.query", message: "provide only one of args.query, args.id, args.shareId, args.urlId, or args.url" });
      }
    },
  },
  "documents.open_batch": {
    properties: {
      refs: { type: "string[]" },
      queries: { type: "string[]" },
      ids: { type: "string[]" },
      shareIds: { type: "string[]" },
      urlIds: { type: "string[]" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      limit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      collectionId: { type: "string" },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      concurrency: { type: "number", min: 1 },
      hydrateConcurrency: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasRef = ["refs", "queries", "ids", "shareIds", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      if (!hasRef) {
        issues.push({ path: "args.refs", message: "or args.queries, args.ids, args.shareIds, args.urlIds, or args.urls must include at least one value" });
      }
      if (typeof args.concurrency === "number" && args.concurrency > 8) {
        issues.push({ path: "args.concurrency", message: "must be <= 8" });
      }
      if (typeof args.hydrateConcurrency === "number" && args.hydrateConcurrency > 8) {
        issues.push({ path: "args.hydrateConcurrency", message: "must be <= 8" });
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
  "collections.open": {
    properties: {
      query: { type: "string" },
      id: { type: "string" },
      urlId: { type: "string" },
      url: { type: "string" },
      profile: { type: "string" },
      limit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const refs = ["query", "id", "urlId", "url"].filter((key) => args[key]);
      if (refs.length === 0) {
        issues.push({ path: "args.query", message: "or args.id, args.urlId, or args.url is required" });
      }
      if (refs.length > 1) {
        issues.push({ path: "args.query", message: "provide only one of args.query, args.id, args.urlId, or args.url" });
      }
    },
  },
  "collections.open_batch": {
    properties: {
      refs: { type: "string[]" },
      queries: { type: "string[]" },
      ids: { type: "string[]" },
      urlIds: { type: "string[]" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      limit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      concurrency: { type: "number", min: 1 },
      hydrateConcurrency: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasRef = ["refs", "queries", "ids", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      if (!hasRef) {
        issues.push({ path: "args.refs", message: "or args.queries, args.ids, args.urlIds, or args.urls must include at least one value" });
      }
      if (typeof args.concurrency === "number" && args.concurrency > 8) {
        issues.push({ path: "args.concurrency", message: "must be <= 8" });
      }
      if (typeof args.hydrateConcurrency === "number" && args.hydrateConcurrency > 8) {
        issues.push({ path: "args.hydrateConcurrency", message: "must be <= 8" });
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
      collectionQuery: { type: "string" },
      collectionRef: { type: "string" },
      collectionQueries: { type: "string[]" },
      collectionRefs: { type: "string[]" },
      userId: { type: "string" },
      userQuery: { type: "string" },
      userRef: { type: "string" },
      userQueries: { type: "string[]" },
      userRefs: { type: "string[]" },
      profile: { type: "string" },
      memory: { type: "boolean" },
      memoryMinScore: { type: "number", min: 0 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      fallbackSearch: { type: "boolean" },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMinScore: { type: "number", min: 0 },
      resolveLimit: { type: "number", min: 1 },
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
      validateDocumentFilterSelectors(args, issues);
      if (typeof args.strictThreshold === "number" && args.strictThreshold > 1) {
        issues.push({ path: "args.strictThreshold", message: "must be <= 1" });
      }
    },
  },
  "documents.resolve_urls": {
    properties: {
      url: { type: "string" },
      urls: { type: "string[]" },
      collectionId: { type: "string" },
      collectionQuery: { type: "string" },
      collectionRef: { type: "string" },
      collectionQueries: { type: "string[]" },
      collectionRefs: { type: "string[]" },
      userId: { type: "string" },
      userQuery: { type: "string" },
      userRef: { type: "string" },
      userQueries: { type: "string[]" },
      userRefs: { type: "string[]" },
      profile: { type: "string" },
      memory: { type: "boolean" },
      memoryMinScore: { type: "number", min: 0 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      fallbackSearch: { type: "boolean" },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMinScore: { type: "number", min: 0 },
      resolveLimit: { type: "number", min: 1 },
      limit: { type: "number", min: 1 },
      strict: { type: "boolean" },
      strictHost: { type: "boolean" },
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
      if (!args.url && !args.urls) {
        issues.push({ path: "args.url", message: "or args.urls[] is required" });
      }
      validateDocumentFilterSelectors(args, issues);
      if (typeof args.strictThreshold === "number" && args.strictThreshold > 1) {
        issues.push({ path: "args.strictThreshold", message: "must be <= 1" });
      }
    },
  },
  "documents.canonicalize_candidates": {
    properties: {
      query: { type: "string" },
      queries: { type: "string[]" },
      ids: { type: "string[]" },
      collectionId: { type: "string" },
      limit: { type: "number", min: 1 },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      titleSimilarityThreshold: { type: "number", min: 0 },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      concurrency: { type: "number", min: 1 },
      hydrateConcurrency: { type: "number", min: 1 },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      excerptChars: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (!args.query && !args.queries && !args.ids) {
        issues.push({ path: "args.query", message: "or args.queries[] or args.ids[] is required" });
      }
      if (Array.isArray(args.ids) && args.ids.length === 0) {
        issues.push({ path: "args.ids", message: "must be a non-empty string[] when provided" });
      }
      if (typeof args.strictThreshold === "number" && args.strictThreshold > 1) {
        issues.push({ path: "args.strictThreshold", message: "must be <= 1" });
      }
      if (typeof args.titleSimilarityThreshold === "number" && args.titleSimilarityThreshold > 1) {
        issues.push({ path: "args.titleSimilarityThreshold", message: "must be <= 1" });
      }
    },
  },
  "collections.tree": {
    properties: {
      collectionId: { type: "string" },
      id: { type: "string" },
      query: { type: "string" },
      urlId: { type: "string" },
      url: { type: "string" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
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
    custom(args, issues) {
      const refs = ["collectionId", "id", "query", "urlId", "url"].filter((key) => args[key]);
      if (refs.length === 0) {
        issues.push({ path: "args.collectionId", message: "or args.id, args.query, args.urlId, or args.url is required" });
      }
      if (refs.length > 1) {
        issues.push({ path: "args.collectionId", message: "provide only one of args.collectionId, args.id, args.query, args.urlId, or args.url" });
      }
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
      collectionQuery: { type: "string" },
      collectionRef: { type: "string" },
      collectionQueries: { type: "string[]" },
      collectionRefs: { type: "string[]" },
      documentId: { type: "string" },
      userId: { type: "string" },
      userQuery: { type: "string" },
      userRef: { type: "string" },
      userQueries: { type: "string[]" },
      userRefs: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
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
      validateDocumentFilterSelectors(args, issues);
    },
  },
  "search.research": {
    properties: {
      question: { type: "string" },
      query: { type: "string" },
      queries: { type: "string[]" },
      collectionId: { type: "string" },
      collectionQuery: { type: "string" },
      collectionRef: { type: "string" },
      collectionQueries: { type: "string[]" },
      collectionRefs: { type: "string[]" },
      userId: { type: "string" },
      userQuery: { type: "string" },
      userRef: { type: "string" },
      userQueries: { type: "string[]" },
      userRefs: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      limitPerQuery: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      includeTitleSearch: { type: "boolean" },
      includeSemanticSearch: { type: "boolean" },
      precisionMode: { type: "string", enum: ["balanced", "precision", "recall"] },
      minScore: { type: "number", min: 0 },
      diversify: { type: "boolean" },
      diversityLambda: { type: "number", min: 0 },
      rrfK: { type: "number", min: 1 },
      expandLimit: { type: "number", min: 1 },
      maxDocuments: { type: "number", min: 1 },
      seenIds: { type: "string[]" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      perQueryView: { type: "string", enum: ["ids", "summary", "full"] },
      perQueryHitLimit: { type: "number", min: 1 },
      evidencePerDocument: { type: "number", min: 1 },
      suggestedQueryLimit: { type: "number", min: 1 },
      includePerQuery: { type: "boolean" },
      includeExpanded: { type: "boolean" },
      includeCoverage: { type: "boolean" },
      includeBacklinks: { type: "boolean" },
      backlinksLimit: { type: "number", min: 1 },
      backlinksConcurrency: { type: "number", min: 1 },
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
      validateDocumentFilterSelectors(args, issues);
      if (args.includeTitleSearch === false && args.includeSemanticSearch === false) {
        issues.push({
          path: "args.includeTitleSearch",
          message: "and includeSemanticSearch cannot both be false",
        });
      }
      if (typeof args.minScore === "number" && args.minScore > 1) {
        issues.push({ path: "args.minScore", message: "must be <= 1" });
      }
      if (typeof args.diversityLambda === "number" && args.diversityLambda > 1) {
        issues.push({ path: "args.diversityLambda", message: "must be <= 1" });
      }
    },
  },
  "documents.safe_update": {
    required: ["expectedRevision"],
    properties: {
      ...DOCUMENT_MUTATION_TARGET_RESOLVE_PROPERTIES,
      expectedRevision: { type: ["number", "string"], min: 0 },
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
    custom: validateRequiredDocumentMutationTargetAndExpectedRevision,
  },
  "documents.diff": {
    required: ["proposedText"],
    properties: {
      id: { type: "string" },
      documentId: { type: "string" },
      refs: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      proposedText: { type: "string" },
      includeFullHunks: { type: "boolean" },
      hunkLimit: { type: "number", min: 1 },
      hunkLineLimit: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.trim().length > 0;
      const hasDocumentId = typeof args.documentId === "string" && args.documentId.trim().length > 0;
      const hasArrays = ["refs", "queries", "shareIds", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      const hasSingle = ["query", "shareId", "urlId", "url"].some((key) =>
        typeof args[key] === "string" && args[key].trim().length > 0
      );
      if (!hasId && !hasDocumentId && !hasArrays && !hasSingle) {
        issues.push({ path: "args.id", message: "or document refs are required" });
      }
      if (hasId && hasDocumentId) {
        issues.push({ path: "args.documentId", message: "cannot be combined with args.id" });
      }
      if (typeof args.resolveConcurrency === "number" && args.resolveConcurrency > 8) {
        issues.push({ path: "args.resolveConcurrency", message: "must be <= 8" });
      }
      if (typeof args.resolveHydrateConcurrency === "number" && args.resolveHydrateConcurrency > 8) {
        issues.push({ path: "args.resolveHydrateConcurrency", message: "must be <= 8" });
      }
    },
  },
  "documents.apply_patch": {
    required: ["patch"],
    properties: {
      ...DOCUMENT_MUTATION_TARGET_RESOLVE_PROPERTIES,
      patch: { type: "string" },
      expectedRevision: { type: ["number", "string"], min: 0 },
      mode: { type: "string", enum: ["unified", "replace"] },
      title: { type: "string" },
      view: { type: "string", enum: ["summary", "full"] },
      excerptChars: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      validateRequiredDocumentMutationTargetArgs(args, issues);
      validateExpectedRevisionGuard(args, issues);
    },
  },
  "documents.apply_patch_safe": {
    required: ["expectedRevision", "patch"],
    properties: {
      ...DOCUMENT_MUTATION_TARGET_RESOLVE_PROPERTIES,
      patch: { type: "string" },
      expectedRevision: { type: ["number", "string"], min: 0 },
      mode: { type: "string", enum: ["unified", "replace"] },
      title: { type: "string" },
      view: { type: "string", enum: ["summary", "full"] },
      excerptChars: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateRequiredDocumentMutationTargetAndExpectedRevision,
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
        validateBatchUpdateDocumentTarget(update, issues, `args.updates[${i}]`);
        if (
          Object.prototype.hasOwnProperty.call(update, "expectedRevision") &&
          !(
            (typeof update.expectedRevision === "number" && Number.isFinite(update.expectedRevision)) ||
            (typeof update.expectedRevision === "string" && update.expectedRevision.trim().toLowerCase() === "latest")
          )
        ) {
          issues.push({ path: `args.updates[${i}].expectedRevision`, message: "must be a number or latest" });
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
    properties: {
      id: { type: "string" },
      documentId: { type: "string" },
      refs: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.trim().length > 0;
      const hasDocumentId = typeof args.documentId === "string" && args.documentId.trim().length > 0;
      const hasArrays = ["refs", "queries", "shareIds", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      const hasSingle = ["query", "shareId", "urlId", "url"].some((key) =>
        typeof args[key] === "string" && args[key].trim().length > 0
      );
      if (!hasId && !hasDocumentId && !hasArrays && !hasSingle) {
        issues.push({ path: "args.documentId", message: "or document refs are required" });
      }
      if (hasId && hasDocumentId) {
        issues.push({ path: "args.documentId", message: "cannot be combined with args.id" });
      }
      if (typeof args.resolveConcurrency === "number" && args.resolveConcurrency > 8) {
        issues.push({ path: "args.resolveConcurrency", message: "must be <= 8" });
      }
      if (typeof args.resolveHydrateConcurrency === "number" && args.resolveHydrateConcurrency > 8) {
        issues.push({ path: "args.resolveHydrateConcurrency", message: "must be <= 8" });
      }
    },
  },
  "revisions.diff": {
    properties: {
      id: { type: "string" },
      documentId: { type: "string" },
      refs: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      baseRevisionId: { type: "string" },
      targetRevisionId: { type: "string" },
      revisionPair: { type: "string", enum: ["latest"] },
      revisionLimit: { type: "number", min: 2 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includeFullHunks: { type: "boolean" },
      hunkLimit: { type: "number", min: 1 },
      hunkLineLimit: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.trim().length > 0;
      const hasDocumentId = typeof args.documentId === "string" && args.documentId.trim().length > 0;
      const hasArrays = ["refs", "queries", "shareIds", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      const hasSingle = ["query", "shareId", "urlId", "url"].some((key) =>
        typeof args[key] === "string" && args[key].trim().length > 0
      );
      const hasBase = typeof args.baseRevisionId === "string" && args.baseRevisionId.trim().length > 0;
      const hasTarget = typeof args.targetRevisionId === "string" && args.targetRevisionId.trim().length > 0;

      if (!hasId && !hasDocumentId && !hasArrays && !hasSingle) {
        issues.push({ path: "args.documentId", message: "or document refs are required" });
      }
      if (hasId && hasDocumentId) {
        issues.push({ path: "args.documentId", message: "cannot be combined with args.id" });
      }
      if (hasBase !== hasTarget) {
        issues.push({ path: hasBase ? "args.targetRevisionId" : "args.baseRevisionId", message: "must be provided with the other revision id" });
      }
      if ((hasBase || hasTarget) && args.revisionPair) {
        issues.push({ path: "args.revisionPair", message: "cannot be combined with explicit revision IDs" });
      }
      if (typeof args.revisionLimit === "number" && args.revisionLimit > 20) {
        issues.push({ path: "args.revisionLimit", message: "must be <= 20" });
      }
      if (typeof args.resolveConcurrency === "number" && args.resolveConcurrency > 8) {
        issues.push({ path: "args.resolveConcurrency", message: "must be <= 8" });
      }
      if (typeof args.resolveHydrateConcurrency === "number" && args.resolveHydrateConcurrency > 8) {
        issues.push({ path: "args.resolveHydrateConcurrency", message: "must be <= 8" });
      }
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
      documentQuery: { type: "string" },
      documentQueries: { type: "string[]" },
      refs: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateOptionalDocumentResolveArgs,
  },
  "shares.info": {
    properties: {
      id: { type: "string" },
      documentId: { type: "string" },
      query: { type: "string" },
      documentQuery: { type: "string" },
      queries: { type: "string[]" },
      documentQueries: { type: "string[]" },
      refs: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateShareInfoSelector,
  },
  "shares.create": {
    properties: {
      ...DOCUMENT_TARGET_RESOLVE_PROPERTIES,
      includeChildDocuments: { type: "boolean" },
      published: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateRequiredDocumentResolveArgs,
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
      collectionQuery: { type: "string" },
      collectionRef: { type: "string" },
      collectionQueries: { type: "string[]" },
      collectionRefs: { type: "string[]" },
      query: { type: "string" },
      ...PRINCIPAL_RESOLVE_OPTION_PROPERTIES,
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateOptionalCollectionFilterResolveArgs,
  },
  "templates.info": {
    properties: {
      id: { type: "string" },
      ids: { type: "string[]" },
      query: { type: "string" },
      ...TEMPLATE_RESOLVE_PROPERTIES,
      includePolicies: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateTemplateTargetSelector,
  },
  "templates.extract_placeholders": {
    properties: {
      id: { type: "string" },
      query: { type: "string" },
      ...TEMPLATE_RESOLVE_PROPERTIES,
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (typeof args.id === "string" && args.id.trim().length === 0) {
        issues.push({ path: "args.id", message: "must be a non-empty string" });
      }
      validateTemplateTargetSelector(args, issues);
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
    properties: {
      id: { type: "string" },
      ...TEMPLATE_RESOLVE_PROPERTIES,
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
    custom(args, issues) {
      validateTemplateTargetSelector(args, issues, { includeQuery: false });
    },
  },
  "templates.delete": {
    properties: {
      id: { type: "string" },
      ...TEMPLATE_RESOLVE_PROPERTIES,
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      validateTemplateTargetSelector(args, issues, { includeQuery: false });
    },
  },
  "templates.restore": {
    properties: {
      id: { type: "string" },
      ...TEMPLATE_RESOLVE_PROPERTIES,
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      validateTemplateTargetSelector(args, issues, { includeQuery: false });
    },
  },
  "templates.duplicate": {
    properties: {
      id: { type: "string" },
      ...TEMPLATE_RESOLVE_PROPERTIES,
      title: { type: "string" },
      collectionId: { type: ["string", "null"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      validateTemplateTargetSelector(args, issues, { includeQuery: false });
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
  "oauth_clients.list": {
    properties: {
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
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
  "oauth_clients.info": {
    properties: {
      id: { type: "string" },
      clientId: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.trim().length > 0;
      const hasClientId = typeof args.clientId === "string" && args.clientId.trim().length > 0;

      if (!hasId && !hasClientId) {
        issues.push({ path: "args.id", message: "or args.clientId is required" });
      }
      if (typeof args.id === "string" && args.id.trim().length === 0) {
        issues.push({ path: "args.id", message: "must be a non-empty string when provided" });
      }
      if (typeof args.clientId === "string" && args.clientId.trim().length === 0) {
        issues.push({ path: "args.clientId", message: "must be a non-empty string when provided" });
      }
      if (hasId && hasClientId) {
        issues.push({ path: "args.clientId", message: "cannot be combined with args.id" });
      }
    },
  },
  "oauth_clients.create": {
    required: ["name", "redirectUris"],
    properties: {
      name: { type: "string" },
      description: { type: "string" },
      developerName: { type: "string" },
      developerUrl: { type: "string" },
      avatarUrl: { type: "string" },
      redirectUris: { type: "string[]" },
      published: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (typeof args.name === "string" && args.name.trim().length === 0) {
        issues.push({ path: "args.name", message: "must be a non-empty string" });
      }
      if (Array.isArray(args.redirectUris)) {
        if (args.redirectUris.length === 0) {
          issues.push({ path: "args.redirectUris", message: "must be a non-empty string[]" });
        }
        for (let i = 0; i < args.redirectUris.length; i += 1) {
          if (args.redirectUris[i].trim().length === 0) {
            issues.push({ path: `args.redirectUris[${i}]`, message: "must be a non-empty string" });
          }
        }
      }
    },
  },
  "oauth_clients.update": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      name: { type: "string" },
      description: { type: "string" },
      developerName: { type: "string" },
      developerUrl: { type: "string" },
      avatarUrl: { type: "string" },
      redirectUris: { type: "string[]" },
      published: { type: "boolean" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (typeof args.id === "string" && args.id.trim().length === 0) {
        issues.push({ path: "args.id", message: "must be a non-empty string" });
      }
      if (typeof args.name === "string" && args.name.trim().length === 0) {
        issues.push({ path: "args.name", message: "must be a non-empty string when provided" });
      }
      if (Array.isArray(args.redirectUris)) {
        if (args.redirectUris.length === 0) {
          issues.push({ path: "args.redirectUris", message: "must be a non-empty string[] when provided" });
        }
        for (let i = 0; i < args.redirectUris.length; i += 1) {
          if (args.redirectUris[i].trim().length === 0) {
            issues.push({ path: `args.redirectUris[${i}]`, message: "must be a non-empty string" });
          }
        }
      }
    },
  },
  "oauth_clients.rotate_secret": {
    required: ["id"],
    properties: {
      id: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (typeof args.id === "string" && args.id.trim().length === 0) {
        issues.push({ path: "args.id", message: "must be a non-empty string" });
      }
    },
  },
  "oauth_clients.delete": {
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
  "oauth_authentications.list": {
    properties: {
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
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
  "oauth_authentications.delete": {
    required: ["oauthClientId"],
    properties: {
      oauthClientId: { type: "string" },
      scope: { type: "string[]" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (typeof args.oauthClientId === "string" && args.oauthClientId.trim().length === 0) {
        issues.push({ path: "args.oauthClientId", message: "must be a non-empty string" });
      }
      if (Array.isArray(args.scope)) {
        if (args.scope.length === 0) {
          issues.push({ path: "args.scope", message: "must be a non-empty string[] when provided" });
        }
        for (let i = 0; i < args.scope.length; i += 1) {
          if (args.scope[i].trim().length === 0) {
            issues.push({ path: `args.scope[${i}]`, message: "must be a non-empty string" });
          }
        }
      }
    },
  },
  "oauthClients.delete": {
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
  "oauthAuthentications.delete": {
    required: ["oauthClientId"],
    properties: {
      oauthClientId: { type: "string" },
      scope: { type: "string[]" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      if (typeof args.oauthClientId === "string" && args.oauthClientId.trim().length === 0) {
        issues.push({ path: "args.oauthClientId", message: "must be a non-empty string" });
      }
      if (Array.isArray(args.scope)) {
        if (args.scope.length === 0) {
          issues.push({ path: "args.scope", message: "must be a non-empty string[] when provided" });
        }
        for (let i = 0; i < args.scope.length; i += 1) {
          if (args.scope[i].trim().length === 0) {
            issues.push({ path: `args.scope[${i}]`, message: "must be a non-empty string" });
          }
        }
      }
    },
  },
  "documents.create_from_template": {
    properties: {
      templateId: { type: "string" },
      query: { type: "string" },
      ...TEMPLATE_RESOLVE_PROPERTIES,
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
      validateTemplateTargetSelector(args, issues, { idKeys: ["templateId"] });

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
      query: { type: "string" },
      documentQuery: { type: "string" },
      queries: { type: "string[]" },
      documentQueries: { type: "string[]" },
      refs: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
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
    custom: validateOptionalDocumentResolveArgs,
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
    properties: {
      ...DOCUMENT_TARGET_RESOLVE_PROPERTIES,
      text: { type: "string" },
      data: { type: "object" },
      parentCommentId: { type: "string" },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom(args, issues) {
      validateRequiredDocumentResolveArgs(args, issues);
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
      documentId: { type: "string" },
      documentIds: { type: "string[]" },
      refs: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      collectionId: { type: "string" },
      collectionQuery: { type: "string" },
      collectionRefId: { type: "string" },
      collectionUrlId: { type: "string" },
      collectionUrl: { type: "string" },
      collectionResolveLimit: { type: "number", min: 1 },
      collectionMinScore: { type: "number", min: 0 },
      collectionMaxAgeHours: { type: "number", min: 0 },
      collectionStrictThreshold: { type: "number", min: 0 },
      collectionFallbackMinScore: { type: "number", min: 0 },
      collectionFallbackLimit: { type: "number", min: 1 },
      includeAnchorText: { type: "boolean" },
      includeReplies: { type: "boolean" },
      limitPerDocument: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasDocumentIds = Array.isArray(args.documentIds) && args.documentIds.length > 0;
      const hasDocumentId = typeof args.documentId === "string" && args.documentId.trim().length > 0;
      const hasDocumentArrays = ["refs", "queries", "shareIds", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      const hasDocumentSingle = ["query", "shareId", "urlId", "url"].some((key) =>
        typeof args[key] === "string" && args[key].trim().length > 0
      );
      const hasCollectionId = typeof args.collectionId === "string" && args.collectionId.length > 0;
      const hasCollectionRef = ["collectionQuery", "collectionRefId", "collectionUrlId", "collectionUrl"].some((key) =>
        typeof args[key] === "string" && args[key].trim().length > 0
      );
      if (!hasDocumentIds && !hasDocumentId && !hasDocumentArrays && !hasDocumentSingle && !hasCollectionId && !hasCollectionRef) {
        issues.push({ path: "args.documentIds", message: "or document refs, args.collectionId, or collection refs are required" });
      }
      if (Array.isArray(args.documentIds) && args.documentIds.length === 0) {
        issues.push({ path: "args.documentIds", message: "must be a non-empty string[] when provided" });
      }
      if (typeof args.resolveConcurrency === "number" && args.resolveConcurrency > 8) {
        issues.push({ path: "args.resolveConcurrency", message: "must be <= 8" });
      }
      if (typeof args.resolveHydrateConcurrency === "number" && args.resolveHydrateConcurrency > 8) {
        issues.push({ path: "args.resolveHydrateConcurrency", message: "must be <= 8" });
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
      userQuery: { type: "string" },
      userRef: { type: "string" },
      userQueries: { type: "string[]" },
      userRefs: { type: "string[]" },
      documentId: { type: "string" },
      documentQuery: { type: "string" },
      documentRef: { type: "string" },
      documentQueries: { type: "string[]" },
      documentRefs: { type: "string[]" },
      refs: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      collectionId: { type: "string" },
      collectionQuery: { type: "string" },
      collectionRef: { type: "string" },
      collectionQueries: { type: "string[]" },
      collectionRefs: { type: "string[]" },
      name: { type: "string" },
      auditLog: { type: "boolean" },
      ip: { type: "string" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateEventsListResolveSelectors,
  },
  "documents.archived": {
    properties: {
      collectionId: { type: "string" },
      collectionQuery: { type: "string" },
      collectionRef: { type: "string" },
      collectionQueries: { type: "string[]" },
      collectionRefs: { type: "string[]" },
      refs: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateOptionalCollectionFilterResolveArgs,
  },
  "documents.deleted": {
    properties: {
      collectionId: { type: "string" },
      collectionQuery: { type: "string" },
      collectionRef: { type: "string" },
      collectionQueries: { type: "string[]" },
      collectionRefs: { type: "string[]" },
      refs: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateOptionalCollectionFilterResolveArgs,
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
      ...PRINCIPAL_RESOLVE_PROPERTIES,
      includePolicies: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.length > 0;
      const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
      const hasResolvedRef = hasPrincipalResolveSelector(args);

      if (!hasId && !hasIds && !args.email && !hasResolvedRef) {
        issues.push({ path: "args.id", message: "or args.ids[], args.email, args.query, or args.refs is required" });
      }
      if (Array.isArray(args.ids) && args.ids.length === 0) {
        issues.push({ path: "args.ids", message: "must be a non-empty string[] when provided" });
      }
      if (hasId && Array.isArray(args.ids)) {
        issues.push({ path: "args.ids", message: "cannot be combined with args.id" });
      }
      if (hasResolvedRef && (hasId || hasIds || args.email)) {
        issues.push({ path: "args.query", message: "cannot be combined with args.id, args.ids, or args.email" });
      }
      validatePrincipalResolveConcurrency(args, issues);
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
      ...PRINCIPAL_RESOLVE_PROPERTIES,
      includePolicies: { type: "boolean" },
      concurrency: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = typeof args.id === "string" && args.id.length > 0;
      const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
      const hasResolvedRef = hasPrincipalResolveSelector(args);

      if (!hasId && !hasIds && !hasResolvedRef) {
        issues.push({ path: "args.id", message: "or args.ids[], args.query, or args.refs is required" });
      }
      if (Array.isArray(args.ids) && args.ids.length === 0) {
        issues.push({ path: "args.ids", message: "must be a non-empty string[] when provided" });
      }
      if (hasId && Array.isArray(args.ids)) {
        issues.push({ path: "args.ids", message: "cannot be combined with args.id" });
      }
      if (hasResolvedRef && (hasId || hasIds)) {
        issues.push({ path: "args.query", message: "cannot be combined with args.id or args.ids" });
      }
      validatePrincipalResolveConcurrency(args, issues);
    },
  },
  "groups.memberships": {
    properties: {
      id: { type: "string" },
      ...PRINCIPAL_RESOLVE_PROPERTIES,
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasId = hasNonEmptyString(args.id);
      const hasResolvedRef = hasPrincipalResolveSelector(args);
      if (!hasId && !hasResolvedRef) {
        issues.push({ path: "args.id", message: "or args.query or args.refs is required" });
      }
      if (hasId && hasResolvedRef) {
        issues.push({ path: "args.query", message: "cannot be combined with args.id" });
      }
      validatePrincipalResolveConcurrency(args, issues);
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
    properties: {
      id: { type: "string" },
      groupId: { type: "string" },
      userId: { type: "string" },
      ...GROUP_PRINCIPAL_RESOLVE_PROPERTIES,
      ...USER_PRINCIPAL_RESOLVE_PROPERTIES,
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateGroupUserMutationSelector,
  },
  "groups.remove_user": {
    properties: {
      id: { type: "string" },
      groupId: { type: "string" },
      userId: { type: "string" },
      ...GROUP_PRINCIPAL_RESOLVE_PROPERTIES,
      ...USER_PRINCIPAL_RESOLVE_PROPERTIES,
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateGroupUserMutationSelector,
  },
  "collections.memberships": {
    properties: {
      ...COLLECTION_ACCESS_RESOLVE_PROPERTIES,
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateCollectionAccessSelector,
  },
  "collections.group_memberships": {
    properties: {
      ...COLLECTION_ACCESS_RESOLVE_PROPERTIES,
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateCollectionAccessSelector,
  },
  "collections.add_user": {
    properties: {
      ...COLLECTION_ACCESS_RESOLVE_PROPERTIES,
      userId: { type: "string" },
      ...USER_PRINCIPAL_RESOLVE_PROPERTIES,
      permission: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateCollectionUserMutationSelector,
  },
  "collections.remove_user": {
    properties: {
      ...COLLECTION_ACCESS_RESOLVE_PROPERTIES,
      userId: { type: "string" },
      ...USER_PRINCIPAL_RESOLVE_PROPERTIES,
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateCollectionUserMutationSelector,
  },
  "collections.add_group": {
    properties: {
      ...COLLECTION_ACCESS_RESOLVE_PROPERTIES,
      groupId: { type: "string" },
      ...GROUP_PRINCIPAL_RESOLVE_PROPERTIES,
      permission: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateCollectionGroupMutationSelector,
  },
  "collections.remove_group": {
    properties: {
      ...COLLECTION_ACCESS_RESOLVE_PROPERTIES,
      groupId: { type: "string" },
      ...GROUP_PRINCIPAL_RESOLVE_PROPERTIES,
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateCollectionGroupMutationSelector,
  },
  "documents.memberships": {
    properties: {
      ...DOCUMENT_ACCESS_RESOLVE_PROPERTIES,
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateDocumentAccessSelector,
  },
  "documents.users": {
    properties: {
      ...DOCUMENT_ACCESS_RESOLVE_PROPERTIES,
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateDocumentAccessSelector,
  },
  "documents.group_memberships": {
    properties: {
      ...DOCUMENT_ACCESS_RESOLVE_PROPERTIES,
      limit: { type: "number", min: 1 },
      offset: { type: "number", min: 0 },
      sort: { type: "string" },
      direction: { type: "string", enum: ["ASC", "DESC"] },
      includePolicies: { type: "boolean" },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom: validateDocumentAccessSelector,
  },
  "documents.add_user": {
    properties: {
      ...DOCUMENT_ACCESS_RESOLVE_PROPERTIES,
      userId: { type: "string" },
      ...USER_PRINCIPAL_RESOLVE_PROPERTIES,
      permission: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateDocumentUserMutationSelector,
  },
  "documents.remove_user": {
    properties: {
      ...DOCUMENT_ACCESS_RESOLVE_PROPERTIES,
      userId: { type: "string" },
      ...USER_PRINCIPAL_RESOLVE_PROPERTIES,
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateDocumentUserMutationSelector,
  },
  "documents.add_group": {
    properties: {
      ...DOCUMENT_ACCESS_RESOLVE_PROPERTIES,
      groupId: { type: "string" },
      ...GROUP_PRINCIPAL_RESOLVE_PROPERTIES,
      permission: { type: "string" },
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateDocumentGroupMutationSelector,
  },
  "documents.remove_group": {
    properties: {
      ...DOCUMENT_ACCESS_RESOLVE_PROPERTIES,
      groupId: { type: "string" },
      ...GROUP_PRINCIPAL_RESOLVE_PROPERTIES,
      maxAttempts: { type: "number", min: 1 },
      performAction: { type: "boolean" },
    },
    custom: validateDocumentGroupMutationSelector,
  },
  "documents.answer": {
    properties: {
      question: { type: "string" },
      query: { type: "string" },
      id: { type: "string" },
      documentId: { type: "string" },
      documentQuery: { type: "string" },
      documentRef: { type: "string" },
      documentQueries: { type: "string[]" },
      documentRefs: { type: "string[]" },
      refs: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      collectionId: { type: "string" },
      collectionQuery: { type: "string" },
      collectionRef: { type: "string" },
      collectionQueries: { type: "string[]" },
      collectionRefs: { type: "string[]" },
      userId: { type: "string" },
      userQuery: { type: "string" },
      userRef: { type: "string" },
      userQueries: { type: "string[]" },
      userRefs: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      hydrateConcurrency: { type: "number", min: 1 },
      statusFilter: { type: ["string", "string[]"] },
      dateFilter: { type: "string", enum: ["day", "week", "month", "year"] },
      includePolicies: { type: "boolean" },
      includeEvidenceDocs: { type: "boolean" },
      limit: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      contextChars: { type: "number", min: 1 },
      excerptChars: { type: "number", min: 1 },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const selected = args.question ?? args.query;
      if (typeof selected !== "string" || selected.trim().length === 0) {
        issues.push({ path: "args.question", message: "or args.query is required and must be non-empty" });
      }
      validateAnswerScopeSelectors(args, issues);
    },
  },
  "documents.answer_batch": {
    properties: {
      question: { type: "string" },
      query: { type: "string" },
      questions: { type: "array" },
      id: { type: "string" },
      documentId: { type: "string" },
      documentQuery: { type: "string" },
      documentRef: { type: "string" },
      documentQueries: { type: "string[]" },
      documentRefs: { type: "string[]" },
      refs: { type: "string[]" },
      shareId: { type: "string" },
      shareIds: { type: "string[]" },
      urlId: { type: "string" },
      urlIds: { type: "string[]" },
      url: { type: "string" },
      urls: { type: "string[]" },
      collectionId: { type: "string" },
      collectionQuery: { type: "string" },
      collectionRef: { type: "string" },
      collectionQueries: { type: "string[]" },
      collectionRefs: { type: "string[]" },
      userId: { type: "string" },
      userQuery: { type: "string" },
      userRef: { type: "string" },
      userQueries: { type: "string[]" },
      userRefs: { type: "string[]" },
      profile: { type: "string" },
      resolveLimit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      strict: { type: "boolean" },
      strictThreshold: { type: "number", min: 0 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      resolveCollectionId: { type: "string" },
      resolveConcurrency: { type: "number", min: 1 },
      resolveHydrateConcurrency: { type: "number", min: 1 },
      hydrateConcurrency: { type: "number", min: 1 },
      statusFilter: { type: ["string", "string[]"] },
      dateFilter: { type: "string", enum: ["day", "week", "month", "year"] },
      includePolicies: { type: "boolean" },
      includeEvidenceDocs: { type: "boolean" },
      limit: { type: "number", min: 1 },
      view: { type: "string", enum: ["summary", "full"] },
      contextChars: { type: "number", min: 1 },
      excerptChars: { type: "number", min: 1 },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
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

      validateAnswerScopeSelectors(args, issues);

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
  "memory.lookup": {
    properties: {
      query: { type: "string" },
      id: { type: "string" },
      urlId: { type: "string" },
      url: { type: "string" },
      type: { type: "string", enum: MEMORY_ENTITY_TYPES },
      profile: { type: "string" },
      limit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
    },
    custom(args, issues) {
      if (!args.query && !args.id && !args.urlId && !args.url) {
        issues.push({ path: "args.query", message: "or args.id, args.urlId, or args.url is required" });
      }
    },
  },
  "memory.resolve": {
    properties: {
      query: { type: "string" },
      id: { type: "string" },
      urlId: { type: "string" },
      url: { type: "string" },
      type: { type: "string", enum: MEMORY_ENTITY_TYPES },
      profile: { type: "string" },
      limit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      hydrateLimit: { type: "number", min: 1 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      collectionId: { type: "string" },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      if (!args.query && !args.id && !args.urlId && !args.url) {
        issues.push({ path: "args.query", message: "or args.id, args.urlId, or args.url is required" });
      }
    },
  },
  "memory.resolve_batch": {
    properties: {
      queries: { type: "string[]" },
      ids: { type: "string[]" },
      urlIds: { type: "string[]" },
      urls: { type: "string[]" },
      type: { type: "string", enum: MEMORY_ENTITY_TYPES },
      profile: { type: "string" },
      limit: { type: "number", min: 1 },
      minScore: { type: "number", min: 0 },
      maxAgeHours: { type: "number", min: 0 },
      refresh: { type: "boolean" },
      hydrateLimit: { type: "number", min: 1 },
      fallbackSearch: { type: "boolean" },
      fallbackMinScore: { type: "number", min: 0 },
      fallbackLimit: { type: "number", min: 1 },
      fallbackMode: { type: "string", enum: ["titles", "semantic", "both"] },
      collectionId: { type: "string" },
      snippetMinWords: { type: "number", min: 1 },
      snippetMaxWords: { type: "number", min: 1 },
      view: { type: "string", enum: ["ids", "summary", "full"] },
      concurrency: { type: "number", min: 1 },
      hydrateConcurrency: { type: "number", min: 1 },
      maxAttempts: { type: "number", min: 1 },
    },
    custom(args, issues) {
      const hasRef = ["queries", "ids", "urlIds", "urls"].some((key) =>
        Array.isArray(args[key]) && args[key].length > 0
      );
      if (!hasRef) {
        issues.push({ path: "args.queries", message: "or args.ids, args.urlIds, or args.urls must include at least one value" });
      }
    },
  },
  "memory.recent": {
    properties: {
      type: { type: "string", enum: MEMORY_ENTITY_TYPES },
      profile: { type: "string" },
      limit: { type: "number", min: 1 },
      maxAgeHours: { type: "number", min: 0 },
      includeDeleted: { type: "boolean" },
    },
  },
  "memory.remember": {
    required: ["type", "id"],
    properties: {
      type: { type: "string", enum: MEMORY_ENTITY_TYPES },
      id: { type: "string" },
      title: { type: "string" },
      name: { type: "string" },
      email: { type: "string" },
      urlId: { type: "string" },
      url: { type: "string" },
      aliases: { type: "string[]" },
      query: { type: "string" },
      queries: { type: "string[]" },
      profile: { type: "string" },
      performAction: { type: "boolean" },
    },
  },
  "memory.stats": {
    properties: {},
  },
  "memory.clear": {
    properties: {
      profile: { type: "string" },
      allProfiles: { type: "boolean" },
      performAction: { type: "boolean" },
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
    return args;
  }

  ensureObject(toolName, args);
  const normalizedArgs = normalizeArgsForSpec(args, spec);
  validateSpec(toolName, normalizedArgs, spec);
  return normalizedArgs;
}
