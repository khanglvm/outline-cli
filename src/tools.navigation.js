import { CliError } from "./errors.js";
import { compactValue, ensureStringArray, mapLimit, toInteger } from "./utils.js";
import { summarizeSafeText } from "./summary-redaction.js";

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
    summary.excerpt = summarizeSafeText(row.text, excerptChars);
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

function uniqueStrings(values = []) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    const trimmed = String(value || "").trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
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

function normalizeResearchPrecisionMode(mode = "balanced") {
  const normalized = String(mode || "balanced").trim().toLowerCase();
  if (["balanced", "precision", "recall"].includes(normalized)) {
    return normalized;
  }
  return "balanced";
}

function getResearchModeConfig(mode = "balanced") {
  const precisionMode = normalizeResearchPrecisionMode(mode);
  if (precisionMode === "precision") {
    return {
      precisionMode,
      sourceWeights: { titles: 1.4, semantic: 0.9 },
      scoreWeights: {
        confidence: 0.48,
        rrf: 0.2,
        queryCoverage: 0.17,
        sourceCoverage: 0.1,
        recency: 0.05,
      },
      mmrLambda: 0.82,
      minScore: 0.42,
    };
  }

  if (precisionMode === "recall") {
    return {
      precisionMode,
      sourceWeights: { titles: 1.05, semantic: 1.25 },
      scoreWeights: {
        confidence: 0.34,
        rrf: 0.34,
        queryCoverage: 0.16,
        sourceCoverage: 0.06,
        recency: 0.1,
      },
      mmrLambda: 0.66,
      minScore: 0.2,
    };
  }

  return {
    precisionMode: "balanced",
    sourceWeights: { titles: 1.25, semantic: 1 },
    scoreWeights: {
      confidence: 0.43,
      rrf: 0.27,
      queryCoverage: 0.14,
      sourceCoverage: 0.08,
      recency: 0.08,
    },
    mmrLambda: 0.74,
    minScore: 0,
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function recencySignal(updatedAt) {
  const ts = Number.isFinite(Date.parse(updatedAt || "")) ? Date.parse(updatedAt) : 0;
  if (!ts) {
    return 0;
  }
  const ageMs = Math.max(0, Date.now() - ts);
  const ageDays = ageMs / (24 * 3600 * 1000);
  if (ageDays <= 1) {
    return 1;
  }
  if (ageDays <= 7) {
    return 0.9;
  }
  if (ageDays <= 30) {
    return 0.75;
  }
  if (ageDays <= 90) {
    return 0.55;
  }
  if (ageDays <= 365) {
    return 0.35;
  }
  return 0.15;
}

function tokenJaccardSimilarity(a, b) {
  const aTokens = new Set(tokenize(a));
  const bTokens = new Set(tokenize(b));
  if (aTokens.size === 0 && bTokens.size === 0) {
    return 0;
  }

  let intersection = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) {
      intersection += 1;
    }
  }
  const union = aTokens.size + bTokens.size - intersection;
  if (union <= 0) {
    return 0;
  }
  return intersection / union;
}

function diversifyRankedRows(rows, limit, lambda = 0.74) {
  const maxItems = Math.max(0, Math.min(limit, rows.length));
  if (maxItems <= 1) {
    return rows.slice(0, maxItems);
  }

  const selected = [];
  const remaining = [...rows];
  const safeLambda = clamp(Number(lambda), 0, 1);

  while (selected.length < maxItems && remaining.length > 0) {
    let bestIndex = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < remaining.length; i += 1) {
      const candidate = remaining[i];
      const relevance = Number(candidate.score || 0);
      let maxSimilarity = 0;
      for (const picked of selected) {
        const sim = tokenJaccardSimilarity(
          `${candidate.title || ""} ${candidate.queries?.join(" ") || ""}`,
          `${picked.title || ""} ${picked.queries?.join(" ") || ""}`
        );
        if (sim > maxSimilarity) {
          maxSimilarity = sim;
        }
      }
      const mmrScore = safeLambda * relevance - (1 - safeLambda) * maxSimilarity;
      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIndex = i;
        continue;
      }
      if (mmrScore === bestScore) {
        const bestCandidate = remaining[bestIndex];
        if (Number(candidate.score || 0) > Number(bestCandidate.score || 0)) {
          bestIndex = i;
          continue;
        }
        if (
          Number(candidate.score || 0) === Number(bestCandidate.score || 0) &&
          String(candidate.title || "").localeCompare(String(bestCandidate.title || "")) < 0
        ) {
          bestIndex = i;
        }
      }
    }

    selected.push(remaining.splice(bestIndex, 1)[0]);
  }

  return selected;
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

function shapeResearchMergedRow(row, view, excerptChars, evidencePerDocument = 5) {
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
    summary.excerpt = summarizeSafeText(row.text, excerptChars);
  }

  if (Array.isArray(row.evidence)) {
    summary.evidence = row.evidence.slice(0, evidencePerDocument);
  }

  return summary;
}

function normalizeResearchTitleHit(query, row, contextChars, sourceRank) {
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
    sourceRank,
    context: undefined,
  };
}

