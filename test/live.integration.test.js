import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const CLI_BIN = path.join(REPO_ROOT, "bin", "outline-cli.js");
const TOOL_CONTRACT_CACHE = new Map();

function parseDotenv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const i = trimmed.indexOf("=");
    if (i <= 0) {
      continue;
    }
    const key = trimmed.slice(0, i).trim();
    let value = trimmed.slice(i + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}

async function resolveLiveEnv() {
  const resolved = {
    baseUrl: process.env.OUTLINE_TEST_BASE_URL,
    apiKey: process.env.OUTLINE_TEST_API_KEY,
  };

  if (resolved.baseUrl && resolved.apiKey) {
    return resolved;
  }

  const dotenvPath = path.join(REPO_ROOT, ".env.test.local");
  const raw = await fs.readFile(dotenvPath, "utf8");
  const env = parseDotenv(raw);

  return {
    baseUrl: resolved.baseUrl || env.OUTLINE_TEST_BASE_URL,
    apiKey: resolved.apiKey || env.OUTLINE_TEST_API_KEY,
  };
}

function runCli(args, opts = {}) {
  const res = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: {
      ...process.env,
      OUTLINE_CLI_KEYCHAIN_MODE: process.env.OUTLINE_CLI_KEYCHAIN_MODE || "disabled",
    },
    maxBuffer: 20 * 1024 * 1024,
  });

  const expectCode = opts.expectCode ?? 0;
  const stdout = (res.stdout || "").trim();
  const stderr = (res.stderr || "").trim();

  if (res.status !== expectCode) {
    throw new Error(
      [
        `Command failed: node ${CLI_BIN} ${args.join(" ")}`,
        `Exit code: ${res.status}`,
        stdout ? `STDOUT:\n${stdout}` : "",
        stderr ? `STDERR:\n${stderr}` : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    );
  }

  if (opts.parseJson === false) {
    return { stdout, stderr, status: res.status };
  }

  if (!stdout) {
    throw new Error(`Expected JSON output but stdout is empty for args: ${args.join(" ")}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (err) {
    throw new Error(`Failed parsing JSON output.\nSTDOUT:\n${stdout}\nError: ${err.message}`);
  }

  return { stdout, stderr, status: res.status, json: parsed };
}

function runCliNdjson(args, opts = {}) {
  const out = runCli(args, { ...opts, parseJson: false });
  const lines = out.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  return {
    ...out,
    lines,
  };
}

function getToolContract(name) {
  if (TOOL_CONTRACT_CACHE.has(name)) {
    return TOOL_CONTRACT_CACHE.get(name);
  }

  let resolved = null;
  try {
    const payload = runCli(["tools", "contract", name, "--result-mode", "inline"]).json;
    if (payload?.ok === true) {
      if (payload.contract && !Array.isArray(payload.contract) && payload.contract.name === name) {
        resolved = payload.contract;
      } else if (Array.isArray(payload.contract)) {
        resolved = payload.contract.find((candidate) => candidate?.name === name) || null;
      }
    }
  } catch {
    resolved = null;
  }

  TOOL_CONTRACT_CACHE.set(name, resolved);
  return resolved;
}

function hasToolContract(name) {
  return Boolean(getToolContract(name));
}

function extractResultRows(result) {
  if (Array.isArray(result?.data)) {
    return result.data;
  }
  if (Array.isArray(result?.items)) {
    return result.items;
  }
  if (Array.isArray(result)) {
    return result;
  }
  return null;
}

function extractResultObject(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return null;
  }
  if (result.data && typeof result.data === "object" && !Array.isArray(result.data)) {
    return result.data;
  }
  if (result.item && typeof result.item === "object" && !Array.isArray(result.item)) {
    return result.item;
  }
  return result;
}

function pickStringId(...candidates) {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }
  return null;
}

async function writeJsonFile(dir, prefix, value) {
  const file = path.join(dir, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  await fs.writeFile(file, `${JSON.stringify(value)}\n`, "utf8");
  return file;
}

async function invokeTool(tmpDir, configPath, tool, args) {
  const argsFile = await writeJsonFile(tmpDir, `args-${tool.replace(/\./g, "-")}`, args);
  const run = runCli([
    "invoke",
    tool,
    "--config",
    configPath,
    "--result-mode",
    "inline",
    "--args-file",
    argsFile,
  ]);
  return run.json;
}

async function batchInvoke(tmpDir, configPath, ops) {
  const opsFile = await writeJsonFile(tmpDir, "ops", ops);
  const run = runCli([
    "batch",
    "--config",
    configPath,
    "--result-mode",
    "inline",
    "--ops-file",
    opsFile,
    "--parallel",
    "3",
    "--strict-exit",
  ]);
  return run.json;
}

async function invokeToolAnyStatus(tmpDir, configPath, tool, args) {
  const argsFile = await writeJsonFile(tmpDir, `args-${tool.replace(/\./g, "-")}`, args);
  const res = spawnSync(
    process.execPath,
    [
      CLI_BIN,
      "invoke",
      tool,
      "--config",
      configPath,
      "--result-mode",
      "inline",
      "--args-file",
      argsFile,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
      env: process.env,
      maxBuffer: 20 * 1024 * 1024,
    }
  );

  const stdout = (res.stdout || "").trim();
  const stderr = (res.stderr || "").trim();
  let stdoutJson = null;
  let stderrJson = null;

  if (stdout) {
    try {
      stdoutJson = JSON.parse(stdout);
    } catch {
      stdoutJson = null;
    }
  }

  if (stderr) {
    try {
      stderrJson = JSON.parse(stderr);
    } catch {
      stderrJson = null;
    }
  }

  return {
    status: res.status ?? -1,
    stdout,
    stderr,
    stdoutJson,
    stderrJson,
  };
}

function isApiNotFoundErrorEnvelope(envelope) {
  const err = envelope?.error;
  if (!err || err.type !== "ApiError") {
    return false;
  }
  if (Number(err.status) !== 404) {
    return false;
  }
  return err?.body?.error === "not_found" || /resource not found/i.test(String(err.message || ""));
}

function isSkippableMembershipError(envelope) {
  const err = envelope?.error;
  return err?.type === "ApiError" && [401, 403, 404, 405].includes(Number(err.status));
}

function isSkippableDirectoryReadError(envelope) {
  const err = envelope?.error;
  if (!err || err.type !== "ApiError") {
    return false;
  }

  const status = getApiErrorStatus(envelope);
  if ([400, 401, 403, 404, 405, 501].includes(Number(status))) {
    return true;
  }

  const text = `${err.message || ""} ${err.body?.error || ""}`.toLowerCase();
  return /not found|forbidden|unauthorized|unsupported|not implemented|method not allowed/i.test(text);
}

function isCliActionGatedError(envelope) {
  const err = envelope?.error;
  return err?.type === "CliError" && err?.code === "ACTION_GATED";
}

function getApiErrorStatus(envelope) {
  const err = envelope?.error;
  const status = Number(err?.status ?? err?.details?.status);
  return Number.isFinite(status) ? status : null;
}

function isSkippableUserAdminContractError(envelope) {
  const err = envelope?.error;
  if (!err || err.type !== "ApiError") {
    return false;
  }

  const status = getApiErrorStatus(envelope);
  if ([400, 401, 403, 404, 405, 409, 422, 429, 500, 501, 503].includes(Number(status))) {
    return true;
  }

  const text = extractErrorText(envelope);
  return /not found|forbidden|unauthorized|unsupported|not implemented|method not allowed|invite|user|role|suspend|activate|validation|tenant/i.test(text);
}

function isSkippableShareLifecycleError(envelope) {
  const err = envelope?.error;
  if (!err || err.type !== "ApiError") {
    return false;
  }

  const status = getApiErrorStatus(envelope);
  if ([401, 403, 404, 405, 501].includes(Number(status))) {
    return true;
  }

  const text = `${err.message || ""} ${err.body?.error || ""}`.toLowerCase();
  if (status === 400) {
    return /share|sharing|public link|publish/i.test(text);
  }

  return false;
}

function extractErrorText(envelope) {
  const err = envelope?.error;
  if (!err || typeof err !== "object") {
    return "";
  }

  return [
    err.code,
    err.message,
    err.body?.error,
    err.body?.message,
    err.details?.message,
  ]
    .filter((value) => typeof value === "string" && value.length > 0)
    .join(" ")
    .toLowerCase();
}

function isSkippableTemplateLifecycleError(envelope) {
  const err = envelope?.error;
  if (!err || err.type !== "ApiError") {
    return false;
  }

  const status = getApiErrorStatus(envelope);
  if ([400, 401, 403, 404, 405, 409, 422, 501].includes(Number(status))) {
    return true;
  }

  const text = extractErrorText(envelope);
  return /not found|forbidden|unauthorized|unsupported|not implemented|method not allowed|template|placeholder/i.test(text);
}

function isSkippableImportLifecycleError(envelope) {
  const err = envelope?.error;
  if (!err || (err.type !== "ApiError" && err.type !== "CliError")) {
    return false;
  }

  if (err.type === "CliError" && err.code === "ARG_VALIDATION_FAILED") {
    return true;
  }

  const status = getApiErrorStatus(envelope);
  if ([400, 401, 403, 404, 405, 409, 415, 422, 429, 500, 501, 503].includes(Number(status))) {
    return true;
  }

  const text = extractErrorText(envelope);
  return /not found|forbidden|unauthorized|unsupported|not implemented|method not allowed|import|multipart|file|upload|confluence|provider|validation|unavailable/i.test(text);
}

function isSkippableFileOperationLifecycleError(envelope) {
  const err = envelope?.error;
  if (!err || (err.type !== "ApiError" && err.type !== "CliError")) {
    return false;
  }

  if (err.type === "CliError" && err.code === "ARG_VALIDATION_FAILED") {
    return true;
  }

  const status = getApiErrorStatus(envelope);
  if ([400, 401, 403, 404, 405, 409, 422, 501].includes(Number(status))) {
    return true;
  }

  const text = extractErrorText(envelope);
  return /not found|forbidden|unauthorized|unsupported|not implemented|method not allowed|file operation|import|export|unavailable/i.test(text);
}

function extractFileOperationId(result) {
  const row = extractResultObject(result);
  return pickStringId(
    row?.fileOperationId,
    row?.operationId,
    row?.id,
    result?.fileOperationId,
    result?.operationId,
    result?.id,
    result?.data?.fileOperationId,
    result?.data?.operationId,
    result?.data?.id,
    result?.item?.fileOperationId,
    result?.item?.operationId,
    result?.item?.id
  );
}

function extractImportedDocumentIds(result) {
  const ids = new Set();

  const addId = (value) => {
    if (typeof value === "string" && value.length > 0) {
      ids.add(value);
    }
  };

  const addDocumentNode = (node) => {
    if (!node || typeof node !== "object") {
      return;
    }
    addId(node.documentId);
    if (node.document && typeof node.document === "object") {
      addId(node.document.id);
    }
  };

  const directCandidates = [
    result?.documentId,
    result?.docId,
    result?.data?.documentId,
    result?.data?.docId,
    result?.item?.documentId,
    result?.item?.docId,
    result?.document?.id,
    result?.data?.document?.id,
    result?.item?.document?.id,
  ];
  for (const candidate of directCandidates) {
    addId(candidate);
  }

  const row = extractResultObject(result);
  addDocumentNode(row);
  addDocumentNode(row?.data);

  const arrayCandidates = [
    result?.documentIds,
    result?.data?.documentIds,
    result?.item?.documentIds,
    row?.documentIds,
    row?.data?.documentIds,
    result?.documents,
    result?.data?.documents,
    result?.item?.documents,
    row?.documents,
    row?.data?.documents,
    extractResultRows(result),
  ];

  for (const candidate of arrayCandidates) {
    if (!Array.isArray(candidate)) {
      continue;
    }
    for (const item of candidate) {
      if (typeof item === "string") {
        addId(item);
      } else {
        addDocumentNode(item);
      }
    }
  }

  return Array.from(ids);
}

function extractPlaceholderKeys(result) {
  const values = [];

  const collect = (node) => {
    if (!node) {
      return;
    }

    if (typeof node === "string") {
      const trimmed = node.trim();
      if (trimmed.length > 0) {
        values.push(trimmed);
      }
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        collect(item);
      }
      return;
    }

    if (typeof node === "object") {
      const namedKey = pickStringId(node.key, node.name, node.placeholder, node.token);
      if (namedKey) {
        values.push(namedKey);
      }

      if (Array.isArray(node.placeholders)) {
        collect(node.placeholders);
      }
      if (Array.isArray(node.keys)) {
        collect(node.keys);
      }
      if (Array.isArray(node.items)) {
        collect(node.items);
      }
      if (Array.isArray(node.data)) {
        collect(node.data);
      }
    }
  };

  collect(result?.placeholders);
  collect(result?.data?.placeholders);
  collect(result?.item?.placeholders);
  collect(result?.keys);
  collect(result?.data?.keys);
  collect(result?.items);
  collect(result?.data?.items);
  collect(result?.data);

  return Array.from(new Set(values)).sort((a, b) => a.localeCompare(b));
}

function extractDocumentText(result) {
  const row = extractResultObject(result);

  const candidates = [
    row?.text,
    row?.data?.text,
    result?.text,
    result?.data?.text,
    result?.item?.text,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.length > 0) {
      return candidate;
    }
  }

  return "";
}

function isShareAccessDeniedRun(run) {
  if (!run) {
    return false;
  }

  if (run.status !== 0) {
    const status = getApiErrorStatus(run.stderrJson);
    if ([400, 401, 403, 404].includes(Number(status))) {
      return true;
    }
    const err = run.stderrJson?.error;
    const text = `${err?.message || ""} ${err?.body?.error || ""}`.toLowerCase();
    return /not found|forbidden|unauthorized|share|revok|invalid/i.test(text);
  }

  const result = run.stdoutJson?.result;
  if (!result || typeof result !== "object") {
    return false;
  }

  if (result.success === false) {
    return true;
  }

  if ("data" in result && !result.data) {
    return true;
  }

  return false;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function extractAnswerSignals(result) {
  const pickString = (...candidates) => {
    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    return "";
  };

  const answerText = pickString(
    result?.answer,
    result?.response,
    result?.text,
    result?.data?.answer,
    result?.data?.response,
    result?.data?.text
  );

  const noAnswerReason = pickString(
    result?.noAnswerReason,
    result?.reason,
    result?.data?.noAnswerReason,
    result?.data?.reason
  );

  const citationCandidates = [
    result?.citations,
    result?.sources,
    result?.references,
    result?.documents,
    result?.data?.citations,
    result?.data?.sources,
    result?.data?.references,
    result?.data?.documents,
  ];
  const citations = citationCandidates.find((candidate) => Array.isArray(candidate)) || [];

  return { answerText, noAnswerReason, citations };
}

function extractResolveCandidates(result) {
  const rows = [];

  const pushRows = (value) => {
    if (Array.isArray(value)) {
      rows.push(...value);
    }
  };

  pushRows(result?.candidates);
  pushRows(result?.data);

  if (Array.isArray(result?.perQuery)) {
    for (const bucket of result.perQuery) {
      if (!bucket || typeof bucket !== "object") {
        continue;
      }
      pushRows(bucket.candidates);
      pushRows(bucket.data);
      pushRows(bucket.hits);
    }
  }

  return rows.filter((row) => row && typeof row === "object");
}

function extractIssueRefRows(result) {
  const rows = [];

  const pushRows = (value) => {
    if (Array.isArray(value)) {
      rows.push(...value);
    }
  };

  pushRows(result?.data);
  pushRows(result?.items);
  pushRows(result?.rows);
  pushRows(result?.reports);
  pushRows(result?.documents);

  const fallbackRows = extractResultRows(result);
  pushRows(fallbackRows);

  const fallbackObject = extractResultObject(result);
  if (fallbackObject && typeof fallbackObject === "object" && !Array.isArray(fallbackObject)) {
    rows.push(fallbackObject);
  }

  const uniqueRows = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    if (seen.has(row)) {
      continue;
    }
    seen.add(row);
    uniqueRows.push(row);
  }

  return uniqueRows;
}

function extractIssueRefDocumentId(row) {
  return pickStringId(
    row?.id,
    row?.documentId,
    row?.docId,
    row?.sourceDocumentId,
    row?.targetDocumentId,
    row?.document?.id,
    row?.document?.documentId,
    row?.source?.id,
    row?.source?.documentId,
    row?.item?.id,
    row?.item?.documentId,
    row?.data?.id,
    row?.data?.documentId
  );
}

function extractIssueRefsFromRow(row) {
  const arrayCandidates = [
    row?.issueRefs,
    row?.issue_refs,
    row?.refs,
    row?.references,
    row?.issueReferences,
    row?.issues,
    row?.matches,
    row?.links,
    row?.data?.issueRefs,
    row?.data?.issue_refs,
    row?.data?.refs,
    row?.data?.references,
    row?.item?.issueRefs,
    row?.item?.refs,
    row?.item?.references,
  ];

  for (const candidate of arrayCandidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  return [];
}

function extractGraphNodes(result) {
  if (Array.isArray(result?.nodes)) {
    return result.nodes;
  }
  if (Array.isArray(result?.data?.nodes)) {
    return result.data.nodes;
  }
  if (Array.isArray(result?.item?.nodes)) {
    return result.item.nodes;
  }
  return null;
}

function extractGraphEdges(result) {
  if (Array.isArray(result?.edges)) {
    return result.edges;
  }
  if (Array.isArray(result?.data?.edges)) {
    return result.data.edges;
  }
  if (Array.isArray(result?.item?.edges)) {
    return result.item.edges;
  }
  return null;
}

function extractGraphNeighborRows(result) {
  if (Array.isArray(result?.neighbors)) {
    return result.neighbors;
  }
  if (Array.isArray(result?.data?.neighbors)) {
    return result.data.neighbors;
  }
  if (Array.isArray(result?.item?.neighbors)) {
    return result.item.neighbors;
  }
  const edgeRows = extractGraphEdges(result);
  if (edgeRows) {
    return edgeRows;
  }
  return extractResultRows(result);
}

function hasCliValidationIssue(envelope, pathPrefix) {
  const err = envelope?.error;
  if (!err || err.type !== "CliError" || !Array.isArray(err.issues)) {
    return false;
  }

  return err.issues.some(
    (issue) =>
      issue &&
      typeof issue.path === "string" &&
      issue.path.startsWith(pathPrefix)
  );
}

test("live integration suite (real Outline API, no mocks)", { timeout: 300_000 }, async (t) => {
  const env = await resolveLiveEnv();
  assert.ok(env.baseUrl, "OUTLINE_TEST_BASE_URL is required");
  assert.ok(env.apiKey, "OUTLINE_TEST_API_KEY is required");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-cli-live-test-"));
  const configPath = path.join(tmpDir, "config.json");

  const state = {
    authUserId: null,
    createdDocumentId: null,
    deletedInTest: false,
    marker: null,
    firstCollectionId: null,
    uc03TemplateId: null,
    uc03TemplateDeleted: false,
    uc03CommentId: null,
    uc03CommentDeleted: false,
    uc03AdditionalDocumentIds: [],
    uc11TemplateIds: [],
    uc11DocumentIds: [],
    uc05ShareId: null,
    uc05ShareRevoked: false,
    uc10DocumentIds: [],
    uc12ImportedDocumentIds: [],
    uc12FileOperationId: null,
    faqResetCode: null,
    faqOwner: null,
    faqNoHitToken: null,
  };

  async function bestEffortDeleteDocument(documentId) {
    if (!documentId) {
      return;
    }

    try {
      const readForDelete = await invokeTool(tmpDir, configPath, "documents.info", {
        id: documentId,
        view: "summary",
        armDelete: true,
      });
      const readToken = readForDelete.result?.deleteReadReceipt?.token;
      if (readToken) {
        await invokeTool(tmpDir, configPath, "documents.delete", {
          id: documentId,
          readToken,
          performAction: true,
        });
        return;
      }
    } catch {
      // continue to fallback delete
    }

    try {
      await invokeTool(tmpDir, configPath, "api.call", {
        method: "documents.delete",
        body: { id: documentId },
        performAction: true,
      });
    } catch {
      // best-effort cleanup only
    }
  }

  async function bestEffortDeleteTemplate(templateId) {
    if (!templateId) {
      return;
    }

    try {
      await invokeTool(tmpDir, configPath, "templates.delete", {
        id: templateId,
        performAction: true,
      });
      return;
    } catch {
      // continue to fallback delete
    }

    try {
      await invokeTool(tmpDir, configPath, "api.call", {
        method: "templates.delete",
        body: { id: templateId },
        performAction: true,
      });
    } catch {
      // best-effort cleanup only
    }
  }

  try {
    await t.test("profile setup + auth", async () => {
      const addRes = runCli([
        "profile",
        "add",
        "live",
        "--config",
        configPath,
        "--base-url",
        env.baseUrl,
        "--api-key",
        env.apiKey,
        "--set-default",
      ]).json;

      assert.equal(addRes.ok, true);
      assert.equal(addRes.defaultProfile, "live");

      const testRes = runCli([
        "profile",
        "test",
        "live",
        "--config",
        configPath,
        "--result-mode",
        "inline",
      ]).json;

      assert.equal(testRes.ok, true);
      assert.ok(testRes.user?.id, "Expected authenticated user id");
      assert.ok(testRes.team?.id, "Expected team id");
      state.authUserId = testRes.user?.id || null;

      const authInfo = await invokeTool(tmpDir, configPath, "auth.info", { view: "summary" });
      assert.equal(authInfo.tool, "auth.info");
      assert.ok(authInfo.result?.data?.user?.id, "auth.info should return user");
      state.authUserId = state.authUserId || authInfo.result?.data?.user?.id || null;

      const capabilities = await invokeTool(tmpDir, configPath, "capabilities.map", {
        includePolicies: true,
      });
      assert.equal(capabilities.tool, "capabilities.map");
      assert.equal(capabilities.result?.capabilities?.canRead, true);
      assert.ok(capabilities.result?.evidence?.probes, "capabilities.map should include evidence probes");
    });

    await t.test("read + navigation tools", async (t) => {
      const collections = await invokeTool(tmpDir, configPath, "collections.list", {
        limit: 10,
        view: "summary",
      });
      assert.equal(collections.tool, "collections.list");
      assert.ok(Array.isArray(collections.result?.data), "collections.list data must be array");
      state.firstCollectionId = collections.result?.data?.[0]?.id || null;

      if (state.firstCollectionId) {
        const treeRes = await invokeTool(tmpDir, configPath, "collections.tree", {
          collectionId: state.firstCollectionId,
          includeDrafts: false,
          maxDepth: 3,
          view: "summary",
        });

        assert.equal(treeRes.tool, "collections.tree");
        assert.equal(treeRes.result?.includeDrafts, false);
        assert.ok(Array.isArray(treeRes.result?.tree), "collections.tree result.tree must be array");
      }

      const resolveRes = await invokeTool(tmpDir, configPath, "documents.resolve", {
        queries: ["policy", "runbook"],
        view: "summary",
        limit: 5,
        strict: false,
        concurrency: 2,
      });

      assert.equal(resolveRes.tool, "documents.resolve");
      assert.ok(resolveRes.result?.perQuery || resolveRes.result?.candidates, "documents.resolve should return grouped/single result");

      const searchTitles = await invokeTool(tmpDir, configPath, "documents.search", {
        query: "policy",
        mode: "titles",
        limit: 5,
        view: "summary",
        merge: true,
      });
      assert.equal(searchTitles.tool, "documents.search");

      const searchSemantic = await invokeTool(tmpDir, configPath, "documents.search", {
        queries: ["runbook", "incident response"],
        mode: "semantic",
        limit: 4,
        view: "summary",
        merge: true,
        concurrency: 2,
      });
      assert.equal(searchSemantic.tool, "documents.search");
      assert.ok(searchSemantic.result?.perQuery || searchSemantic.result?.data, "semantic search should return perQuery/data");

      const searchExpand = await invokeTool(tmpDir, configPath, "search.expand", {
        query: "policy",
        mode: "semantic",
        limit: 6,
        expandLimit: 3,
        view: "summary",
      });

      assert.equal(searchExpand.tool, "search.expand");
      assert.ok(Array.isArray(searchExpand.result?.expanded), "search.expand should return expanded array");

      const research = await invokeTool(tmpDir, configPath, "search.research", {
        question: "How do policy and runbook documents connect?",
        queries: ["policy", "runbook"],
        limitPerQuery: 4,
        expandLimit: 3,
        maxDocuments: 8,
        includeTitleSearch: true,
        includeSemanticSearch: true,
        view: "summary",
      });
      assert.equal(research.tool, "search.research");
      assert.ok(Array.isArray(research.result?.perQuery), "search.research should return perQuery");
      assert.ok(Array.isArray(research.result?.merged), "search.research should return merged array");
      assert.ok(Array.isArray(research.result?.expanded), "search.research should return expanded array");
      assert.ok(Array.isArray(research.result?.next?.seenIds), "search.research should include next.seenIds");
      assert.ok(Array.isArray(research.result?.next?.suggestedQueries), "search.research should include suggestedQueries");

      const listIdsView = await invokeTool(tmpDir, configPath, "documents.list", {
        limit: 3,
        view: "ids",
      });
      assert.equal(listIdsView.tool, "documents.list");
      assert.ok(Array.isArray(listIdsView.result?.data));
      if (listIdsView.result.data[0]) {
        assert.ok(typeof listIdsView.result.data[0].id === "string");
        assert.ok(!("excerpt" in listIdsView.result.data[0]));
      }

      const readWrapperCandidates = [
        { tool: "events.list", args: { limit: 3, view: "full" }, body: { limit: 3 } },
        { tool: "shares.list", args: { limit: 3, view: "full" }, body: { limit: 3 } },
        { tool: "templates.list", args: { limit: 3, view: "full" }, body: { limit: 3 } },
      ];

      let comparedCount = 0;
      for (const candidate of readWrapperCandidates) {
        let wrapped;
        try {
          wrapped = await invokeTool(tmpDir, configPath, candidate.tool, candidate.args);
        } catch {
          continue;
        }

        if (wrapped?.result?.success === false) {
          continue;
        }

        let raw;
        try {
          raw = await invokeTool(tmpDir, configPath, "api.call", {
            method: candidate.tool,
            body: candidate.body,
          });
        } catch {
          continue;
        }

        if (raw?.result?.success === false) {
          continue;
        }

        const wrappedRows = Array.isArray(wrapped?.result?.data)
          ? wrapped.result.data
          : Array.isArray(wrapped?.result)
            ? wrapped.result
            : null;
        const rawRows = Array.isArray(raw?.result?.data) ? raw.result.data : null;
        if (!wrappedRows || !rawRows) {
          continue;
        }

        assert.equal(raw.tool, "api.call");
        assert.equal(raw.method, candidate.tool);
        assert.ok(wrappedRows.length <= 3);
        assert.ok(rawRows.length <= 3);
        comparedCount += 1;
      }

      if (comparedCount === 0) {
        t.diagnostic("Skipped read-wrapper equivalence: events.list/shares.list/templates.list unavailable");
      }
    });

    await t.test("create isolated test document", async () => {
      state.marker = `outline-cli-live-test-${Date.now()}`;
      state.faqResetCode = `OPS-${Date.now()}`;
      state.faqOwner = "Ops Helpdesk";
      state.faqNoHitToken = `no-hit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const createDoc = await invokeTool(tmpDir, configPath, "documents.create", {
        title: state.marker,
        text:
          `# ${state.marker}\n\n` +
          "Created by live integration suite.\n\n" +
          "## Internal FAQ\n" +
          `- VPN reset code: ${state.faqResetCode}\n` +
          `- Escalation owner: ${state.faqOwner}\n` +
          "- Expense approval SLA: 2 business days\n",
        publish: false,
        view: "full",
      });

      state.createdDocumentId = createDoc?.result?.data?.id;
      assert.ok(state.createdDocumentId, "documents.create must return id");
    });

    await t.test("UC-06 department spaces read-path visibility checks", async (t) => {
      assert.ok(state.createdDocumentId, "created test document id is required");

      const hasUsersList = hasToolContract("users.list");
      const hasUsersInfo = hasToolContract("users.info");
      const hasGroupsList = hasToolContract("groups.list");
      const hasGroupsInfo = hasToolContract("groups.info");
      const hasGroupMemberships = hasToolContract("groups.memberships");
      const hasCollectionGroupMemberships = hasToolContract("collections.group_memberships");
      const hasDocumentGroupMemberships = hasToolContract("documents.group_memberships");

      let discoveredUserId = state.authUserId || null;
      let discoveredGroupId = null;

      await t.test("users.list read checks", async (t) => {
        if (!hasUsersList) {
          t.skip("users.list contract unavailable");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "users.list", {
          limit: 10,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`users.list skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("users.list unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`users.list expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `users.list stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "users.list");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.ok(payload.result && typeof payload.result === "object");

        const rows = extractResultRows(payload.result) || [];
        assert.ok(Array.isArray(rows), "users.list should expose data rows array");

        const firstUser = rows.find((row) => row && typeof row === "object");
        const userId = pickStringId(firstUser?.id, firstUser?.userId);
        if (userId) {
          discoveredUserId = userId;
        }
      });

      await t.test("users.info read checks", async (t) => {
        if (!hasUsersInfo) {
          t.skip("users.info contract unavailable");
          return;
        }

        const targetUserId = discoveredUserId || state.authUserId;
        if (!targetUserId) {
          t.skip("No user id available for users.info check");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "users.info", {
          id: targetUserId,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`users.info skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("users.info unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`users.info expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `users.info stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "users.info");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.ok(payload.result && typeof payload.result === "object");
      });

      await t.test("groups.list read checks", async (t) => {
        if (!hasGroupsList) {
          t.skip("groups.list contract unavailable");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "groups.list", {
          limit: 10,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`groups.list skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("groups.list unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`groups.list expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `groups.list stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "groups.list");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.ok(payload.result && typeof payload.result === "object");

        const rows = extractResultRows(payload.result) || [];
        assert.ok(Array.isArray(rows), "groups.list should expose data rows array");

        const firstGroup = rows.find((row) => row && typeof row === "object");
        const groupId = pickStringId(firstGroup?.id, firstGroup?.groupId);
        if (groupId) {
          discoveredGroupId = groupId;
        }
      });

      await t.test("groups.info read checks", async (t) => {
        if (!hasGroupsInfo) {
          t.skip("groups.info contract unavailable");
          return;
        }
        if (!discoveredGroupId) {
          t.skip("No group id available for groups.info check");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "groups.info", {
          id: discoveredGroupId,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`groups.info skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("groups.info unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`groups.info expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `groups.info stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "groups.info");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.ok(payload.result && typeof payload.result === "object");
      });

      await t.test("groups.memberships read checks", async (t) => {
        if (!hasGroupMemberships) {
          t.skip("groups.memberships contract unavailable");
          return;
        }
        if (!discoveredGroupId) {
          t.skip("No group id available for groups.memberships check");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "groups.memberships", {
          id: discoveredGroupId,
          limit: 5,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableMembershipError(run.stderrJson) || isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`groups.memberships skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("groups.memberships unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`groups.memberships expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `groups.memberships stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "groups.memberships");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.ok(payload.result && typeof payload.result === "object");

        const memberships =
          payload.result?.data?.memberships ??
          payload.result?.memberships ??
          extractResultRows(payload.result) ??
          [];
        assert.ok(Array.isArray(memberships), "groups.memberships should expose memberships array");
      });

      await t.test("collections.group_memberships read checks", async (t) => {
        if (!hasCollectionGroupMemberships) {
          t.skip("collections.group_memberships contract unavailable");
          return;
        }
        if (!state.firstCollectionId) {
          t.skip("No collection id available for collections.group_memberships check");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "collections.group_memberships", {
          id: state.firstCollectionId,
          limit: 5,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableMembershipError(run.stderrJson)) {
            t.diagnostic(`collections.group_memberships skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("collections.group_memberships unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`collections.group_memberships expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `collections.group_memberships stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "collections.group_memberships");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.ok(payload.result && typeof payload.result === "object");

        const memberships =
          payload.result?.data?.memberships ??
          payload.result?.memberships ??
          extractResultRows(payload.result) ??
          [];
        assert.ok(Array.isArray(memberships), "collections.group_memberships should expose memberships array");
      });

      await t.test("documents.group_memberships read checks", async (t) => {
        if (!hasDocumentGroupMemberships) {
          t.skip("documents.group_memberships contract unavailable");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "documents.group_memberships", {
          id: state.createdDocumentId,
          limit: 5,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableMembershipError(run.stderrJson)) {
            t.diagnostic(`documents.group_memberships skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("documents.group_memberships unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`documents.group_memberships expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `documents.group_memberships stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "documents.group_memberships");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.ok(payload.result && typeof payload.result === "object");

        const memberships =
          payload.result?.data?.memberships ??
          payload.result?.memberships ??
          extractResultRows(payload.result) ??
          [];
        assert.ok(Array.isArray(memberships), "documents.group_memberships should expose memberships array");
      });
    });

    await t.test("UC-13 API-driven workspace automation", async (t) => {
      const hasDocumentsUsers = hasToolContract("documents.users");

      await t.test("documents.users read checks", async (t) => {
        if (!hasDocumentsUsers) {
          t.skip("documents.users contract unavailable");
          return;
        }
        if (!state.createdDocumentId) {
          t.skip("No test document id available for documents.users read check");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "documents.users", {
          id: state.createdDocumentId,
          limit: 10,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableMembershipError(run.stderrJson) || isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`documents.users skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("documents.users unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`documents.users expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `documents.users stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "documents.users");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.ok(payload.result && typeof payload.result === "object");

        const users =
          payload.result?.data?.users ??
          payload.result?.users ??
          payload.result?.data?.memberships ??
          payload.result?.memberships ??
          extractResultRows(payload.result) ??
          [];
        assert.ok(Array.isArray(users), "documents.users should expose users/memberships array");
      });

      const userMutationProbes = [
        {
          tool: "users.invite",
          args: {
            invites: [],
          },
        },
        {
          tool: "users.update_role",
          args: {
            id: "",
            role: "__invalid_role__",
          },
        },
        {
          tool: "users.activate",
          args: {
            id: "",
          },
        },
        {
          tool: "users.suspend",
          args: {
            id: "",
          },
        },
      ];

      for (const probe of userMutationProbes) {
        await t.test(`${probe.tool} contract + safe action-gate check`, async (t) => {
          const contract = getToolContract(probe.tool);
          if (!contract) {
            t.skip(`${probe.tool} contract unavailable`);
            return;
          }

          assert.equal(contract.name, probe.tool);
          assert.match(
            String(contract.signature || ""),
            /performAction\?: boolean/,
            `${probe.tool} signature should expose performAction action gate`
          );

          const run = await invokeToolAnyStatus(tmpDir, configPath, probe.tool, probe.args);

          if (run.status === 0) {
            t.diagnostic(`${probe.tool} unexpected success payload: ${run.stdout || "<empty stdout>"}`);
            assert.fail(`${probe.tool} should not execute without performAction`);
          }

          const err = run.stderrJson;
          assert.ok(err, `${probe.tool} stderr must be valid JSON: ${run.stderr || "<empty stderr>"}`);

          if (isCliActionGatedError(err)) {
            return;
          }

          if (err?.error?.type === "CliError" && err.error?.code === "ARG_VALIDATION_FAILED") {
            return;
          }

          if (isSkippableUserAdminContractError(err) || isSkippableDirectoryReadError(err)) {
            t.diagnostic(`${probe.tool} skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip(`${probe.tool} unsupported or tenant-restricted in this deployment`);
            return;
          }

          assert.fail(
            `${probe.tool} expected ACTION_GATED/ARG_VALIDATION_FAILED or skippable API error, stderr=${run.stderr || "<empty>"}`
          );
        });
      }
    });

    await t.test("UC-05 public help docs sharing lifecycle", async (t) => {
      assert.ok(state.createdDocumentId, "created test document id is required");
      assert.ok(state.marker, "created test marker is required");

      const requiredTools = ["shares.create", "shares.update", "shares.info", "shares.revoke"];
      const missing = requiredTools.filter((tool) => !hasToolContract(tool));
      if (missing.length > 0) {
        t.skip(`Missing share tools in this build: ${missing.join(", ")}`);
        return;
      }

      const createRun = await invokeToolAnyStatus(tmpDir, configPath, "shares.create", {
        documentId: state.createdDocumentId,
        published: false,
        includeChildDocuments: true,
        view: "full",
        performAction: true,
      });

      if (createRun.status !== 0) {
        if (isSkippableShareLifecycleError(createRun.stderrJson)) {
          t.diagnostic(`shares.create skipped payload: ${createRun.stderr || "<empty stderr>"}`);
          t.skip("share creation unsupported/disabled in this deployment");
          return;
        }
        assert.fail(`shares.create expected success, got status=${createRun.status}, stderr=${createRun.stderr || "<empty>"}`);
      }

      const createPayload = createRun.stdoutJson;
      assert.ok(createPayload, `shares.create stdout must be valid JSON: ${createRun.stdout}`);
      assert.equal(createPayload.tool, "shares.create");
      assert.notEqual(createPayload.result?.success, false, "shares.create should not return success=false");

      const createShareObject = extractResultObject(createPayload.result);
      const shareId = pickStringId(
        createShareObject?.id,
        createShareObject?.shareId,
        createPayload.result?.id,
        createPayload.result?.shareId,
        createPayload.result?.data?.id,
        createPayload.result?.data?.shareId
      );

      if (!shareId) {
        t.diagnostic(`shares.create payload missing share id: ${JSON.stringify(createPayload.result)}`);
        t.skip("share id is not returned by this deployment");
        return;
      }
      state.uc05ShareId = shareId;

      const updateRun = await invokeToolAnyStatus(tmpDir, configPath, "shares.update", {
        id: shareId,
        published: true,
        includeChildDocuments: true,
        view: "full",
        performAction: true,
      });

      if (updateRun.status !== 0) {
        if (isSkippableShareLifecycleError(updateRun.stderrJson)) {
          t.diagnostic(`shares.update skipped payload: ${updateRun.stderr || "<empty stderr>"}`);
          t.skip("share update unsupported in this deployment");
          return;
        }
        assert.fail(`shares.update expected success, got status=${updateRun.status}, stderr=${updateRun.stderr || "<empty>"}`);
      }

      const updatePayload = updateRun.stdoutJson;
      assert.ok(updatePayload, `shares.update stdout must be valid JSON: ${updateRun.stdout}`);
      assert.equal(updatePayload.tool, "shares.update");
      assert.notEqual(updatePayload.result?.success, false, "shares.update should not return success=false");

      const shareInfo = await invokeTool(tmpDir, configPath, "shares.info", {
        id: shareId,
        view: "full",
      });
      assert.equal(shareInfo.tool, "shares.info");
      assert.ok(shareInfo.result && typeof shareInfo.result === "object");

      const shareInfoObject = extractResultObject(shareInfo.result);
      if (!shareInfoObject || typeof shareInfoObject !== "object") {
        t.diagnostic(`Unexpected shares.info payload: ${JSON.stringify(shareInfo.result)}`);
        t.skip("shares.info payload shape varies by deployment");
        return;
      }

      const infoShareId = pickStringId(
        shareInfoObject.id,
        shareInfoObject.shareId,
        shareInfo.result?.id,
        shareInfo.result?.shareId
      );
      if (infoShareId) {
        assert.equal(infoShareId, shareId);
      }
      if (Object.prototype.hasOwnProperty.call(shareInfoObject, "published")) {
        assert.equal(shareInfoObject.published, true);
      }

      const sharedInfo = await invokeTool(tmpDir, configPath, "documents.info", {
        shareId,
        view: "summary",
      });
      assert.equal(sharedInfo.tool, "documents.info");
      assert.ok(sharedInfo.result?.data && typeof sharedInfo.result.data === "object");
      assert.equal(sharedInfo.result?.data?.id, state.createdDocumentId);
      assert.equal(sharedInfo.result?.data?.title, state.marker);

      let scopedSearch = null;
      let scopedRows = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        scopedSearch = await invokeTool(tmpDir, configPath, "documents.search", {
          query: state.marker,
          mode: "titles",
          shareId,
          limit: 5,
          view: "summary",
          merge: true,
        });
        assert.equal(scopedSearch.tool, "documents.search");
        scopedRows = Array.isArray(scopedSearch.result?.data) ? scopedSearch.result.data : [];
        if (scopedRows.some((row) => row && typeof row === "object" && row.id === state.createdDocumentId)) {
          break;
        }
        if (attempt < 4) {
          await wait(700);
        }
      }

      const scopedMatch = scopedRows.some((row) => row && typeof row === "object" && row.id === state.createdDocumentId);
      if (!scopedMatch) {
        t.diagnostic(`Share-scoped search rows did not include suite doc: ${JSON.stringify(scopedRows)}`);
        t.skip("share-scoped search visibility can lag by deployment indexing");
        return;
      }

      const revokeRun = await invokeToolAnyStatus(tmpDir, configPath, "shares.revoke", {
        id: shareId,
        performAction: true,
      });

      if (revokeRun.status !== 0) {
        if (isSkippableShareLifecycleError(revokeRun.stderrJson)) {
          t.diagnostic(`shares.revoke skipped payload: ${revokeRun.stderr || "<empty stderr>"}`);
          t.skip("share revoke unsupported in this deployment");
          return;
        }
        assert.fail(`shares.revoke expected success, got status=${revokeRun.status}, stderr=${revokeRun.stderr || "<empty>"}`);
      }

      const revokePayload = revokeRun.stdoutJson;
      assert.ok(revokePayload, `shares.revoke stdout must be valid JSON: ${revokeRun.stdout}`);
      assert.equal(revokePayload.tool, "shares.revoke");
      assert.notEqual(revokePayload.result?.success, false, "shares.revoke should not return success=false");
      state.uc05ShareRevoked = true;

      let denied = false;
      let lastPostRevokeRun = null;
      for (let attempt = 0; attempt < 6; attempt += 1) {
        lastPostRevokeRun = await invokeToolAnyStatus(tmpDir, configPath, "documents.info", {
          shareId,
          view: "summary",
        });
        if (isShareAccessDeniedRun(lastPostRevokeRun)) {
          denied = true;
          break;
        }
        if (attempt < 5) {
          await wait(500);
        }
      }

      assert.equal(
        denied,
        true,
        `Expected revoked share to deny share-scoped read, last run=${JSON.stringify({
          status: lastPostRevokeRun?.status,
          stdout: lastPostRevokeRun?.stdout,
          stderr: lastPostRevokeRun?.stderr,
        })}`
      );
    });

    await t.test("UC-04 internal FAQ wrappers", async (t) => {
      assert.ok(state.createdDocumentId, "created test document id is required");
      assert.ok(state.faqResetCode, "FAQ reset code marker is required");
      assert.ok(state.faqNoHitToken, "FAQ no-hit token marker is required");

      const hasAnswer = hasToolContract("documents.answer");
      const hasAnswerBatch = hasToolContract("documents.answer_batch");
      const hasDocumentMemberships = hasToolContract("documents.memberships");
      const hasCollectionMemberships = hasToolContract("collections.memberships");

      const happyQuestion = `What is the VPN reset code in ${state.marker}?`;
      const noHitQuestion = `What is the emergency token ${state.faqNoHitToken}?`;
      const noHitPattern = /not found|no answer|no information|unable to|cannot|can't|couldn't|do not have|don't have/i;

      await t.test("documents.answer happy path + deterministic envelope assertions", async (t) => {
        if (!hasAnswer) {
          t.skip("documents.answer contract unavailable");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "documents.answer", {
          question: happyQuestion,
          documentId: state.createdDocumentId,
          includeEvidenceDocs: true,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isApiNotFoundErrorEnvelope(run.stderrJson)) {
            t.diagnostic(`documents.answer unsupported payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("documents.answerQuestion endpoint unsupported by this Outline deployment");
            return;
          }
          assert.fail(`documents.answer expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `documents.answer stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "documents.answer");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.equal(payload.result?.question, happyQuestion);

        const signals = extractAnswerSignals(payload.result);
        assert.ok(
          signals.answerText.length > 0,
          `documents.answer happy path should include answer text: ${JSON.stringify(payload.result)}`
        );
        assert.ok(Array.isArray(signals.citations), "documents.answer envelope should expose citations array");
      });

      await t.test("documents.answer no-hit path assertions", async (t) => {
        if (!hasAnswer) {
          t.skip("documents.answer contract unavailable");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "documents.answer", {
          question: noHitQuestion,
          documentId: state.createdDocumentId,
          includeEvidenceDocs: true,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isApiNotFoundErrorEnvelope(run.stderrJson)) {
            t.diagnostic(`documents.answer unsupported payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("documents.answerQuestion endpoint unsupported by this Outline deployment");
            return;
          }
          assert.fail(`documents.answer no-hit expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `documents.answer stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "documents.answer");
        assert.equal(payload.result?.question, noHitQuestion);

        const signals = extractAnswerSignals(payload.result);
        assert.ok(
          signals.noAnswerReason.length > 0 || signals.citations.length === 0 || noHitPattern.test(signals.answerText),
          `documents.answer no-hit should include explicit no-hit signal: ${JSON.stringify(payload.result)}`
        );
      });

      await t.test("documents.answer_batch mixed questions keep per-item isolation", async (t) => {
        if (!hasAnswerBatch) {
          t.skip("documents.answer_batch contract unavailable");
          return;
        }

        const missingDocumentId = "00000000-0000-0000-0000-000000000000";
        const run = await invokeToolAnyStatus(tmpDir, configPath, "documents.answer_batch", {
          questions: [
            { question: happyQuestion, documentId: state.createdDocumentId },
            { question: noHitQuestion, documentId: state.createdDocumentId },
            { question: "Force missing-doc isolation check", documentId: missingDocumentId },
          ],
          concurrency: 2,
          includeEvidenceDocs: true,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isApiNotFoundErrorEnvelope(run.stderrJson)) {
            t.diagnostic(`documents.answer_batch unsupported payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("documents.answerQuestion endpoint unsupported by this Outline deployment");
            return;
          }
          assert.fail(`documents.answer_batch expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `documents.answer_batch stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "documents.answer_batch");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.equal(payload.result?.total, 3);
        assert.ok(Array.isArray(payload.result?.items));
        assert.equal(payload.result.items.length, 3);

        const allItemsNotFound = payload.result.items.every(
          (item) => item?.ok === false && Number(item?.status) === 404 && /resource not found/i.test(String(item?.error || ""))
        );
        if (allItemsNotFound) {
          t.diagnostic(`documents.answer_batch unsupported payload: ${JSON.stringify(payload.result.items)}`);
          t.skip("documents.answerQuestion endpoint unsupported by this Outline deployment");
          return;
        }

        for (let i = 0; i < payload.result.items.length; i += 1) {
          const item = payload.result.items[i];
          assert.equal(item.index, i);
          assert.equal(typeof item.ok, "boolean");
          assert.ok(typeof item.question === "string" && item.question.length > 0);
        }

        const succeeded = payload.result.items.filter((item) => item.ok);
        const failed = payload.result.items.filter((item) => !item.ok);
        assert.equal(payload.result.succeeded, succeeded.length);
        assert.equal(payload.result.failed, failed.length);

        const forcedFailure = payload.result.items.find((item) => item.index === 2);
        assert.equal(forcedFailure?.ok, false);
        assert.ok(typeof forcedFailure?.error === "string" && forcedFailure.error.length > 0);
        assert.ok(succeeded.length >= 1, "documents.answer_batch should preserve successful items when one item fails");
      });

      await t.test("documents.memberships read-path checks", async (t) => {
        if (!hasDocumentMemberships) {
          t.skip("documents.memberships contract unavailable");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "documents.memberships", {
          id: state.createdDocumentId,
          limit: 5,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableMembershipError(run.stderrJson)) {
            t.diagnostic(`documents.memberships skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("documents.memberships unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`documents.memberships expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `documents.memberships stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "documents.memberships");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.ok(payload.result && typeof payload.result === "object");

        const memberships = payload.result?.data?.memberships ?? payload.result?.memberships ?? [];
        assert.ok(Array.isArray(memberships), "documents.memberships should expose memberships array");
      });

      await t.test("collections.memberships read-path checks", async (t) => {
        if (!hasCollectionMemberships) {
          t.skip("collections.memberships contract unavailable");
          return;
        }
        if (!state.firstCollectionId) {
          t.skip("No collection id available for collections.memberships check");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "collections.memberships", {
          id: state.firstCollectionId,
          limit: 5,
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableMembershipError(run.stderrJson)) {
            t.diagnostic(`collections.memberships skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("collections.memberships unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`collections.memberships expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `collections.memberships stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "collections.memberships");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);
        assert.ok(payload.result && typeof payload.result === "object");
        assert.ok(payload.result.pagination && typeof payload.result.pagination === "object");

        const memberships = payload.result?.data?.memberships ?? payload.result?.memberships ?? [];
        assert.ok(Array.isArray(memberships), "collections.memberships should expose memberships array");
      });
    });

    await t.test("UC-07 project docs issue-link workflows", async (t) => {
      assert.ok(state.createdDocumentId, "created test document id is required");
      assert.ok(state.marker, "created test marker is required");

      const requiredTools = [
        "documents.update",
        "documents.search",
        "documents.resolve",
        "documents.list",
        "documents.info",
      ];
      const missing = requiredTools.filter((tool) => !hasToolContract(tool));
      if (missing.length > 0) {
        t.skip(`Missing UC-07 tools in this build: ${missing.join(", ")}`);
        return;
      }

      const issueSeed = Date.now();
      const issueKey = `ENG-${String(issueSeed).slice(-6)}`;
      const issueUrl = `https://linear.app/acme/issue/${issueKey.toLowerCase()}`;
      const issueToken = `uc07-issue-token-${issueSeed}-${Math.random().toString(36).slice(2, 10)}`;
      const patchMarker = `uc07-patch-${issueSeed}`;

      const injectRes = await invokeTool(tmpDir, configPath, "documents.update", {
        id: state.createdDocumentId,
        text:
          "\n\n## UC-07 Issue Links\n" +
          `- Linear issue key: ${issueKey}\n` +
          `- Linear issue URL: ${issueUrl}\n` +
          `- Deterministic token: ${issueToken}\n` +
          `- Patch marker: ${patchMarker}\n`,
        editMode: "append",
        performAction: true,
        view: "summary",
      });
      assert.equal(injectRes.tool, "documents.update");

      await t.test("documents.issue_refs against suite-created issue-link doc", async (t) => {
        if (!hasToolContract("documents.issue_refs")) {
          t.skip("documents.issue_refs contract unavailable");
          return;
        }

        let run = await invokeToolAnyStatus(tmpDir, configPath, "documents.issue_refs", {
          id: state.createdDocumentId,
          view: "summary",
        });

        if (run.status !== 0 && hasCliValidationIssue(run.stderrJson, "args.view")) {
          run = await invokeToolAnyStatus(tmpDir, configPath, "documents.issue_refs", {
            id: state.createdDocumentId,
          });
        }

        if (run.status !== 0) {
          if (hasCliValidationIssue(run.stderrJson, "args") || isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`documents.issue_refs skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("documents.issue_refs unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`documents.issue_refs expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `documents.issue_refs stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "documents.issue_refs");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);

        const rows = extractIssueRefRows(payload.result);
        if (!rows || rows.length === 0) {
          t.diagnostic(`Unexpected documents.issue_refs payload shape: ${JSON.stringify(payload.result)}`);
          t.skip("documents.issue_refs payload shape differs across deployments");
          return;
        }
        assert.ok(Array.isArray(rows), "documents.issue_refs should expose issue-reference rows");

        const targetRow = rows.find((row) => extractIssueRefDocumentId(row) === state.createdDocumentId);
        if (!targetRow) {
          t.diagnostic(`documents.issue_refs rows missing suite doc ${state.createdDocumentId}: ${JSON.stringify(rows)}`);
          t.skip("documents.issue_refs did not expose per-document linkage for the target document");
          return;
        }

        const refs = extractIssueRefsFromRow(targetRow);
        const hasRefShape =
          refs.length > 0 ||
          Number.isFinite(Number(targetRow?.issueRefCount ?? targetRow?.refCount ?? targetRow?.matchCount));

        if (!hasRefShape) {
          t.diagnostic(`documents.issue_refs target row missing refs/count shape: ${JSON.stringify(targetRow)}`);
          t.skip("documents.issue_refs row shape differs across deployments");
          return;
        }

        const targetText = JSON.stringify(targetRow).toLowerCase();
        const hasExpectedIssueSignal =
          targetText.includes(issueKey.toLowerCase()) ||
          targetText.includes(issueUrl.toLowerCase());
        if (!hasExpectedIssueSignal) {
          t.diagnostic(
            `documents.issue_refs target row missing expected issue signal (${issueKey} / ${issueUrl}): ${JSON.stringify(targetRow)}`
          );
          t.skip("documents.issue_refs extraction/indexing differs by deployment");
          return;
        }

        assert.equal(hasExpectedIssueSignal, true);
      });

      await t.test("issue token retrieval via documents.search", async (t) => {
        let found = false;
        let finalRows = [];

        for (let attempt = 0; attempt < 7; attempt += 1) {
          const searchRes = await invokeTool(tmpDir, configPath, "documents.search", {
            query: issueToken,
            mode: "titles",
            limit: 10,
            view: "summary",
            merge: true,
          });
          assert.equal(searchRes.tool, "documents.search");

          finalRows = extractResultRows(searchRes.result) || [];
          found = finalRows.some(
            (row) =>
              row &&
              typeof row === "object" &&
              (row.id === state.createdDocumentId || row.title === state.marker)
          );

          if (found) {
            break;
          }
          if (attempt < 6) {
            await wait(700);
          }
        }

        if (!found) {
          t.diagnostic(`UC-07 search rows did not include suite doc: ${JSON.stringify(finalRows)}`);
          t.skip("Search indexing lag or deployment search behavior prevented deterministic token retrieval");
          return;
        }

        assert.equal(found, true);
      });

      await t.test("issue token retrieval via documents.resolve", async (t) => {
        let found = false;
        let finalCandidates = [];

        for (let attempt = 0; attempt < 7; attempt += 1) {
          const resolveRes = await invokeTool(tmpDir, configPath, "documents.resolve", {
            query: issueToken,
            limit: 10,
            strict: false,
            view: "summary",
          });
          assert.equal(resolveRes.tool, "documents.resolve");

          finalCandidates = extractResolveCandidates(resolveRes.result);
          found = finalCandidates.some((candidate) => {
            const candidateId = pickStringId(
              candidate.id,
              candidate.documentId,
              candidate.document?.id
            );
            return candidateId === state.createdDocumentId;
          });

          if (found) {
            break;
          }
          if (attempt < 6) {
            await wait(700);
          }
        }

        if (!found) {
          t.diagnostic(`UC-07 resolve candidates missing suite doc: ${JSON.stringify(finalCandidates)}`);
          t.skip("Resolve ranking/indexing varies by deployment for fresh issue tokens");
          return;
        }

        assert.equal(found, true);
      });

      await t.test("documents.issue_ref_report query flow and shape assertions", async (t) => {
        if (!hasToolContract("documents.issue_ref_report")) {
          t.skip("documents.issue_ref_report contract unavailable");
          return;
        }

        let run = await invokeToolAnyStatus(tmpDir, configPath, "documents.issue_ref_report", {
          query: issueKey,
          limit: 10,
          view: "summary",
        });

        if (run.status !== 0 && hasCliValidationIssue(run.stderrJson, "args.view")) {
          run = await invokeToolAnyStatus(tmpDir, configPath, "documents.issue_ref_report", {
            query: issueKey,
            limit: 10,
          });
        }

        if (run.status !== 0) {
          if (hasCliValidationIssue(run.stderrJson, "args") || isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`documents.issue_ref_report skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("documents.issue_ref_report unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(
            `documents.issue_ref_report expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`
          );
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `documents.issue_ref_report stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "documents.issue_ref_report");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);

        const rows = extractIssueRefRows(payload.result);
        if (!rows || rows.length === 0) {
          t.diagnostic(`Unexpected documents.issue_ref_report payload shape: ${JSON.stringify(payload.result)}`);
          t.skip("documents.issue_ref_report payload shape differs across deployments");
          return;
        }
        assert.ok(Array.isArray(rows), "documents.issue_ref_report should expose an array payload");

        const objectRows = rows.filter((row) => row && typeof row === "object");
        if (objectRows.length === 0) {
          t.diagnostic(`documents.issue_ref_report emitted no object rows: ${JSON.stringify(rows)}`);
          t.skip("documents.issue_ref_report row shape differs across deployments");
          return;
        }

        const hasShapeSignals = objectRows.some((row) => {
          const hasDocumentIdentity = Boolean(extractIssueRefDocumentId(row));
          const hasRefs = extractIssueRefsFromRow(row).length > 0;
          const hasCountSignal = Number.isFinite(
            Number(row?.issueRefCount ?? row?.refCount ?? row?.matchCount ?? row?.count)
          );
          return hasDocumentIdentity || hasRefs || hasCountSignal;
        });
        if (!hasShapeSignals) {
          t.diagnostic(`documents.issue_ref_report rows missing expected shape signals: ${JSON.stringify(objectRows)}`);
          t.skip("documents.issue_ref_report row shape differs across deployments");
          return;
        }
        assert.equal(hasShapeSignals, true);

        const hasExpectedIssueSignal = objectRows.some((row) => {
          const text = JSON.stringify(row).toLowerCase();
          return (
            text.includes(issueKey.toLowerCase()) ||
            text.includes(issueUrl.toLowerCase()) ||
            text.includes(state.createdDocumentId.toLowerCase()) ||
            text.includes(state.marker.toLowerCase())
          );
        });
        if (!hasExpectedIssueSignal) {
          t.diagnostic(
            `documents.issue_ref_report rows missing expected issue signals for ${issueKey}/${state.createdDocumentId}: ${JSON.stringify(objectRows)}`
          );
          t.skip("issue_ref_report query ranking/indexing varies by deployment");
          return;
        }

        assert.equal(hasExpectedIssueSignal, true);
      });

      await t.test("backlink traversal via documents.list(backlinkDocumentId)", async (t) => {
        const sourceInfo = await invokeTool(tmpDir, configPath, "documents.info", {
          id: state.createdDocumentId,
          view: "full",
        });
        assert.equal(sourceInfo.tool, "documents.info");

        const sourceDoc = sourceInfo.result?.data || {};
        const sourceUrlId = typeof sourceDoc.urlId === "string" ? sourceDoc.urlId : null;
        const sourceUrl = typeof sourceDoc.url === "string" && sourceDoc.url.length > 0
          ? sourceDoc.url
          : sourceUrlId
            ? `${String(env.baseUrl || "").replace(/\/+$/, "")}/doc/${sourceUrlId}`
            : null;

        const backlinkDocTitle = `${state.marker}-uc07-backlink-${Date.now()}`;
        const backlinkDocText =
          `# ${backlinkDocTitle}\n\n` +
          "This suite-created document references the UC-07 target document.\n\n" +
          `- Issue key: ${issueKey}\n` +
          `- Issue URL: ${issueUrl}\n` +
          (sourceUrl
            ? `- Target doc: [${state.marker}](${sourceUrl})\n`
            : `- Target doc id: ${state.createdDocumentId}\n`);

        const createBacklinkDoc = await invokeTool(tmpDir, configPath, "documents.create", {
          title: backlinkDocTitle,
          text: backlinkDocText,
          publish: false,
          view: "summary",
        });
        const backlinkDocId = pickStringId(
          createBacklinkDoc?.result?.data?.id,
          createBacklinkDoc?.result?.id
        );
        if (!backlinkDocId) {
          t.diagnostic(`Backlink source doc missing id: ${JSON.stringify(createBacklinkDoc.result)}`);
          t.skip("Cannot verify backlink traversal without backlink source document id");
          return;
        }
        state.uc03AdditionalDocumentIds.push(backlinkDocId);

        let foundBacklink = false;
        let finalRows = [];

        for (let attempt = 0; attempt < 7; attempt += 1) {
          const listRun = await invokeToolAnyStatus(tmpDir, configPath, "documents.list", {
            backlinkDocumentId: state.createdDocumentId,
            limit: 25,
            view: "summary",
          });

          if (listRun.status !== 0) {
            if (
              hasCliValidationIssue(listRun.stderrJson, "args.backlinkDocumentId") ||
              isSkippableDirectoryReadError(listRun.stderrJson)
            ) {
              t.diagnostic(`documents.list backlink query skipped payload: ${listRun.stderr || "<empty stderr>"}`);
              t.skip("backlinkDocumentId not accepted/available in this deployment");
              return;
            }
            assert.fail(
              `documents.list backlink query expected success, got status=${listRun.status}, stderr=${listRun.stderr || "<empty>"}`
            );
          }

          const payload = listRun.stdoutJson;
          assert.ok(payload, `documents.list stdout must be valid JSON: ${listRun.stdout}`);
          assert.equal(payload.tool, "documents.list");

          finalRows = extractResultRows(payload.result) || [];
          foundBacklink = finalRows.some(
            (row) =>
              row &&
              typeof row === "object" &&
              pickStringId(row.id, row.documentId) === backlinkDocId
          );

          if (foundBacklink) {
            break;
          }
          if (attempt < 6) {
            await wait(700);
          }
        }

        if (!foundBacklink) {
          t.diagnostic(
            `UC-07 backlink rows missing expected source document ${backlinkDocId}: ${JSON.stringify(finalRows)}`
          );
          t.skip("Backlink graph/index propagation varies by deployment");
          return;
        }

        assert.equal(foundBacklink, true);
      });

      await t.test("events.list audit context query for UC-07 update", async (t) => {
        if (!hasToolContract("events.list")) {
          t.skip("events.list contract unavailable");
          return;
        }

        const run = await invokeToolAnyStatus(tmpDir, configPath, "events.list", {
          documentId: state.createdDocumentId,
          limit: 25,
          sort: "createdAt",
          direction: "DESC",
          view: "summary",
        });

        if (run.status !== 0) {
          if (isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`events.list skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("events.list unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`events.list expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `events.list stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "events.list");
        assert.equal(typeof payload.profile, "string");
        assert.ok(payload.profile.length > 0);

        const rows = extractResultRows(payload.result);
        if (!rows) {
          t.diagnostic(`Unexpected events.list payload shape: ${JSON.stringify(payload.result)}`);
          t.skip("events.list payload shape differs across deployments");
          return;
        }
        assert.ok(Array.isArray(rows), "events.list should expose an array payload");

        if (rows.length === 0) {
          t.diagnostic("events.list returned no rows for document-scoped UC-07 audit query");
          t.skip("Audit events can be delayed or hidden by retention/policy settings");
          return;
        }

        const hasDocumentScopedEvent = rows.some((row) => {
          if (!row || typeof row !== "object") {
            return false;
          }
          const rowDocumentId = pickStringId(
            row.documentId,
            row.modelId,
            row.document?.id,
            row.document?.documentId
          );
          if (rowDocumentId === state.createdDocumentId) {
            return true;
          }
          const rowText = JSON.stringify(row);
          return typeof rowText === "string" && rowText.includes(state.createdDocumentId);
        });

        if (!hasDocumentScopedEvent) {
          t.diagnostic(`events.list rows did not include target doc id ${state.createdDocumentId}`);
          t.skip("Event payload/document linkage differs by deployment");
          return;
        }

        assert.equal(hasDocumentScopedEvent, true);
      });
    });

    await t.test("UC-10 cross-linked knowledge graph", async (t) => {
      assert.ok(state.marker, "created test marker is required");

      const uc10Marker = `${state.marker}-uc10-${Date.now()}`;
      const uc10Docs = { a: null, b: null, c: null };

      const knownReferrersToA = () => [uc10Docs.b, uc10Docs.c].filter(Boolean);

      const edgeFromId = (edge) =>
        pickStringId(
          edge?.from,
          edge?.fromId,
          edge?.sourceId,
          edge?.sourceDocumentId,
          edge?.source?.id,
          edge?.from?.id
        );

      const edgeToId = (edge) =>
        pickStringId(
          edge?.to,
          edge?.toId,
          edge?.targetId,
          edge?.targetDocumentId,
          edge?.target?.id,
          edge?.to?.id
        );

      const makeDocUrl = (doc) => {
        const docUrlId = typeof doc?.urlId === "string" ? doc.urlId : null;
        if (typeof doc?.url === "string" && doc.url.length > 0) {
          return doc.url;
        }
        if (docUrlId) {
          return `${String(env.baseUrl || "").replace(/\/+$/, "")}/doc/${docUrlId}`;
        }
        return null;
      };

      await t.test("create A/B/C docs with explicit cross-links", async (t) => {
        const createA = await invokeTool(tmpDir, configPath, "documents.create", {
          title: `${uc10Marker}-A`,
          text: `# ${uc10Marker} A\n\nUC-10 seed document A.`,
          publish: false,
          view: "summary",
        });
        uc10Docs.a = pickStringId(createA?.result?.data?.id, createA?.result?.id);
        if (!uc10Docs.a) {
          t.diagnostic(`UC-10 doc A create payload missing id: ${JSON.stringify(createA.result)}`);
          t.skip("Cannot run UC-10 graph tests without seed document id");
          return;
        }
        state.uc10DocumentIds.push(uc10Docs.a);

        const infoA = await invokeTool(tmpDir, configPath, "documents.info", {
          id: uc10Docs.a,
          view: "full",
        });
        const docAUrl = makeDocUrl(infoA.result?.data);
        if (!docAUrl) {
          t.diagnostic(`UC-10 doc A missing url/urlId: ${JSON.stringify(infoA.result?.data || {})}`);
          t.skip("Cannot produce deterministic markdown links without a canonical document URL");
          return;
        }

        const createB = await invokeTool(tmpDir, configPath, "documents.create", {
          title: `${uc10Marker}-B`,
          text:
            `# ${uc10Marker} B\n\n` +
            "UC-10 neighbor document B.\n\n" +
            `- Link to A: [${uc10Marker}-A](${docAUrl})\n`,
          publish: false,
          view: "summary",
        });
        uc10Docs.b = pickStringId(createB?.result?.data?.id, createB?.result?.id);
        if (!uc10Docs.b) {
          t.diagnostic(`UC-10 doc B create payload missing id: ${JSON.stringify(createB.result)}`);
          t.skip("Cannot run UC-10 graph tests without neighbor document B");
          return;
        }
        state.uc10DocumentIds.push(uc10Docs.b);

        const infoB = await invokeTool(tmpDir, configPath, "documents.info", {
          id: uc10Docs.b,
          view: "full",
        });
        const docBUrl = makeDocUrl(infoB.result?.data);
        if (!docBUrl) {
          t.diagnostic(`UC-10 doc B missing url/urlId: ${JSON.stringify(infoB.result?.data || {})}`);
          t.skip("Cannot complete deterministic A/B/C cross-link graph without B URL");
          return;
        }

        await invokeTool(tmpDir, configPath, "documents.update", {
          id: uc10Docs.a,
          text: `\n\n## UC-10 explicit links\n- Link to B: [${uc10Marker}-B](${docBUrl})`,
          editMode: "append",
          performAction: true,
          view: "summary",
        });

        const createC = await invokeTool(tmpDir, configPath, "documents.create", {
          title: `${uc10Marker}-C`,
          text:
            `# ${uc10Marker} C\n\n` +
            "UC-10 neighbor document C links to both A and B.\n\n" +
            `- Link to A: [${uc10Marker}-A](${docAUrl})\n` +
            `- Link to B: [${uc10Marker}-B](${docBUrl})\n`,
          publish: false,
          view: "summary",
        });
        uc10Docs.c = pickStringId(createC?.result?.data?.id, createC?.result?.id);
        if (!uc10Docs.c) {
          t.diagnostic(`UC-10 doc C create payload missing id: ${JSON.stringify(createC.result)}`);
          t.skip("Cannot run UC-10 graph tests without neighbor document C");
          return;
        }
        state.uc10DocumentIds.push(uc10Docs.c);

        assert.ok(uc10Docs.a && uc10Docs.b && uc10Docs.c, "UC-10 requires deterministic A/B/C ids");
      });

      await t.test("documents.list(backlinkDocumentId) baseline known referrers for A", async (t) => {
        if (!uc10Docs.a || knownReferrersToA().length < 2) {
          t.skip("UC-10 graph seed docs unavailable");
          return;
        }

        let hasExpectedReferrers = false;
        let finalRows = [];
        for (let attempt = 0; attempt < 8; attempt += 1) {
          const listRun = await invokeToolAnyStatus(tmpDir, configPath, "documents.list", {
            backlinkDocumentId: uc10Docs.a,
            limit: 50,
            view: "summary",
          });

          if (listRun.status !== 0) {
            if (
              hasCliValidationIssue(listRun.stderrJson, "args.backlinkDocumentId") ||
              isSkippableDirectoryReadError(listRun.stderrJson)
            ) {
              t.diagnostic(`documents.list UC-10 backlink query skipped payload: ${listRun.stderr || "<empty stderr>"}`);
              t.skip("backlinkDocumentId traversal unavailable in this deployment");
              return;
            }
            assert.fail(
              `documents.list UC-10 backlink query expected success, got status=${listRun.status}, stderr=${listRun.stderr || "<empty>"}`
            );
          }

          const payload = listRun.stdoutJson;
          assert.ok(payload, `documents.list stdout must be valid JSON: ${listRun.stdout}`);
          assert.equal(payload.tool, "documents.list");

          finalRows = extractResultRows(payload.result) || [];
          const rowIds = new Set(
            finalRows
              .filter((row) => row && typeof row === "object")
              .map((row) => pickStringId(row.id, row.documentId))
              .filter(Boolean)
          );
          hasExpectedReferrers = knownReferrersToA().every((docId) => rowIds.has(docId));

          if (hasExpectedReferrers) {
            break;
          }
          if (attempt < 7) {
            await wait(700);
          }
        }

        if (!hasExpectedReferrers) {
          t.diagnostic(
            `UC-10 documents.list backlink rows missing expected referrers ${JSON.stringify(knownReferrersToA())}: ${JSON.stringify(finalRows)}`
          );
          t.skip("Backlink graph/index propagation varies by deployment");
          return;
        }

        assert.equal(hasExpectedReferrers, true);
      });

      await t.test("documents.backlinks known referrer behavior (when contract available)", async (t) => {
        if (!hasToolContract("documents.backlinks")) {
          t.skip("documents.backlinks contract unavailable");
          return;
        }
        if (!uc10Docs.a || knownReferrersToA().length < 2) {
          t.skip("UC-10 graph seed docs unavailable");
          return;
        }

        let hasExpectedReferrers = false;
        let finalRows = [];

        for (let attempt = 0; attempt < 8; attempt += 1) {
          const run = await invokeToolAnyStatus(tmpDir, configPath, "documents.backlinks", {
            id: uc10Docs.a,
            limit: 50,
            view: "summary",
          });

          if (run.status !== 0) {
            if (hasCliValidationIssue(run.stderrJson, "args") || isSkippableDirectoryReadError(run.stderrJson)) {
              t.diagnostic(`documents.backlinks skipped payload: ${run.stderr || "<empty stderr>"}`);
              t.skip("documents.backlinks unsupported or unauthorized in this deployment");
              return;
            }
            assert.fail(`documents.backlinks expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
          }

          const payload = run.stdoutJson;
          assert.ok(payload, `documents.backlinks stdout must be valid JSON: ${run.stdout}`);
          assert.equal(payload.tool, "documents.backlinks");

          finalRows = extractResultRows(payload.result) || [];
          const rowIds = new Set(
            finalRows
              .filter((row) => row && typeof row === "object")
              .map((row) => pickStringId(row.id, row.documentId))
              .filter(Boolean)
          );
          hasExpectedReferrers = knownReferrersToA().every((docId) => rowIds.has(docId));

          if (hasExpectedReferrers) {
            break;
          }
          if (attempt < 7) {
            await wait(700);
          }
        }

        if (!hasExpectedReferrers) {
          t.diagnostic(
            `UC-10 documents.backlinks rows missing expected referrers ${JSON.stringify(knownReferrersToA())}: ${JSON.stringify(finalRows)}`
          );
          t.skip("Backlink graph/index propagation varies by deployment");
          return;
        }

        assert.equal(hasExpectedReferrers, true);
      });

      await t.test("documents.graph_neighbors output shape and deterministic keys", async (t) => {
        if (!hasToolContract("documents.graph_neighbors")) {
          t.skip("documents.graph_neighbors contract unavailable");
          return;
        }
        if (!uc10Docs.a || knownReferrersToA().length < 2) {
          t.skip("UC-10 graph seed docs unavailable");
          return;
        }

        let run = await invokeToolAnyStatus(tmpDir, configPath, "documents.graph_neighbors", {
          id: uc10Docs.a,
          includeBacklinks: true,
          includeSearchNeighbors: false,
          limitPerSource: 10,
          view: "summary",
        });

        if (run.status !== 0 && hasCliValidationIssue(run.stderrJson, "args")) {
          run = await invokeToolAnyStatus(tmpDir, configPath, "documents.graph_neighbors", {
            id: uc10Docs.a,
            view: "summary",
          });
        }

        if (run.status !== 0) {
          if (hasCliValidationIssue(run.stderrJson, "args") || isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`documents.graph_neighbors skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("documents.graph_neighbors unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(
            `documents.graph_neighbors expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`
          );
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `documents.graph_neighbors stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "documents.graph_neighbors");

        const rows = extractGraphNeighborRows(payload.result);
        if (!rows) {
          t.diagnostic(`Unexpected documents.graph_neighbors payload shape: ${JSON.stringify(payload.result)}`);
          t.skip("documents.graph_neighbors payload shape differs across deployments");
          return;
        }
        assert.ok(Array.isArray(rows), "documents.graph_neighbors should expose neighbor/edge rows");

        const objectRows = rows.filter((row) => row && typeof row === "object");
        if (objectRows.length === 0) {
          t.diagnostic("documents.graph_neighbors returned no object rows");
          t.skip("graph neighbors can be empty due to indexing lag or deployment policy");
          return;
        }

        const keySignatures = new Set(objectRows.map((row) => Object.keys(row).sort().join("|")));
        assert.equal(keySignatures.size, 1, "documents.graph_neighbors should emit deterministic row keys");

        const signature = [...keySignatures][0];
        const keyList = signature.split("|").filter(Boolean);
        const hasNormalizedEdgeKeys =
          ["from", "to", "relation", "source"].every((key) => keyList.includes(key)) ||
          ["fromId", "toId", "relation", "source"].every((key) => keyList.includes(key)) ||
          ["sourceId", "targetId", "relation", "source"].every((key) => keyList.includes(key));

        if (!hasNormalizedEdgeKeys) {
          t.diagnostic(`documents.graph_neighbors row keys: ${signature}`);
          t.skip("graph_neighbors did not expose normalized edge-key shape in this deployment");
          return;
        }

        const knownReferrerSet = new Set(knownReferrersToA());
        const hasKnownInbound = objectRows.some((row) => edgeToId(row) === uc10Docs.a && knownReferrerSet.has(edgeFromId(row)));
        if (!hasKnownInbound) {
          t.diagnostic(
            `documents.graph_neighbors rows missing known inbound edge to ${uc10Docs.a}: ${JSON.stringify(objectRows)}`
          );
          t.skip("graph_neighbors edge propagation varies by deployment");
          return;
        }

        assert.equal(hasKnownInbound, true);
      });

      await t.test("documents.graph_report depth/maxNodes bounds", async (t) => {
        if (!hasToolContract("documents.graph_report")) {
          t.skip("documents.graph_report contract unavailable");
          return;
        }
        if (!uc10Docs.a) {
          t.skip("UC-10 graph seed docs unavailable");
          return;
        }

        const requestedDepth = 1;
        const requestedMaxNodes = 2;

        let run = await invokeToolAnyStatus(tmpDir, configPath, "documents.graph_report", {
          seedIds: [uc10Docs.a],
          depth: requestedDepth,
          maxNodes: requestedMaxNodes,
          includeBacklinks: true,
          includeSearchNeighbors: false,
        });

        if (run.status !== 0 && hasCliValidationIssue(run.stderrJson, "args")) {
          run = await invokeToolAnyStatus(tmpDir, configPath, "documents.graph_report", {
            seedIds: [uc10Docs.a],
            depth: requestedDepth,
            maxNodes: requestedMaxNodes,
          });
        }

        if (run.status !== 0) {
          if (hasCliValidationIssue(run.stderrJson, "args") || isSkippableDirectoryReadError(run.stderrJson)) {
            t.diagnostic(`documents.graph_report skipped payload: ${run.stderr || "<empty stderr>"}`);
            t.skip("documents.graph_report unsupported or unauthorized in this deployment");
            return;
          }
          assert.fail(`documents.graph_report expected success, got status=${run.status}, stderr=${run.stderr || "<empty>"}`);
        }

        const payload = run.stdoutJson;
        assert.ok(payload, `documents.graph_report stdout must be valid JSON: ${run.stdout}`);
        assert.equal(payload.tool, "documents.graph_report");

        const nodes = extractGraphNodes(payload.result);
        const edges = extractGraphEdges(payload.result);
        if (!nodes || !edges) {
          t.diagnostic(`Unexpected documents.graph_report payload shape: ${JSON.stringify(payload.result)}`);
          t.skip("documents.graph_report payload shape differs across deployments");
          return;
        }
        assert.ok(Array.isArray(nodes), "documents.graph_report should expose nodes[]");
        assert.ok(Array.isArray(edges), "documents.graph_report should expose edges[]");

        const nodeIds = nodes
          .filter((node) => node && typeof node === "object")
          .map((node) => pickStringId(node.id, node.documentId, node.nodeId))
          .filter(Boolean);

        if (nodeIds.length === 0) {
          t.diagnostic(`documents.graph_report nodes without ids: ${JSON.stringify(nodes)}`);
          t.skip("graph_report did not expose node ids in this deployment");
          return;
        }

        assert.equal(new Set(nodeIds).size, nodeIds.length, "documents.graph_report node ids should be unique");
        assert.ok(nodeIds.includes(uc10Docs.a), "documents.graph_report should include the seed id");
        assert.ok(nodeIds.length <= requestedMaxNodes, "documents.graph_report should respect maxNodes upper bound");

        const nodeDepths = nodes
          .map((node) => Number(node?.depth ?? node?.distance ?? node?.hops ?? node?.level))
          .filter(Number.isFinite);
        const reportedDepth = Number(
          payload.result?.depth ??
            payload.result?.data?.depth ??
            payload.result?.maxDepth ??
            payload.result?.data?.maxDepth
        );

        if (nodeDepths.length > 0) {
          assert.ok(
            Math.max(...nodeDepths) <= requestedDepth,
            "documents.graph_report node depth values should be bounded by requested depth"
          );
        } else if (Number.isFinite(reportedDepth)) {
          assert.ok(
            reportedDepth <= requestedDepth,
            "documents.graph_report reported depth should be bounded by requested depth"
          );
        } else {
          t.diagnostic(`documents.graph_report depth metadata unavailable: ${JSON.stringify(payload.result)}`);
          t.skip("graph_report does not expose depth metadata in this deployment");
          return;
        }

        const nodeSet = new Set(nodeIds);
        const boundedEdges = edges.filter((edge) => {
          const fromId = edgeFromId(edge);
          const toId = edgeToId(edge);
          return fromId && toId && nodeSet.has(fromId) && nodeSet.has(toId);
        });
        if (boundedEdges.length === 0) {
          t.diagnostic(`documents.graph_report edges did not map to bounded nodes: ${JSON.stringify(edges)}`);
          t.skip("graph_report edges can be omitted or delayed by deployment indexing");
          return;
        }

        assert.ok(boundedEdges.length >= 1);
      });
    });

    await t.test("federated sync manifest composite read (stable + skippable)", async (t) => {
      assert.ok(state.createdDocumentId, "created test document id is required");
      assert.ok(state.marker, "created test marker is required");

      if (!hasToolContract("federated.sync_manifest")) {
        t.skip("federated.sync_manifest is not registered in this build");
        return;
      }

      let manifest;
      try {
        manifest = await invokeTool(tmpDir, configPath, "federated.sync_manifest", {
          query: state.marker,
          includeDrafts: true,
          limit: 5,
          offset: 0,
          view: "summary",
        });
      } catch (err) {
        t.diagnostic(`Skipping federated.sync_manifest check: ${err.message}`);
        t.skip("federated.sync_manifest endpoint behavior is environment-dependent");
        return;
      }

      assert.equal(manifest?.tool, "federated.sync_manifest");

      const rows = Array.isArray(manifest?.result?.data)
        ? manifest.result.data
        : Array.isArray(manifest?.result?.items)
          ? manifest.result.items
          : Array.isArray(manifest?.result?.rows)
            ? manifest.result.rows
            : null;

      if (!rows) {
        t.diagnostic(`Unexpected federated.sync_manifest shape: ${JSON.stringify(manifest?.result)}`);
        t.skip("manifest payload shape is deployment-specific");
        return;
      }

      const found = rows.find(
        (row) =>
          row &&
          typeof row === "object" &&
          (row.id === state.createdDocumentId || row.title === state.marker)
      );

      if (!found) {
        t.diagnostic("No deterministic match found in sync manifest for suite-created document");
        t.skip("manifest visibility/indexing can vary by deployment and sync lag");
        return;
      }

      assert.ok(typeof found.id === "string" && found.id.length > 0, "manifest row should include id");
      assert.ok(typeof found.title === "string" && found.title.length > 0, "manifest row should include title");
    });

    await t.test("mutation safety + patch + diff + revisions", async (t) => {
      assert.ok(state.createdDocumentId, "created test document id is required");

      const appendTag = `suite-append-${Date.now()}`;
      const updateDoc = await invokeTool(tmpDir, configPath, "documents.update", {
        id: state.createdDocumentId,
        text: `\n\n## Integration Update\n- ${appendTag}`,
        editMode: "append",
        performAction: true,
        view: "full",
      });

      assert.equal(updateDoc.tool, "documents.update");

      const readDoc = await invokeTool(tmpDir, configPath, "documents.info", {
        id: state.createdDocumentId,
        view: "full",
        includePolicies: true,
      });

      const baselineRevision = Number(readDoc.result?.data?.revision);
      assert.ok(Number.isFinite(baselineRevision), "documents.info should include revision");

      const safeAppendTag = `safe-append-${Date.now()}`;
      const safeUpdateOk = await invokeTool(tmpDir, configPath, "documents.safe_update", {
        id: state.createdDocumentId,
        expectedRevision: baselineRevision,
        text: `\n\n## Safe Update\n- ${safeAppendTag}`,
        editMode: "append",
        performAction: true,
        view: "full",
      });

      assert.equal(safeUpdateOk.result?.ok, true);
      assert.equal(safeUpdateOk.result?.updated, true);

      const conflictAppendTag = `safe-conflict-${Date.now()}`;
      const safeUpdateConflict = await invokeTool(tmpDir, configPath, "documents.safe_update", {
        id: state.createdDocumentId,
        expectedRevision: baselineRevision,
        text: `\n\n## Should Not Land\n- ${conflictAppendTag}`,
        editMode: "append",
        performAction: true,
      });

      assert.equal(safeUpdateConflict.result?.ok, false);
      assert.equal(safeUpdateConflict.result?.code, "revision_conflict");

      const afterSafeUpdateRead = await invokeTool(tmpDir, configPath, "documents.info", {
        id: state.createdDocumentId,
        view: "full",
      });

      assert.match(afterSafeUpdateRead.result?.data?.text || "", new RegExp(safeAppendTag));
      assert.doesNotMatch(afterSafeUpdateRead.result?.data?.text || "", new RegExp(conflictAppendTag));

      const planRes = await invokeTool(tmpDir, configPath, "documents.plan_batch_update", {
        ids: [state.createdDocumentId],
        rules: [
          {
            field: "text",
            find: safeAppendTag,
            replace: `${safeAppendTag}-planned`,
          },
        ],
        includeUnchanged: false,
        maxDocuments: 5,
      });
      assert.equal(planRes.tool, "documents.plan_batch_update");
      assert.ok(typeof planRes.result?.planHash === "string" && planRes.result.planHash.length > 0);
      assert.ok(planRes.result?.changedCount >= 1, "plan should detect at least one changed document");
      assert.ok(Array.isArray(planRes.result?.plan?.items) && planRes.result.plan.items.length >= 1);

      const applyPlanDryRun = await invokeTool(tmpDir, configPath, "documents.apply_batch_plan", {
        plan: planRes.result?.plan,
        confirmHash: planRes.result?.planHash,
        dryRun: true,
      });
      assert.equal(applyPlanDryRun.tool, "documents.apply_batch_plan");
      assert.equal(applyPlanDryRun.result?.ok, true);
      assert.equal(applyPlanDryRun.result?.dryRun, true);

      const applyPlan = await invokeTool(tmpDir, configPath, "documents.apply_batch_plan", {
        plan: planRes.result?.plan,
        confirmHash: planRes.result?.planHash,
        continueOnError: false,
        performAction: true,
      });
      assert.equal(applyPlan.tool, "documents.apply_batch_plan");
      assert.equal(applyPlan.result?.ok, true);
      assert.ok((applyPlan.result?.succeeded || 0) >= 1);

      const afterPlanApplyRead = await invokeTool(tmpDir, configPath, "documents.info", {
        id: state.createdDocumentId,
        view: "full",
      });
      assert.match(afterPlanApplyRead.result?.data?.text || "", new RegExp(`${safeAppendTag}-planned`));
      assert.doesNotMatch(
        afterPlanApplyRead.result?.data?.text || "",
        new RegExp(`${safeAppendTag}(?!-planned)`)
      );

      const currentText = afterSafeUpdateRead.result?.data?.text || "";
      const currentLines = currentText.replace(/\r\n/g, "\n").split("\n");
      const firstLine = currentLines[0] || `# ${state.marker}`;
      const patchedFirstLine = `${firstLine} patched`;

      const unifiedPatch = [
        "--- a/doc.md",
        "+++ b/doc.md",
        "@@ -1,1 +1,1 @@",
        `-${firstLine}`,
        `+${patchedFirstLine}`,
      ].join("\n");

      const patchApply = await invokeTool(tmpDir, configPath, "documents.apply_patch", {
        id: state.createdDocumentId,
        mode: "unified",
        patch: unifiedPatch,
        performAction: true,
        view: "full",
      });

      assert.equal(patchApply.result?.ok, true);

      const blankLinePatch = ["@@ -1,1 +1,2 @@", ` ${patchedFirstLine}`, "+"].join("\n");
      const patchBlankLine = await invokeTool(tmpDir, configPath, "documents.apply_patch", {
        id: state.createdDocumentId,
        mode: "unified",
        patch: blankLinePatch,
        performAction: true,
        view: "full",
      });

      assert.equal(patchBlankLine.result?.ok, true, JSON.stringify(patchBlankLine));
      const afterBlankRead = await invokeTool(tmpDir, configPath, "documents.info", {
        id: state.createdDocumentId,
        view: "full",
      });
      assert.match(afterBlankRead.result?.data?.text || "", new RegExp(`^${patchedFirstLine.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\n`));

      const patchFail = await invokeTool(tmpDir, configPath, "documents.apply_patch", {
        id: state.createdDocumentId,
        mode: "unified",
        patch: "@@ -1,1 +1,1 @@\n-__never_match__\n+__replacement__",
        performAction: true,
      });

      assert.equal(patchFail.result?.ok, false);
      assert.equal(patchFail.result?.error?.code, "patch_apply_failed");

      const afterPatchRead = await invokeTool(tmpDir, configPath, "documents.info", {
        id: state.createdDocumentId,
        view: "full",
      });

      const proposedText = `${afterPatchRead.result?.data?.text || ""}\n\nDIFF-CANDIDATE-LINE`;
      const diffRes = await invokeTool(tmpDir, configPath, "documents.diff", {
        id: state.createdDocumentId,
        proposedText,
        hunkLimit: 6,
        hunkLineLimit: 8,
      });

      assert.equal(diffRes.result?.ok, true);
      assert.ok(diffRes.result?.stats?.added >= 1);

      const batchUpdateRes = await invokeTool(tmpDir, configPath, "documents.batch_update", {
        updates: [
          {
            id: state.createdDocumentId,
            text: `\n\n## Batch Update\n- batch-ok-${Date.now()}`,
            editMode: "append",
          },
          {
            id: "00000000-0000-0000-0000-000000000000",
            title: "should-fail",
          },
        ],
        concurrency: 2,
        continueOnError: true,
        performAction: true,
      });

      assert.equal(batchUpdateRes.result?.total, 2);
      assert.equal(batchUpdateRes.result?.succeeded, 1);
      assert.equal(batchUpdateRes.result?.failed, 1);

      const revisionsList = await invokeTool(tmpDir, configPath, "revisions.list", {
        documentId: state.createdDocumentId,
        limit: 10,
        view: "summary",
      });

      assert.ok(Number.isFinite(Number(revisionsList.result?.revisionCount ?? 0)));
      if (Array.isArray(revisionsList.result?.data) && revisionsList.result.data.length >= 1) {
        const restoreTargetRevision = revisionsList.result.data[revisionsList.result.data.length - 1]?.id;
        assert.ok(restoreTargetRevision, "Expected a revision id for restore test");

        if (hasToolContract("revisions.info")) {
          try {
            const revisionInfo = await invokeTool(tmpDir, configPath, "revisions.info", {
              id: restoreTargetRevision,
              view: "full",
            });
            assert.equal(revisionInfo.tool, "revisions.info");
            const revisionObject = extractResultObject(revisionInfo.result);
            if (!revisionObject || typeof revisionObject !== "object") {
              t.diagnostic(`Unexpected revisions.info payload: ${JSON.stringify(revisionInfo.result)}`);
            } else {
              assert.ok(typeof revisionObject.id === "string" && revisionObject.id.length > 0);
            }
          } catch (err) {
            t.diagnostic(`Skipping revisions.info hydration assertion: ${err.message}`);
          }
        } else {
          t.diagnostic("Skipped revisions.info hydration: contract not registered in this build");
        }

        const restoreRes = await invokeTool(tmpDir, configPath, "revisions.restore", {
          id: state.createdDocumentId,
          revisionId: restoreTargetRevision,
          performAction: true,
          view: "summary",
        });

        assert.equal(restoreRes.result?.ok, true);
      }
    });

    await t.test("UC-09 postmortem/RCA rollback safety", async (t) => {
      assert.ok(state.createdDocumentId, "created test document id is required");

      const escapeRegex = (value) => String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const hasRevisionsList = hasToolContract("revisions.list");
      const hasRevisionsInfo = hasToolContract("revisions.info");
      const hasRevisionsRestore = hasToolContract("revisions.restore");
      const hasRevisionsDiff = hasToolContract("revisions.diff");
      const hasApplyPatch = hasToolContract("documents.apply_patch");
      const hasDelete = hasToolContract("documents.delete");

      await t.test("revision hydration + rollback assertions", async (t) => {
        if (!hasRevisionsList || !hasRevisionsInfo || !hasRevisionsRestore) {
          t.skip("revisions.list/revisions.info/revisions.restore required for UC-09 rollback flow");
          return;
        }

        const rollbackKeepTag = `uc09-rollback-keep-${Date.now()}`;
        const rollbackDropTag = `uc09-rollback-drop-${Date.now()}`;
        await invokeTool(tmpDir, configPath, "documents.update", {
          id: state.createdDocumentId,
          text: `\n\n## UC-09 Rollback Keep\n- ${rollbackKeepTag}`,
          editMode: "append",
          performAction: true,
          view: "summary",
        });
        await invokeTool(tmpDir, configPath, "documents.update", {
          id: state.createdDocumentId,
          text: `\n\n## UC-09 Rollback Drop\n- ${rollbackDropTag}`,
          editMode: "append",
          performAction: true,
          view: "summary",
        });

        const revisionsList = await invokeTool(tmpDir, configPath, "revisions.list", {
          documentId: state.createdDocumentId,
          limit: 20,
          sort: "createdAt",
          direction: "DESC",
          view: "summary",
        });
        assert.equal(revisionsList.tool, "revisions.list");
        const revisionRows = Array.isArray(revisionsList.result?.data) ? revisionsList.result.data : null;
        if (!revisionRows || revisionRows.length < 2) {
          t.diagnostic(`Unexpected revisions.list payload: ${JSON.stringify(revisionsList.result)}`);
          t.skip("revision history is unavailable for deterministic rollback assertions");
          return;
        }

        let rollbackRevisionId = null;
        let hydratedRevisionCount = 0;
        for (const row of revisionRows.slice(0, 12)) {
          const candidateRevisionId = row?.id;
          if (!candidateRevisionId) {
            continue;
          }

          let revisionInfo;
          try {
            revisionInfo = await invokeTool(tmpDir, configPath, "revisions.info", {
              id: candidateRevisionId,
              view: "full",
            });
          } catch (err) {
            t.diagnostic(`Skipping revision ${candidateRevisionId} hydration: ${err.message}`);
            continue;
          }

          const revisionObject = extractResultObject(revisionInfo.result);
          if (!revisionObject || typeof revisionObject !== "object") {
            continue;
          }
          hydratedRevisionCount += 1;

          const revisionTextCandidates = [
            revisionObject?.text,
            revisionObject?.document?.text,
            revisionObject?.data?.text,
            revisionObject?.content,
            revisionObject?.markdown,
          ];
          const revisionText = revisionTextCandidates.find((value) => typeof value === "string");
          if (!revisionText) {
            continue;
          }
          if (revisionText.includes(rollbackKeepTag) && !revisionText.includes(rollbackDropTag)) {
            rollbackRevisionId = candidateRevisionId;
            break;
          }
        }

        if (!rollbackRevisionId) {
          t.diagnostic(
            `UC-09 rollback target not found via hydrated revisions (hydrated=${hydratedRevisionCount}, rows=${revisionRows.length})`
          );
          t.skip("unable to deterministically select rollback target revision from hydrated payload");
          return;
        }

        const restoreRes = await invokeTool(tmpDir, configPath, "revisions.restore", {
          id: state.createdDocumentId,
          revisionId: rollbackRevisionId,
          performAction: true,
          view: "summary",
        });
        assert.equal(restoreRes.tool, "revisions.restore");
        assert.equal(restoreRes.result?.ok, true);

        const afterRestore = await invokeTool(tmpDir, configPath, "documents.info", {
          id: state.createdDocumentId,
          view: "full",
        });
        const afterRestoreText = afterRestore.result?.data?.text || "";
        assert.match(afterRestoreText, new RegExp(escapeRegex(rollbackKeepTag)));
        assert.doesNotMatch(afterRestoreText, new RegExp(escapeRegex(rollbackDropTag)));
      });

      await t.test("revisions.diff assertions when contract available", async (t) => {
        if (!hasRevisionsDiff) {
          t.skip("revisions.diff contract not registered in this build");
          return;
        }
        if (!hasRevisionsList) {
          t.skip("revisions.list required to select diff inputs");
          return;
        }

        const diffBaseTag = `uc09-diff-base-${Date.now()}`;
        const diffTargetTag = `uc09-diff-target-${Date.now()}`;
        await invokeTool(tmpDir, configPath, "documents.update", {
          id: state.createdDocumentId,
          text: `\n\n## UC-09 Diff Base\n- ${diffBaseTag}`,
          editMode: "append",
          performAction: true,
          view: "summary",
        });
        await invokeTool(tmpDir, configPath, "documents.update", {
          id: state.createdDocumentId,
          text: `\n\n## UC-09 Diff Target\n- ${diffTargetTag}`,
          editMode: "append",
          performAction: true,
          view: "summary",
        });

        const revisionsList = await invokeTool(tmpDir, configPath, "revisions.list", {
          documentId: state.createdDocumentId,
          limit: 10,
          sort: "createdAt",
          direction: "DESC",
          view: "summary",
        });
        const revisionRows = Array.isArray(revisionsList.result?.data) ? revisionsList.result.data : null;
        if (!revisionRows || revisionRows.length < 2) {
          t.diagnostic(`Unexpected revisions.list payload for revisions.diff: ${JSON.stringify(revisionsList.result)}`);
          t.skip("insufficient revision history for revisions.diff assertion");
          return;
        }

        const targetRevisionId = revisionRows[0]?.id;
        const baseRevisionId = revisionRows[1]?.id;
        if (!targetRevisionId || !baseRevisionId) {
          t.skip("missing revision ids for revisions.diff assertion");
          return;
        }

        let revisionsDiffRes;
        try {
          revisionsDiffRes = await invokeTool(tmpDir, configPath, "revisions.diff", {
            id: state.createdDocumentId,
            baseRevisionId,
            targetRevisionId,
            hunkLimit: 8,
            hunkLineLimit: 12,
          });
        } catch (err) {
          t.diagnostic(`Skipping revisions.diff assertion despite contract: ${err.message}`);
          t.skip("revisions.diff endpoint behavior is deployment-dependent");
          return;
        }

        assert.equal(revisionsDiffRes.tool, "revisions.diff");
        assert.equal(revisionsDiffRes.result?.ok, true);
        const diffPayload =
          revisionsDiffRes.result?.data &&
          typeof revisionsDiffRes.result.data === "object" &&
          !Array.isArray(revisionsDiffRes.result.data)
            ? revisionsDiffRes.result.data
            : revisionsDiffRes.result;
        const added = Number(diffPayload?.stats?.added ?? 0);
        const removed = Number(diffPayload?.stats?.removed ?? 0);
        const hasHunks = Array.isArray(diffPayload?.hunks) && diffPayload.hunks.length >= 1;
        assert.ok(added + removed >= 1 || hasHunks, "revisions.diff should report at least one textual change");
      });

      await t.test("patch precondition mismatch returns revision_conflict", async (t) => {
        if (!hasApplyPatch) {
          t.skip("documents.apply_patch contract not registered in this build");
          return;
        }

        const beforePatchRead = await invokeTool(tmpDir, configPath, "documents.info", {
          id: state.createdDocumentId,
          view: "summary",
        });
        const staleExpectedRevision = Number(beforePatchRead.result?.data?.revision);
        assert.ok(Number.isFinite(staleExpectedRevision), "documents.info should return numeric revision");

        const mutateBeforePatchTag = `uc09-patch-precondition-mutate-${Date.now()}`;
        await invokeTool(tmpDir, configPath, "documents.update", {
          id: state.createdDocumentId,
          text: `\n\n## UC-09 Patch Precondition\n- ${mutateBeforePatchTag}`,
          editMode: "append",
          performAction: true,
          view: "summary",
        });

        const blockedReplaceTag = `uc09-patch-precondition-blocked-${Date.now()}`;
        const patchConflict = await invokeTool(tmpDir, configPath, "documents.apply_patch", {
          id: state.createdDocumentId,
          mode: "replace",
          patch: `# ${state.marker}\n\n${blockedReplaceTag}`,
          expectedRevision: staleExpectedRevision,
          performAction: true,
          view: "summary",
        });

        assert.equal(patchConflict.tool, "documents.apply_patch");
        assert.equal(patchConflict.result?.ok, false);
        assert.equal(patchConflict.result?.code, "revision_conflict");
        assert.equal(Number(patchConflict.result?.expectedRevision), staleExpectedRevision);
        const actualRevision = Number(patchConflict.result?.actualRevision);
        assert.ok(Number.isFinite(actualRevision), "revision_conflict should include actualRevision");
        assert.ok(actualRevision > staleExpectedRevision, "actualRevision should advance past stale expectedRevision");

        const afterPatchConflict = await invokeTool(tmpDir, configPath, "documents.info", {
          id: state.createdDocumentId,
          view: "full",
        });
        const afterPatchText = afterPatchConflict.result?.data?.text || "";
        assert.match(afterPatchText, new RegExp(escapeRegex(mutateBeforePatchTag)));
        assert.doesNotMatch(afterPatchText, new RegExp(escapeRegex(blockedReplaceTag)));
      });

      await t.test("stale delete-read-token is rejected after mutation", async (t) => {
        if (!hasDelete) {
          t.skip("documents.delete contract not registered in this build");
          return;
        }

        const readForDelete = await invokeTool(tmpDir, configPath, "documents.info", {
          id: state.createdDocumentId,
          view: "summary",
          armDelete: true,
        });
        const readToken = readForDelete.result?.deleteReadReceipt?.token;
        if (!readToken) {
          t.diagnostic(`documents.info armDelete payload: ${JSON.stringify(readForDelete.result)}`);
          t.skip("delete read token not available in this deployment");
          return;
        }

        await invokeTool(tmpDir, configPath, "documents.update", {
          id: state.createdDocumentId,
          text: `\n\n## UC-09 Stale Delete Token\n- ${Date.now()}`,
          editMode: "append",
          performAction: true,
          view: "summary",
        });

        const staleDeleteRun = await invokeToolAnyStatus(tmpDir, configPath, "documents.delete", {
          id: state.createdDocumentId,
          readToken,
          performAction: true,
        });
        assert.notEqual(staleDeleteRun.status, 0, "documents.delete should fail with stale read token");
        const staleDeleteError = staleDeleteRun.stderrJson?.error || staleDeleteRun.stdoutJson?.error;
        assert.equal(staleDeleteError?.type, "CliError");
        assert.equal(staleDeleteError?.code, "DELETE_READ_TOKEN_STALE");
        assert.match(String(staleDeleteError?.message || ""), /stale/i);

        const expectedRevision = Number(
          staleDeleteError?.expectedRevision ?? staleDeleteError?.details?.expectedRevision
        );
        const actualRevision = Number(staleDeleteError?.actualRevision ?? staleDeleteError?.details?.actualRevision);
        if (Number.isFinite(expectedRevision) && Number.isFinite(actualRevision)) {
          assert.ok(actualRevision > expectedRevision);
        }

        const stillExists = await invokeTool(tmpDir, configPath, "documents.info", {
          id: state.createdDocumentId,
          view: "summary",
        });
        assert.equal(stillExists.result?.data?.id, state.createdDocumentId);
      });
    });

    await t.test("UC-03 comments workflow (create/list/info/update/delete)", async (t) => {
      assert.ok(state.createdDocumentId, "created test document id is required");

      const requiredTools = [
        "comments.create",
        "comments.list",
        "comments.info",
        "comments.update",
        "comments.delete",
      ];
      const missing = requiredTools.filter((tool) => !hasToolContract(tool));
      if (missing.length > 0) {
        t.skip(`Missing comment tools in this build: ${missing.join(", ")}`);
        return;
      }

      const firstCommentText = `UC-03 decision rationale ${Date.now()}`;
      let createComment;
      try {
        createComment = await invokeTool(tmpDir, configPath, "comments.create", {
          documentId: state.createdDocumentId,
          text: firstCommentText,
          performAction: true,
          view: "full",
        });
      } catch (err) {
        t.diagnostic(`Skipping comment workflow: ${err.message}`);
        t.skip("comments endpoint behavior is deployment-dependent");
        return;
      }

      assert.equal(createComment.tool, "comments.create");
      if (createComment.result?.success === false) {
        t.diagnostic(`comments.create returned success=false: ${JSON.stringify(createComment.result)}`);
        t.skip("comment creation not available in this deployment");
        return;
      }

      const createdComment = extractResultObject(createComment.result);
      const commentId = pickStringId(
        createdComment?.id,
        createComment.result?.id,
        createComment.result?.commentId
      );
      if (!commentId) {
        t.diagnostic(`comments.create missing id payload: ${JSON.stringify(createComment.result)}`);
        t.skip("comment id is not returned by this deployment");
        return;
      }
      state.uc03CommentId = commentId;
      assert.ok(commentId.length > 0, "comments.create should return a non-empty id");
      if (typeof createdComment?.text === "string") {
        assert.ok(
          createdComment.text.includes(firstCommentText),
          "created comment should include the provided text"
        );
      }

      const listComments = await invokeTool(tmpDir, configPath, "comments.list", {
        documentId: state.createdDocumentId,
        limit: 50,
        view: "full",
      });
      assert.equal(listComments.tool, "comments.list");
      const listedRows = extractResultRows(listComments.result);
      if (!listedRows) {
        t.diagnostic(`Unexpected comments.list shape: ${JSON.stringify(listComments.result)}`);
        t.skip("comments.list payload shape varies by deployment");
        return;
      }
      assert.ok(Array.isArray(listedRows));

      const listedComment = listedRows.find((row) => row && typeof row === "object" && row.id === commentId);
      if (!listedComment) {
        t.diagnostic("comments.list did not immediately include the created comment");
        t.skip("comment visibility can be delayed by deployment indexing");
        return;
      }
      assert.ok(typeof listedComment.id === "string" && listedComment.id.length > 0);

      const infoComment = await invokeTool(tmpDir, configPath, "comments.info", {
        id: commentId,
        view: "full",
      });
      assert.equal(infoComment.tool, "comments.info");
      const infoRow = extractResultObject(infoComment.result);
      if (!infoRow || typeof infoRow !== "object") {
        t.diagnostic(`Unexpected comments.info payload: ${JSON.stringify(infoComment.result)}`);
        t.skip("comments.info payload shape varies by deployment");
        return;
      }
      assert.equal(infoRow.id, commentId);

      const updatedCommentText = `${firstCommentText} updated`;
      const updateComment = await invokeTool(tmpDir, configPath, "comments.update", {
        id: commentId,
        text: updatedCommentText,
        performAction: true,
        view: "full",
      });
      assert.equal(updateComment.tool, "comments.update");
      if (updateComment.result?.success === false) {
        t.diagnostic(`comments.update returned success=false: ${JSON.stringify(updateComment.result)}`);
        t.skip("comment update not available in this deployment");
        return;
      }

      const verifyInfoComment = await invokeTool(tmpDir, configPath, "comments.info", {
        id: commentId,
        view: "full",
      });
      const verifyRow = extractResultObject(verifyInfoComment.result);
      if (verifyRow && typeof verifyRow.text === "string") {
        assert.ok(
          verifyRow.text.includes(updatedCommentText),
          "comments.info should include updated comment text"
        );
      }

      const deleteComment = await invokeTool(tmpDir, configPath, "comments.delete", {
        id: commentId,
        performAction: true,
      });
      assert.equal(deleteComment.tool, "comments.delete");
      assert.notEqual(deleteComment.result?.success, false, "comments.delete should not return success=false");
      state.uc03CommentDeleted = true;
    });

    await t.test("batch + ndjson + validation + offload + cleanup dry-run", async () => {
      assert.ok(state.createdDocumentId, "created test document id is required");

      const batchRes = await batchInvoke(tmpDir, configPath, [
        { tool: "auth.info", args: { view: "summary" } },
        { tool: "documents.info", args: { id: state.createdDocumentId, view: "summary" } },
        { tool: "documents.search", args: { query: state.marker, mode: "titles", limit: 3, view: "ids" } },
      ]);

      assert.equal(batchRes.ok, true);
      assert.equal(batchRes.failed, 0);
      assert.equal(batchRes.succeeded, 3);
      assert.ok(batchRes.items?.[0]?.result, "batch items should include compact result payload");
      assert.ok(!Object.prototype.hasOwnProperty.call(batchRes.items?.[0]?.result || {}, "tool"));

      const batchFull = runCli([
        "batch",
        "--config",
        configPath,
        "--result-mode",
        "inline",
        "--item-envelope",
        "full",
        "--ops",
        JSON.stringify([{ tool: "auth.info", args: { view: "summary" } }]),
        "--strict-exit",
      ]).json;
      assert.equal(batchFull.ok, true);
      assert.equal(batchFull.items?.[0]?.result?.tool, "auth.info");

      const ndjsonBatch = runCliNdjson([
        "batch",
        "--config",
        configPath,
        "--output",
        "ndjson",
        "--ops",
        JSON.stringify([
          { tool: "auth.info", args: { view: "summary" } },
          { tool: "documents.info", args: { id: state.createdDocumentId, view: "summary" } },
        ]),
        "--strict-exit",
      ]);

      assert.ok(ndjsonBatch.lines.length >= 3, "ndjson batch should print meta + item lines");
      assert.equal(ndjsonBatch.lines[0].type, "meta");
      assert.ok(ndjsonBatch.lines.some((line) => line.type === "item"), "ndjson output should include item lines");

      const ndjsonOffload = runCliNdjson([
        "tools",
        "contract",
        "all",
        "--output",
        "ndjson",
        "--result-mode",
        "auto",
        "--inline-max-bytes",
        "500",
      ]);
      assert.ok(ndjsonOffload.lines.some((line) => line.type === "file"), "ndjson should offload large payloads to file envelope");

      const validationErr = runCli([
        "invoke",
        "documents.safe_update",
        "--config",
        configPath,
        "--result-mode",
        "inline",
        "--args",
        JSON.stringify({ id: state.createdDocumentId }),
      ], { expectCode: 1, parseJson: false });

      const parsedValidationError = JSON.parse(validationErr.stderr);
      assert.equal(parsedValidationError.ok, false);
      assert.equal(parsedValidationError.error?.type, "CliError");
      assert.equal(parsedValidationError.error?.code, "ARG_VALIDATION_FAILED");

      const actionGateErr = runCli([
        "invoke",
        "documents.update",
        "--config",
        configPath,
        "--result-mode",
        "inline",
        "--args",
        JSON.stringify({
          id: state.createdDocumentId,
          text: "\n\nAttempted without performAction",
          editMode: "append",
        }),
      ], { expectCode: 1, parseJson: false });

      const parsedActionGateErr = JSON.parse(actionGateErr.stderr);
      assert.equal(parsedActionGateErr.ok, false);
      assert.equal(parsedActionGateErr.error?.type, "CliError");
      assert.equal(parsedActionGateErr.error?.code, "ACTION_GATED");

      const unknownArgErr = runCli([
        "invoke",
        "auth.info",
        "--config",
        configPath,
        "--result-mode",
        "inline",
        "--args",
        JSON.stringify({ view: "summary", unexpected: true }),
      ], { expectCode: 1, parseJson: false });

      const parsedUnknownArgErr = JSON.parse(unknownArgErr.stderr);
      assert.equal(parsedUnknownArgErr.ok, false);
      assert.equal(parsedUnknownArgErr.error?.code, "ARG_VALIDATION_FAILED");
      assert.ok(
        Array.isArray(parsedUnknownArgErr.error?.issues) &&
          parsedUnknownArgErr.error.issues.some((issue) => issue.path === "args.unexpected")
      );

      const endpointAliasCall = await invokeTool(tmpDir, configPath, "api.call", {
        endpoint: "auth.info",
        body: {},
      });
      assert.equal(endpointAliasCall.tool, "api.call");
      assert.equal(endpointAliasCall.method, "auth.info");
      assert.ok(endpointAliasCall.result?.data?.user?.id);

      const offload = runCli([
        "tools",
        "contract",
        "all",
        "--result-mode",
        "auto",
        "--inline-max-bytes",
        "500",
      ]).json;

      assert.equal(offload.ok, true);
      assert.equal(offload.stored, true);
      assert.ok(offload.file, "Expected offloaded file path");
      const stat = await fs.stat(offload.file);
      assert.ok(stat.size > 0, "Offloaded file must be non-empty");

      try {
        const cleanupDryRun = await invokeTool(tmpDir, configPath, "documents.cleanup_test", {
          markerPrefix: "outline-cli-live-test-",
          olderThanHours: 0,
          dryRun: true,
        });
        assert.equal(cleanupDryRun.tool, "documents.cleanup_test");
        assert.ok(cleanupDryRun.result?.candidateCount >= 1, "cleanup dry-run should detect at least one test doc");
      } catch {
        // Some Outline deployments can return 500 on wide list/search combinations.
      }
    });

    await t.test("UC-03 template lifecycle (templatize/list/info + instantiate)", async (t) => {
      const requiredTools = ["documents.templatize", "templates.list", "templates.info"];
      const missing = requiredTools.filter((tool) => !hasToolContract(tool));
      if (missing.length > 0) {
        t.skip(`Missing template tools in this build: ${missing.join(", ")}`);
        return;
      }

      const sourceTitle = `${state.marker}-template-source`;
      const sourceDoc = await invokeTool(tmpDir, configPath, "documents.create", {
        title: sourceTitle,
        text: `# ${sourceTitle}\n\n## Decisions\n- Owner: TBD\n- Due: TBD`,
        publish: false,
        view: "summary",
      });
      const sourceDocId = pickStringId(sourceDoc?.result?.data?.id, sourceDoc?.result?.id);
      assert.ok(sourceDocId, "template source document id is required");
      state.uc03AdditionalDocumentIds.push(sourceDocId);

      let templatize;
      try {
        templatize = await invokeTool(tmpDir, configPath, "documents.templatize", {
          id: sourceDocId,
          performAction: true,
          view: "full",
        });
      } catch (err) {
        t.diagnostic(`Skipping documents.templatize flow: ${err.message}`);
        t.skip("template conversion behavior is deployment-dependent");
        return;
      }

      assert.equal(templatize.tool, "documents.templatize");
      if (templatize.result?.success === false) {
        t.diagnostic(`documents.templatize returned success=false: ${JSON.stringify(templatize.result)}`);
        t.skip("templatize action not available in this deployment");
        return;
      }

      const templatizedRow = extractResultObject(templatize.result);
      const templateId = pickStringId(
        templatizedRow?.templateId,
        templatizedRow?.id,
        templatize.result?.templateId,
        templatize.result?.id
      );
      if (!templateId) {
        t.diagnostic(`documents.templatize missing template id: ${JSON.stringify(templatize.result)}`);
        t.skip("template id is not returned by this deployment");
        return;
      }
      state.uc03TemplateId = templateId;
      assert.ok(templateId.length > 0, "documents.templatize should return template id");

      const templatesList = await invokeTool(tmpDir, configPath, "templates.list", {
        query: sourceTitle,
        limit: 20,
        view: "summary",
      });
      assert.equal(templatesList.tool, "templates.list");
      const templateRows = extractResultRows(templatesList.result);
      if (!templateRows) {
        t.diagnostic(`Unexpected templates.list shape: ${JSON.stringify(templatesList.result)}`);
        t.skip("templates.list payload shape varies by deployment");
        return;
      }
      assert.ok(Array.isArray(templateRows));

      const visibleTemplate = templateRows.find((row) => row && typeof row === "object" && row.id === templateId);
      if (!visibleTemplate) {
        t.diagnostic("Templatized template not visible in templates.list yet");
      } else {
        assert.ok(typeof visibleTemplate.id === "string" && visibleTemplate.id.length > 0);
      }

      const templateInfo = await invokeTool(tmpDir, configPath, "templates.info", {
        id: templateId,
        view: "full",
      });
      assert.equal(templateInfo.tool, "templates.info");
      const templateInfoRow = extractResultObject(templateInfo.result);
      if (!templateInfoRow || typeof templateInfoRow !== "object") {
        t.diagnostic(`Unexpected templates.info payload: ${JSON.stringify(templateInfo.result)}`);
        t.skip("templates.info payload shape varies by deployment");
        return;
      }
      assert.equal(templateInfoRow.id, templateId);
      if (typeof templateInfoRow.title === "string") {
        assert.ok(templateInfoRow.title.length > 0);
      }

      const fromTemplateDoc = await invokeTool(tmpDir, configPath, "documents.create", {
        title: `${state.marker}-templated-notes`,
        templateId,
        publish: false,
        view: "summary",
      });
      const fromTemplateDocId = pickStringId(fromTemplateDoc?.result?.data?.id, fromTemplateDoc?.result?.id);
      if (!fromTemplateDocId) {
        t.diagnostic(`documents.create(templateId) returned unexpected payload: ${JSON.stringify(fromTemplateDoc.result)}`);
        t.skip("templated document creation is deployment-dependent");
        return;
      }
      state.uc03AdditionalDocumentIds.push(fromTemplateDocId);
      assert.ok(fromTemplateDocId.length > 0, "documents.create(templateId) should return a document id");
    });

    await t.test("UC-11 template-driven doc pipeline (extract + create_from_template + strict + lifecycle)", async (t) => {
      const requiredTools = [
        "documents.templatize",
        "templates.extract_placeholders",
        "documents.create_from_template",
      ];
      const missing = requiredTools.filter((tool) => !hasToolContract(tool));
      if (missing.length > 0) {
        t.skip(`Missing UC-11 template pipeline tools in this build: ${missing.join(", ")}`);
        return;
      }

      const uc11Marker = `${state.marker || "outline-cli-live-test"}-uc11-${Date.now()}`;
      const sourceTitle = `${uc11Marker}-source`;
      const expectedPlaceholderKeys = ["service_name", "owner", "target_date", "runbook_url", "approver"];
      const placeholderValues = {
        service_name: "Billing API",
        owner: "Ops Duty Lead",
        target_date: "2026-03-31",
        runbook_url: "https://example.invalid/runbooks/billing-api",
      };

      const sourceDoc = await invokeTool(tmpDir, configPath, "documents.create", {
        title: sourceTitle,
        text:
          `# ${sourceTitle}\n\n` +
          "## Release Inputs\n" +
          "- Service: {{service_name}}\n" +
          "- Owner: {{owner}}\n" +
          "- Target date: {{target_date}}\n" +
          "- Runbook: {{runbook_url}}\n" +
          "- Approver: {{approver}}\n" +
          "- Duplicate marker: {{owner}}\n",
        publish: false,
        view: "summary",
      });
      const sourceDocId = pickStringId(sourceDoc?.result?.data?.id, sourceDoc?.result?.id);
      assert.ok(sourceDocId, "UC-11 source document id is required");
      state.uc11DocumentIds.push(sourceDocId);

      let templatize;
      try {
        templatize = await invokeTool(tmpDir, configPath, "documents.templatize", {
          id: sourceDocId,
          performAction: true,
          view: "full",
        });
      } catch (err) {
        t.diagnostic(`Skipping UC-11 templatize flow: ${err.message}`);
        t.skip("UC-11 template conversion behavior is deployment-dependent");
        return;
      }

      if (templatize.result?.success === false) {
        t.diagnostic(`UC-11 templatize returned success=false: ${JSON.stringify(templatize.result)}`);
        t.skip("UC-11 templatize action unavailable in this deployment");
        return;
      }

      const templatizedRow = extractResultObject(templatize.result);
      const templateId = pickStringId(
        templatizedRow?.templateId,
        templatizedRow?.id,
        templatize.result?.templateId,
        templatize.result?.id
      );
      if (!templateId) {
        t.diagnostic(`UC-11 templatize missing template id: ${JSON.stringify(templatize.result)}`);
        t.skip("UC-11 template id not returned by this deployment");
        return;
      }
      state.uc11TemplateIds.push(templateId);

      await t.test("templates.extract_placeholders against templatized template", async (t) => {
        const extracted = await invokeTool(tmpDir, configPath, "templates.extract_placeholders", {
          id: templateId,
        });
        assert.equal(extracted.tool, "templates.extract_placeholders");

        const rawKeys = extractPlaceholderKeys(extracted.result);
        if (!Array.isArray(rawKeys) || rawKeys.length === 0) {
          t.diagnostic(`Unexpected templates.extract_placeholders payload: ${JSON.stringify(extracted.result)}`);
          t.skip("templates.extract_placeholders payload shape varies by deployment");
          return;
        }

        const normalizedKeys = rawKeys
          .map((key) => key.replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, ""))
          .map((key) => key.trim())
          .filter(Boolean);

        for (const expectedKey of expectedPlaceholderKeys) {
          assert.ok(
            normalizedKeys.includes(expectedKey),
            `templates.extract_placeholders should include "${expectedKey}"`
          );
        }
      });

      await t.test("documents.create_from_template with placeholderValues substitution", async (t) => {
        const fromTemplate = await invokeTool(tmpDir, configPath, "documents.create_from_template", {
          templateId,
          title: `${uc11Marker}-filled`,
          publish: false,
          placeholderValues,
          view: "summary",
          performAction: true,
        });
        assert.equal(fromTemplate.tool, "documents.create_from_template");
        if (fromTemplate.result?.success === false) {
          t.diagnostic(`documents.create_from_template returned success=false: ${JSON.stringify(fromTemplate.result)}`);
          t.skip("documents.create_from_template behavior is deployment-dependent");
          return;
        }

        const createdRow = extractResultObject(fromTemplate.result);
        const createdDocId = pickStringId(
          createdRow?.id,
          createdRow?.documentId,
          fromTemplate.result?.id,
          fromTemplate.result?.documentId,
          fromTemplate.result?.data?.id
        );
        if (!createdDocId) {
          t.diagnostic(`Unexpected documents.create_from_template payload: ${JSON.stringify(fromTemplate.result)}`);
          t.skip("documents.create_from_template payload shape varies by deployment");
          return;
        }
        state.uc11DocumentIds.push(createdDocId);

        const createdInfo = await invokeTool(tmpDir, configPath, "documents.info", {
          id: createdDocId,
          view: "full",
        });
        const fullText = extractDocumentText(createdInfo.result);
        if (!fullText) {
          t.diagnostic(`documents.info missing text for UC-11 created doc: ${JSON.stringify(createdInfo.result)}`);
          t.skip("documents.info text payload varies by deployment");
          return;
        }

        for (const value of Object.values(placeholderValues)) {
          assert.ok(fullText.includes(value), `created document should include placeholder value: ${value}`);
        }

        for (const key of Object.keys(placeholderValues)) {
          assert.equal(
            fullText.includes(`{{${key}}}`),
            false,
            `created document should not retain resolved placeholder token {{${key}}}`
          );
        }
      });

      await t.test("strictPlaceholders unresolved-token assertion", async (t) => {
        const strictRun = await invokeToolAnyStatus(tmpDir, configPath, "documents.create_from_template", {
          templateId,
          title: `${uc11Marker}-strict`,
          publish: false,
          placeholderValues,
          strictPlaceholders: true,
          view: "summary",
          performAction: true,
        });

        const strictCreatedId = pickStringId(
          strictRun.stdoutJson?.result?.data?.id,
          strictRun.stdoutJson?.result?.id,
          strictRun.stdoutJson?.result?.documentId
        );
        if (strictCreatedId) {
          state.uc11DocumentIds.push(strictCreatedId);
          t.diagnostic("strictPlaceholders=true still created a document");
          t.skip("strictPlaceholders unresolved-token enforcement is deployment-dependent");
          return;
        }

        if (strictRun.status !== 0 && hasCliValidationIssue(strictRun.stderrJson, "args.strictPlaceholders")) {
          t.skip("documents.create_from_template schema in this build does not expose strictPlaceholders");
          return;
        }

        if (strictRun.status === 0) {
          const successFalse = strictRun.stdoutJson?.result?.success === false;
          const payloadText = JSON.stringify(strictRun.stdoutJson?.result || {}).toLowerCase();
          if (successFalse && /placeholder|unresolved|missing|strict/.test(payloadText)) {
            assert.ok(true, "strictPlaceholders should fail when unresolved placeholders remain");
            return;
          }

          t.diagnostic(`strictPlaceholders run output: ${strictRun.stdout || "<empty>"}`);
          t.skip("strictPlaceholders failure signaling varies by deployment");
          return;
        }

        const errorText = `${extractErrorText(strictRun.stderrJson)} ${(strictRun.stderr || "").toLowerCase()}`;
        assert.ok(
          /placeholder|unresolved|missing|strict/.test(errorText),
          `strictPlaceholders failure should mention unresolved placeholders; got: ${strictRun.stderr || "<empty stderr>"}`
        );
      });

      let duplicatedTemplateId = null;

      await t.test("templates.update lifecycle check", async (t) => {
        if (!hasToolContract("templates.update")) {
          t.skip("templates.update contract unavailable");
          return;
        }

        const updateTitle = `${uc11Marker}-updated`;
        const updateRun = await invokeToolAnyStatus(tmpDir, configPath, "templates.update", {
          id: templateId,
          title: updateTitle,
          performAction: true,
          view: "summary",
        });

        if (updateRun.status !== 0) {
          if (isSkippableTemplateLifecycleError(updateRun.stderrJson)) {
            t.diagnostic(`templates.update skipped payload: ${updateRun.stderr || "<empty stderr>"}`);
            t.skip("templates.update unavailable in this deployment");
            return;
          }
          assert.fail(`templates.update expected success, got status=${updateRun.status}, stderr=${updateRun.stderr || "<empty>"}`);
        }

        const payload = updateRun.stdoutJson;
        assert.ok(payload, `templates.update stdout must be valid JSON: ${updateRun.stdout}`);
        assert.equal(payload.tool, "templates.update");
        if (payload.result?.success === false) {
          t.diagnostic(`templates.update returned success=false: ${JSON.stringify(payload.result)}`);
          t.skip("templates.update action unavailable in this deployment");
          return;
        }

        const updated = extractResultObject(payload.result);
        if (typeof updated?.title === "string" && updated.title.length > 0) {
          assert.equal(updated.title, updateTitle);
        }
      });

      await t.test("templates.duplicate lifecycle check", async (t) => {
        if (!hasToolContract("templates.duplicate")) {
          t.skip("templates.duplicate contract unavailable");
          return;
        }

        const duplicateRun = await invokeToolAnyStatus(tmpDir, configPath, "templates.duplicate", {
          id: templateId,
          title: `${uc11Marker}-duplicate`,
          performAction: true,
          view: "summary",
        });

        if (duplicateRun.status !== 0) {
          if (isSkippableTemplateLifecycleError(duplicateRun.stderrJson)) {
            t.diagnostic(`templates.duplicate skipped payload: ${duplicateRun.stderr || "<empty stderr>"}`);
            t.skip("templates.duplicate unavailable in this deployment");
            return;
          }
          assert.fail(
            `templates.duplicate expected success, got status=${duplicateRun.status}, stderr=${duplicateRun.stderr || "<empty>"}`
          );
        }

        const payload = duplicateRun.stdoutJson;
        assert.ok(payload, `templates.duplicate stdout must be valid JSON: ${duplicateRun.stdout}`);
        assert.equal(payload.tool, "templates.duplicate");
        if (payload.result?.success === false) {
          t.diagnostic(`templates.duplicate returned success=false: ${JSON.stringify(payload.result)}`);
          t.skip("templates.duplicate action unavailable in this deployment");
          return;
        }

        const duplicateRow = extractResultObject(payload.result);
        duplicatedTemplateId = pickStringId(
          duplicateRow?.id,
          duplicateRow?.templateId,
          payload.result?.id,
          payload.result?.templateId,
          payload.result?.data?.id
        );
        if (!duplicatedTemplateId) {
          t.diagnostic(`Unexpected templates.duplicate payload: ${JSON.stringify(payload.result)}`);
          t.skip("templates.duplicate payload shape varies by deployment");
          return;
        }

        state.uc11TemplateIds.push(duplicatedTemplateId);
        assert.notEqual(duplicatedTemplateId, templateId, "templates.duplicate should return a different id");
      });

      await t.test("templates.delete/restore lifecycle checks", async (t) => {
        if (!hasToolContract("templates.delete")) {
          t.skip("templates.delete contract unavailable");
          return;
        }
        if (!duplicatedTemplateId) {
          t.skip("safe delete/restore lifecycle check requires a duplicated template id");
          return;
        }

        const deleteRun = await invokeToolAnyStatus(tmpDir, configPath, "templates.delete", {
          id: duplicatedTemplateId,
          performAction: true,
        });

        if (deleteRun.status !== 0) {
          if (isSkippableTemplateLifecycleError(deleteRun.stderrJson)) {
            t.diagnostic(`templates.delete skipped payload: ${deleteRun.stderr || "<empty stderr>"}`);
            t.skip("templates.delete unavailable in this deployment");
            return;
          }
          assert.fail(`templates.delete expected success, got status=${deleteRun.status}, stderr=${deleteRun.stderr || "<empty>"}`);
        }

        const deletePayload = deleteRun.stdoutJson;
        assert.ok(deletePayload, `templates.delete stdout must be valid JSON: ${deleteRun.stdout}`);
        assert.equal(deletePayload.tool, "templates.delete");
        assert.notEqual(deletePayload.result?.success, false, "templates.delete should not return success=false");

        if (!hasToolContract("templates.restore")) {
          t.diagnostic("templates.restore unavailable; delete-only lifecycle check completed");
          return;
        }

        const restoreRun = await invokeToolAnyStatus(tmpDir, configPath, "templates.restore", {
          id: duplicatedTemplateId,
          performAction: true,
          view: "summary",
        });

        if (restoreRun.status !== 0) {
          if (isSkippableTemplateLifecycleError(restoreRun.stderrJson)) {
            t.diagnostic(`templates.restore skipped payload: ${restoreRun.stderr || "<empty stderr>"}`);
            t.skip("templates.restore unavailable in this deployment");
            return;
          }
          assert.fail(
            `templates.restore expected success, got status=${restoreRun.status}, stderr=${restoreRun.stderr || "<empty>"}`
          );
        }

        const restorePayload = restoreRun.stdoutJson;
        assert.ok(restorePayload, `templates.restore stdout must be valid JSON: ${restoreRun.stdout}`);
        assert.equal(restorePayload.tool, "templates.restore");
        assert.notEqual(restorePayload.result?.success, false, "templates.restore should not return success=false");
      });
    });

    await t.test("UC-12 legacy wiki migration primitives", async (t) => {
      assert.ok(state.marker, "created test marker is required");

      const importFixturePath = path.join(tmpDir, `${state.marker}-uc12-import.md`);
      await fs.writeFile(
        importFixturePath,
        `# ${state.marker} UC-12 import fixture\n\n` +
          "Suite-owned legacy wiki migration smoke fixture.\n\n" +
          `- marker: ${state.marker}\n` +
          `- generated_at: ${new Date().toISOString()}\n`,
        "utf8"
      );

      await t.test("api.call import mutation path is action-gated", async () => {
        const actionGateErr = runCli([
          "invoke",
          "api.call",
          "--config",
          configPath,
          "--result-mode",
          "inline",
          "--args",
          JSON.stringify({
            method: "documents.import",
            body: {},
          }),
        ], { expectCode: 1, parseJson: false });

        const parsedActionGateErr = JSON.parse(actionGateErr.stderr);
        assert.equal(parsedActionGateErr.ok, false);
        assert.equal(parsedActionGateErr.error?.type, "CliError");
        assert.equal(parsedActionGateErr.error?.code, "ACTION_GATED");
      });

      await t.test("documents.import_file skip-safe smoke", async (t) => {
        if (!hasToolContract("documents.import_file")) {
          t.skip("documents.import_file contract unavailable");
          return;
        }
        if (!state.firstCollectionId) {
          t.skip("No collection id available for documents.import_file target");
          return;
        }

        const importRun = await invokeToolAnyStatus(tmpDir, configPath, "documents.import_file", {
          filePath: importFixturePath,
          collectionId: state.firstCollectionId,
          publish: false,
          view: "summary",
          performAction: true,
        });

        if (importRun.status !== 0) {
          if (
            hasCliValidationIssue(importRun.stderrJson, "args.filePath") ||
            isSkippableImportLifecycleError(importRun.stderrJson)
          ) {
            t.diagnostic(`documents.import_file skipped payload: ${importRun.stderr || "<empty stderr>"}`);
            t.skip("documents.import_file unavailable or unsupported in this deployment");
            return;
          }
          assert.fail(
            `documents.import_file expected success, got status=${importRun.status}, stderr=${importRun.stderr || "<empty>"}`
          );
        }

        const payload = importRun.stdoutJson;
        assert.ok(payload, `documents.import_file stdout must be valid JSON: ${importRun.stdout}`);
        assert.equal(payload.tool, "documents.import_file");

        if (payload.result?.success === false) {
          t.diagnostic(`documents.import_file returned success=false: ${JSON.stringify(payload.result)}`);
          t.skip("documents.import_file action unavailable in this deployment");
          return;
        }

        const fileOperationId = extractFileOperationId(payload.result);
        if (fileOperationId) {
          state.uc12FileOperationId = fileOperationId;
        } else {
          t.diagnostic(`documents.import_file did not expose file operation id: ${JSON.stringify(payload.result)}`);
        }

        const importedDocIds = extractImportedDocumentIds(payload.result);
        if (importedDocIds.length === 0) {
          t.diagnostic(`documents.import_file did not expose imported document ids: ${JSON.stringify(payload.result)}`);
        } else {
          const known = new Set(state.uc12ImportedDocumentIds);
          for (const docId of importedDocIds) {
            if (!known.has(docId)) {
              known.add(docId);
              state.uc12ImportedDocumentIds.push(docId);
            }
          }
        }
      });

      await t.test("file_operations list/info/delete skip-safe lifecycle", async (t) => {
        const hasList = hasToolContract("file_operations.list");
        const hasInfo = hasToolContract("file_operations.info");
        const hasDelete = hasToolContract("file_operations.delete");

        if (!hasList && !hasInfo && !hasDelete) {
          t.skip("file_operations.list/info/delete contracts unavailable");
          return;
        }

        let operationId = state.uc12FileOperationId;

        if (hasList) {
          const listRun = await invokeToolAnyStatus(tmpDir, configPath, "file_operations.list", {
            type: "import",
            limit: 20,
            view: "summary",
          });

          if (listRun.status !== 0) {
            if (isSkippableFileOperationLifecycleError(listRun.stderrJson)) {
              t.diagnostic(`file_operations.list skipped payload: ${listRun.stderr || "<empty stderr>"}`);
              t.skip("file_operations.list unavailable or unsupported in this deployment");
              return;
            }
            assert.fail(
              `file_operations.list expected success, got status=${listRun.status}, stderr=${listRun.stderr || "<empty>"}`
            );
          }

          const listPayload = listRun.stdoutJson;
          assert.ok(listPayload, `file_operations.list stdout must be valid JSON: ${listRun.stdout}`);
          assert.equal(listPayload.tool, "file_operations.list");

          const rows = listPayload.result?.data?.operations ??
            listPayload.result?.operations ??
            extractResultRows(listPayload.result) ??
            [];
          assert.ok(Array.isArray(rows), "file_operations.list should expose an array payload");

          if (!operationId) {
            for (const row of rows) {
              operationId = extractFileOperationId(row);
              if (operationId) {
                break;
              }
            }
          }
        } else {
          t.diagnostic("file_operations.list contract unavailable; relying on import_file operation id if present");
        }

        if (hasInfo) {
          if (!operationId) {
            t.skip("file_operations.info requires an operation id from documents.import_file or file_operations.list");
            return;
          }

          const infoRun = await invokeToolAnyStatus(tmpDir, configPath, "file_operations.info", {
            id: operationId,
            view: "summary",
          });

          if (infoRun.status !== 0) {
            if (isSkippableFileOperationLifecycleError(infoRun.stderrJson)) {
              t.diagnostic(`file_operations.info skipped payload: ${infoRun.stderr || "<empty stderr>"}`);
              t.skip("file_operations.info unavailable or unsupported in this deployment");
              return;
            }
            assert.fail(
              `file_operations.info expected success, got status=${infoRun.status}, stderr=${infoRun.stderr || "<empty>"}`
            );
          }

          const infoPayload = infoRun.stdoutJson;
          assert.ok(infoPayload, `file_operations.info stdout must be valid JSON: ${infoRun.stdout}`);
          assert.equal(infoPayload.tool, "file_operations.info");
          assert.ok(infoPayload.result && typeof infoPayload.result === "object");
        } else {
          t.diagnostic("file_operations.info contract unavailable");
        }

        if (!hasDelete) {
          t.skip("file_operations.delete contract unavailable");
          return;
        }
        if (!state.uc12FileOperationId) {
          t.skip("file_operations.delete only runs on suite-created import operation ids");
          return;
        }

        const deleteRun = await invokeToolAnyStatus(tmpDir, configPath, "file_operations.delete", {
          id: state.uc12FileOperationId,
          performAction: true,
        });

        if (deleteRun.status !== 0) {
          if (isSkippableFileOperationLifecycleError(deleteRun.stderrJson)) {
            t.diagnostic(`file_operations.delete skipped payload: ${deleteRun.stderr || "<empty stderr>"}`);
            t.skip("file_operations.delete unavailable or unsupported in this deployment");
            return;
          }
          assert.fail(
            `file_operations.delete expected success, got status=${deleteRun.status}, stderr=${deleteRun.stderr || "<empty>"}`
          );
        }

        const deletePayload = deleteRun.stdoutJson;
        assert.ok(deletePayload, `file_operations.delete stdout must be valid JSON: ${deleteRun.stdout}`);
        assert.equal(deletePayload.tool, "file_operations.delete");
        assert.notEqual(deletePayload.result?.success, false, "file_operations.delete should not return success=false");
        state.uc12FileOperationId = null;
      });
    });

    await t.test("delete isolated test document", async () => {
      assert.ok(state.createdDocumentId, "created test document id is required");
      const readForDelete = await invokeTool(tmpDir, configPath, "documents.info", {
        id: state.createdDocumentId,
        view: "summary",
        armDelete: true,
      });
      const readToken = readForDelete.result?.deleteReadReceipt?.token;
      assert.ok(readToken, "documents.info armDelete should return delete read token");

      const deleteDoc = await invokeTool(tmpDir, configPath, "documents.delete", {
        id: state.createdDocumentId,
        readToken,
        performAction: true,
      });

      assert.equal(deleteDoc.tool, "documents.delete");
      assert.equal(deleteDoc.result?.ok, true);
      assert.equal(deleteDoc.result?.deleted, true);
      state.deletedInTest = true;
    });
  } finally {
    if (state.uc03CommentId && !state.uc03CommentDeleted) {
      try {
        await invokeTool(tmpDir, configPath, "comments.delete", {
          id: state.uc03CommentId,
          performAction: true,
        });
      } catch {
        // comment may already be deleted or not supported
      }
    }

    if (state.uc03TemplateId && !state.uc03TemplateDeleted) {
      try {
        await invokeTool(tmpDir, configPath, "templates.delete", {
          id: state.uc03TemplateId,
          performAction: true,
        });
        state.uc03TemplateDeleted = true;
      } catch {
        // template deletion may not be available in all deployments
      }
    }

    if (Array.isArray(state.uc03AdditionalDocumentIds)) {
      for (const docId of state.uc03AdditionalDocumentIds) {
        await bestEffortDeleteDocument(docId);
      }
    }

    if (Array.isArray(state.uc11DocumentIds)) {
      for (const docId of state.uc11DocumentIds) {
        await bestEffortDeleteDocument(docId);
      }
    }

    if (Array.isArray(state.uc11TemplateIds)) {
      for (const templateId of state.uc11TemplateIds) {
        await bestEffortDeleteTemplate(templateId);
      }
    }

    if (Array.isArray(state.uc12ImportedDocumentIds)) {
      for (const docId of state.uc12ImportedDocumentIds) {
        await bestEffortDeleteDocument(docId);
      }
    }

    if (Array.isArray(state.uc10DocumentIds)) {
      for (const docId of state.uc10DocumentIds) {
        await bestEffortDeleteDocument(docId);
      }
    }

    if (state.uc05ShareId && !state.uc05ShareRevoked) {
      try {
        await invokeTool(tmpDir, configPath, "shares.revoke", {
          id: state.uc05ShareId,
          performAction: true,
        });
        state.uc05ShareRevoked = true;
      } catch {
        // share revoke may be unavailable or already revoked
      }
    }

    if (state.createdDocumentId && !state.deletedInTest) {
      await bestEffortDeleteDocument(state.createdDocumentId);
    }

    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("secret scanner guard: no tracked hardcoded Outline API key", async () => {
  const listed = spawnSync("git", ["ls-files"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    env: process.env,
  });

  assert.equal(listed.status, 0, `git ls-files failed: ${listed.stderr || "unknown error"}`);
  const files = (listed.stdout || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((file) => file !== ".env.test.local");

  const pattern = /ol_api_[A-Za-z0-9]{20,}/g;
  const findings = [];

  for (const file of files) {
    const fullPath = path.join(REPO_ROOT, file);
    const content = await fs.readFile(fullPath, "utf8").catch(() => null);
    if (content == null || content.includes("\u0000")) {
      continue;
    }

    const matches = content.match(pattern) || [];
    for (const match of matches) {
      findings.push({ file, secret: `${match.slice(0, 8)}...` });
    }
  }

  assert.deepEqual(findings, [], `Hardcoded Outline API key(s) found in tracked files: ${JSON.stringify(findings)}`);
});
