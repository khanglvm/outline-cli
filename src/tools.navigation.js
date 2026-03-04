import { CliError } from "./errors.js";
import { compactValue, ensureStringArray, mapLimit, toInteger } from "./utils.js";

function normalizeDocumentRow(row, view = "summary", excerptChars = 220) {
  if (!row) {
    return null;
  }

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

function normalizeSearchHit(hit, view = "summary", contextChars = 220) {
  const doc = hit?.document || hit;
  if (!doc) {
    return null;
  }

  if (view === "full") {
    return hit;
  }

  const context = typeof hit?.context === "string" ? hit.context : "";
  const summary = {
    id: doc.id,
    title: doc.title,
    collectionId: doc.collectionId,
    parentDocumentId: doc.parentDocumentId,
    updatedAt: doc.updatedAt,
    publishedAt: doc.publishedAt,
    urlId: doc.urlId,
    ranking: Number.isFinite(Number(hit?.ranking)) ? Number(hit.ranking) : undefined,
    context: context ? (context.length > contextChars ? `${context.slice(0, contextChars)}...` : context) : undefined,
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

function normalizeRanking(ranking) {
  const val = Number(ranking);
  if (!Number.isFinite(val)) {
    return 0;
  }
  if (val < 0) {
    return 0;
  }
  if (val <= 1) {
    return val;
  }
  return Math.min(1, val / 10);
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

const QUERY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "their",
  "this",
  "to",
  "we",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "you",
]);

function normalizeSearchRanking(value) {
  const ranking = Number(value);
  if (!Number.isFinite(ranking)) {
    return 0;
  }
  if (ranking < 0) {
    return 0;
  }
  if (ranking <= 1) {
    return ranking;
  }
  return Math.min(1, ranking / 10);
}

function buildResearchQueries(args) {
  const out = [];
  const add = (value) => {
    const trimmed = String(value || "").trim();
    if (!trimmed) {
      return;
    }
    if (!out.includes(trimmed)) {
      out.push(trimmed);
    }
  };

  const queries = ensureStringArray(args.queries, "queries") || [];
  for (const query of queries) {
    add(query);
  }
  add(args.query);
  add(args.question);

  if (out.length === 0) {
    throw new CliError("search.research requires args.question, args.query, or args.queries[]");
  }

  return out;
}

function tokenFrequency(values, existingTerms = new Set()) {
  const counts = new Map();
  for (const value of values) {
    for (const token of tokenize(value)) {
      if (token.length < 4 || QUERY_STOP_WORDS.has(token) || existingTerms.has(token)) {
        continue;
      }
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => {
      if (b[1] !== a[1]) {
        return b[1] - a[1];
      }
      return a[0].localeCompare(b[0]);
    })
    .map(([token]) => token);
}

function buildFollowUpQueries(merged, queries, limit = 6) {
  const existingTerms = new Set();
  for (const query of queries) {
    for (const token of tokenize(query)) {
      existingTerms.add(token);
    }
  }

  const top = merged.slice(0, 20);
  const tokens = tokenFrequency(
    top.flatMap((row) => [row.title, ...(row.evidence || []).map((ev) => ev.context)]),
    existingTerms
  );

  return tokens.slice(0, limit);
}

function shapeResearchMergedRow(row, view, excerptChars) {
  if (view === "full") {
    return row;
  }

  const summary = {
    id: row.id,
    title: row.title,
    score: row.score,
    queryMatches: row.queryMatches,
    sources: row.sources,
    ranking: row.ranking,
    collectionId: row.collectionId,
    parentDocumentId: row.parentDocumentId,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    urlId: row.urlId,
    evidenceCount: Array.isArray(row.evidence) ? row.evidence.length : 0,
  };

  if (view === "ids") {
    return {
      id: summary.id,
      title: summary.title,
      score: summary.score,
      queryMatches: summary.queryMatches,
    };
  }

  if (row.text) {
    summary.excerpt = row.text.length > excerptChars ? `${row.text.slice(0, excerptChars)}...` : row.text;
  }

  if (Array.isArray(row.evidence)) {
    summary.evidence = row.evidence.slice(0, 5);
  }

  return summary;
}

function normalizeResearchTitleHit(query, row, contextChars) {
  if (!row?.id) {
    return null;
  }

  const confidence = computeConfidence({
    query,
    title: row.title,
    source: "titles",
  });

  return {
    id: row.id,
    title: row.title,
    collectionId: row.collectionId,
    parentDocumentId: row.parentDocumentId,
    updatedAt: row.updatedAt,
    publishedAt: row.publishedAt,
    urlId: row.urlId,
    text: row.text,
    ranking: undefined,
    scoreContribution: confidence,
    source: "titles",
    query,
    context: undefined,
  };
}

function normalizeResearchSemanticHit(query, row, contextChars) {
  const doc = row?.document;
  if (!doc?.id) {
    return null;
  }

  const confidence = computeConfidence({
    query,
    title: doc.title,
    source: "semantic",
    ranking: row.ranking,
  });
  const context = typeof row.context === "string" ? row.context : "";

  return {
    id: doc.id,
    title: doc.title,
    collectionId: doc.collectionId,
    parentDocumentId: doc.parentDocumentId,
    updatedAt: doc.updatedAt,
    publishedAt: doc.publishedAt,
    urlId: doc.urlId,
    text: doc.text,
    ranking: Number.isFinite(Number(row.ranking)) ? Number(row.ranking) : undefined,
    scoreContribution: confidence,
    source: "semantic",
    query,
    context: context ? (context.length > contextChars ? `${context.slice(0, contextChars)}...` : context) : undefined,
  };
}

function mergeResearchHits(rawHits, seenIds = []) {
  const seenSet = new Set((seenIds || []).map((id) => String(id)));
  const mergedMap = new Map();
  let skippedSeen = 0;

  for (const hit of rawHits) {
    if (!hit?.id) {
      continue;
    }
    if (seenSet.has(hit.id)) {
      skippedSeen += 1;
      continue;
    }

    const existing = mergedMap.get(hit.id);
    const evidenceRow = {
      query: hit.query,
      source: hit.source,
      ranking: hit.ranking,
      scoreContribution: hit.scoreContribution,
      context: hit.context,
    };

    if (!existing) {
      mergedMap.set(hit.id, {
        id: hit.id,
        title: hit.title,
        collectionId: hit.collectionId,
        parentDocumentId: hit.parentDocumentId,
        updatedAt: hit.updatedAt,
        publishedAt: hit.publishedAt,
        urlId: hit.urlId,
        text: hit.text,
        ranking: hit.ranking,
        score: Number(hit.scoreContribution || 0),
        queryMatches: 1,
        sources: [hit.source],
        queries: [hit.query],
        evidence: [evidenceRow],
      });
      continue;
    }

    if (!existing.sources.includes(hit.source)) {
      existing.sources.push(hit.source);
    }
    if (!existing.queries.includes(hit.query)) {
      existing.queries.push(hit.query);
      existing.queryMatches += 1;
    }
    existing.score = Math.max(existing.score, Number(hit.scoreContribution || 0));
    existing.evidence.push(evidenceRow);
    if (existing.ranking === undefined && hit.ranking !== undefined) {
      existing.ranking = hit.ranking;
    }
    if (!existing.text && hit.text) {
      existing.text = hit.text;
    }
    if (!existing.updatedAt && hit.updatedAt) {
      existing.updatedAt = hit.updatedAt;
    }
  }

  const merged = Array.from(mergedMap.values()).map((row) => {
    const rankingSignal = normalizeSearchRanking(row.ranking);
    const queryBonus = Math.min(0.24, Math.max(0, row.queryMatches - 1) * 0.08);
    const sourceBonus = row.sources.length > 1 ? 0.06 : 0;
    const finalScore = Math.max(0, Math.min(1.5, row.score + rankingSignal * 0.2 + queryBonus + sourceBonus));
    return {
      ...row,
      score: Number(finalScore.toFixed(4)),
    };
  });

  merged.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    if (b.queryMatches !== a.queryMatches) {
      return b.queryMatches - a.queryMatches;
    }
    const ar = Number(a.ranking || 0);
    const br = Number(b.ranking || 0);
    if (br !== ar) {
      return br - ar;
    }
    const aTs = Number.isFinite(Date.parse(a.updatedAt || "")) ? Date.parse(a.updatedAt) : 0;
    const bTs = Number.isFinite(Date.parse(b.updatedAt || "")) ? Date.parse(b.updatedAt) : 0;
    if (bTs !== aTs) {
      return bTs - aTs;
    }
    return String(a.title || "").localeCompare(String(b.title || ""));
  });

  return { merged, skippedSeen };
}

async function researchSingleQuery(ctx, query, args, maxAttempts, contextChars) {
  const includeTitleSearch = args.includeTitleSearch !== false;
  const includeSemanticSearch = args.includeSemanticSearch !== false;
  const limitPerQuery = Math.max(1, toInteger(args.limitPerQuery, 8));
  const offset = Math.max(0, toInteger(args.offset, 0));

  const baseBody = compactValue({
    query,
    collectionId: args.collectionId,
    limit: limitPerQuery,
    offset,
  }) || {};

  const tasks = [];
  if (includeTitleSearch) {
    tasks.push(
      ctx.client.call("documents.search_titles", baseBody, { maxAttempts }).then((res) => ({
        source: "titles",
        rows: Array.isArray(res.body?.data) ? res.body.data : [],
      }))
    );
  }
  if (includeSemanticSearch) {
    tasks.push(
      ctx.client
        .call(
          "documents.search",
          {
            ...baseBody,
            snippetMinWords: toInteger(args.snippetMinWords, 16),
            snippetMaxWords: toInteger(args.snippetMaxWords, 24),
          },
          { maxAttempts }
        )
        .then((res) => ({
          source: "semantic",
          rows: Array.isArray(res.body?.data) ? res.body.data : [],
        }))
    );
  }

  const settled = await Promise.all(tasks);
  const titleRows = settled.find((item) => item.source === "titles")?.rows || [];
  const semanticRows = settled.find((item) => item.source === "semantic")?.rows || [];

  const normalizedTitleHits = titleRows
    .map((row) => normalizeResearchTitleHit(query, row, contextChars))
    .filter(Boolean);
  const normalizedSemanticHits = semanticRows
    .map((row) => normalizeResearchSemanticHit(query, row, contextChars))
    .filter(Boolean);

  const allHits = [...normalizedTitleHits, ...normalizedSemanticHits];

  return {
    query,
    result: {
      titleHits: normalizedTitleHits.length,
      semanticHits: normalizedSemanticHits.length,
      totalHits: allHits.length,
      hits: allHits,
    },
    raw: {
      titleRows,
      semanticRows,
    },
  };
}

async function searchResearchTool(ctx, args) {
  const includeTitleSearch = args.includeTitleSearch !== false;
  const includeSemanticSearch = args.includeSemanticSearch !== false;
  if (!includeTitleSearch && !includeSemanticSearch) {
    throw new CliError("search.research requires at least one of includeTitleSearch/includeSemanticSearch to be true");
  }

  const queries = buildResearchQueries(args);
  const maxAttempts = toInteger(args.maxAttempts, 2);
  const contextChars = toInteger(args.contextChars, 220);
  const excerptChars = toInteger(args.excerptChars, 220);
  const concurrency = Math.max(1, toInteger(args.concurrency, 4));
  const view = args.view || "summary";
  const maxDocuments = Math.max(1, toInteger(args.maxDocuments, 40));
  const expandLimit = Math.max(1, toInteger(args.expandLimit, 8));
  const seenIds = ensureStringArray(args.seenIds, "seenIds") || [];

  const perQueryRaw = await mapLimit(queries, concurrency, async (query) =>
    researchSingleQuery(ctx, query, args, maxAttempts, contextChars)
  );

  const allHits = perQueryRaw.flatMap((item) => item.result.hits || []);
  const { merged: mergedAll, skippedSeen } = mergeResearchHits(allHits, seenIds);
  const merged = mergedAll.slice(0, maxDocuments);

  const expandedIds = merged.slice(0, expandLimit).map((item) => item.id);
  const hydration = await fetchDocumentsByIds(ctx, expandedIds, {
    maxAttempts,
    concurrency: Math.max(1, toInteger(args.hydrateConcurrency, 4)),
  });

  const expanded = expandedIds
    .map((id) => {
      const doc = hydration.byId.get(id);
      if (!doc) {
        return null;
      }
      const mergedRow = merged.find((row) => row.id === id);
      if (!mergedRow) {
        return null;
      }
      if (view === "ids") {
        return {
          id: doc.id,
          title: doc.title,
          score: mergedRow.score,
          queryMatches: mergedRow.queryMatches,
        };
      }
      if (view === "full") {
        return {
          id: doc.id,
          score: mergedRow.score,
          queryMatches: mergedRow.queryMatches,
          evidence: mergedRow.evidence,
          document: doc,
        };
      }
      return {
        id: doc.id,
        title: doc.title,
        score: mergedRow.score,
        queryMatches: mergedRow.queryMatches,
        evidence: mergedRow.evidence.slice(0, 5),
        document: normalizeDocumentRow(doc, "summary", excerptChars),
      };
    })
    .filter(Boolean);

  const perQuery = perQueryRaw.map((item) => {
    const compactHits =
      view === "full"
        ? item.result.hits.map((hit) => ({
            ...hit,
          }))
        : item.result.hits
            .map((hit) =>
              normalizeSearchHit(
                hit.source === "semantic"
                  ? {
                      document: {
                        id: hit.id,
                        title: hit.title,
                        collectionId: hit.collectionId,
                        parentDocumentId: hit.parentDocumentId,
                        updatedAt: hit.updatedAt,
                        publishedAt: hit.publishedAt,
                        urlId: hit.urlId,
                      },
                      ranking: hit.ranking,
                      context: hit.context,
                    }
                  : {
                      id: hit.id,
                      title: hit.title,
                      collectionId: hit.collectionId,
                      parentDocumentId: hit.parentDocumentId,
                      updatedAt: hit.updatedAt,
                      publishedAt: hit.publishedAt,
                      urlId: hit.urlId,
                      ranking: hit.ranking,
                      context: hit.context,
                    },
                view === "full" ? "summary" : view,
                contextChars
              )
            )
            .filter(Boolean);

    return {
      query: item.query,
      titleHits: item.result.titleHits,
      semanticHits: item.result.semanticHits,
      totalHits: item.result.totalHits,
      hits: compactHits,
    };
  });

  const mergedOut = merged.map((row) => shapeResearchMergedRow(row, view, excerptChars));

  const nextSeenIds = [...new Set([...seenIds, ...merged.map((item) => item.id)])];
  const suggestedQueries = buildFollowUpQueries(merged, queries, 6);

  return {
    tool: "search.research",
    profile: ctx.profile.id,
    queryCount: queries.length,
    result: {
      question: args.question,
      queries,
      perQuery,
      merged: mergedOut,
      expanded,
      coverage: {
        includeTitleSearch,
        includeSemanticSearch,
        queryCount: queries.length,
        seenInputCount: seenIds.length,
        seenSkippedCount: skippedSeen,
        rawHitCount: allHits.length,
        mergedCount: mergedAll.length,
        returnedMergedCount: merged.length,
        expandedRequested: expandedIds.length,
        expandedOk: hydration.items.filter((item) => item.ok).length,
        expandedFailed: hydration.items.filter((item) => !item.ok).length,
      },
      next: {
        seenIds: nextSeenIds,
        suggestedQueries,
      },
    },
  };
}

function lexicalScore(query, title) {
  const q = String(query || "").trim().toLowerCase();
  const t = String(title || "").trim().toLowerCase();
  if (!q || !t) {
    return 0;
  }
  if (q === t) {
    return 1;
  }
  if (t.startsWith(q)) {
    return 0.92;
  }
  if (t.includes(q)) {
    return 0.82;
  }

  const qTokens = tokenize(q);
  const tTokens = tokenize(t);
  if (qTokens.length === 0 || tTokens.length === 0) {
    return 0;
  }
  const tSet = new Set(tTokens);
  const overlap = qTokens.reduce((acc, token) => (tSet.has(token) ? acc + 1 : acc), 0);
  return overlap / qTokens.length;
}

function computeConfidence({ query, title, source, ranking }) {
  const lexical = lexicalScore(query, title);
  const semantic = normalizeRanking(ranking);

  let confidence;
  if (source === "titles") {
    confidence = 0.45 + lexical * 0.45 + semantic * 0.1;
  } else {
    confidence = 0.25 + semantic * 0.45 + lexical * 0.3;
  }

  if (String(query || "").trim().toLowerCase() === String(title || "").trim().toLowerCase()) {
    confidence = Math.max(confidence, 0.98);
  }

  return Math.max(0, Math.min(1, Number(confidence.toFixed(4))));
}

function normalizeStatusFilter(statusFilter) {
  if (statusFilter === undefined || statusFilter === null) {
    return undefined;
  }
  if (Array.isArray(statusFilter)) {
    return statusFilter;
  }
  if (typeof statusFilter === "string") {
    return statusFilter
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  throw new CliError("statusFilter must be string or string[]");
}

function makeCandidateView(candidate, view, excerptChars) {
  if (view === "full") {
    return candidate;
  }

  const out = {
    id: candidate.id,
    title: candidate.title,
    confidence: candidate.confidence,
    sources: candidate.sources,
    ranking: candidate.ranking,
    collectionId: candidate.collectionId,
    parentDocumentId: candidate.parentDocumentId,
    updatedAt: candidate.updatedAt,
    publishedAt: candidate.publishedAt,
    urlId: candidate.urlId,
  };

  if (view === "ids") {
    return {
      id: out.id,
      title: out.title,
      confidence: out.confidence,
    };
  }

  if (candidate.text) {
    out.excerpt = candidate.text.length > excerptChars ? `${candidate.text.slice(0, excerptChars)}...` : candidate.text;
  }

  return out;
}

async function resolveSingleQuery(ctx, query, args) {
  const maxAttempts = toInteger(args.maxAttempts, 2);
  const limit = Math.max(1, toInteger(args.limit, 8));
  const strict = !!args.strict;

  const common = compactValue({
    query,
    collectionId: args.collectionId,
    limit,
    offset: 0,
  }) || {};

  const titleResponse = await ctx.client.call("documents.search_titles", common, { maxAttempts });
  const titleHits = Array.isArray(titleResponse.body?.data) ? titleResponse.body.data : [];

  const semanticResponse =
    strict && titleHits.length > 0
      ? null
      : await ctx.client.call(
          "documents.search",
          {
            ...common,
            snippetMinWords: toInteger(args.snippetMinWords, 16),
            snippetMaxWords: toInteger(args.snippetMaxWords, 24),
          },
          { maxAttempts }
        );

  const semanticHits = Array.isArray(semanticResponse?.body?.data) ? semanticResponse.body.data : [];

  const byId = new Map();

  for (const hit of titleHits) {
    const id = hit?.id;
    if (!id) {
      continue;
    }

    const candidate = {
      id,
      title: hit.title,
      collectionId: hit.collectionId,
      parentDocumentId: hit.parentDocumentId,
      updatedAt: hit.updatedAt,
      publishedAt: hit.publishedAt,
      urlId: hit.urlId,
      text: hit.text,
      ranking: undefined,
      confidence: computeConfidence({
        query,
        title: hit.title,
        source: "titles",
      }),
      sources: ["titles"],
      document: hit,
    };

    byId.set(id, candidate);
  }

  for (const hit of semanticHits) {
    const doc = hit?.document;
    if (!doc?.id) {
      continue;
    }

    const id = doc.id;
    const confidence = computeConfidence({
      query,
      title: doc.title,
      source: "semantic",
      ranking: hit.ranking,
    });

    const existing = byId.get(id);
    if (!existing) {
      byId.set(id, {
        id,
        title: doc.title,
        collectionId: doc.collectionId,
        parentDocumentId: doc.parentDocumentId,
        updatedAt: doc.updatedAt,
        publishedAt: doc.publishedAt,
        urlId: doc.urlId,
        text: doc.text,
        ranking: Number.isFinite(Number(hit.ranking)) ? Number(hit.ranking) : undefined,
        confidence,
        sources: ["semantic"],
        context: hit.context,
        document: doc,
      });
      continue;
    }

    existing.confidence = Math.max(existing.confidence, confidence);
    existing.sources = [...new Set([...existing.sources, "semantic"])];
    if (existing.ranking === undefined && Number.isFinite(Number(hit.ranking))) {
      existing.ranking = Number(hit.ranking);
    }
    if (!existing.context && hit.context) {
      existing.context = hit.context;
    }
    if (!existing.text && doc.text) {
      existing.text = doc.text;
    }
  }

  const candidates = Array.from(byId.values()).sort((a, b) => {
    if (b.confidence !== a.confidence) {
      return b.confidence - a.confidence;
    }
    const ar = Number(a.ranking || 0);
    const br = Number(b.ranking || 0);
    if (br !== ar) {
      return br - ar;
    }
    return String(a.title || "").localeCompare(String(b.title || ""));
  });

  const strictThreshold = Number.isFinite(Number(args.strictThreshold))
    ? Number(args.strictThreshold)
    : 0.82;

  const bestRaw = candidates[0] || null;
  const bestMatch = bestRaw && (!strict || bestRaw.confidence >= strictThreshold) ? bestRaw : null;

  const view = args.view || "summary";
  const excerptChars = toInteger(args.excerptChars, 220);

  return {
    query,
    bestMatch: bestMatch ? makeCandidateView(bestMatch, view, excerptChars) : null,
    candidates: candidates.map((item) => makeCandidateView(item, view, excerptChars)),
    stats: {
      titleHits: titleHits.length,
      semanticHits: semanticHits.length,
      candidateCount: candidates.length,
      strict,
      strictThreshold,
    },
  };
}

async function documentsResolveTool(ctx, args) {
  const queries = ensureStringArray(args.queries, "queries") || (args.query ? [String(args.query)] : []);
  if (queries.length === 0) {
    throw new CliError("documents.resolve requires args.query or args.queries[]");
  }

  const perQuery = await mapLimit(queries, Math.max(1, toInteger(args.concurrency, 4)), async (query) =>
    resolveSingleQuery(ctx, query, args)
  );

  if (queries.length === 1 && !args.forceGroupedResult) {
    return {
      tool: "documents.resolve",
      profile: ctx.profile.id,
      query: perQuery[0].query,
      result: perQuery[0],
    };
  }

  const mergedBestMatches = perQuery
    .map((item) => item.bestMatch)
    .filter(Boolean)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));

  return {
    tool: "documents.resolve",
    profile: ctx.profile.id,
    queryCount: perQuery.length,
    result: {
      perQuery,
      mergedBestMatches,
    },
  };
}

