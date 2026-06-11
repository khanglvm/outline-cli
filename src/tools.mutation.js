import { createHash } from "node:crypto";
import { ApiError, CliError } from "./errors.js";
import {
  assertPerformAction,
  consumeDocumentDeleteReadReceipt,
  getDocumentDeleteReadReceipt,
} from "./action-gate.js";
import { compactValue, mapLimit, toInteger } from "./utils.js";
import { summarizeSafeText } from "./summary-redaction.js";
import { documentsOpenBatchTool } from "./memory-store.js";

function normalizeDocumentSummary(doc, view = "summary", excerptChars = 220) {
  if (!doc) {
    return doc;
  }
  if (view === "full") {
    return doc;
  }

  const summary = {
    id: doc.id,
    title: doc.title,
    collectionId: doc.collectionId,
    parentDocumentId: doc.parentDocumentId,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    publishedAt: doc.publishedAt,
    urlId: doc.urlId,
    emoji: doc.emoji,
  };

  if (doc.text) {
    summary.excerpt = summarizeSafeText(doc.text, excerptChars);
  }

  return summary;
}

function buildRevisionConflict({ id, expectedRevision, actualRevision }) {
  return {
    ok: false,
    code: "revision_conflict",
    message: "Document revision changed since last read",
    id,
    expectedRevision,
    actualRevision,
    updated: false,
  };
}

function resolveExpectedRevisionGuard(args, actualRevision, toolName) {
  if (typeof args.expectedRevision === "string") {
    const mode = args.expectedRevision.trim().toLowerCase();
    if (mode !== "latest") {
      throw new CliError("expectedRevision must be a number or \"latest\"");
    }
    if (!Number.isFinite(actualRevision)) {
      throw new CliError(`${toolName} could not read the latest document revision`);
    }
    return {
      expectedRevision: actualRevision,
      source: "latest",
    };
  }

  const expectedRevision = Number(args.expectedRevision);
  if (!Number.isFinite(expectedRevision)) {
    throw new CliError("expectedRevision must be a number or \"latest\"");
  }
  return {
    expectedRevision,
    source: "explicit",
  };
}

function ensureUpdatePayload(args) {
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

  if (!body.id) {
    throw new CliError("id is required");
  }

  return body;
}

function splitLines(text) {
  return String(text ?? "").replace(/\r\n/g, "\n").split("\n");
}

function buildLcsMatrix(a, b) {
  const m = a.length;
  const n = b.length;
  const matrix = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      if (a[i] === b[j]) {
        matrix[i][j] = matrix[i + 1][j + 1] + 1;
      } else {
        matrix[i][j] = Math.max(matrix[i + 1][j], matrix[i][j + 1]);
      }
    }
  }

  return matrix;
}

function computeLineDiff(currentText, proposedText) {
  const a = splitLines(currentText);
  const b = splitLines(proposedText);
  const matrix = buildLcsMatrix(a, b);

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ type: "equal", line: a[i] });
      i += 1;
      j += 1;
    } else if (matrix[i + 1][j] >= matrix[i][j + 1]) {
      ops.push({ type: "remove", line: a[i] });
      i += 1;
    } else {
      ops.push({ type: "add", line: b[j] });
      j += 1;
    }
  }

  while (i < a.length) {
    ops.push({ type: "remove", line: a[i] });
    i += 1;
  }

  while (j < b.length) {
    ops.push({ type: "add", line: b[j] });
    j += 1;
  }

  const hunks = [];
  let pointerOld = 1;
  let pointerNew = 1;
  let added = 0;
  let removed = 0;
  let unchanged = 0;

  let pending = null;

  function flushPending() {
    if (!pending) {
      return;
    }
    const lines = pending.lines;
    const hasAdds = lines.some((l) => l.type === "add");
    const hasRemoves = lines.some((l) => l.type === "remove");
    pending.kind = hasAdds && hasRemoves ? "change" : hasAdds ? "add" : "remove";
    hunks.push(pending);
    pending = null;
  }

  for (const op of ops) {
    if (op.type === "equal") {
      unchanged += 1;
      flushPending();
      pointerOld += 1;
      pointerNew += 1;
      continue;
    }

    if (!pending) {
      pending = {
        oldStart: pointerOld,
        newStart: pointerNew,
        lines: [],
      };
    }

    pending.lines.push(op);

    if (op.type === "add") {
      added += 1;
      pointerNew += 1;
    } else {
      removed += 1;
      pointerOld += 1;
    }
  }

  flushPending();

  const changed = hunks.filter((h) => h.kind === "change").length;

  return {
    stats: {
      added,
      removed,
      changed,
      unchanged,
      totalCurrentLines: a.length,
      totalProposedLines: b.length,
    },
    hunks,
  };
}

function previewHunks(hunks, limit = 8, perHunkLineLimit = 12) {
  return hunks.slice(0, limit).map((h) => ({
    kind: h.kind,
    oldStart: h.oldStart,
    newStart: h.newStart,
    lines: h.lines.slice(0, perHunkLineLimit).map((line) => ({
      type: line.type,
      line: line.line,
    })),
    truncated: h.lines.length > perHunkLineLimit,
  }));
}

function buildDiffPayload(diff, args = {}) {
  const includeFullHunks = !!args.includeFullHunks;
  return {
    stats: diff.stats,
    hunks: includeFullHunks
      ? diff.hunks
      : previewHunks(diff.hunks, toInteger(args.hunkLimit, 8), toInteger(args.hunkLineLimit, 12)),
    truncated: !includeFullHunks,
  };
}

function normalizeRevisionDiffMeta(revision, view = "summary") {
  if (!revision || typeof revision !== "object") {
    return null;
  }
  if (view === "full") {
    return revision;
  }
  return compactValue({
    id: revision.id,
    documentId: revision.documentId,
    title: revision.title,
    createdAt: revision.createdAt,
    createdBy: revision.createdBy
      ? {
          id: revision.createdBy.id,
          name: revision.createdBy.name,
        }
      : undefined,
  });
}

function resolveRevisionDocumentId(revision) {
  if (typeof revision?.documentId === "string" && revision.documentId) {
    return revision.documentId;
  }
  if (typeof revision?.document?.id === "string" && revision.document.id) {
    return revision.document.id;
  }
  return undefined;
}

function resolveRevisionText(revision) {
  if (typeof revision?.text === "string") {
    return revision.text;
  }
  if (typeof revision?.document?.text === "string") {
    return revision.document.text;
  }
  return "";
}

function parseUnifiedPatch(patchText) {
  const lines = splitLines(patchText);
  const hunks = [];
  let current = null;

  const headerRe = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

  for (const line of lines) {
    if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      continue;
    }

    // Allow leading/trailing blank lines outside hunks (common from shell heredocs),
    // but inside a hunk every line must carry a unified-diff prefix.
    if (line === "" && !current) {
      continue;
    }

    const m = line.match(headerRe);
    if (m) {
      current = {
        oldStart: Number(m[1]),
        oldCount: Number(m[2] || 1),
        newStart: Number(m[3]),
        newCount: Number(m[4] || 1),
        lines: [],
      };
      hunks.push(current);
      continue;
    }

    if (!current) {
      return {
        ok: false,
        error: {
          code: "patch_parse_failed",
          message: "Patch contains lines outside any hunk",
          line,
        },
      };
    }

    const prefix = line[0];
    if (![" ", "+", "-"].includes(prefix)) {
      return {
        ok: false,
        error: {
          code: "patch_parse_failed",
          message: "Patch line must start with space, +, or -",
          line,
        },
      };
    }

    current.lines.push({
      kind: prefix,
      text: line.slice(1),
    });
  }

  if (hunks.length === 0) {
    return {
      ok: false,
      error: {
        code: "patch_parse_failed",
        message: "No hunks found in unified patch",
      },
    };
  }

  return { ok: true, hunks };
}

