import { ApiError, CliError } from "./errors.js";
import {
  assertPerformAction,
  consumeDocumentDeleteReadReceipt,
  getDocumentDeleteReadReceipt,
  issueDocumentDeleteReadReceipt,
} from "./action-gate.js";
import { mapLimit, toBoolean, toInteger } from "./utils.js";

function summarizePolicies(policies = []) {
  const truthyAbilityCounts = {};
  const falsyAbilityCounts = {};

  for (const policy of policies || []) {
    const abilities = policy?.abilities;
    if (!abilities || typeof abilities !== "object") {
      continue;
    }
    for (const [ability, enabled] of Object.entries(abilities)) {
      if (enabled) {
        truthyAbilityCounts[ability] = (truthyAbilityCounts[ability] || 0) + 1;
      } else {
        falsyAbilityCounts[ability] = (falsyAbilityCounts[ability] || 0) + 1;
      }
    }
  }

  const topTruthy = Object.entries(truthyAbilityCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 25)
    .map(([ability, count]) => ({ ability, count }));

  return {
    policyCount: Array.isArray(policies) ? policies.length : 0,
    truthyAbilityCounts,
    falsyAbilityCounts,
    topTruthy,
  };
}

async function capabilitiesMapTool(ctx, args) {
  const includePolicies = toBoolean(args.includePolicies, false);
  const includeRaw = toBoolean(args.includeRaw, false);

  async function probe(method, body) {
    try {
      const res = await ctx.client.call(method, body, { maxAttempts: 1 });
      return {
        ok: true,
        status: 200,
        data: res.body?.data,
        policies: Array.isArray(res.body?.policies) ? res.body.policies : [],
      };
    } catch (err) {
      if (err instanceof ApiError) {
        return {
          ok: false,
          status: err.details.status,
          error: err.message,
          data: null,
          policies: [],
        };
      }
      throw err;
    }
  }

  function inferCapability(policySummary, abilityKeys) {
    const hasTruthy = abilityKeys.some((key) => (policySummary.truthyAbilityCounts[key] || 0) > 0);
    if (hasTruthy) {
      return true;
    }
    const hasAnySignal = abilityKeys.some(
      (key) => (policySummary.truthyAbilityCounts[key] || 0) + (policySummary.falsyAbilityCounts[key] || 0) > 0
    );
    if (hasAnySignal) {
      return false;
    }
    return null;
  }

  const authRes = await ctx.client.call("auth.info", {});
  const user = authRes.body?.data?.user || null;
  const team = authRes.body?.data?.team || null;
  const role = user?.role || "unknown";

  const collectionsProbe = await probe("collections.list", { limit: 3, offset: 0 });
  const documentsProbe = await probe("documents.list", { limit: 3, offset: 0 });
  const searchProbe = await probe("documents.search_titles", { query: "a", limit: 1, offset: 0 });

  const evidencePolicies = [
    ...(Array.isArray(authRes.body?.policies) ? authRes.body.policies : []),
    ...collectionsProbe.policies,
    ...documentsProbe.policies,
    ...searchProbe.policies,
  ];
  const policySummary = summarizePolicies(evidencePolicies);

  const canCreateCollection = inferCapability(policySummary, ["createCollection"]);
  const canCreateDocumentInSomeCollection = inferCapability(policySummary, [
    "createDocument",
    "createChildDocument",
  ]);
  const canUpdateSomeDocument = inferCapability(policySummary, [
    "update",
    "updateDocument",
    "archive",
    "unarchive",
  ]);
  const canDeleteSomeDocument = inferCapability(policySummary, ["delete", "permanentDelete"]);

  const canCreate =
    canCreateCollection === true || canCreateDocumentInSomeCollection === true
      ? true
      : canCreateCollection === false && canCreateDocumentInSomeCollection === false
        ? false
        : null;

  const canUpdate = canUpdateSomeDocument;
  const canDelete = canDeleteSomeDocument;

  const capabilities = {
    canRead: true,
    canSearch: searchProbe.ok,
    canList: collectionsProbe.ok && documentsProbe.ok,
    canCreate,
    canUpdate,
    canDelete,
    canCreateCollection,
    canCreateDocumentInSomeCollection,
    canUpdateSomeDocument,
    canDeleteSomeDocument,
    role,
    isAdmin: role === "admin",
    isViewer: role === "viewer",
  };

  const result = {
    user: user
      ? {
          id: user.id,
          name: user.name,
          email: user.email,
          role,
        }
      : null,
    team: team
      ? {
          id: team.id,
          name: team.name,
          url: team.url,
        }
      : null,
    capabilities,
    policySummary,
    evidence: {
      probes: {
        collectionsList: {
          ok: collectionsProbe.ok,
          status: collectionsProbe.status,
          error: collectionsProbe.error,
        },
        documentsList: {
          ok: documentsProbe.ok,
          status: documentsProbe.status,
          error: documentsProbe.error,
        },
        documentsSearchTitles: {
          ok: searchProbe.ok,
          status: searchProbe.status,
          error: searchProbe.error,
        },
      },
    },
  };

  if (includeRaw) {
    result.raw = {
      authInfo: authRes.body,
      collectionsProbe,
      documentsProbe,
      searchProbe,
    };
  }

  if (!includePolicies) {
    result.policySummary = {
      policyCount: policySummary.policyCount,
      topTruthy: policySummary.topTruthy,
    };
  }

  return {
    tool: "capabilities.map",
    profile: ctx.profile.id,
    result,
  };
}