function shapeTreeNode(doc, children, view, depth) {
  if (view === "full") {
    return {
      depth,
      document: doc,
      children,
    };
  }

  return {
    depth,
    id: doc.id,
    title: doc.title,
    collectionId: doc.collectionId,
    parentDocumentId: doc.parentDocumentId,
    updatedAt: doc.updatedAt,
    publishedAt: doc.publishedAt,
    urlId: doc.urlId,
    childCount: children.length,
    children,
  };
}

function buildTree({ docs, view, maxDepth }) {
  const byId = new Map();
  const order = new Map();

  docs.forEach((doc, index) => {
    byId.set(doc.id, doc);
    order.set(doc.id, index);
  });

  const childIds = new Map();
  for (const doc of docs) {
    if (!doc.parentDocumentId || !byId.has(doc.parentDocumentId)) {
      continue;
    }
    if (!childIds.has(doc.parentDocumentId)) {
      childIds.set(doc.parentDocumentId, []);
    }
    childIds.get(doc.parentDocumentId).push(doc.id);
  }

  const roots = docs
    .filter((doc) => !doc.parentDocumentId || !byId.has(doc.parentDocumentId))
    .sort((a, b) => (order.get(a.id) || 0) - (order.get(b.id) || 0));

  function buildNode(docId, depth, trail) {
    const doc = byId.get(docId);
    if (!doc) {
      return null;
    }

    if (trail.has(docId)) {
      return {
        depth,
        id: doc.id,
        title: doc.title,
        cycleDetected: true,
        children: [],
      };
    }

    const nextTrail = new Set(trail);
    nextTrail.add(docId);

    const rawChildren = (childIds.get(docId) || [])
      .sort((a, b) => (order.get(a) || 0) - (order.get(b) || 0))
      .map((childId) => {
        if (depth >= maxDepth) {
          return {
            depth: depth + 1,
            id: childId,
            truncated: true,
            children: [],
          };
        }
        return buildNode(childId, depth + 1, nextTrail);
      })
      .filter(Boolean);

    return shapeTreeNode(doc, rawChildren, view, depth);
  }

  const tree = roots.map((doc) => buildNode(doc.id, 0, new Set())).filter(Boolean);
  return { tree, rootCount: roots.length };
}

