import { createHash } from "node:crypto";
import { ApiError, CliError } from "./errors.js";
import {
  assertPerformAction,
  consumeDocumentDeleteReadReceipt,
  getDocumentDeleteReadReceipt,
} from "./action-gate.js";
import { compactValue, mapLimit, toInteger } from "./utils.js";

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
    summary.excerpt = doc.text.length > excerptChars ? `${doc.text.slice(0, excerptChars)}...` : doc.text;
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
  if (!args.id) {
    throw new CliError("documents.safe_update requires args.id");
  }
  if (args.expectedRevision === undefined || args.expectedRevision === null) {
    throw new CliError("documents.safe_update requires args.expectedRevision");
  }
  assertPerformAction(args, {
    tool: "documents.safe_update",
    action: "update a document",
  });

  const expectedRevision = Number(args.expectedRevision);
  if (!Number.isFinite(expectedRevision)) {
    throw new CliError("expectedRevision must be a number");
  }

  const info = await ctx.client.call("documents.info", { id: args.id }, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });

  const current = info.body?.data;
  const actualRevision = Number(current?.revision);

  if (actualRevision !== expectedRevision) {
    return {
      tool: "documents.safe_update",
      profile: ctx.profile.id,
      result: buildRevisionConflict({
        id: args.id,
        expectedRevision,
        actualRevision,
      }),
    };
  }

  const updateBody = ensureUpdatePayload(args);
  const updated = await ctx.client.call("documents.update", updateBody, {
    maxAttempts: toInteger(args.maxAttempts, 1),
  });

  return {
    tool: "documents.safe_update",
    profile: ctx.profile.id,
    result: {
      ok: true,
      updated: true,
      id: args.id,
      previousRevision: actualRevision,
      currentRevision: updated.body?.data?.revision,
      data: normalizeDocumentSummary(updated.body?.data, args.view || "summary", toInteger(args.excerptChars, 220)),
    },
  };
}

async function documentsDiffTool(ctx, args) {
  if (!args.id) {
    throw new CliError("documents.diff requires args.id");
  }
  if (typeof args.proposedText !== "string") {
    throw new CliError("documents.diff requires args.proposedText as string");
  }

  const info = await ctx.client.call("documents.info", { id: args.id }, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });

  const current = info.body?.data;
  const currentText = current?.text || "";
  const diff = computeLineDiff(currentText, args.proposedText);
  const includeFullHunks = !!args.includeFullHunks;

  return {
    tool: "documents.diff",
    profile: ctx.profile.id,
    result: {
      ok: true,
      id: args.id,
      revision: current?.revision,
      title: current?.title,
      stats: diff.stats,
      hunks: includeFullHunks ? diff.hunks : previewHunks(diff.hunks, toInteger(args.hunkLimit, 8), toInteger(args.hunkLineLimit, 12)),
      truncated: !includeFullHunks,
    },
  };
}