function normalizeResearchSemanticHit(query, row, contextChars, sourceRank) {
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
    sourceRank,
    context: context ? (context.length > contextChars ? `${context.slice(0, contextChars)}...` : context) : undefined,
  };
}

function mergeResearchHits(rawHits, seenIds = [], options = {}) {
  const modeConfig = getResearchModeConfig(options.precisionMode || "balanced");
  const totalQueries = Math.max(1, Number(options.totalQueries || 1));
  const enabledSourceCount = Math.max(1, Number(options.enabledSourceCount || 2));
  const rrfK = Math.max(1, toInteger(options.rrfK, 60));
  const minScore = Number.isFinite(Number(options.minScore))
    ? clamp(Number(options.minScore), 0, 1)
    : modeConfig.minScore;

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
    const source = String(hit.source || "semantic");
    const sourceWeight = modeConfig.sourceWeights[source] || 1;
    const sourceRank = Number.isFinite(Number(hit.sourceRank)) ? Math.max(1, Number(hit.sourceRank)) : 1;
    const rrfContribution = sourceWeight / (rrfK + sourceRank);
    const contribution = clamp(Number(hit.scoreContribution || 0), 0, 1);
    const evidenceRow = {
      query: hit.query,
      source: hit.source,
      sourceRank,
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
        score: contribution,
        confidenceMax: contribution,
        confidenceSum: contribution,
        confidenceCount: 1,
        rrf: rrfContribution,
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
    existing.score = Math.max(existing.score, contribution);
    existing.confidenceMax = Math.max(existing.confidenceMax || 0, contribution);
    existing.confidenceSum = Number(existing.confidenceSum || 0) + contribution;
    existing.confidenceCount = Number(existing.confidenceCount || 0) + 1;
    existing.rrf = Number(existing.rrf || 0) + rrfContribution;
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

  const mergedBase = Array.from(mergedMap.values());
  const maxRrf = mergedBase.reduce((max, row) => Math.max(max, Number(row.rrf || 0)), 0) || 1;
  const scoreWeights = modeConfig.scoreWeights;

  const merged = mergedBase
    .map((row) => {
      const rankingSignal = normalizeSearchRanking(row.ranking);
      const confidenceSignal = clamp(
        Math.max(
          Number(row.confidenceMax || 0),
          row.confidenceCount > 0 ? Number(row.confidenceSum || 0) / row.confidenceCount : 0
        ),
        0,
        1
      );
      const rrfSignal = clamp(Number(row.rrf || 0) / maxRrf, 0, 1);
      const queryCoverage = clamp(Number(row.queryMatches || 0) / totalQueries, 0, 1);
      const sourceCoverage = clamp(Number(row.sources?.length || 0) / enabledSourceCount, 0, 1);
      const recency = recencySignal(row.updatedAt);

      const finalScore = clamp(
        scoreWeights.confidence * Math.max(confidenceSignal, rankingSignal * 0.55) +
          scoreWeights.rrf * rrfSignal +
          scoreWeights.queryCoverage * queryCoverage +
          scoreWeights.sourceCoverage * sourceCoverage +
          scoreWeights.recency * recency,
        0,
        1
      );

      return {
        ...row,
        score: Number(finalScore.toFixed(4)),
      };
    })
    .filter((row) => row.score >= minScore);

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

  return {
    merged,
    skippedSeen,
    precisionMode: modeConfig.precisionMode,
    minScore,
    rrfK,
  };
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
    .map((row, index) => normalizeResearchTitleHit(query, row, contextChars, index + 1))
    .filter(Boolean);
  const normalizedSemanticHits = semanticRows
    .map((row, index) => normalizeResearchSemanticHit(query, row, contextChars, index + 1))
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
  const perQueryView =
    args.perQueryView && ["ids", "summary", "full"].includes(String(args.perQueryView))
      ? String(args.perQueryView)
      : view;
  const maxDocuments = Math.max(1, toInteger(args.maxDocuments, 40));
  const expandLimit = Math.max(1, toInteger(args.expandLimit, 8));
  const seenIds = ensureStringArray(args.seenIds, "seenIds") || [];
  const perQueryHitLimit = Math.max(1, toInteger(args.perQueryHitLimit, 6));
  const evidencePerDocument = Math.max(1, toInteger(args.evidencePerDocument, 5));
  const suggestedQueryLimit = Math.max(1, toInteger(args.suggestedQueryLimit, 6));
  const includePerQuery = args.includePerQuery !== false;
  const includeCoverage = args.includeCoverage !== false;
  const includeExpanded = args.includeExpanded !== false;
  const includeBacklinks = args.includeBacklinks === true;
  const backlinksLimit = Math.max(1, toInteger(args.backlinksLimit, 5));
  const backlinksConcurrency = Math.max(1, toInteger(args.backlinksConcurrency, 4));

  const precisionMode = normalizeResearchPrecisionMode(args.precisionMode || "balanced");
  const modeConfig = getResearchModeConfig(precisionMode);
  const diversityLambda = Number.isFinite(Number(args.diversityLambda))
    ? clamp(Number(args.diversityLambda), 0, 1)
    : modeConfig.mmrLambda;
  const diversify = args.diversify !== false;

  const perQueryRaw = await mapLimit(queries, concurrency, async (query) =>
    researchSingleQuery(ctx, query, args, maxAttempts, contextChars)
  );

  const allHits = perQueryRaw.flatMap((item) => item.result.hits || []);
  const mergeMeta = mergeResearchHits(allHits, seenIds, {
    precisionMode,
    minScore: args.minScore,
    totalQueries: queries.length,
    enabledSourceCount: (includeTitleSearch ? 1 : 0) + (includeSemanticSearch ? 1 : 0),
    rrfK: args.rrfK,
  });
  const mergedAll = mergeMeta.merged;
  const merged = diversify
    ? diversifyRankedRows(mergedAll, maxDocuments, diversityLambda)
    : mergedAll.slice(0, maxDocuments);

  const expandedIds = includeExpanded ? merged.slice(0, expandLimit).map((item) => item.id) : [];
  const hydration = includeExpanded
    ? await fetchDocumentsByIds(ctx, expandedIds, {
        maxAttempts,
        concurrency: Math.max(1, toInteger(args.hydrateConcurrency, 4)),
      })
    : {
        byId: new Map(),
        items: [],
      };
  const backlinks = includeExpanded && includeBacklinks && expandedIds.length > 0
    ? await fetchBacklinksByDocumentIds(ctx, expandedIds, {
        maxAttempts,
        concurrency: backlinksConcurrency,
        limit: backlinksLimit,
        view: view === "ids" ? "ids" : "summary",
        excerptChars,
      })
    : {
        byId: new Map(),
        items: [],
      };

  const expanded = includeExpanded
    ? expandedIds
        .map((id) => {
          const doc = hydration.byId.get(id);
          if (!doc) {
            return null;
          }
          const mergedRow = merged.find((row) => row.id === id);
          if (!mergedRow) {
            return null;
          }
          const backlinkRows = includeBacklinks ? backlinks.byId.get(id) || [] : undefined;

          if (view === "ids") {
            return compactValue({
              id: doc.id,
              title: doc.title,
              score: mergedRow.score,
              queryMatches: mergedRow.queryMatches,
              backlinks: backlinkRows,
            });
          }
          if (view === "full") {
            return compactValue({
              id: doc.id,
              score: mergedRow.score,
              queryMatches: mergedRow.queryMatches,
              evidence: mergedRow.evidence,
              document: doc,
              backlinks: backlinkRows,
            });
          }
          return compactValue({
            id: doc.id,
            title: doc.title,
            score: mergedRow.score,
            queryMatches: mergedRow.queryMatches,
            evidence: mergedRow.evidence.slice(0, evidencePerDocument),
            document: normalizeDocumentRow(doc, "summary", excerptChars),
            backlinks: backlinkRows,
          });
        })
        .filter(Boolean)
    : [];

  const perQuery = perQueryRaw.map((item) => {
    const compactHits =
      perQueryView === "full"
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
                perQueryView,
                contextChars
              )
            )
            .filter(Boolean);

    return {
      query: item.query,
      titleHits: item.result.titleHits,
      semanticHits: item.result.semanticHits,
      totalHits: item.result.totalHits,
      hits: compactHits.slice(0, perQueryHitLimit),
    };
  });

  const mergedOut = merged.map((row) =>
    shapeResearchMergedRow(row, view, excerptChars, evidencePerDocument)
  );

  const nextSeenIds = [...new Set([...seenIds, ...merged.map((item) => item.id)])];
  const suggestedQueries = buildFollowUpQueries(merged, queries, suggestedQueryLimit);

  return {
    tool: "search.research",
    profile: ctx.profile.id,
    queryCount: queries.length,
    result: {
      question: args.question,
      queries,
      ...(includePerQuery ? { perQuery } : {}),
      merged: mergedOut,
      ...(includeExpanded ? { expanded } : {}),
      ...(includeCoverage
        ? {
            coverage: {
              includeTitleSearch,
              includeSemanticSearch,
              precisionMode: mergeMeta.precisionMode,
              minScoreApplied: mergeMeta.minScore,
              rrfK: mergeMeta.rrfK,
              diversified: diversify,
              diversityLambda: diversify ? diversityLambda : undefined,
              queryCount: queries.length,
              seenInputCount: seenIds.length,
              seenSkippedCount: mergeMeta.skippedSeen,
              rawHitCount: allHits.length,
              mergedCount: mergedAll.length,
              returnedMergedCount: merged.length,
              perQueryHitLimit,
              evidencePerDocument,
              expandedRequested: expandedIds.length,
              expandedOk: hydration.items.filter((item) => item.ok).length,
              expandedFailed: hydration.items.filter((item) => !item.ok).length,
              backlinksRequested: includeBacklinks ? backlinks.items.length : 0,
              backlinksOk: includeBacklinks ? backlinks.items.filter((item) => item.ok).length : 0,
              backlinksFailed: includeBacklinks ? backlinks.items.filter((item) => !item.ok).length : 0,
            },
          }
        : {}),
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

function safeParseUrl(value) {
  try {
    return new URL(String(value || ""));
  } catch {
    return null;
  }
}

function maybeExtractUrlIdHint(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const match = raw.match(/-([A-Za-z0-9]{6,})$/);
  if (match?.[1]) {
    return String(match[1]);
  }
  if (/^[A-Za-z0-9]{6,}$/.test(raw)) {
    return raw;
  }
  return "";
}

function extractHashUrlIdHint(hashValue) {
  const match = String(hashValue || "").match(/(?:^#|[#/])d-([A-Za-z0-9_-]{6,})/i);
  return match?.[1] ? String(match[1]) : "";
}

function parseOutlineReferenceUrl(rawValue, profileBaseUrl) {
  const input = String(rawValue || "").trim();
  const profileUrl = safeParseUrl(profileBaseUrl);
  const parsed = safeParseUrl(input);
  if (!parsed) {
    return {
      input,
      validUrl: false,
      host: "",
      path: "",
      shareId: "",
      titleQuery: "",
      urlIdHints: [],
      matchesProfileHost: null,
      fallbackQuery: input,
    };
  }

  const path = parsed.pathname.replace(/\/+$/, "");
  const segments = path.split("/").filter(Boolean);
  const lowerSegments = segments.map((segment) => segment.toLowerCase());
  const shareIndex = lowerSegments.indexOf("share");
  const shareId = shareIndex >= 0 && segments[shareIndex + 1] ? String(segments[shareIndex + 1]) : "";

  const docIndex = lowerSegments.indexOf("doc");
  const rawDocSegment = docIndex >= 0 && segments[docIndex + 1] ? String(segments[docIndex + 1]) : "";
  const hashUrlId = extractHashUrlIdHint(parsed.hash);
  const docUrlId = maybeExtractUrlIdHint(rawDocSegment);

  const urlIdHints = uniqueStrings([docUrlId, hashUrlId]);

  let titleQuery = "";
  if (rawDocSegment) {
    titleQuery = rawDocSegment;
    if (docUrlId && titleQuery.endsWith(`-${docUrlId}`)) {
      titleQuery = titleQuery.slice(0, -(docUrlId.length + 1));
    }
    titleQuery = titleQuery.replace(/[-_]+/g, " ").trim();
  }

  const fallbackQuery =
    titleQuery ||
    (segments.length > 0
      ? segments[segments.length - 1].replace(/[-_]+/g, " ").trim()
      : input);

  return {
    input,
    validUrl: true,
    host: parsed.host,
    path,
    shareId,
    titleQuery,
    urlIdHints,
    matchesProfileHost: profileUrl ? parsed.host.toLowerCase() === profileUrl.host.toLowerCase() : null,
    fallbackQuery,
  };
}

function compareIsoDesc(a, b) {
  const aTs = Number.isFinite(Date.parse(a || "")) ? Date.parse(a) : 0;
  const bTs = Number.isFinite(Date.parse(b || "")) ? Date.parse(b) : 0;
  if (bTs !== aTs) {
    return bTs - aTs;
  }
  return 0;
}

function shapeResolveUrlCandidate(candidate, view, excerptChars) {
  const base = makeCandidateView(candidate, view, excerptChars);
  if (!base || view === "ids") {
    return base;
  }
  return compactValue({
    ...base,
    matchedQueries: candidate.matchedQueries,
    matchingReasons: candidate.matchingReasons,
    rawConfidence: candidate.rawConfidence,
    urlIdHintMatched: candidate.urlIdHintMatched,
  });
}

function buildCandidateFromDocument(document, { confidence = 1, source = "explicit", ranking, context } = {}) {
  if (!document?.id) {
    return null;
  }
  return {
    id: String(document.id),
    title: document.title,
    collectionId: document.collectionId,
    parentDocumentId: document.parentDocumentId,
    updatedAt: document.updatedAt,
    publishedAt: document.publishedAt,
    urlId: document.urlId,
    text: document.text,
    ranking: Number.isFinite(Number(ranking)) ? Number(ranking) : undefined,
    confidence: clamp(Number(confidence), 0, 1),
    sources: [source],
    context,
    document,
  };
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

async function resolveSingleUrlReference(ctx, rawUrl, args) {
  const parsed = parseOutlineReferenceUrl(rawUrl, ctx.profile?.baseUrl);
  const limit = Math.max(1, toInteger(args.limit, 8));
  const strict = !!args.strict;
  const strictThreshold = Number.isFinite(Number(args.strictThreshold))
    ? Number(args.strictThreshold)
    : 0.82;
  const view = args.view || "summary";
  const excerptChars = toInteger(args.excerptChars, 220);
  const candidateMap = new Map();
  const warnings = [];
  let shareLookupAttempted = false;

  if (parsed.validUrl && args.strictHost === true && parsed.matchesProfileHost === false) {
    warnings.push("host_mismatch_skipped");
    return {
      url: parsed.input,
      parsed,
      bestMatch: null,
      candidates: [],
      stats: {
        queryCount: 0,
        candidateCount: 0,
        strict,
        strictThreshold,
        shareLookupAttempted,
      },
      warnings,
    };
  }

  if (parsed.validUrl && parsed.shareId) {
    shareLookupAttempted = true;
    try {
      const shareInfo = await ctx.client.call(
        "documents.info",
        { shareId: parsed.shareId },
        { maxAttempts: toInteger(args.maxAttempts, 2) }
      );
      const shareDoc = shareInfo.body?.data || null;
      const shareCandidate = buildCandidateFromDocument(shareDoc, {
        confidence: 1,
        source: "share",
        ranking: 1,
      });
      if (shareCandidate) {
        candidateMap.set(shareCandidate.id, {
          ...shareCandidate,
          rawConfidence: shareCandidate.confidence,
          matchingReasons: ["share_id_lookup"],
          matchedQueries: [],
          urlIdHintMatched: false,
        });
      }
    } catch {
      warnings.push("share_lookup_failed");
    }
  }

  const queryHints = uniqueStrings([parsed.titleQuery, ...parsed.urlIdHints, parsed.fallbackQuery]);
  for (const query of queryHints) {
    const resolved = await resolveSingleQuery(ctx, query, {
      ...args,
      view: "full",
      limit,
      strict: false,
    });

    for (const candidate of resolved.candidates || []) {
      const id = candidate?.id;
      if (!id) {
        continue;
      }

      const rawConfidence = clamp(Number(candidate.confidence || 0), 0, 1);
      const reasons = [];
      let confidence = rawConfidence;
      let urlIdHintMatched = false;

      if (parsed.urlIdHints.length > 0 && parsed.urlIdHints.includes(String(candidate.urlId || ""))) {
        confidence = clamp(confidence + 0.24, 0, 1);
        urlIdHintMatched = true;
        reasons.push("url_id_hint");
      }

      if (parsed.titleQuery) {
        const lexical = lexicalScore(parsed.titleQuery, candidate.title);
        if (lexical >= 0.88) {
          confidence = clamp(confidence + 0.06, 0, 1);
          reasons.push("title_hint");
        }
      }

      if (parsed.matchesProfileHost === true) {
        confidence = clamp(confidence + 0.02, 0, 1);
      }

      const existing = candidateMap.get(id);
      const nextRow = {
        ...candidate,
        confidence: Number(confidence.toFixed(4)),
        rawConfidence,
        matchingReasons: reasons,
        matchedQueries: [query],
        urlIdHintMatched,
      };

      if (!existing) {
        candidateMap.set(id, nextRow);
        continue;
      }

      existing.confidence = Math.max(Number(existing.confidence || 0), nextRow.confidence);
      existing.rawConfidence = Math.max(Number(existing.rawConfidence || 0), nextRow.rawConfidence);
      existing.matchingReasons = uniqueStrings([...(existing.matchingReasons || []), ...nextRow.matchingReasons]);
      existing.matchedQueries = uniqueStrings([...(existing.matchedQueries || []), query]);
      existing.sources = uniqueStrings([...(existing.sources || []), ...(nextRow.sources || [])]);
      existing.urlIdHintMatched = existing.urlIdHintMatched || nextRow.urlIdHintMatched;
      if (existing.ranking === undefined && nextRow.ranking !== undefined) {
        existing.ranking = nextRow.ranking;
      }
      if (!existing.context && nextRow.context) {
        existing.context = nextRow.context;
      }
      if (!existing.text && nextRow.text) {
        existing.text = nextRow.text;
      }
      if (compareIsoDesc(existing.updatedAt, nextRow.updatedAt) > 0) {
        existing.updatedAt = nextRow.updatedAt;
        existing.publishedAt = nextRow.publishedAt;
      }
    }
  }

  const candidates = Array.from(candidateMap.values()).sort((a, b) => {
    const confidenceDiff = Number(b.confidence || 0) - Number(a.confidence || 0);
    if (confidenceDiff !== 0) {
      return confidenceDiff;
    }
    const rankingDiff = Number(b.ranking || 0) - Number(a.ranking || 0);
    if (rankingDiff !== 0) {
      return rankingDiff;
    }
    const updatedCmp = compareIsoDesc(a.updatedAt, b.updatedAt);
    if (updatedCmp !== 0) {
      return updatedCmp;
    }
    return String(a.title || "").localeCompare(String(b.title || ""));
  });

  const strictCandidates = strict ? candidates.filter((item) => Number(item.confidence || 0) >= strictThreshold) : candidates;
  const trimmedCandidates = strictCandidates.slice(0, limit);
  const bestMatch = trimmedCandidates[0] || null;

  return {
    url: parsed.input,
    parsed,
    bestMatch: bestMatch ? shapeResolveUrlCandidate(bestMatch, view, excerptChars) : null,
    candidates: trimmedCandidates.map((item) => shapeResolveUrlCandidate(item, view, excerptChars)),
    stats: {
      queryCount: queryHints.length,
      candidateCount: trimmedCandidates.length,
      strict,
      strictThreshold,
      shareLookupAttempted,
    },
    warnings,
  };
}

async function documentsResolveUrlsTool(ctx, args) {
  const rawUrls = ensureStringArray(args.urls, "urls") || (args.url ? [String(args.url)] : []);
  const urls = uniqueStrings(rawUrls);
  if (urls.length === 0) {
    throw new CliError("documents.resolve_urls requires args.url or args.urls[]");
  }

  const concurrency = Math.max(1, toInteger(args.concurrency, 4));
  const perUrl = await mapLimit(urls, concurrency, async (url) => resolveSingleUrlReference(ctx, url, args));

  if (urls.length === 1 && !args.forceGroupedResult) {
    return {
      tool: "documents.resolve_urls",
      profile: ctx.profile.id,
      url: perUrl[0].url,
      result: perUrl[0],
    };
  }

  const mergedBestMatches = perUrl
    .map((item) => item.bestMatch)
    .filter(Boolean)
    .sort((a, b) => Number(b.confidence || 0) - Number(a.confidence || 0));

  return {
    tool: "documents.resolve_urls",
    profile: ctx.profile.id,
    urlCount: perUrl.length,
    result: {
      perUrl,
      mergedBestMatches,
    },
  };
}

function canonicalClusterSimilarity(a, b) {
  const aUrlId = String(a?.urlId || "");
  const bUrlId = String(b?.urlId || "");
  if (aUrlId && bUrlId && aUrlId === bUrlId) {
    return {
      score: 1,
      reason: "url_id_exact",
    };
  }
  const lexicalForward = lexicalScore(a?.title, b?.title);
  const lexicalBackward = lexicalScore(b?.title, a?.title);
  const lexical = Math.max(lexicalForward, lexicalBackward);
  const jaccard = tokenJaccardSimilarity(a?.title, b?.title);
  const score = Math.max(jaccard, lexical);
  return {
    score,
    reason: lexical >= jaccard ? "title_lexical" : "title_similarity",
  };
}

function shapeCanonicalCandidate(candidate, view, excerptChars) {
  return makeCandidateView(candidate, view, excerptChars);
}

async function documentsCanonicalizeCandidatesTool(ctx, args) {
  const queries = uniqueStrings(ensureStringArray(args.queries, "queries") || (args.query ? [String(args.query)] : []));
  const ids = uniqueStrings(ensureStringArray(args.ids, "ids") || []);
  if (queries.length === 0 && ids.length === 0) {
    throw new CliError("documents.canonicalize_candidates requires args.query/args.queries[] or args.ids[]");
  }

  const candidateMap = new Map();
  const limit = Math.max(1, toInteger(args.limit, 8));
  const strict = !!args.strict;
  const strictThreshold = Number.isFinite(Number(args.strictThreshold))
    ? Number(args.strictThreshold)
    : 0.82;
  const view = args.view || "summary";
  const excerptChars = toInteger(args.excerptChars, 220);
  const maxAttempts = toInteger(args.maxAttempts, 2);
  const titleSimilarityThreshold = Number.isFinite(Number(args.titleSimilarityThreshold))
    ? clamp(Number(args.titleSimilarityThreshold), 0, 1)
    : 0.82;

  if (ids.length > 0) {
    const hydrated = await fetchDocumentsByIds(ctx, ids, {
      maxAttempts,
      concurrency: Math.max(1, toInteger(args.hydrateConcurrency, 4)),
    });
    for (const [id, doc] of hydrated.byId.entries()) {
      const candidate = buildCandidateFromDocument(doc, {
        confidence: 1,
        source: "explicit",
        ranking: 1,
      });
      if (!candidate) {
        continue;
      }
      candidate.matchedQueries = [];
      candidate.rawConfidence = candidate.confidence;
      candidateMap.set(id, candidate);
    }
  }

  const queryResults = await mapLimit(queries, Math.max(1, toInteger(args.concurrency, 4)), async (query) =>
    resolveSingleQuery(ctx, query, {
      ...args,
      strict: false,
      limit,
      view: "full",
      maxAttempts,
    })
  );

  for (const group of queryResults) {
    for (const candidate of group.candidates || []) {
      const id = candidate?.id;
      if (!id) {
        continue;
      }
      const existing = candidateMap.get(id);
      if (!existing) {
        candidateMap.set(id, {
          ...candidate,
          rawConfidence: candidate.confidence,
          matchedQueries: [group.query],
        });
        continue;
      }
      existing.confidence = Math.max(Number(existing.confidence || 0), Number(candidate.confidence || 0));
      existing.rawConfidence = Math.max(Number(existing.rawConfidence || 0), Number(candidate.confidence || 0));
      existing.sources = uniqueStrings([...(existing.sources || []), ...(candidate.sources || [])]);
      existing.matchedQueries = uniqueStrings([...(existing.matchedQueries || []), group.query]);
      if (existing.ranking === undefined && candidate.ranking !== undefined) {
        existing.ranking = candidate.ranking;
      }
      if (!existing.text && candidate.text) {
        existing.text = candidate.text;
      }
      if (compareIsoDesc(existing.updatedAt, candidate.updatedAt) > 0) {
        existing.updatedAt = candidate.updatedAt;
        existing.publishedAt = candidate.publishedAt;
      }
    }
  }

  const candidateRows = Array.from(candidateMap.values())
    .filter((row) => (!strict ? true : Number(row.confidence || 0) >= strictThreshold))
    .sort((a, b) => {
      const confidenceDiff = Number(b.confidence || 0) - Number(a.confidence || 0);
      if (confidenceDiff !== 0) {
        return confidenceDiff;
      }
      const updatedCmp = compareIsoDesc(a.updatedAt, b.updatedAt);
      if (updatedCmp !== 0) {
        return updatedCmp;
      }
      return String(a.title || "").localeCompare(String(b.title || ""));
    });

  const clusters = [];
  for (const candidate of candidateRows) {
    let bestCluster = null;
    let bestScore = -1;
    let bestReason = "";
    for (const cluster of clusters) {
      const similarity = canonicalClusterSimilarity(candidate, cluster.canonical);
      if (similarity.score >= titleSimilarityThreshold && similarity.score > bestScore) {
        bestCluster = cluster;
        bestScore = similarity.score;
        bestReason = similarity.reason;
      }
    }

    if (!bestCluster) {
      clusters.push({
        canonical: candidate,
        members: [{ ...candidate, similarity: 1, similarityReason: "seed" }],
      });
      continue;
    }

    bestCluster.members.push({
      ...candidate,
      similarity: Number(bestScore.toFixed(4)),
      similarityReason: bestReason,
    });
  }

  for (const cluster of clusters) {
    cluster.members.sort((a, b) => {
      const aExplicit = (a.sources || []).includes("explicit");
      const bExplicit = (b.sources || []).includes("explicit");
      if (aExplicit !== bExplicit) {
        return aExplicit ? -1 : 1;
      }
      const confidenceDiff = Number(b.confidence || 0) - Number(a.confidence || 0);
      if (confidenceDiff !== 0) {
        return confidenceDiff;
      }
      const updatedCmp = compareIsoDesc(a.updatedAt, b.updatedAt);
      if (updatedCmp !== 0) {
        return updatedCmp;
      }
      return String(a.title || "").localeCompare(String(b.title || ""));
    });
    cluster.canonical = cluster.members[0];
  }

  clusters.sort((a, b) => {
    const confidenceDiff = Number(b.canonical?.confidence || 0) - Number(a.canonical?.confidence || 0);
    if (confidenceDiff !== 0) {
      return confidenceDiff;
    }
    return String(a.canonical?.title || "").localeCompare(String(b.canonical?.title || ""));
  });

  const canonical = clusters.map((cluster) =>
    compactValue({
      ...shapeCanonicalCandidate(cluster.canonical, view, excerptChars),
      memberCount: cluster.members.length,
      duplicateIds: cluster.members.slice(1).map((member) => member.id),
    })
  );

  const clusterRows =
    view === "ids"
      ? clusters.map((cluster) => ({
          canonicalId: cluster.canonical.id,
          memberIds: cluster.members.map((member) => member.id),
          memberCount: cluster.members.length,
        }))
      : clusters.map((cluster) => ({
          canonical: shapeCanonicalCandidate(cluster.canonical, view, excerptChars),
          members: cluster.members.map((member) =>
            compactValue({
              ...shapeCanonicalCandidate(member, view, excerptChars),
              similarity: member.similarity,
              similarityReason: member.similarityReason,
            })
          ),
        }));

  return {
    tool: "documents.canonicalize_candidates",
    profile: ctx.profile.id,
    result: {
      queryCount: queries.length,
      requestedIdCount: ids.length,
      candidateCount: candidateRows.length,
      clusterCount: clusters.length,
      duplicateClusterCount: clusters.filter((cluster) => cluster.members.length > 1).length,
      strict,
      strictThreshold,
      titleSimilarityThreshold,
      canonical,
      clusters: clusterRows,
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

async function fetchDocumentsByIds(ctx, ids, { maxAttempts, concurrency, cache }) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const useCache = cache instanceof Map ? cache : null;
  const items = await mapLimit(uniqueIds, Math.max(1, concurrency), async (id) => {
    if (useCache && useCache.has(id)) {
      return Promise.resolve(useCache.get(id));
    }

    const fetchPromise = (async () => {
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
    })();

    if (useCache) {
      useCache.set(id, fetchPromise);
    }
    const item = await fetchPromise;
    if (useCache) {
      useCache.set(id, item);
    }
    return item;
  });

  const byId = new Map();
  for (const item of items) {
    if (item.ok && item.document) {
      byId.set(item.id, item.document);
    }
  }

  return { byId, items };
}

async function fetchBacklinksByDocumentIds(ctx, ids, options = {}) {
  const uniqueIds = [...new Set(ids.filter(Boolean))];
  const maxAttempts = toInteger(options.maxAttempts, 2);
  const limit = Math.max(1, toInteger(options.limit, 5));
  const concurrency = Math.max(1, toInteger(options.concurrency, 4));
  const view = options.view || "summary";
  const excerptChars = toInteger(options.excerptChars, 180);

  const items = await mapLimit(uniqueIds, concurrency, async (id) => {
    try {
      const res = await ctx.client.call(
        "documents.list",
        {
          backlinkDocumentId: id,
          limit,
          offset: 0,
          sort: "updatedAt",
          direction: "DESC",
        },
        { maxAttempts }
      );
      const rows = Array.isArray(res.body?.data) ? res.body.data : [];
      return {
        id,
        ok: true,
        backlinks: rows.map((row) => normalizeDocumentRow(row, view, excerptChars)).filter(Boolean),
      };
    } catch (err) {
      return {
        id,
        ok: false,
        backlinks: [],
        error: err?.message || String(err),
      };
    }
  });

  const byId = new Map();
  for (const item of items) {
    byId.set(item.id, item.backlinks || []);
  }
  return { byId, items };
}

async function expandSingleQuery(ctx, query, args, hydrationCache) {
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
    cache: hydrationCache,
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

  const hydrationCache = new Map();
  const perQuery = await mapLimit(queries, Math.max(1, toInteger(args.concurrency, 4)), async (query) =>
    expandSingleQuery(ctx, query, args, hydrationCache)
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
  "documents.resolve_urls": {
    signature:
      "documents.resolve_urls(args: { url?: string; urls?: string[]; collectionId?: string; limit?: number; strict?: boolean; strictHost?: boolean; strictThreshold?: number; view?: 'ids'|'summary'|'full'; concurrency?: number; snippetMinWords?: number; snippetMaxWords?: number; excerptChars?: number; forceGroupedResult?: boolean; maxAttempts?: number; })",
    description:
      "Resolve document URLs (doc/share links) into confidence-ranked document candidates with URL-id/host-aware boosts.",
    usageExample: {
      tool: "documents.resolve_urls",
      args: {
        urls: [
          "https://handbook.example.com/doc/event-tracking-data-A7hLXuHZJl",
          "https://handbook.example.com/doc/campaign-detail-page-GWK1uA8w35#d-GWK1uA8w35",
        ],
        strict: true,
        strictThreshold: 0.85,
        view: "summary",
      },
    },
    bestPractices: [
      "Use strictHost=true when links should belong to the currently selected profile host only.",
      "Use strict=true for automation paths that should avoid weak URL matches.",
      "Start with view=ids, then hydrate selected IDs with documents.info for low-token loops.",
    ],
    handler: documentsResolveUrlsTool,
  },
  "documents.canonicalize_candidates": {
    signature:
      "documents.canonicalize_candidates(args: { query?: string; queries?: string[]; ids?: string[]; collectionId?: string; limit?: number; strict?: boolean; strictThreshold?: number; titleSimilarityThreshold?: number; view?: 'ids'|'summary'|'full'; concurrency?: number; hydrateConcurrency?: number; snippetMinWords?: number; snippetMaxWords?: number; excerptChars?: number; maxAttempts?: number; })",
    description:
      "Canonicalize noisy/duplicate candidate sets into stable clusters with one preferred canonical document per cluster.",
    usageExample: {
      tool: "documents.canonicalize_candidates",
      args: {
        queries: ["campaign detail", "campaign tracking event"],
        strict: true,
        titleSimilarityThreshold: 0.8,
        view: "summary",
      },
    },
    bestPractices: [
      "Feed this tool with multi-query retrieval inputs before answer generation to reduce duplicate/noisy context.",
      "Use strict=true + strictThreshold when low-confidence matches should be dropped from canonical clusters.",
      "Inspect duplicateIds/memberCount to detect ambiguous sources before applying changes.",
    ],
    handler: documentsCanonicalizeCandidatesTool,
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
      "For multi-query runs, duplicate document hydration is automatically cached within the same tool call.",
      "Prefer `view=summary` unless a full markdown body is strictly needed.",
    ],
    handler: searchExpandTool,
  },
  "search.research": {
    signature:
      "search.research(args: { question?: string; query?: string; queries?: string[]; collectionId?: string; limitPerQuery?: number; offset?: number; includeTitleSearch?: boolean; includeSemanticSearch?: boolean; precisionMode?: 'balanced'|'precision'|'recall'; minScore?: number; diversify?: boolean; diversityLambda?: number; rrfK?: number; expandLimit?: number; maxDocuments?: number; seenIds?: string[]; view?: 'ids'|'summary'|'full'; perQueryView?: 'ids'|'summary'|'full'; perQueryHitLimit?: number; evidencePerDocument?: number; suggestedQueryLimit?: number; includePerQuery?: boolean; includeExpanded?: boolean; includeCoverage?: boolean; includeBacklinks?: boolean; backlinksLimit?: number; backlinksConcurrency?: number; concurrency?: number; hydrateConcurrency?: number; contextChars?: number; excerptChars?: number; maxAttempts?: number; })",
    description:
      "Run multi-query, multi-source research retrieval with weighted reranking, optional diversification, hydration, and follow-up cursor support for multi-turn QA.",
    usageExample: {
      tool: "search.research",
      args: {
        question: "How do we run incident communication and escalation?",
        queries: ["incident comms", "escalation matrix"],
        includeTitleSearch: true,
        includeSemanticSearch: true,
        precisionMode: "precision",
        limitPerQuery: 8,
        perQueryHitLimit: 4,
        evidencePerDocument: 3,
        expandLimit: 5,
        includeBacklinks: true,
        backlinksLimit: 3,
        view: "summary",
      },
    },
    bestPractices: [
      "Pass prior `next.seenIds` into `seenIds` for follow-up turns to avoid repetition.",
      "Use `precisionMode=precision` for answer-grade retrieval and `precisionMode=recall` for exploration.",
      "Set `perQueryView=ids` + `perQueryHitLimit` to reduce token cost while preserving traceability.",
      "Enable `includeBacklinks` when one-call context gathering is more important than raw latency.",
      "Keep `expandLimit` small and raise only when answer confidence is insufficient.",
    ],
    handler: searchResearchTool,
  },
};