async function collectionsTreeTool(ctx, args) {
  if (!args.collectionId) {
    throw new CliError("collections.tree requires args.collectionId");
  }

  const includeDrafts = !!args.includeDrafts;
  const maxDepth = Math.max(0, toInteger(args.maxDepth, 6));
  const pageSize = Math.max(1, Math.min(100, toInteger(args.pageSize, 100)));
  const maxPages = Math.max(1, toInteger(args.maxPages, 20));
  const maxAttempts = toInteger(args.maxAttempts, 2);
  const view = args.view || "summary";

  const docs = [];
  for (let page = 0; page < maxPages; page += 1) {
    const offset = page * pageSize;
    const body = compactValue({
      collectionId: args.collectionId,
      limit: pageSize,
      offset,
      sort: args.sort || "index",
      direction: args.direction || "ASC",
      statusFilter: normalizeStatusFilter(args.statusFilter),
    }) || {};

    const res = await ctx.client.call("documents.list", body, { maxAttempts });
    const chunk = Array.isArray(res.body?.data) ? res.body.data : [];
    docs.push(...chunk);

    if (chunk.length < pageSize) {
      break;
    }
  }

  const filtered = includeDrafts ? docs : docs.filter((doc) => !!doc.publishedAt);
  const normalizedDocs = filtered.map((doc) => normalizeDocumentRow(doc, "full")).filter(Boolean);
  const { tree, rootCount } = buildTree({ docs: normalizedDocs, view, maxDepth });

  return {
    tool: "collections.tree",
    profile: ctx.profile.id,
    collectionId: args.collectionId,
    result: {
      includeDrafts,
      maxDepth,
      totalDocuments: normalizedDocs.length,
      rootCount,
      tree,
    },
  };
}

