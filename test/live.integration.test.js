import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const CLI_BIN = path.join(REPO_ROOT, "bin", "outline-agent.js");

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
    env: process.env,
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

test("live integration suite (real Outline API, no mocks)", { timeout: 300_000 }, async (t) => {
  const env = await resolveLiveEnv();
  assert.ok(env.baseUrl, "OUTLINE_TEST_BASE_URL is required");
  assert.ok(env.apiKey, "OUTLINE_TEST_API_KEY is required");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-agent-live-test-"));
  const configPath = path.join(tmpDir, "config.json");

  const state = {
    createdDocumentId: null,
    deletedInTest: false,
    marker: null,
    firstCollectionId: null,
  };

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

      const authInfo = await invokeTool(tmpDir, configPath, "auth.info", { view: "summary" });
      assert.equal(authInfo.tool, "auth.info");
      assert.ok(authInfo.result?.data?.user?.id, "auth.info should return user");

      const capabilities = await invokeTool(tmpDir, configPath, "capabilities.map", {
        includePolicies: true,
      });
      assert.equal(capabilities.tool, "capabilities.map");
      assert.equal(capabilities.result?.capabilities?.canRead, true);
      assert.ok(capabilities.result?.evidence?.probes, "capabilities.map should include evidence probes");
    });

    await t.test("read + navigation tools", async () => {
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
    });

    await t.test("create isolated test document", async () => {
      state.marker = `outline-agent-live-test-${Date.now()}`;
      const createDoc = await invokeTool(tmpDir, configPath, "documents.create", {
        title: state.marker,
        text: `# ${state.marker}\n\nCreated by live integration suite.`,
        publish: false,
        view: "full",
      });

      state.createdDocumentId = createDoc?.result?.data?.id;
      assert.ok(state.createdDocumentId, "documents.create must return id");
    });

    await t.test("mutation safety + patch + diff + revisions", async () => {
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

        const restoreRes = await invokeTool(tmpDir, configPath, "revisions.restore", {
          id: state.createdDocumentId,
          revisionId: restoreTargetRevision,
          performAction: true,
          view: "summary",
        });

        assert.equal(restoreRes.result?.ok, true);
      }
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
          markerPrefix: "outline-agent-live-test-",
          olderThanHours: 0,
          dryRun: true,
        });
        assert.equal(cleanupDryRun.tool, "documents.cleanup_test");
        assert.ok(cleanupDryRun.result?.candidateCount >= 1, "cleanup dry-run should detect at least one test doc");
      } catch {
        // Some Outline deployments can return 500 on wide list/search combinations.
      }
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
    if (state.createdDocumentId && !state.deletedInTest) {
      try {
        const readForDelete = await invokeTool(tmpDir, configPath, "documents.info", {
          id: state.createdDocumentId,
          view: "summary",
          armDelete: true,
        });
        const readToken = readForDelete.result?.deleteReadReceipt?.token;
        if (readToken) {
          await invokeTool(tmpDir, configPath, "documents.delete", {
            id: state.createdDocumentId,
            readToken,
            performAction: true,
          });
        }
      } catch {
        // document may already be deleted or inaccessible
      }
      try {
        await invokeTool(tmpDir, configPath, "api.call", {
          method: "documents.delete",
          body: { id: state.createdDocumentId },
          performAction: true,
        });
      } catch {
        // best-effort cleanup only
      }
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