function applyUnifiedPatch(currentText, patchText) {
  const parsed = parseUnifiedPatch(patchText);
  if (!parsed.ok) {
    return parsed;
  }

  const source = splitLines(currentText);
  const output = [];
  let index = 0;

  for (const hunk of parsed.hunks) {
    const expectedStart = Math.max(0, hunk.oldStart - 1);
    if (expectedStart < index) {
      return {
        ok: false,
        error: {
          code: "patch_apply_failed",
          message: "Overlapping hunks are not supported",
          detail: { expectedStart, index },
        },
      };
    }

    while (index < expectedStart && index < source.length) {
      output.push(source[index]);
      index += 1;
    }

    for (const line of hunk.lines) {
      if (line.kind === " ") {
        if (source[index] !== line.text) {
          return {
            ok: false,
            error: {
              code: "patch_apply_failed",
              message: "Context line mismatch",
              detail: {
                expected: line.text,
                actual: source[index],
                line: index + 1,
              },
            },
          };
        }
        output.push(source[index]);
        index += 1;
      } else if (line.kind === "-") {
        if (source[index] !== line.text) {
          return {
            ok: false,
            error: {
              code: "patch_apply_failed",
              message: "Remove line mismatch",
              detail: {
                expected: line.text,
                actual: source[index],
                line: index + 1,
              },
            },
          };
        }
        index += 1;
      } else if (line.kind === "+") {
        output.push(line.text);
      }
    }
  }

  while (index < source.length) {
    output.push(source[index]);
    index += 1;
  }

  return {
    ok: true,
    text: output.join("\n"),
  };
}

function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function hashPlanObject(plan) {
  const stable = stableObject(plan);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

function normalizePlanRules(args) {
  const raw = Array.isArray(args.rules)
    ? args.rules
    : typeof args.find === "string"
      ? [
          {
            field: args.field || "both",
            find: args.find,
            replace: args.replace ?? "",
            caseSensitive: args.caseSensitive,
            wholeWord: args.wholeWord,
            all: args.all,
          },
        ]
      : [];

  if (raw.length === 0) {
    throw new CliError("documents.plan_batch_update requires args.rules[] or args.find");
  }

  return raw.map((rule, index) => {
    if (!rule || typeof rule !== "object" || Array.isArray(rule)) {
      throw new CliError(`rules[${index}] must be an object`);
    }

    const find = String(rule.find || "");
    if (!find) {
      throw new CliError(`rules[${index}].find is required`);
    }

    const field = rule.field || "both";
    if (!["title", "text", "both"].includes(field)) {
      throw new CliError(`rules[${index}].field must be title|text|both`);
    }

    const caseSensitive = !!rule.caseSensitive;
    const wholeWord = !!rule.wholeWord;
    const all = rule.all !== false;
    const flags = `${all ? "g" : ""}${caseSensitive ? "" : "i"}`;
    const source = wholeWord ? `\\b${escapeRegex(find)}\\b` : escapeRegex(find);
    const regex = new RegExp(source, flags || (caseSensitive ? "" : "i"));

    return {
      field,
      find,
      replace: String(rule.replace ?? ""),
      caseSensitive,
      wholeWord,
      all,
      regex,
    };
  });
}

function normalizeTerminologyRuleEntries(args) {
  const rawGlossary = Array.isArray(args.glossary) ? args.glossary : null;
  const rawMapCandidates = [args.map, args.glossaryMap, args.terminologyMap];
  const rawMap = rawMapCandidates.find(
    (candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate)
  );

  const rules = [];
  let inputMode = "";

  if (rawGlossary && rawGlossary.length > 0) {
    inputMode = "glossary";
    for (let index = 0; index < rawGlossary.length; index += 1) {
      const entry = rawGlossary[index];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new CliError(`glossary[${index}] must be an object`);
      }

      const from = String(entry.from ?? entry.find ?? "").trim();
      if (!from) {
        throw new CliError(`glossary[${index}].from (or find) is required`);
      }

      const to = String(entry.to ?? entry.replace ?? "");
      const field = entry.field || "both";
      if (!["title", "text", "both"].includes(field)) {
        throw new CliError(`glossary[${index}].field must be title|text|both`);
      }

      rules.push({
        field,
        find: from,
        replace: to,
        caseSensitive: entry.caseSensitive,
        wholeWord: entry.wholeWord,
        all: entry.all,
      });
    }
  } else if (rawMap && Object.keys(rawMap).length > 0) {
    inputMode = "map";
    const keys = Object.keys(rawMap).sort((a, b) => a.localeCompare(b));
    for (const fromKey of keys) {
      const from = String(fromKey || "").trim();
      if (!from) {
        continue;
      }
      rules.push({
        field: "both",
        find: from,
        replace: String(rawMap[fromKey] ?? ""),
        caseSensitive: !!args.caseSensitive,
        wholeWord: args.wholeWord,
        all: args.all,
      });
    }
  } else {
    throw new CliError("documents.plan_terminology_refactor requires args.glossary[] or args.map object");
  }

  const deduped = [];
  const seen = new Set();
  for (const rule of rules) {
    const key = [
      rule.field || "both",
      String(rule.find || ""),
      String(rule.replace ?? ""),
      rule.caseSensitive ? "1" : "0",
      rule.wholeWord ? "1" : "0",
      rule.all === false ? "0" : "1",
    ].join("::");
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    deduped.push(rule);
  }

  return {
    inputMode,
    rules: deduped,
    glossary: deduped.map((rule) => ({
      from: rule.find,
      to: String(rule.replace ?? ""),
      field: rule.field || "both",
      caseSensitive: !!rule.caseSensitive,
      wholeWord: !!rule.wholeWord,
      all: rule.all !== false,
    })),
  };
}

function countMatches(text, regex) {
  const flags = regex.flags.includes("g") ? regex.flags : `${regex.flags}g`;
  const counter = new RegExp(regex.source, flags);
  const matches = String(text || "").match(counter);
  return matches ? matches.length : 0;
}

function applyPlanRulesToDocument(doc, rules) {
  const currentTitle = String(doc?.title || "");
  const currentText = String(doc?.text || "");
  let nextTitle = currentTitle;
  let nextText = currentText;

  const replacements = {
    title: 0,
    text: 0,
  };

  for (const rule of rules) {
    if (rule.field === "title" || rule.field === "both") {
      const count = countMatches(nextTitle, rule.regex);
      if (count > 0) {
        nextTitle = nextTitle.replace(rule.regex, rule.replace);
        replacements.title += count;
      }
    }

    if (rule.field === "text" || rule.field === "both") {
      const count = countMatches(nextText, rule.regex);
      if (count > 0) {
        nextText = nextText.replace(rule.regex, rule.replace);
        replacements.text += count;
      }
    }
  }

  return {
    nextTitle,
    nextText,
    titleChanged: nextTitle !== currentTitle,
    textChanged: nextText !== currentText,
    replacements: {
      ...replacements,
      total: replacements.title + replacements.text,
    },
  };
}

function normalizeQueryInputs(args) {
  const queries = [];
  const ids = [];

  if (Array.isArray(args.ids)) {
    for (const id of args.ids) {
      if (id != null) {
        ids.push(String(id));
      }
    }
  } else if (args.id) {
    ids.push(String(args.id));
  }

  if (Array.isArray(args.queries)) {
    for (const query of args.queries) {
      if (query != null && String(query).trim()) {
        queries.push(String(query).trim());
      }
    }
  }
  if (args.query && String(args.query).trim()) {
    queries.push(String(args.query).trim());
  }

  const uniqueIds = [...new Set(ids)];
  const uniqueQueries = [...new Set(queries)];
  if (uniqueIds.length === 0 && uniqueQueries.length === 0) {
    throw new CliError("documents.plan_batch_update requires ids[]/id or query/queries[]");
  }

  return {
    ids: uniqueIds,
    queries: uniqueQueries,
  };
}