async function fetchDocumentsByIds(ctx, ids, { maxAttempts, concurrency }) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const items = await mapLimit(uniqueIds, Math.max(1, concurrency), async (id) => {
    try {
      const res = await ctx.client.call("documents.info", { id }, { maxAttempts });
      return {
        id,
        ok: true,
        document: res.body?.data || null,
      };
    } catch (err) {
      return {
        id,
        ok: false,
        error: err?.message || String(err),
      };
    }
  });

  const byId = new Map();
  for (const item of items) {
    if (item.ok && item.document) {
      byId.set(item.id, item.document);
    }
  }

  return { byId, items };
}

async function expandSingleQuery(ctx, query, args) {
  const mode = args.mode === "titles" ? "titles" : "semantic";
  const endpoint = mode === "titles" ? "documents.search_titles" : "documents.search";
  const limit = Math.max(1, toInteger(args.limit, 8));
  const expandLimit = Math.max(1, toInteger(args.expandLimit, 3));
  const maxAttempts = toInteger(args.maxAttempts, 2);

  const body = compactValue({
    query,
    collectionId: args.collectionId,
    documentId: args.documentId,
    userId: args.userId,
    limit,
    offset: toInteger(args.offset, 0),
    snippetMinWords: mode === "semantic" ? toInteger(args.snippetMinWords, 16) : undefined,
    snippetMaxWords: mode === "semantic" ? toInteger(args.snippetMaxWords, 24) : undefined,
    sort: args.sort,
    direction: args.direction,
  }) || {};

  const searchRes = await ctx.client.call(endpoint, body, { maxAttempts });
  const hits = Array.isArray(searchRes.body?.data) ? searchRes.body.data : [];

  const topIds = [];
  for (const hit of hits) {
    const id = hit?.document?.id || hit?.id;
    if (id && !topIds.includes(id)) {
      topIds.push(id);
    }
    if (topIds.length >= expandLimit) {
      break;
    }
  }

  const hydrate = await fetchDocumentsByIds(ctx, topIds, {
    maxAttempts,
    concurrency: Math.max(1, toInteger(args.hydrateConcurrency, 4)),
  });

  const view = args.view || "summary";
  const contextChars = toInteger(args.contextChars, 200);
  const expanded = topIds
    .map((id) => {
      const doc = hydrate.byId.get(id);
      if (!doc) {
        return null;
      }
      const hit = hits.find((item) => (item?.document?.id || item?.id) === id) || {};
      const base = {
        id,
        ranking: Number.isFinite(Number(hit?.ranking)) ? Number(hit.ranking) : undefined,
        context:
          typeof hit?.context === "string"
            ? hit.context.length > contextChars
              ? `${hit.context.slice(0, contextChars)}...`
              : hit.context
            : undefined,
        document: normalizeDocumentRow(doc, view, toInteger(args.excerptChars, 200)),
      };

      if (view === "ids") {
        return {
          id,
          title: doc.title,
          ranking: base.ranking,
        };
      }

      if (view === "full") {
        return {
          ...base,
          searchHit: hit,
        };
      }

      return {
        id,
        title: doc.title,
        ranking: base.ranking,
        context: base.context,
        document: base.document,
      };
    })
    .filter(Boolean);

  const compactSearchHits = hits.map((hit) => normalizeSearchHit(hit, view === "full" ? "summary" : view, contextChars));

  return {
    query,
    mode,
    searchCount: hits.length,
    expandedCount: expanded.length,
    search: compactSearchHits,
    expanded,
    hydration: {
      requested: topIds.length,
      ok: hydrate.items.filter((item) => item.ok).length,
      failed: hydrate.items.filter((item) => !item.ok).length,
    },
  };
}