function assertSafeMarkerPrefix(markerPrefix, allowUnsafePrefix) {
  if (typeof markerPrefix !== "string" || markerPrefix.length < 8) {
    throw new CliError("markerPrefix must be a string with length >= 8");
  }

  if (
    !allowUnsafePrefix &&
    !markerPrefix.startsWith("outline-cli-") &&
    !markerPrefix.startsWith("outline-agent-")
  ) {
    throw new CliError(
      "Unsafe markerPrefix blocked. Use prefix starting with 'outline-cli-' (or legacy 'outline-agent-') or pass allowUnsafePrefix=true",
      { code: "UNSAFE_MARKER_PREFIX", markerPrefix }
    );
  }
}

function normalizeDeleteCandidate(row, markerPrefix) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const title = row.title || row?.document?.title;
  const id = row.id || row?.document?.id;
  if (!id || !title || !title.startsWith(markerPrefix)) {
    return null;
  }

  const updatedAt = row.updatedAt || row?.document?.updatedAt;
  const createdAt = row.createdAt || row?.document?.createdAt;

  return {
    id,
    title,
    updatedAt: updatedAt || null,
    createdAt: createdAt || null,
    collectionId: row.collectionId || row?.document?.collectionId || null,
  };
}

function isOlderThan(candidate, olderThanHours) {
  if (!olderThanHours || olderThanHours <= 0) {
    return true;
  }

  const at = candidate.updatedAt || candidate.createdAt;
  if (!at) {
    return false;
  }

  const ts = Date.parse(at);
  if (!Number.isFinite(ts)) {
    return false;
  }

  const ageMs = Date.now() - ts;
  return ageMs >= olderThanHours * 3600 * 1000;
}