async function findPlanCandidateIds(ctx, args, queries, maxAttempts) {
  const set = new Set();
  const limitPerQuery = Math.max(1, toInteger(args.limitPerQuery, 10));
  const offset = Math.max(0, toInteger(args.offset, 0));
  const includeTitleSearch = args.includeTitleSearch !== false;
  const includeSemanticSearch = args.includeSemanticSearch !== false;
  if (!includeTitleSearch && !includeSemanticSearch) {
    throw new CliError("documents.plan_batch_update requires includeTitleSearch or includeSemanticSearch");
  }

  await mapLimit(queries, Math.max(1, toInteger(args.concurrency, 4)), async (query) => {
    const base = compactValue({
      query,
      collectionId: args.collectionId,
      limit: limitPerQuery,
      offset,
    }) || {};

    if (includeTitleSearch) {
      const titleRes = await ctx.client.call("documents.search_titles", base, { maxAttempts });
      const rows = Array.isArray(titleRes.body?.data) ? titleRes.body.data : [];
      for (const row of rows) {
        if (row?.id) {
          set.add(String(row.id));
        }
      }
    }

    if (includeSemanticSearch) {
      const semanticRes = await ctx.client.call(
        "documents.search",
        {
          ...base,
          snippetMinWords: toInteger(args.snippetMinWords, 16),
          snippetMaxWords: toInteger(args.snippetMaxWords, 24),
        },
        { maxAttempts }
      );
      const rows = Array.isArray(semanticRes.body?.data) ? semanticRes.body.data : [];
      for (const row of rows) {
        const id = row?.document?.id;
        if (id) {
          set.add(String(id));
        }
      }
    }
  });

  return [...set];
}

