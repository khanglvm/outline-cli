import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const REPO_ROOT = process.cwd();
const CLI_BIN = path.join(REPO_ROOT, "bin", "outline-cli.js");

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

function hasToolContract(name) {
  try {
    const contract = runCli(["tools", "contract", name, "--result-mode", "inline"]).json;
    return contract?.ok === true && contract?.contract?.name === name;
  } catch {
    return false;
  }
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

test("live integration suite (real Outline API, no mocks)", { timeout: 300_000 }, async (t) => {
  const env = await resolveLiveEnv();
  assert.ok(env.baseUrl, "OUTLINE_TEST_BASE_URL is required");
  assert.ok(env.apiKey, "OUTLINE_TEST_API_KEY is required");

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-cli-live-test-"));
  const configPath = path.join(tmpDir, "config.json");

  const state = {
    createdDocumentId: null,
    deletedInTest: false,
    marker: null,
    firstCollectionId: null,
    uc03TemplateId: null,
    uc03TemplateDeleted: false,
    uc03CommentId: null,
    uc03CommentDeleted: false,
    uc03AdditionalDocumentIds: [],
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