async function searchExpandTool(ctx, args) {
  const queries = ensureStringArray(args.queries, "queries") || (args.query ? [String(args.query)] : []);
  if (queries.length === 0) {
    throw new CliError("search.expand requires args.query or args.queries[]");
  }

  const perQuery = await mapLimit(queries, Math.max(1, toInteger(args.concurrency, 4)), async (query) =>
    expandSingleQuery(ctx, query, args)
  );

  if (queries.length === 1 && !args.forceGroupedResult) {
    return {
      tool: "search.expand",
      profile: ctx.profile.id,
      query: perQuery[0].query,
      result: perQuery[0],
    };
  }

  const mergedMap = new Map();
  for (const group of perQuery) {
    for (const item of group.expanded || []) {
      const id = item.id;
      if (!id) {
        continue;
      }
      if (!mergedMap.has(id)) {
        mergedMap.set(id, {
          ...item,
          queries: [group.query],
        });
      } else {
        const existing = mergedMap.get(id);
        existing.queries = [...new Set([...(existing.queries || []), group.query])];
      }
    }
  }

  return {
    tool: "search.expand",
    profile: ctx.profile.id,
    queryCount: perQuery.length,
    result: {
      perQuery,
      mergedExpanded: Array.from(mergedMap.values()),
    },
  };
}