async function documentsApplyPatchTool(ctx, args) {
  if (!args.id) {
    throw new CliError("documents.apply_patch requires args.id");
  }
  if (typeof args.patch !== "string") {
    throw new CliError("documents.apply_patch requires args.patch as string");
  }
  assertPerformAction(args, {
    tool: "documents.apply_patch",
    action: "apply a document patch",
  });

  const mode = args.mode === "replace" ? "replace" : "unified";

  const info = await ctx.client.call("documents.info", { id: args.id }, {
    maxAttempts: toInteger(args.maxAttempts, 2),
  });

  const current = info.body?.data;
  const currentText = current?.text || "";
  const previousRevision = Number(current?.revision);

  let nextText = args.patch;
  if (mode === "unified") {
    const applied = applyUnifiedPatch(currentText, args.patch);
    if (!applied.ok) {
      return {
        tool: "documents.apply_patch",
        profile: ctx.profile.id,
        result: {
          ok: false,
          updated: false,
          id: args.id,
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
    id: args.id,
    text: nextText,
    editMode: "replace",
  });

  const updated = await ctx.client.call("documents.update", updateBody, {
    maxAttempts: toInteger(args.maxAttempts, 1),
  });

  return {
    tool: "documents.apply_patch",
    profile: ctx.profile.id,
    result: {
      ok: true,
      updated: true,
      id: args.id,
      mode,
      previousRevision,
      currentRevision: updated.body?.data?.revision,
      data: normalizeDocumentSummary(updated.body?.data, args.view || "summary", toInteger(args.excerptChars, 220)),
    },
  };
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
      if (!update || typeof update !== "object" || !update.id) {
        throw new CliError(`updates[${index}] must include id`);
      }

      const body = ensureUpdatePayload(update);

      if (Object.prototype.hasOwnProperty.call(update, "expectedRevision")) {
        const safe = await documentsSafeUpdateTool(ctx, {
          ...update,
          performAction: true,
          maxAttempts,
          view: "summary",
        });
        return {
          index,
          id: update.id,
          ok: safe.result?.ok === true,
          result: safe.result,
        };
      }

      const updated = await ctx.client.call("documents.update", body, { maxAttempts });
      return {
        index,
        id: update.id,
        ok: true,
        result: {
          ok: true,
          updated: true,
          id: update.id,
          revision: updated.body?.data?.revision,
          data: normalizeDocumentSummary(updated.body?.data, update.view || "summary"),
        },
      };
    } catch (err) {
      if (err instanceof ApiError || err instanceof CliError) {
        return {
          index,
          id: update?.id,
          ok: false,
          result: {
            ok: false,
            updated: false,
            id: update?.id,
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
  if (!args.documentId) {
    throw new CliError("revisions.list requires args.documentId");
  }

  const body = compactValue({
    documentId: args.documentId,
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
      "documents.safe_update(args: { id: string; expectedRevision: number; title?: string; text?: string; editMode?: 'replace'|'append'|'prepend'; icon?: string; color?: string; fullWidth?: boolean; templateId?: string; collectionId?: string; insightsEnabled?: boolean; publish?: boolean; dataAttributes?: any[]; view?: 'summary'|'full'; performAction?: boolean })",
    description: "Update document only if current revision matches expectedRevision.",
    usageExample: {
      tool: "documents.safe_update",
      args: {
        id: "doc-id",
        expectedRevision: 3,
        text: "\n\n## Changes\n- added new action",
        editMode: "append",
      },
    },
    bestPractices: [
      "Read document first and pass returned revision as expectedRevision.",
      "Handle revision_conflict deterministically and re-read before retry.",
      "Use append/prepend for low-token incremental writes.",
      "This tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: documentsSafeUpdateTool,
  },
  "documents.diff": {
    signature:
      "documents.diff(args: { id: string; proposedText: string; includeFullHunks?: boolean; hunkLimit?: number; hunkLineLimit?: number })",
    description: "Compute line-level diff between current document text and proposed text.",
    usageExample: {
      tool: "documents.diff",
      args: {
        id: "doc-id",
        proposedText: "# Title\n\nUpdated body",
      },
    },
    bestPractices: [
      "Run diff before patch/apply to reduce accidental destructive edits.",
      "Use preview hunks first; request full hunks only when needed.",
      "Track added/removed counts to detect large unintended changes.",
    ],
    handler: documentsDiffTool,
  },
  "documents.apply_patch": {
    signature:
      "documents.apply_patch(args: { id: string; patch: string; mode?: 'unified'|'replace'; title?: string; view?: 'summary'|'full'; performAction?: boolean })",
    description: "Apply unified diff patch (or full replace) to a document and persist update.",
    usageExample: {
      tool: "documents.apply_patch",
      args: {
        id: "doc-id",
        mode: "unified",
        patch: "@@ -1,1 +1,1 @@\n-Old\n+New",
      },
    },
    bestPractices: [
      "Prefer unified mode for minimal, auditable text changes.",
      "On patch_apply_failed, re-read latest text and regenerate patch.",
      "Use replace mode only for full-document rewrites.",
      "This tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: documentsApplyPatchTool,
  },
  "documents.batch_update": {
    signature:
      "documents.batch_update(args: { updates: Array<{ id: string; expectedRevision?: number; title?: string; text?: string; editMode?: 'replace'|'append'|'prepend' }>; concurrency?: number; continueOnError?: boolean; performAction?: boolean })",
    description: "Run multiple document updates in one call with per-item results.",
    usageExample: {
      tool: "documents.batch_update",
      args: {
        updates: [
          { id: "doc-1", text: "\n\nupdate one", editMode: "append" },
          { id: "doc-2", title: "Renamed" },
        ],
        concurrency: 2,
        continueOnError: true,
      },
    },
    bestPractices: [
      "Use expectedRevision per update for multi-agent safety.",
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
      "revisions.list(args: { documentId: string; limit?: number; offset?: number; sort?: string; direction?: 'ASC'|'DESC'; view?: 'summary'|'full' })",
    description: "List revisions for a document.",
    usageExample: {
      tool: "revisions.list",
      args: {
        documentId: "doc-id",
        limit: 10,
        view: "summary",
      },
    },
    bestPractices: [
      "Use small limits and paginate for long histories.",
      "Capture revision IDs before performing restore operations.",
      "Use summary view for fast planning loops.",
    ],
    handler: revisionsListTool,
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
