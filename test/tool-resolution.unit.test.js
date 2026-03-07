import test from "node:test";
import assert from "node:assert/strict";

import { ApiError, CliError } from "../src/errors.js";
import { getToolContract, invokeTool, resolveToolInvocation } from "../src/tools.js";

test("getToolContract auto-corrects common raw endpoint aliases", () => {
  const contract = getToolContract("documents.search_titles");
  assert.equal(contract.name, "documents.search");
  assert.equal(contract.autoCorrected, true);
  assert.equal(contract.requestedName, "documents.search_titles");
  assert.match(contract.reason || "", /mode=titles/);
});

test("resolveToolInvocation surfaces structured suggestions for unknown tools", () => {
  assert.throws(
    () => resolveToolInvocation("document.search"),
    (err) => {
      assert.equal(err.name, "CliError");
      assert.equal(err.details?.code, "UNKNOWN_TOOL");
      assert.ok(Array.isArray(err.details?.suggestions));
      assert.ok(err.details.suggestions.some((row) => row.name === "documents.search"));
      return true;
    }
  );
});

test("invokeTool auto-corrects title-search alias and coerces common JSON string mistakes", async () => {
  const calls = [];
  const ctx = {
    profile: { id: "prod" },
    client: {
      async call(method, body) {
        calls.push({ method, body });
        return {
          body: {
            ok: true,
            status: 200,
            data: [
              {
                id: "doc-1",
                title: "Engineering Handbook",
                collectionId: "col-1",
                updatedAt: "2026-03-07T00:00:00.000Z",
                publishedAt: "2026-03-07T00:00:00.000Z",
                urlId: "abc123",
                ranking: 0.99,
                context: "sample context",
              },
            ],
            pagination: { limit: body.limit, offset: body.offset },
          },
        };
      },
    },
  };

  const result = await invokeTool(ctx, "documents.searchTitles", {
    query: ["engineering handbook"],
    limit: "5",
    offset: "0",
    compact: false,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "documents.search_titles");
  assert.equal(calls[0].body.query, "engineering handbook");
  assert.equal(calls[0].body.limit, 5);
  assert.equal(calls[0].body.offset, 0);
  assert.equal(result.tool, "documents.search");
  assert.equal(result.requestedTool, "documents.searchTitles");
  assert.equal(result.toolResolution?.autoCorrected, true);
  assert.equal(result.result?.ok, true);
});

test("documents.list preserves parentDocumentId null for collection root filtering", async () => {
  const calls = [];
  const ctx = {
    profile: { id: "prod" },
    client: {
      async call(method, body) {
        calls.push({ method, body });
        return {
          body: {
            ok: true,
            status: 200,
            data: [],
            pagination: { limit: body.limit, offset: body.offset },
          },
        };
      },
    },
  };

  await invokeTool(ctx, "documents.list", {
    collectionId: "col-1",
    parentDocumentId: null,
    limit: 10,
    compact: false,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "documents.list");
  assert.ok(Object.prototype.hasOwnProperty.call(calls[0].body, "parentDocumentId"));
  assert.equal(calls[0].body.parentDocumentId, null);
});

test("documents.list rootOnly maps to parentDocumentId null", async () => {
  const calls = [];
  const ctx = {
    profile: { id: "prod" },
    client: {
      async call(method, body) {
        calls.push({ method, body });
        return {
          body: {
            ok: true,
            status: 200,
            data: [],
            pagination: { limit: body.limit, offset: body.offset },
          },
        };
      },
    },
  };

  await invokeTool(ctx, "documents.list", {
    collectionId: "col-1",
    rootOnly: "true",
    compact: false,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "documents.list");
  assert.ok(Object.prototype.hasOwnProperty.call(calls[0].body, "parentDocumentId"));
  assert.equal(calls[0].body.parentDocumentId, null);
});

test("invokeTool enriches arg validation failures with contract hints", async () => {
  const ctx = {
    profile: { id: "prod" },
    client: {
      async call() {
        throw new Error("client.call should not run for validation failures");
      },
    },
  };

  await assert.rejects(
    () => invokeTool(ctx, "docs.answer", { question: "Where?", limt: "3", compact: false }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.details?.code, "ARG_VALIDATION_FAILED");
      assert.equal(err.details?.tool, "documents.answer");
      assert.equal(err.details?.requestedTool, "docs.answer");
      assert.equal(err.details?.toolResolution?.autoCorrected, true);
      assert.match(err.details?.toolSignature || "", /^documents\.answer\(/);
      assert.equal(err.details?.usageExample?.tool, "documents.answer");
      assert.match(err.details?.contractHint || "", /tools contract documents\.answer/);
      const typoIssue = err.details?.issues?.find((issue) => issue.path === "args.limt");
      assert.ok(Array.isArray(typoIssue?.suggestions));
      assert.ok(typoIssue.suggestions.includes("limit"));
      assert.deepEqual(err.details?.suggestedArgs, {
        question: "Where?",
        limit: 3,
        compact: false,
      });
      return true;
    }
  );
});

test("docs.answer alias accepts limit and falls back to deterministic retrieval", async () => {
  const calls = [];
  const ctx = {
    profile: { id: "prod" },
    client: {
      async call(method, body) {
        calls.push({ method, body });
        if (method === "documents.answerQuestion") {
          throw new ApiError("Not Found", {
            status: 404,
            url: "https://example.com/api/documents.answerQuestion",
          });
        }
        if (method === "documents.search") {
          return {
            body: {
              ok: true,
              status: 200,
              data: [
                {
                  id: "doc-1",
                  title: "Engineering / Welcome",
                  collectionId: "col-1",
                  updatedAt: "2026-03-07T00:00:00.000Z",
                  publishedAt: "2026-03-07T00:00:00.000Z",
                  urlId: "welcome",
                  ranking: 0.88,
                  context: "This page helps onboard new engineers.",
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    },
  };

  const payload = await invokeTool(ctx, "docs.answer", {
    question: "How do I onboard engineers?",
    collectionId: "col-1",
    limit: "3",
    compact: false,
  });

  assert.equal(calls[0].method, "documents.answerQuestion");
  assert.equal(calls[0].body.limit, undefined);
  assert.equal(calls[1].method, "documents.search");
  assert.equal(calls[1].body.limit, 3);
  assert.equal(payload.tool, "documents.answer");
  assert.equal(payload.requestedTool, "docs.answer");
  assert.equal(payload.toolResolution?.autoCorrected, true);
  assert.equal(payload.result?.fallbackUsed, true);
  assert.equal(payload.result?.unsupported, true);
  assert.equal(payload.result?.fallbackTool, "documents.search");
  assert.equal(payload.result?.question, "How do I onboard engineers?");
  assert.deepEqual(payload.result?.fallbackSuggestion, {
    tool: "documents.search",
    args: {
      query: "How do I onboard engineers?",
      collectionId: "col-1",
      limit: 3,
      view: "summary",
    },
  });
  assert.ok(Array.isArray(payload.result?.documents));
  assert.equal(payload.result.documents[0]?.title, "Engineering / Welcome");
  assert.match(payload.result?.noAnswerReason || "", /unsupported/i);
});

test("documents.info summary redacts obvious credentials in excerpts", async () => {
  const ctx = {
    profile: { id: "prod" },
    client: {
      async call() {
        return {
          body: {
            ok: true,
            status: 200,
            data: {
              id: "doc-1",
              title: "Keycloak",
              collectionId: "col-1",
              revision: 3,
              updatedAt: "2026-03-07T00:00:00.000Z",
              publishedAt: "2026-03-07T00:00:00.000Z",
              urlId: "keycloak",
              text: [
                "Site: https://idp.example.com",
                "User / Pass: dev / qUHxy1auV5E7",
                "* **Credentials**: `test@yopmail.com` / `xxxxyyyy`",
                "API key: ol_api_abcdef123456",
                "Git Repo: https://dev:supersecret@example.com/repo",
              ].join("\n"),
            },
          },
        };
      },
    },
  };

  const payload = await invokeTool(ctx, "documents.info", {
    id: "doc-1",
    view: "summary",
    compact: false,
  });

  const excerpt = payload.result?.data?.excerpt || "";
  assert.match(excerpt, /User \/ Pass: \[REDACTED\]/);
  assert.match(excerpt, /\* \*\*Credentials\*\*: \[REDACTED\]/);
  assert.match(excerpt, /API key: \[REDACTED\]/i);
  assert.match(excerpt, /https:\/\/\[REDACTED\]@example\.com\/repo/);
  assert.ok(!excerpt.includes("qUHxy1auV5E7"));
  assert.ok(!excerpt.includes("xxxxyyyy"));
  assert.ok(!excerpt.includes("ol_api_abcdef123456"));
});

test("documents.search summary redacts obvious credentials in contexts", async () => {
  const ctx = {
    profile: { id: "prod" },
    client: {
      async call(method) {
        assert.equal(method, "documents.search");
        return {
          body: {
            ok: true,
            status: 200,
            data: [
              {
                document: {
                  id: "doc-1",
                  title: "Keycloak",
                  collectionId: "col-1",
                  updatedAt: "2026-03-07T00:00:00.000Z",
                  publishedAt: "2026-03-07T00:00:00.000Z",
                  urlId: "keycloak",
                },
                ranking: 0.9,
                context:
                  "* **Credentials**: dev / secretpass\nAPI key: ol_api_searchsecret\nURL: https://dev:pass@example.com/repo",
              },
            ],
          },
        };
      },
    },
  };

  const payload = await invokeTool(ctx, "documents.search", {
    query: "keycloak",
    view: "summary",
    compact: false,
  });

  const context = payload.result?.data?.[0]?.context || "";
  assert.match(context, /\* \*\*Credentials\*\*: \[REDACTED\]/);
  assert.match(context, /API key: \[REDACTED\]/i);
  assert.match(context, /https:\/\/\[REDACTED\]@example\.com\/repo/);
  assert.ok(!context.includes("secretpass"));
  assert.ok(!context.includes("ol_api_searchsecret"));
});