export const NAVIGATION_TOOLS = {
  "documents.resolve": {
    signature:
      "documents.resolve(args: { query?: string; queries?: string[]; collectionId?: string; limit?: number; strict?: boolean; strictThreshold?: number; view?: 'ids'|'summary'|'full'; concurrency?: number; })",
    description:
      "Resolve fuzzy document references by combining title search with semantic fallback and returning confidence-ranked candidates.",
    usageExample: {
      tool: "documents.resolve",
      args: {
        queries: ["incident handbook", "oncall escalation"],
        limit: 6,
        view: "summary",
      },
    },
    bestPractices: [
      "Use `strict=true` when only near-exact matches should be auto-selected.",
      "Start with `view=ids` in planner loops, then hydrate selected IDs separately.",
      "Send multiple references in `queries[]` to reduce tool round trips.",
    ],
    handler: documentsResolveTool,
  },
  "collections.tree": {
    signature:
      "collections.tree(args: { collectionId: string; includeDrafts?: boolean; maxDepth?: number; view?: 'summary'|'full'; pageSize?: number; maxPages?: number; })",
    description: "Build a parent/child document tree for a collection without modifying server data.",
    usageExample: {
      tool: "collections.tree",
      args: {
        collectionId: "collection-id",
        includeDrafts: false,
        maxDepth: 4,
        view: "summary",
      },
    },
    bestPractices: [
      "Keep `view=summary` and low `maxDepth` for navigation tasks to save tokens.",
      "Set includeDrafts=true only if draft pages matter for your workflow.",
      "Use output tree IDs as anchors for targeted `documents.info` calls.",
    ],
    handler: collectionsTreeTool,
  },
  "search.expand": {
    signature:
      "search.expand(args: { query?: string; queries?: string[]; mode?: 'semantic'|'titles'; limit?: number; expandLimit?: number; view?: 'ids'|'summary'|'full'; concurrency?: number; hydrateConcurrency?: number; })",
    description:
      "Search and then hydrate top-ranked documents in one call, returning compact joined search+document output.",
    usageExample: {
      tool: "search.expand",
      args: {
        query: "postmortem template",
        mode: "semantic",
        limit: 8,
        expandLimit: 3,
        view: "summary",
      },
    },
    bestPractices: [
      "Use low `expandLimit` (2-5) to minimize payload while preserving answer quality.",
      "Use `queries[]` for multi-intent retrieval in one request.",
      "Prefer `view=summary` unless a full markdown body is strictly needed.",
    ],
    handler: searchExpandTool,
  },
  "search.research": {
    signature:
      "search.research(args: { question?: string; query?: string; queries?: string[]; collectionId?: string; limitPerQuery?: number; offset?: number; includeTitleSearch?: boolean; includeSemanticSearch?: boolean; expandLimit?: number; maxDocuments?: number; seenIds?: string[]; view?: 'ids'|'summary'|'full'; concurrency?: number; hydrateConcurrency?: number; contextChars?: number; excerptChars?: number; maxAttempts?: number; })",
    description:
      "Run multi-query, multi-source research retrieval with evidence merging, hydration, and follow-up cursor support for multi-turn QA.",
    usageExample: {
      tool: "search.research",
      args: {
        question: "How do we run incident communication and escalation?",
        queries: ["incident comms", "escalation matrix"],
        includeTitleSearch: true,
        includeSemanticSearch: true,
        limitPerQuery: 8,
        expandLimit: 5,
        view: "summary",
      },
    },
    bestPractices: [
      "Pass prior `next.seenIds` into `seenIds` for follow-up turns to avoid repetition.",
      "Use both title+semantic modes for broad recall, then narrow with `collectionId`.",
      "Keep `expandLimit` small and raise only when answer confidence is insufficient.",
    ],
    handler: searchResearchTool,
  },
};