async function loadPlanDocs(ctx, ids, maxAttempts, concurrency) {
  const loaded = await mapLimit(ids, Math.max(1, concurrency), async (id) => {
    try {
      const info = await ctx.client.call("documents.info", { id }, { maxAttempts });
      return {
        id,
        ok: true,
        data: info.body?.data || null,
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

  return loaded;
}

async function documentsPlanBatchUpdateTool(ctx, args) {
  const rules = normalizePlanRules(args);
  const maxAttempts = toInteger(args.maxAttempts, 2);
  const readConcurrency = Math.max(1, toInteger(args.readConcurrency, 4));
  const maxDocuments = Math.max(1, toInteger(args.maxDocuments, 30));
  const includeUnchanged = !!args.includeUnchanged;

  const normalized = normalizeQueryInputs(args);
  const discoveredIds =
    normalized.queries.length > 0
      ? await findPlanCandidateIds(ctx, args, normalized.queries, maxAttempts)
      : [];
  const candidateIds = [...new Set([...normalized.ids, ...discoveredIds])].slice(0, maxDocuments);

  const loaded = await loadPlanDocs(ctx, candidateIds, maxAttempts, readConcurrency);
  const docs = loaded.filter((row) => row.ok && row.data).map((row) => row.data);
  const loadFailures = loaded.filter((row) => !row.ok);

  const impacts = [];
  const planItems = [];
  const hunkLimit = Math.max(1, toInteger(args.hunkLimit, 8));
  const hunkLineLimit = Math.max(1, toInteger(args.hunkLineLimit, 10));

  for (const doc of docs) {
    const applied = applyPlanRulesToDocument(doc, rules);
    const changed = applied.titleChanged || applied.textChanged;
    if (!changed && !includeUnchanged) {
      continue;
    }

    const textDiff = applied.textChanged ? computeLineDiff(doc.text || "", applied.nextText) : null;
    const summary = {
      id: doc.id,
      title: doc.title,
      revision: doc.revision,
      changed,
      titleChanged: applied.titleChanged,
      textChanged: applied.textChanged,
      replacementCounts: applied.replacements,
      proposedTitle: applied.titleChanged ? applied.nextTitle : undefined,
      stats: textDiff?.stats,
      hunks: textDiff ? previewHunks(textDiff.hunks, hunkLimit, hunkLineLimit) : [],
      truncated: !!textDiff,
    };
    impacts.push(summary);

    if (changed) {
      planItems.push(
        compactValue({
          id: doc.id,
          expectedRevision: Number(doc.revision),
          title: applied.titleChanged ? applied.nextTitle : undefined,
          text: applied.textChanged ? applied.nextText : undefined,
        })
      );
    }
  }

  impacts.sort((a, b) => {
    const aChanged = a.changed ? 1 : 0;
    const bChanged = b.changed ? 1 : 0;
    if (bChanged !== aChanged) {
      return bChanged - aChanged;
    }
    const aTotal = Number(a.replacementCounts?.total || 0);
    const bTotal = Number(b.replacementCounts?.total || 0);
    if (bTotal !== aTotal) {
      return bTotal - aTotal;
    }
    return String(a.title || "").localeCompare(String(b.title || ""));
  });

  const plan = {
    version: 1,
    createdAt: new Date().toISOString(),
    source: {
      ids: normalized.ids,
      queries: normalized.queries,
      collectionId: args.collectionId,
    },
    rules: rules.map((rule) => ({
      field: rule.field,
      find: rule.find,
      replace: rule.replace,
      caseSensitive: rule.caseSensitive,
      wholeWord: rule.wholeWord,
      all: rule.all,
    })),
    items: planItems,
  };
  const normalizedPlan = compactValue(plan) || {};
  const planHash = hashPlanObject(normalizedPlan);
  const changedCount = planItems.length;
  const unchangedCount = impacts.filter((row) => !row.changed).length;
  const totalReplacementCount = impacts.reduce((acc, row) => acc + Number(row.replacementCounts?.total || 0), 0);

  return {
    tool: "documents.plan_batch_update",
    profile: ctx.profile.id,
    result: {
      ok: true,
      planHash,
      candidateCount: candidateIds.length,
      loadedCount: docs.length,
      loadFailedCount: loadFailures.length,
      changedCount,
      unchangedCount,
      totalReplacementCount,
      impacts,
      loadFailures,
      plan: normalizedPlan,
      next: {
        tool: "documents.apply_batch_plan",
        args: {
          confirmHash: planHash,
          plan: normalizedPlan,
        },
      },
    },
  };
}

async function documentsPlanTerminologyRefactorTool(ctx, args) {
  const normalizedGlossary = normalizeTerminologyRuleEntries(args || {});
  const planArgs = compactValue({
    id: args.id,
    ids: args.ids,
    query: args.query,
    queries: args.queries,
    collectionId: args.collectionId,
    rules: normalizedGlossary.rules,
    includeTitleSearch: args.includeTitleSearch,
    includeSemanticSearch: args.includeSemanticSearch,
    limitPerQuery: args.limitPerQuery,
    offset: args.offset,
    maxDocuments: args.maxDocuments,
    readConcurrency: args.readConcurrency,
    includeUnchanged: args.includeUnchanged,
    hunkLimit: args.hunkLimit,
    hunkLineLimit: args.hunkLineLimit,
    maxAttempts: args.maxAttempts,
  }) || {};

  const planned = await documentsPlanBatchUpdateTool(ctx, planArgs);
  return {
    tool: "documents.plan_terminology_refactor",
    profile: ctx.profile.id,
    result: {
      ...(planned.result || {}),
      metadata: {
        sourceTool: "documents.plan_batch_update",
        inputMode: normalizedGlossary.inputMode,
        glossaryCount: normalizedGlossary.glossary.length,
        glossary: normalizedGlossary.glossary,
      },
    },
  };
}

async function documentsApplyBatchPlanTool(ctx, args) {
  if (!args.plan || typeof args.plan !== "object" || Array.isArray(args.plan)) {
    throw new CliError("documents.apply_batch_plan requires args.plan object");
  }
  if (!args.confirmHash || typeof args.confirmHash !== "string") {
    throw new CliError("documents.apply_batch_plan requires args.confirmHash");
  }

  const incomingPlan = { ...args.plan };
  delete incomingPlan.planHash;
  const expectedHash = hashPlanObject(incomingPlan);
  if (expectedHash !== args.confirmHash) {
    throw new CliError("plan hash mismatch; regenerate/confirm latest plan", {
      code: "PLAN_HASH_MISMATCH",
      expectedHash,
      providedHash: args.confirmHash,
    });
  }

  const items = Array.isArray(incomingPlan.items) ? incomingPlan.items : [];
  if (items.length === 0) {
    return {
      tool: "documents.apply_batch_plan",
      profile: ctx.profile.id,
      result: {
        ok: true,
        applied: false,
        reason: "empty_plan_items",
        total: 0,
      },
    };
  }

  const dryRun = !!args.dryRun;
  if (!dryRun) {
    assertPerformAction(args, {
      tool: "documents.apply_batch_plan",
      action: "apply planned document updates",
    });
  }
  const continueOnError = args.continueOnError !== false;
  const concurrency = continueOnError ? Math.max(1, toInteger(args.concurrency, 3)) : 1;
  const maxAttempts = toInteger(args.maxAttempts, 1);

  const runner = async (item, index) => {
    try {
      if (!item || typeof item !== "object") {
        throw new CliError(`plan.items[${index}] must be an object`);
      }
      if (!item.id || typeof item.id !== "string") {
        throw new CliError(`plan.items[${index}].id is required`);
      }
      if (!Number.isFinite(Number(item.expectedRevision))) {
        throw new CliError(`plan.items[${index}].expectedRevision must be a number`);
      }

      if (dryRun) {
        return {
          index,
          id: item.id,
          ok: true,
          result: {
            ok: true,
            updated: false,
            dryRun: true,
            id: item.id,
            expectedRevision: Number(item.expectedRevision),
          },
        };
      }

      const safeArgs = compactValue({
        id: item.id,
        expectedRevision: Number(item.expectedRevision),
        title: Object.prototype.hasOwnProperty.call(item, "title") ? item.title : undefined,
        text: Object.prototype.hasOwnProperty.call(item, "text") ? item.text : undefined,
        editMode: "replace",
        performAction: true,
        view: args.view || "summary",
        excerptChars: args.excerptChars,
        maxAttempts,
      }) || {};

      const safe = await documentsSafeUpdateTool(ctx, safeArgs);
      return {
        index,
        id: item.id,
        ok: safe.result?.ok === true,
        result: safe.result,
      };
    } catch (err) {
      if (err instanceof ApiError || err instanceof CliError) {
        return {
          index,
          id: item?.id,
          ok: false,
          result: {
            ok: false,
            updated: false,
            id: item?.id,
            error: {
              code: err instanceof ApiError ? "api_error" : "invalid_plan_item",
              message: err.message,
              ...(err.details || {}),
            },
          },
        };
      }
      throw err;
    }
  };

  const results = [];
  if (!continueOnError) {
    for (let i = 0; i < items.length; i += 1) {
      const out = await runner(items[i], i);
      results.push(out);
      if (!out.ok) {
        break;
      }
    }
  } else {
    const out = await mapLimit(items, concurrency, runner);
    results.push(...out);
  }

  const failed = results.filter((item) => !item.ok).length;

  return {
    tool: "documents.apply_batch_plan",
    profile: ctx.profile.id,
    result: {
      ok: failed === 0,
      dryRun,
      total: results.length,
      succeeded: results.length - failed,
      failed,
      continueOnError,
      confirmHash: args.confirmHash,
      items: results,
    },
  };
}

async function documentsDeleteTool(ctx, args) {
  if (!args.id) {
    throw new CliError("documents.delete requires args.id");
  }

  assertPerformAction(args, {
    tool: "documents.delete",
    action: "delete a document",
  });

  const maxAttempts = toInteger(args.maxAttempts, 1);
  const receipt = await getDocumentDeleteReadReceipt({
    token: args.readToken,
    profileId: ctx.profile.id,
    documentId: args.id,
  });

  const latest = await ctx.client.call("documents.info", { id: args.id }, {
    maxAttempts: Math.max(1, maxAttempts),
  });

  const expectedRevision = Number(receipt.revision);
  const actualRevision = Number(latest.body?.data?.revision);
  if (
    Number.isFinite(expectedRevision) &&
    Number.isFinite(actualRevision) &&
    actualRevision !== expectedRevision
  ) {
    throw new CliError("Delete read confirmation is stale; re-read document with armDelete=true", {
      code: "DELETE_READ_TOKEN_STALE",
      id: args.id,
      expectedRevision,
      actualRevision,
    });
  }

  const deleted = await ctx.client.call("documents.delete", { id: args.id }, { maxAttempts });
  if (deleted.body?.success !== false) {
    await consumeDocumentDeleteReadReceipt(args.readToken);
  }

  return {
    tool: "documents.delete",
    profile: ctx.profile.id,
    result: {
      ok: true,
      deleted: true,
      id: args.id,
      success: deleted.body?.success !== false,
      expectedRevision: Number.isFinite(expectedRevision) ? expectedRevision : undefined,
      actualRevision: Number.isFinite(actualRevision) ? actualRevision : undefined,
      usedReadToken: true,
    },
  };
}

async function documentsSafeUpdateTool(ctx, args) {
  if (args.expectedRevision === undefined || args.expectedRevision === null) {
    throw new CliError("documents.safe_update requires args.expectedRevision");
  }
  assertPerformAction(args, {
    tool: "documents.safe_update",
    action: "update a document",
  });

  const resolved = await resolveMutationDocumentTarget(ctx, args, "documents.safe_update");
  if (resolved.error || !resolved.id) {
    return {
      tool: "documents.safe_update",
      profile: ctx.profile.id,
      result: {
        ok: false,
        updated: false,
        status: resolved.error?.failed?.status || "not_found",
        id: "",
        resolution: resolved.error,
      },
    };
  }

  const info = await ctx.client.call("documents.info", { id: resolved.id }, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });

  const current = info.body?.data;
  const actualRevision = Number(current?.revision);
  const expected = resolveExpectedRevisionGuard(args, actualRevision, "documents.safe_update");
  const expectedRevision = expected.expectedRevision;

  if (actualRevision !== expectedRevision) {
    return {
      tool: "documents.safe_update",
      profile: ctx.profile.id,
      result: {
        ...buildRevisionConflict({
          id: resolved.id,
          expectedRevision,
          actualRevision,
        }),
        ...(resolved.resolution ? { resolution: resolved.resolution } : {}),
      },
    };
  }

  const updateBody = ensureUpdatePayload({
    ...args,
    id: resolved.id,
  });
  const updated = await ctx.client.call("documents.update", updateBody, {
    maxAttempts: toInteger(args.maxAttempts, 1),
  });

  return {
    tool: "documents.safe_update",
    profile: ctx.profile.id,
    result: {
      ok: true,
      updated: true,
      id: resolved.id,
      ...(resolved.resolution ? { resolution: resolved.resolution } : {}),
      ...(expected.source === "latest" ? { expectedRevision, expectedRevisionSource: "latest" } : {}),
      previousRevision: actualRevision,
      currentRevision: updated.body?.data?.revision,
      data: normalizeDocumentSummary(updated.body?.data, args.view || "summary", toInteger(args.excerptChars, 220)),
    },
  };
}

async function resolveDiffDocument(ctx, args) {
  if (args.id || args.documentId) {
    const id = String(args.id || args.documentId);
    const info = await ctx.client.call("documents.info", { id }, {
      maxAttempts: toInteger(args.maxAttempts, 2),
    });
    return {
      document: info.body?.data || null,
      resolution: {
        mode: "direct",
        id,
        memory: null,
      },
    };
  }

  const refArgs = compactValue({
    refs: args.refs || args.documentRefs || (args.documentRef ? [args.documentRef] : undefined),
    queries: args.queries || args.documentQueries || (args.query ? [args.query] : args.documentQuery ? [args.documentQuery] : undefined),
    shareIds: args.shareIds || (args.shareId ? [args.shareId] : undefined),
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
    collectionId: args.resolveCollectionId,
    view: "full",
    concurrency: args.resolveConcurrency,
    hydrateConcurrency: args.resolveHydrateConcurrency,
    maxAttempts: args.maxAttempts,
  }) || {};

  if (!refArgs.refs && !refArgs.queries && !refArgs.shareIds && !refArgs.urlIds && !refArgs.urls) {
    throw new CliError("documents.diff requires args.id or document refs");
  }

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

async function resolveDocumentIdForRevisionList(ctx, args) {
  if (args.documentId || args.id) {
    const id = String(args.documentId || args.id);
    return {
      documentId: id,
      resolution: {
        mode: "direct",
        id,
        memory: null,
      },
    };
  }

  const refArgs = compactValue({
    refs: args.refs || args.documentRefs || (args.documentRef ? [args.documentRef] : undefined),
    queries: args.queries || args.documentQueries || (args.query ? [args.query] : args.documentQuery ? [args.documentQuery] : undefined),
    shareIds: args.shareIds || (args.shareId ? [args.shareId] : undefined),
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
    collectionId: args.resolveCollectionId,
    view: "summary",
    concurrency: args.resolveConcurrency,
    hydrateConcurrency: args.resolveHydrateConcurrency,
    maxAttempts: args.maxAttempts,
  }) || {};

  if (!refArgs.refs && !refArgs.queries && !refArgs.shareIds && !refArgs.urlIds && !refArgs.urls) {
    throw new CliError("revisions.list requires args.documentId or document refs");
  }

  const opened = await documentsOpenBatchTool(ctx, refArgs);
  const item = (opened.result?.items || []).find((row) => row?.ok && row.document?.id)
    || (opened.result?.items || [])[0]
    || null;
  if (item?.ok && item.document?.id) {
    return {
      documentId: item.document.id,
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
    documentId: "",
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

async function resolveMutationDocumentTarget(ctx, args, toolName) {
  if (args.id || args.documentId) {
    const id = String(args.id || args.documentId);
    return {
      id,
      resolution: null,
    };
  }

  const refArgs = compactValue({
    refs: args.refs || args.documentRefs || (args.documentRef ? [args.documentRef] : undefined),
    queries: args.queries || args.documentQueries || (args.query ? [args.query] : args.documentQuery ? [args.documentQuery] : undefined),
    shareIds: args.shareIds || (args.shareId ? [args.shareId] : undefined),
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
    collectionId: args.resolveCollectionId,
    view: "summary",
    concurrency: args.resolveConcurrency,
    hydrateConcurrency: args.resolveHydrateConcurrency,
    maxAttempts: args.maxAttempts,
  }) || {};

  if (!refArgs.refs && !refArgs.queries && !refArgs.shareIds && !refArgs.urlIds && !refArgs.urls) {
    throw new CliError(`${toolName} requires args.id or document refs`);
  }

  const opened = await documentsOpenBatchTool(ctx, refArgs);
  const item = (opened.result?.items || []).find((row) => row?.ok && row.document?.id)
    || (opened.result?.items || [])[0]
    || null;
  if (item?.ok && item.document?.id) {
    return {
      id: item.document.id,
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
    id: "",
    error: {
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

async function documentsDiffTool(ctx, args) {
  if (typeof args.proposedText !== "string") {
    throw new CliError("documents.diff requires args.proposedText as string");
  }

  const resolved = await resolveDiffDocument(ctx, args);
  const current = resolved.document;
  if (!current) {
    return {
      tool: "documents.diff",
      profile: ctx.profile.id,
      result: {
        ok: false,
        status: "not_found",
        resolution: resolved.resolution,
        stats: { added: 0, removed: 0, unchanged: 0 },
        hunks: [],
        truncated: false,
      },
    };
  }

  const currentText = current?.text || "";
  const diff = computeLineDiff(currentText, args.proposedText);
  const payload = buildDiffPayload(diff, args);

  return {
    tool: "documents.diff",
    profile: ctx.profile.id,
    result: {
      ok: true,
      id: current.id || args.id || args.documentId,
      revision: current?.revision,
      title: current?.title,
      resolution: resolved.resolution,
      stats: payload.stats,
      hunks: payload.hunks,
      truncated: payload.truncated,
    },
  };
}

async function revisionsDiffTool(ctx, args) {
  const maxAttempts = toInteger(args.maxAttempts, 2);
  let documentId = args.id || args.documentId || "";
  let resolution = null;
  let baseRevisionId = args.baseRevisionId || "";
  let targetRevisionId = args.targetRevisionId || "";

  if (!documentId) {
    const resolved = await resolveDocumentIdForRevisionList(ctx, args);
    documentId = resolved.documentId;
    resolution = resolved.resolution;
    if (!documentId) {
      return {
        tool: "revisions.diff",
        profile: ctx.profile.id,
        result: {
          ok: false,
          status: "not_found",
          id: "",
          resolution,
          baseRevisionId: "",
          targetRevisionId: "",
          stats: { added: 0, removed: 0, unchanged: 0 },
          hunks: [],
          truncated: false,
        },
      };
    }
  } else {
    resolution = {
      mode: "direct",
      id: documentId,
      memory: null,
    };
  }

  if (!baseRevisionId || !targetRevisionId) {
    const revisionPair = String(args.revisionPair || "latest").trim().toLowerCase();
    if (revisionPair !== "latest") {
      throw new CliError("revisions.diff requires args.baseRevisionId and args.targetRevisionId unless args.revisionPair is latest");
    }
    const listRes = await ctx.client.call(
      "revisions.list",
      compactValue({
        documentId,
        limit: Math.min(20, Math.max(2, toInteger(args.revisionLimit, 2))),
        offset: 0,
        sort: args.sort,
        direction: args.direction,
      }) || { documentId, limit: 2, offset: 0 },
      { maxAttempts }
    );
    const revisions = Array.isArray(listRes.body?.data) ? listRes.body.data : [];
    if (revisions.length < 2) {
      return {
        tool: "revisions.diff",
        profile: ctx.profile.id,
        result: {
          ok: false,
          status: "insufficient_revisions",
          id: documentId,
          resolution,
          revisionCount: revisions.length,
          baseRevisionId: "",
          targetRevisionId: "",
          stats: { added: 0, removed: 0, unchanged: 0 },
          hunks: [],
          truncated: false,
        },
      };
    }
    targetRevisionId = String(revisions[0]?.id || "");
    baseRevisionId = String(revisions[1]?.id || "");
    if (!baseRevisionId || !targetRevisionId) {
      throw new CliError("revisions.diff could not derive latest revision IDs from revisions.list");
    }
  }

  const [baseRes, targetRes] = await Promise.all([
    ctx.client.call("revisions.info", { id: baseRevisionId }, { maxAttempts }),
    ctx.client.call("revisions.info", { id: targetRevisionId }, { maxAttempts }),
  ]);

  const baseRevision = baseRes.body?.data;
  const targetRevision = targetRes.body?.data;

  if (!baseRevision || typeof baseRevision !== "object") {
    throw new CliError("revisions.diff could not hydrate baseRevisionId via revisions.info");
  }
  if (!targetRevision || typeof targetRevision !== "object") {
    throw new CliError("revisions.diff could not hydrate targetRevisionId via revisions.info");
  }

  const baseDocumentId = resolveRevisionDocumentId(baseRevision);
  const targetDocumentId = resolveRevisionDocumentId(targetRevision);
  if (baseDocumentId && baseDocumentId !== documentId) {
    throw new CliError("revisions.diff base revision does not belong to args.id", {
      code: "REVISION_DOCUMENT_MISMATCH",
      id: documentId,
      baseRevisionId,
      revisionDocumentId: baseDocumentId,
    });
  }
  if (targetDocumentId && targetDocumentId !== documentId) {
    throw new CliError("revisions.diff target revision does not belong to args.id", {
      code: "REVISION_DOCUMENT_MISMATCH",
      id: documentId,
      targetRevisionId,
      revisionDocumentId: targetDocumentId,
    });
  }

  const diff = computeLineDiff(resolveRevisionText(baseRevision), resolveRevisionText(targetRevision));
  const payload = buildDiffPayload(diff, args);
  const view = args.view === "full" ? "full" : "summary";

  return {
    tool: "revisions.diff",
    profile: ctx.profile.id,
    result: {
      ok: true,
      id: documentId,
      resolution,
      revisionPair: !args.baseRevisionId || !args.targetRevisionId ? "latest" : "explicit",
      baseRevisionId,
      targetRevisionId,
      baseRevision: normalizeRevisionDiffMeta(baseRevision, view),
      targetRevision: normalizeRevisionDiffMeta(targetRevision, view),
      stats: payload.stats,
      hunks: payload.hunks,
      truncated: payload.truncated,
    },
  };
}

async function documentsApplyPatchTool(ctx, args, options = {}) {
  const toolName = options.toolName || "documents.apply_patch";
  const requireExpectedRevision = options.requireExpectedRevision === true;

  if (typeof args.patch !== "string") {
    throw new CliError(`${toolName} requires args.patch as string`);
  }
  assertPerformAction(args, {
    tool: toolName,
    action: "apply a document patch",
  });

  const mode = args.mode === "replace" ? "replace" : "unified";
  const hasExpectedRevision = Object.prototype.hasOwnProperty.call(args, "expectedRevision");
  if (requireExpectedRevision && !hasExpectedRevision) {
    throw new CliError(`${toolName} requires args.expectedRevision`);
  }

  const resolved = await resolveMutationDocumentTarget(ctx, args, toolName);
  if (resolved.error || !resolved.id) {
    return {
      tool: toolName,
      profile: ctx.profile.id,
      result: {
        ok: false,
        updated: false,
        status: resolved.error?.failed?.status || "not_found",
        id: "",
        resolution: resolved.error,
      },
    };
  }

  const info = await ctx.client.call("documents.info", { id: resolved.id }, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });

  const current = info.body?.data;
  const currentText = current?.text || "";
  const previousRevision = Number(current?.revision);
  const expected = hasExpectedRevision
    ? resolveExpectedRevisionGuard(args, previousRevision, toolName)
    : { expectedRevision: undefined, source: "none" };
  const expectedRevision = expected.expectedRevision;

  const actualRevision = Number.isFinite(previousRevision) ? previousRevision : undefined;
  if (hasExpectedRevision && actualRevision !== expectedRevision) {
    return {
      tool: toolName,
      profile: ctx.profile.id,
      result: {
        ...buildRevisionConflict({
          id: resolved.id,
          expectedRevision,
          actualRevision,
        }),
        ...(resolved.resolution ? { resolution: resolved.resolution } : {}),
        mode,
        previousRevision: actualRevision,
      },
    };
  }

  let nextText = args.patch;
  if (mode === "unified") {
    const applied = applyUnifiedPatch(currentText, args.patch);
    if (!applied.ok) {
      return {
        tool: toolName,
        profile: ctx.profile.id,
        result: {
          ok: false,
          updated: false,
          id: resolved.id,
          ...(resolved.resolution ? { resolution: resolved.resolution } : {}),
          mode,
          previousRevision,
          error: applied.error,
        },
      };
    }
    nextText = applied.text;
  }

  const updateBody = ensureUpdatePayload({
    ...args,
    id: resolved.id,
    text: nextText,
    editMode: "replace",
  });

  const updated = await ctx.client.call("documents.update", updateBody, {
    maxAttempts: toInteger(args.maxAttempts, 1),
  });

  return {
    tool: toolName,
    profile: ctx.profile.id,
    result: {
      ok: true,
      updated: true,
      id: resolved.id,
      ...(resolved.resolution ? { resolution: resolved.resolution } : {}),
      ...(expected.source === "latest" ? { expectedRevision, expectedRevisionSource: "latest" } : {}),
      mode,
      previousRevision,
      currentRevision: updated.body?.data?.revision,
      data: normalizeDocumentSummary(updated.body?.data, args.view || "summary", toInteger(args.excerptChars, 220)),
    },
  };
}

async function documentsApplyPatchSafeTool(ctx, args) {
  return documentsApplyPatchTool(ctx, args, {
    toolName: "documents.apply_patch_safe",
    requireExpectedRevision: true,
  });
}

async function documentsBatchUpdateTool(ctx, args) {
  const updates = Array.isArray(args.updates) ? args.updates : null;
  if (!updates || updates.length === 0) {
    throw new CliError("documents.batch_update requires args.updates[]");
  }
  assertPerformAction(args, {
    tool: "documents.batch_update",
    action: "perform batch document updates",
  });

  const continueOnError = args.continueOnError !== false;
  const concurrency = continueOnError ? toInteger(args.concurrency, 4) : 1;
  const maxAttempts = toInteger(args.maxAttempts, 1);

  const items = [];

  const runner = async (update, index) => {
    try {
      if (!update || typeof update !== "object") {
        throw new CliError(`updates[${index}] must be an object`);
      }

      const hasExpectedRevision = Object.prototype.hasOwnProperty.call(update, "expectedRevision");
      const hasExactId = Boolean(update.id || update.documentId);
      if (hasExpectedRevision || !hasExactId) {
        const safe = await documentsSafeUpdateTool(ctx, {
          ...update,
          performAction: true,
          maxAttempts,
          view: "summary",
        });
        return {
          index,
          id: safe.result?.id || update.id || update.documentId,
          ok: safe.result?.ok === true,
          result: safe.result,
        };
      }

      const body = ensureUpdatePayload({
        ...update,
        id: update.id || update.documentId,
      });

      const updated = await ctx.client.call("documents.update", body, { maxAttempts });
      return {
        index,
        id: body.id,
        ok: true,
        result: {
          ok: true,
          updated: true,
          id: body.id,
          revision: updated.body?.data?.revision,
          data: normalizeDocumentSummary(updated.body?.data, update.view || "summary"),
        },
      };
    } catch (err) {
      if (err instanceof ApiError || err instanceof CliError) {
        return {
          index,
          id: update?.id || update?.documentId,
          ok: false,
          result: {
            ok: false,
            updated: false,
            id: update?.id || update?.documentId,
            error: {
              code: err instanceof ApiError ? "api_error" : "invalid_input",
              message: err.message,
              ...(err.details || {}),
            },
          },
        };
      }
      throw err;
    }
  };

  if (!continueOnError) {
    for (let i = 0; i < updates.length; i += 1) {
      const item = await runner(updates[i], i);
      items.push(item);
      if (!item.ok) {
        break;
      }
    }
  } else {
    const out = await mapLimit(updates, concurrency, runner);
    items.push(...out);
  }

  const failed = items.filter((item) => !item.ok).length;

  return {
    tool: "documents.batch_update",
    profile: ctx.profile.id,
    result: {
      ok: failed === 0,
      total: items.length,
      succeeded: items.length - failed,
      failed,
      continueOnError,
      items,
    },
  };
}

function normalizeRevisionRow(row, view = "summary") {
  if (view === "full") {
    return row;
  }

  return {
    id: row.id,
    documentId: row.documentId,
    title: row.title,
    createdAt: row.createdAt,
    createdBy: row.createdBy
      ? {
          id: row.createdBy.id,
          name: row.createdBy.name,
        }
      : undefined,
  };
}

async function revisionsListTool(ctx, args) {
  const resolved = await resolveDocumentIdForRevisionList(ctx, args);
  if (!resolved.documentId) {
    return {
      tool: "revisions.list",
      profile: ctx.profile.id,
      result: {
        ok: false,
        status: "not_found",
        documentId: "",
        resolution: resolved.resolution,
        data: [],
        revisionCount: 0,
      },
    };
  }

  const body = compactValue({
    documentId: resolved.documentId,
    limit: toInteger(args.limit, 20),
    offset: toInteger(args.offset, 0),
    sort: args.sort,
    direction: args.direction,
  }) || {};

  const res = await ctx.client.call("revisions.list", body, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });

  const view = args.view || "summary";
  const rows = Array.isArray(res.body?.data) ? res.body.data.map((row) => normalizeRevisionRow(row, view)) : [];

  const payload = {
    ...res.body,
    documentId: resolved.documentId,
    resolution: resolved.resolution,
    data: rows,
    revisionCount: rows.length,
  };

  return {
    tool: "revisions.list",
    profile: ctx.profile.id,
    result: payload,
  };
}

async function revisionsRestoreTool(ctx, args) {
  if (!args.id) {
    throw new CliError("revisions.restore requires args.id");
  }
  if (!args.revisionId) {
    throw new CliError("revisions.restore requires args.revisionId");
  }
  assertPerformAction(args, {
    tool: "revisions.restore",
    action: "restore a document revision",
  });

  const body = compactValue({
    id: args.id,
    revisionId: args.revisionId,
    collectionId: args.collectionId,
  }) || {};

  const res = await ctx.client.call("documents.restore", body, {
    maxAttempts: toInteger(args.maxAttempts, 1),
  });

  return {
    tool: "revisions.restore",
    profile: ctx.profile.id,
    result: {
      ok: true,
      id: args.id,
      revisionId: args.revisionId,
      data: normalizeDocumentSummary(res.body?.data, args.view || "summary", toInteger(args.excerptChars, 220)),
    },
  };
}

export const MUTATION_TOOLS = {
  "documents.safe_update": {
    signature:
      "documents.safe_update(args: { id?: string; documentId?: string; query?: string; refs?: string[]; shareId?: string; urlId?: string; url?: string; expectedRevision: number|'latest'; title?: string; text?: string; editMode?: 'replace'|'append'|'prepend'; icon?: string; color?: string; fullWidth?: boolean; templateId?: string; collectionId?: string; insightsEnabled?: boolean; publish?: boolean; dataAttributes?: any[]; view?: 'summary'|'full'; performAction?: boolean })",
    description: "Update document only if current revision matches expectedRevision.",
    usageExample: {
      tool: "documents.safe_update",
      args: {
        query: "incident runbook",
        expectedRevision: "latest",
        text: "\n\n## Changes\n- added new action",
        editMode: "append",
      },
    },
    bestPractices: [
      "Pass id/documentId for exact targets, or query/refs/url when you only have a remembered title or pasted Outline URL.",
      "Pass expectedRevision='latest' only when the requested edit should apply to the current revision read inside this tool call.",
      "Pass a numeric revision from a prior read when coordinating an externally reviewed edit.",
      "Handle revision_conflict deterministically and re-read before retry.",
      "Use append/prepend for low-token incremental writes.",
      "This tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: documentsSafeUpdateTool,
  },
  "documents.diff": {
    signature:
      "documents.diff(args: { id?: string; documentId?: string; refs?: string[]; query?: string; queries?: string[]; shareId?: string; shareIds?: string[]; urlId?: string; urlIds?: string[]; url?: string; urls?: string[]; proposedText: string; includeFullHunks?: boolean; hunkLimit?: number; hunkLineLimit?: number })",
    description: "Resolve a document and compute a line-level diff between current document text and proposed text.",
    usageExample: {
      tool: "documents.diff",
      args: {
        query: "incident runbook",
        proposedText: "# Title\n\nUpdated body",
      },
    },
    bestPractices: [
      "Pass id/documentId for exact targets, or query/refs/url when you only have a remembered title or pasted Outline URL.",
      "Run diff before patch/apply to reduce accidental destructive edits.",
      "Use strict=true defaults for remembered titles so weak fuzzy matches return a structured miss instead of guessing.",
      "Use preview hunks first; request full hunks only when needed.",
      "Track added/removed counts to detect large unintended changes.",
    ],
    handler: documentsDiffTool,
  },
  "documents.apply_patch": {
    signature:
      "documents.apply_patch(args: { id?: string; documentId?: string; query?: string; refs?: string[]; shareId?: string; urlId?: string; url?: string; patch: string; mode?: 'unified'|'replace'; expectedRevision?: number|'latest'; title?: string; view?: 'summary'|'full'; performAction?: boolean })",
    description: "Apply unified diff patch (or full replace) to a document and persist update.",
    usageExample: {
      tool: "documents.apply_patch",
      args: {
        query: "incident runbook",
        expectedRevision: 7,
        mode: "unified",
        patch: "@@ -1,1 +1,1 @@\n-Old\n+New",
      },
    },
    bestPractices: [
      "Pass id/documentId for exact targets, or query/refs/url when you only have a remembered title or pasted Outline URL.",
      "Prefer unified mode for minimal, auditable text changes.",
      "Pass expectedRevision='latest' only when the patch should apply to the current revision read inside this tool call; pass a number for externally reviewed edits.",
      "On patch_apply_failed, re-read latest text and regenerate patch.",
      "Use replace mode only for full-document rewrites.",
      "This tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: documentsApplyPatchTool,
  },
  "documents.apply_patch_safe": {
    signature:
      "documents.apply_patch_safe(args: { id?: string; documentId?: string; query?: string; refs?: string[]; shareId?: string; urlId?: string; url?: string; expectedRevision: number|'latest'; patch: string; mode?: 'unified'|'replace'; title?: string; view?: 'summary'|'full'; performAction?: boolean })",
    description:
      "Apply patch with mandatory revision guard so writes only proceed from the expected document revision.",
    usageExample: {
      tool: "documents.apply_patch_safe",
      args: {
        query: "incident runbook",
        expectedRevision: "latest",
        mode: "unified",
        patch: "@@ -1,1 +1,1 @@\n-Old\n+New",
      },
    },
    bestPractices: [
      "Pass id/documentId for exact targets, or query/refs/url when you only have a remembered title or pasted Outline URL.",
      "Use this wrapper for all automated patch writes to enforce optimistic concurrency.",
      "Pass expectedRevision='latest' only when the patch should apply to the current revision read inside this tool call; pass a number for externally reviewed edits.",
      "Re-read the document and regenerate patch when revision_conflict is returned.",
      "Keep unified mode for minimal, auditable edits; use replace mode for full rewrites only.",
      "This tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: documentsApplyPatchSafeTool,
  },
  "documents.batch_update": {
    signature:
      "documents.batch_update(args: { updates: Array<{ id?: string; documentId?: string; query?: string; refs?: string[]; url?: string; expectedRevision?: number|'latest'; title?: string; text?: string; editMode?: 'replace'|'append'|'prepend' }>; concurrency?: number; continueOnError?: boolean; performAction?: boolean })",
    description: "Run multiple document updates in one call with per-item results.",
    usageExample: {
      tool: "documents.batch_update",
      args: {
        updates: [
          { query: "incident runbook", expectedRevision: "latest", text: "\n\nupdate one", editMode: "append" },
          { id: "doc-2", title: "Renamed" },
        ],
        concurrency: 2,
        continueOnError: true,
      },
    },
    bestPractices: [
      "Use query/refs/url per item when batching named documents; fuzzy targets require expectedRevision.",
      "Use expectedRevision='latest' only when each edit should apply to the current revision read inside that item.",
      "Use numeric expectedRevision per update for externally reviewed multi-agent safety.",
      "Set continueOnError=false for transactional-style stop-on-first-failure flows.",
      "Use per-item results to retry only failed updates.",
      "This tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: documentsBatchUpdateTool,
  },
  "documents.delete": {
    signature:
      "documents.delete(args: { id: string; readToken: string; performAction?: boolean; maxAttempts?: number })",
    description:
      "Delete a document with mandatory read-confirmation token and action gate.",
    usageExample: {
      tool: "documents.delete",
      args: {
        id: "doc-id",
        readToken: "<token from documents.info armDelete=true>",
        performAction: true,
      },
    },
    bestPractices: [
      "Always read with documents.info armDelete=true immediately before delete.",
      "Delete tokens are profile-bound and revision-sensitive; re-read on stale token errors.",
      "Keep performAction=false by default in automation and set true only for the final confirmed call.",
    ],
    handler: documentsDeleteTool,
  },
  "documents.plan_batch_update": {
    signature:
      "documents.plan_batch_update(args: { id?: string; ids?: string[]; query?: string; queries?: string[]; collectionId?: string; rules?: Array<{ field?: 'title'|'text'|'both'; find: string; replace?: string; caseSensitive?: boolean; wholeWord?: boolean; all?: boolean }>; includeTitleSearch?: boolean; includeSemanticSearch?: boolean; limitPerQuery?: number; offset?: number; maxDocuments?: number; readConcurrency?: number; includeUnchanged?: boolean; hunkLimit?: number; hunkLineLimit?: number; maxAttempts?: number; })",
    description:
      "Plan multi-document refactors/renames by previewing affected docs, replacement counts, and text hunks before applying.",
    usageExample: {
      tool: "documents.plan_batch_update",
      args: {
        query: "incident communication",
        rules: [
          {
            field: "both",
            find: "SEV1",
            replace: "SEV-1",
            wholeWord: true,
          },
        ],
        maxDocuments: 20,
      },
    },
    bestPractices: [
      "Review `impacts` with the user before applying changes.",
      "Use precise rules (wholeWord/caseSensitive) to avoid broad unintended edits.",
      "Apply with `documents.apply_batch_plan` using the returned `planHash` for explicit confirmation.",
    ],
    handler: documentsPlanBatchUpdateTool,
  },
  "documents.plan_terminology_refactor": {
    signature:
      "documents.plan_terminology_refactor(args: { glossary?: Array<{ from?: string; to?: string; find?: string; replace?: string; field?: 'title'|'text'|'both'; caseSensitive?: boolean; wholeWord?: boolean; all?: boolean }>; map?: Record<string, string>; glossaryMap?: Record<string, string>; terminologyMap?: Record<string, string>; id?: string; ids?: string[]; query?: string; queries?: string[]; collectionId?: string; includeTitleSearch?: boolean; includeSemanticSearch?: boolean; limitPerQuery?: number; offset?: number; maxDocuments?: number; readConcurrency?: number; includeUnchanged?: boolean; hunkLimit?: number; hunkLineLimit?: number; maxAttempts?: number })",
    description:
      "Plan terminology refactors using glossary/map inputs and return plan_batch_update-compatible output with metadata.",
    usageExample: {
      tool: "documents.plan_terminology_refactor",
      args: {
        queries: ["incident response", "escalation policy"],
        glossary: [
          { from: "SEV1", to: "SEV-1", field: "both", wholeWord: true },
          { from: "on call", to: "on-call", field: "text" },
        ],
        maxDocuments: 25,
      },
    },
    bestPractices: [
      "Use glossary[] when each mapping needs its own field/casing controls.",
      "Use map for fast one-to-one terminology upgrades across both title and text.",
      "Review returned impacts/planHash before applying with documents.apply_batch_plan.",
    ],
    handler: documentsPlanTerminologyRefactorTool,
  },
  "documents.apply_batch_plan": {
    signature:
      "documents.apply_batch_plan(args: { plan: object; confirmHash: string; dryRun?: boolean; continueOnError?: boolean; concurrency?: number; view?: 'summary'|'full'; maxAttempts?: number; performAction?: boolean; })",
    description:
      "Apply a previously generated batch-update plan with hash confirmation and revision-safe updates.",
    usageExample: {
      tool: "documents.apply_batch_plan",
      args: {
        confirmHash: "sha256-hash-from-plan",
        plan: {
          version: 1,
          items: [
            {
              id: "doc-id",
              expectedRevision: 12,
              title: "Renamed title",
            },
          ],
        },
      },
    },
    bestPractices: [
      "Require explicit user confirmation of `planHash` before execution.",
      "Keep `dryRun=true` for one final verification step in automation loops.",
      "Treat `revision_conflict` results as a re-plan signal, not an auto-retry.",
      "When dryRun=false this tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: documentsApplyBatchPlanTool,
  },
  "revisions.list": {
    signature:
      "revisions.list(args: { documentId?: string; id?: string; refs?: string[]; query?: string; queries?: string[]; shareId?: string; shareIds?: string[]; urlId?: string; urlIds?: string[]; url?: string; urls?: string[]; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'summary'|'full' })",
    description: "Resolve a document and list its revisions.",
    usageExample: {
      tool: "revisions.list",
      args: {
        query: "incident runbook",
        limit: 10,
        view: "summary",
      },
    },
    bestPractices: [
      "Pass documentId/id for exact targets, or query/refs/url when you only have a remembered title or pasted Outline URL.",
      "Use small limits and paginate for long histories.",
      "Capture revision IDs before performing restore operations.",
      "Use summary view for fast planning loops.",
    ],
    handler: revisionsListTool,
  },
  "revisions.diff": {
    signature:
      "revisions.diff(args: { id?: string; documentId?: string; refs?: string[]; query?: string; queries?: string[]; shareId?: string; shareIds?: string[]; urlId?: string; urlIds?: string[]; url?: string; urls?: string[]; baseRevisionId?: string; targetRevisionId?: string; revisionPair?: 'latest'; revisionLimit?: number; includeFullHunks?: boolean; hunkLimit?: number; hunkLineLimit?: number; view?: 'summary'|'full'; maxAttempts?: number })",
    description: "Resolve a document and compute a line-level diff between explicit revision IDs or the latest two revisions.",
    usageExample: {
      tool: "revisions.diff",
      args: {
        query: "incident runbook",
        revisionPair: "latest",
        view: "summary",
      },
    },
    bestPractices: [
      "Pass query/refs/url for one-call latest revision diffs when the exact document ID is unknown.",
      "Pass explicit baseRevisionId and targetRevisionId when comparing non-adjacent revisions.",
      "Pass adjacent revisions first to isolate rollback root causes.",
      "Use preview hunks first; set includeFullHunks=true only when needed.",
      "Verify revision metadata before applying restore or patch actions.",
    ],
    handler: revisionsDiffTool,
  },
  "revisions.restore": {
    signature:
      "revisions.restore(args: { id: string; revisionId: string; collectionId?: string; view?: 'summary'|'full'; performAction?: boolean })",
    description: "Restore a document to a specific revision using documents.restore endpoint.",
    usageExample: {
      tool: "revisions.restore",
      args: {
        id: "doc-id",
        revisionId: "revision-id",
      },
    },
    bestPractices: [
      "List revisions first and confirm target revision id.",
      "Use on test/sandbox docs before applying to important docs.",
      "Capture post-restore revision for subsequent safe updates.",
      "This tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: revisionsRestoreTool,
  },
};