async function safeDeleteCandidate(ctx, candidate, maxAttempts) {
  const evidence = {
    tokenIssued: false,
    revisionChecked: false,
    deleted: false,
  };

  let readToken;
  try {
    const armedInfo = await ctx.client.call("documents.info", { id: candidate.id }, { maxAttempts });
    const receipt = await issueDocumentDeleteReadReceipt({
      profileId: ctx.profile.id,
      documentId: candidate.id,
      revision: armedInfo.body?.data?.revision,
      title: armedInfo.body?.data?.title || candidate.title,
      ttlSeconds: 900,
    });
    readToken = receipt.token;
    evidence.tokenIssued = true;

    const verified = await getDocumentDeleteReadReceipt({
      token: readToken,
      profileId: ctx.profile.id,
      documentId: candidate.id,
    });

    const latest = await ctx.client.call("documents.info", { id: candidate.id }, { maxAttempts });
    const expectedRevision = Number(verified.revision);
    const actualRevision = Number(latest.body?.data?.revision);
    evidence.revisionChecked = true;
    evidence.expectedRevision = Number.isFinite(expectedRevision) ? expectedRevision : null;
    evidence.actualRevision = Number.isFinite(actualRevision) ? actualRevision : null;

    if (
      Number.isFinite(expectedRevision) &&
      Number.isFinite(actualRevision) &&
      expectedRevision !== actualRevision
    ) {
      throw new CliError("Delete read confirmation is stale; re-read document with armDelete=true", {
        code: "DELETE_READ_TOKEN_STALE",
        id: candidate.id,
        expectedRevision,
        actualRevision,
      });
    }

    const deleted = await ctx.client.call("documents.delete", { id: candidate.id }, { maxAttempts });
    const success = deleted.body?.success !== false;
    evidence.deleted = success;
    if (success) {
      await consumeDocumentDeleteReadReceipt(readToken);
    }

    return {
      id: candidate.id,
      title: candidate.title,
      ok: success,
      ...evidence,
    };
  } catch (err) {
    if (err instanceof ApiError || err instanceof CliError) {
      return {
        id: candidate.id,
        title: candidate.title,
        ok: false,
        status: err instanceof ApiError ? err.details.status : undefined,
        error: err.message,
        ...evidence,
      };
    }
    throw err;
  }
}

async function directDeleteCandidate(ctx, candidate, maxAttempts) {
  const evidence = {
    tokenIssued: false,
    revisionChecked: false,
    deleted: false,
  };
  try {
    const deleted = await ctx.client.call("documents.delete", { id: candidate.id }, { maxAttempts });
    const success = deleted.body?.success !== false;
    evidence.deleted = success;
    return {
      id: candidate.id,
      title: candidate.title,
      ok: success,
      ...evidence,
    };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        id: candidate.id,
        title: candidate.title,
        ok: false,
        status: err.details.status,
        error: err.message,
        ...evidence,
      };
    }
    throw err;
  }
}

async function documentsCleanupTestTool(ctx, args) {
  const markerPrefix = args.markerPrefix || "outline-cli-live-test-";
  const dryRun = toBoolean(args.dryRun, true);
  const deleteMode = args.deleteMode === "direct" ? "direct" : "safe";
  const olderThanHours = toInteger(args.olderThanHours, 0);
  const maxPages = Math.max(1, Math.min(50, toInteger(args.maxPages, 8)));
  const pageLimit = Math.max(1, Math.min(100, toInteger(args.pageLimit, 50)));
  const concurrency = Math.max(1, Math.min(10, toInteger(args.concurrency, 3)));
  const allowUnsafePrefix = toBoolean(args.allowUnsafePrefix, false);
  const includeErrors = toBoolean(args.includeErrors, true);

  assertSafeMarkerPrefix(markerPrefix, allowUnsafePrefix);

  if (!dryRun) {
    assertPerformAction(args, {
      tool: "documents.cleanup_test",
      action: "delete test documents",
    });
  }

  const scanned = [];
  let offset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    const res = await ctx.client.call("documents.search_titles", {
      query: markerPrefix,
      limit: pageLimit,
      offset,
      sort: "updatedAt",
      direction: "DESC",
    });

    const rows = Array.isArray(res.body?.data) ? res.body.data : [];
    scanned.push(...rows);

    if (rows.length < pageLimit) {
      break;
    }
    offset += pageLimit;
  }

  // Some deployments return limited title-search results by default.
  // We add a second bounded pass explicitly targeting draft status.
  let draftOffset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    try {
      const draftRes = await ctx.client.call("documents.search_titles", {
        query: markerPrefix,
        limit: pageLimit,
        offset: draftOffset,
        sort: "updatedAt",
        direction: "DESC",
        statusFilter: ["draft"],
      });

      const rows = Array.isArray(draftRes.body?.data) ? draftRes.body.data : [];
      scanned.push(...rows);

      if (rows.length < pageLimit) {
        break;
      }
      draftOffset += pageLimit;
    } catch {
      break;
    }
  }

  // Final fallback for deployments where search_titles omits recent drafts.
  let listOffset = 0;
  for (let page = 0; page < maxPages; page += 1) {
    try {
      const listRes = await ctx.client.call("documents.list", {
        limit: pageLimit,
        offset: listOffset,
        sort: "updatedAt",
        direction: "DESC",
      });

      const rows = Array.isArray(listRes.body?.data) ? listRes.body.data : [];
      scanned.push(...rows);

      if (rows.length < pageLimit) {
        break;
      }
      listOffset += pageLimit;
    } catch {
      break;
    }
  }

  const dedup = new Map();
  for (const row of scanned) {
    const candidate = normalizeDeleteCandidate(row, markerPrefix);
    if (!candidate) {
      continue;
    }
    if (!isOlderThan(candidate, olderThanHours)) {
      continue;
    }
    dedup.set(candidate.id, candidate);
  }

  const candidates = Array.from(dedup.values()).sort((a, b) => {
    const aAt = Date.parse(a.updatedAt || a.createdAt || 0);
    const bAt = Date.parse(b.updatedAt || b.createdAt || 0);
    return bAt - aAt;
  });

  if (dryRun) {
    return {
      tool: "documents.cleanup_test",
      profile: ctx.profile.id,
      result: {
        markerPrefix,
        deleteMode,
        dryRun: true,
        scannedCount: scanned.length,
        candidateCount: candidates.length,
        deletedCount: 0,
        candidates,
      },
    };
  }

  const deleteMaxAttempts = 1;
  const deleteResults = await mapLimit(candidates, concurrency, async (candidate) => {
    if (deleteMode === "direct") {
      return directDeleteCandidate(ctx, candidate, deleteMaxAttempts);
    }
    return safeDeleteCandidate(ctx, candidate, deleteMaxAttempts);
  });

  const failures = deleteResults.filter((r) => !r.ok);
  const deleted = deleteResults.filter((r) => r.ok);

  return {
    tool: "documents.cleanup_test",
    profile: ctx.profile.id,
    result: {
      markerPrefix,
      deleteMode,
      dryRun: false,
      scannedCount: scanned.length,
      candidateCount: candidates.length,
      deletedCount: deleted.length,
      failedCount: failures.length,
      deleted,
      errors: includeErrors ? failures : undefined,
    },
  };
}

export const PLATFORM_TOOLS = {
  "capabilities.map": {
    signature: "capabilities.map(args?: { includePolicies?: boolean; includeRaw?: boolean })",
    description: "Return effective profile capabilities from auth context and optional policy summary.",
    usageExample: {
      tool: "capabilities.map",
      args: {
        includePolicies: true,
      },
    },
    bestPractices: [
      "Call once before planning mutating operations.",
      "Use includePolicies=true when you need per-resource ability inference.",
      "Keep includeRaw=false unless debugging capability mismatches.",
    ],
    handler: capabilitiesMapTool,
  },
  "documents.cleanup_test": {
    signature:
      "documents.cleanup_test(args?: { markerPrefix?: string; olderThanHours?: number; dryRun?: boolean; deleteMode?: 'safe'|'direct'; maxPages?: number; pageLimit?: number; concurrency?: number; allowUnsafePrefix?: boolean; performAction?: boolean })",
    description: "Find and optionally delete test-created documents by marker prefix.",
    usageExample: {
      tool: "documents.cleanup_test",
      args: {
        markerPrefix: "outline-cli-live-test-",
        olderThanHours: 24,
        dryRun: true,
        deleteMode: "safe",
      },
    },
    bestPractices: [
      "Use dryRun=true first to review deletion set.",
      "Keep markerPrefix specific to your test suite to avoid accidental deletes.",
      "Use deleteMode=safe (default) to enforce read-token and revision checks before delete.",
      "Avoid allowUnsafePrefix unless operating in an isolated sandbox.",
      "When dryRun=false this tool is action-gated; set performAction=true only after explicit confirmation.",
    ],
    handler: documentsCleanupTestTool,
  },
};
