import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ApiError } from "../src/errors.js";
import { invokeTool } from "../src/tools.js";

async function withTmpMemory(fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-cli-memory-"));
  const file = path.join(dir, "memory.json");
  try {
    await fn(file);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("successful document reads populate profile-scoped local memory", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Engineering Handbook",
                  collectionId: "col-1",
                  parentDocumentId: null,
                  revision: 3,
                  updatedAt: "2026-06-01T00:00:00.000Z",
                  urlId: "eng-handbook-AbCdEf12",
                  ranking: 0.98,
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      view: "summary",
      compact: false,
    });

    const lookup = await invokeTool(ctx, "memory.lookup", {
      query: "Engineering Handbook",
      type: "document",
      compact: false,
    });

    assert.equal(calls.length, 1);
    assert.equal(lookup.tool, "memory.lookup");
    assert.equal(lookup.result.items[0]?.id, "doc-1");
    assert.equal(lookup.result.items[0]?.title, "Engineering Handbook");
    assert.equal(lookup.result.items[0]?.score, 100);
    assert.equal(lookup.result.items[0]?.sourceTools[0]?.tool, "documents.search");
  });
});

test("memory.lookup resolves full Outline document URLs from remembered urlId", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Engineering Handbook",
                  collectionId: "col-1",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                  urlId: "eng-handbook-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      compact: false,
    });

    const lookup = await invokeTool(ctx, "memory.lookup", {
      url: "https://handbook.example.com/doc/eng-handbook-AbCdEf12#d-AbCdEf12",
      type: "document",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles"]);
    assert.equal(lookup.result.items[0]?.id, "doc-1");
    assert.equal(lookup.result.items[0]?.score, 100);
  });
});

test("successful user and group reads populate local memory", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "users.list") {
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "user-1",
                    name: "Alice Example",
                    email: "alice@example.com",
                  },
                ],
              },
            };
          }
          assert.equal(method, "groups.list");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "group-1",
                  name: "Engineering",
                  memberCount: 12,
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "users.list", {
      query: "alice",
      compact: false,
    });
    await invokeTool(ctx, "groups.list", {
      query: "engineering",
      compact: false,
    });

    const userLookup = await invokeTool(ctx, "memory.lookup", {
      query: "alice@example.com",
      type: "user",
      compact: false,
    });
    const groupLookup = await invokeTool(ctx, "memory.lookup", {
      query: "Engineering",
      type: "group",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["users.list", "groups.list"]);
    assert.equal(userLookup.result.items[0]?.id, "user-1");
    assert.equal(userLookup.result.items[0]?.email, "alice@example.com");
    assert.equal(groupLookup.result.items[0]?.id, "group-1");
    assert.equal(groupLookup.result.items[0]?.memberCount, 12);
  });
});

test("documents.search resolves remembered collection and user filters before searching", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.list") {
            assert.equal(body.query, "Engineering");
            return {
              body: {
                ok: true,
                data: [{ id: "col-eng", name: "Engineering" }],
              },
            };
          }
          if (method === "collections.info") {
            assert.deepEqual(body, { id: "col-eng" });
            return {
              body: {
                ok: true,
                data: { id: "col-eng", name: "Engineering" },
              },
            };
          }
          if (method === "users.list") {
            assert.equal(body.query, "alice@example.com");
            return {
              body: {
                ok: true,
                data: [{ id: "user-alice", name: "Alice Example", email: "alice@example.com" }],
              },
            };
          }
          if (method === "users.info") {
            assert.deepEqual(body, { id: "user-alice" });
            return {
              body: {
                ok: true,
                data: { id: "user-alice", name: "Alice Example", email: "alice@example.com" },
              },
            };
          }
          assert.equal(method, "documents.search");
          assert.deepEqual(body, {
            collectionId: "col-eng",
            userId: "user-alice",
            limit: 5,
            offset: 0,
            snippetMinWords: 20,
            snippetMaxWords: 30,
            query: "incident",
          });
          return {
            body: {
              ok: true,
              data: [
                {
                  document: {
                    id: "doc-incident",
                    title: "Incident Notes",
                    collectionId: "col-eng",
                  },
                  ranking: 0.9,
                  context: "incident context",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.search", {
      query: "incident",
      collectionQuery: "Engineering",
      userQuery: "alice@example.com",
      limit: 5,
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "users.list",
      "users.info",
      "documents.search",
    ]);
    assert.equal(output.tool, "documents.search");
    assert.equal(output.result.collectionId, undefined);
    assert.equal(output.result.resolution.collectionId.id, "col-eng");
    assert.equal(output.result.resolution.userId.id, "user-alice");
    assert.equal(output.result.data[0]?.id, "doc-incident");
  });
});

test("documents.list resolves remembered collection filters before listing", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.list") {
            assert.equal(body.query, "Engineering");
            return {
              body: {
                ok: true,
                data: [{ id: "col-eng", name: "Engineering" }],
              },
            };
          }
          if (method === "collections.info") {
            assert.deepEqual(body, { id: "col-eng" });
            return {
              body: {
                ok: true,
                data: { id: "col-eng", name: "Engineering" },
              },
            };
          }
          assert.equal(method, "documents.list");
          assert.deepEqual(body, {
            limit: 10,
            offset: 0,
            collectionId: "col-eng",
            parentDocumentId: null,
          });
          return {
            body: {
              ok: true,
              data: [{ id: "doc-root", title: "Root Doc", collectionId: "col-eng" }],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.list", {
      collectionQuery: "Engineering",
      rootOnly: true,
      limit: 10,
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "documents.list",
    ]);
    assert.equal(output.tool, "documents.list");
    assert.equal(output.result.resolution.collectionId.id, "col-eng");
    assert.equal(output.result.data[0]?.id, "doc-root");
  });
});

test("documents.search returns a structured miss when a remembered filter cannot resolve", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          throw new Error(`unexpected live call ${method}`);
        },
      },
    };

    const output = await invokeTool(ctx, "documents.search", {
      query: "incident",
      collectionQuery: "Missing Collection",
      fallbackSearch: false,
      compact: false,
    });

    assert.equal(calls.length, 0);
    assert.equal(output.tool, "documents.search");
    assert.equal(output.result.ok, false);
    assert.equal(output.result.status, "not_found");
    assert.equal(output.result.collectionId, "");
    assert.equal(output.result.resolution.failed.kind, "collectionQuery");
  });
});

test("search.research resolves remembered collection and user filters before retrieval", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.list") {
            assert.equal(body.query, "Engineering");
            return { body: { ok: true, data: [{ id: "col-eng", name: "Engineering" }] } };
          }
          if (method === "collections.info") {
            assert.deepEqual(body, { id: "col-eng" });
            return { body: { ok: true, data: { id: "col-eng", name: "Engineering" } } };
          }
          if (method === "users.list") {
            assert.equal(body.query, "alice@example.com");
            return {
              body: {
                ok: true,
                data: [{ id: "user-alice", name: "Alice Example", email: "alice@example.com" }],
              },
            };
          }
          if (method === "users.info") {
            assert.deepEqual(body, { id: "user-alice" });
            return {
              body: {
                ok: true,
                data: { id: "user-alice", name: "Alice Example", email: "alice@example.com" },
              },
            };
          }
          assert.ok(["documents.search_titles", "documents.search"].includes(method));
          assert.equal(body.collectionId, "col-eng");
          assert.equal(body.userId, "user-alice");
          assert.equal(body.query, "incident");
          return {
            body: {
              ok: true,
              data: [
                method === "documents.search"
                  ? {
                      document: {
                        id: "doc-incident",
                        title: "Incident Notes",
                        collectionId: "col-eng",
                      },
                      ranking: 0.9,
                      context: "incident context",
                    }
                  : {
                      id: "doc-incident",
                      title: "Incident Notes",
                      collectionId: "col-eng",
                      ranking: 0.9,
                    },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "search.research", {
      query: "incident",
      collectionQuery: "Engineering",
      userQuery: "alice@example.com",
      includeExpanded: false,
      includeCoverage: false,
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "users.list",
      "users.info",
      "documents.search_titles",
      "documents.search",
    ]);
    assert.equal(output.tool, "search.research");
    assert.equal(output.result.resolution.collectionId.id, "col-eng");
    assert.equal(output.result.resolution.userId.id, "user-alice");
    assert.equal(output.result.merged[0]?.id, "doc-incident");
  });
});

test("search.expand resolves remembered collection filters before search hydration", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.list") {
            assert.equal(body.query, "Engineering");
            return { body: { ok: true, data: [{ id: "col-eng", name: "Engineering" }] } };
          }
          if (method === "collections.info") {
            assert.deepEqual(body, { id: "col-eng" });
            return { body: { ok: true, data: { id: "col-eng", name: "Engineering" } } };
          }
          if (method === "documents.search_titles") {
            assert.equal(body.collectionId, "col-eng");
            assert.equal(body.query, "runbook");
            return {
              body: {
                ok: true,
                data: [{ id: "doc-runbook", title: "Runbook", collectionId: "col-eng" }],
              },
            };
          }
          assert.equal(method, "documents.info");
          assert.deepEqual(body, { id: "doc-runbook" });
          return {
            body: {
              ok: true,
              data: { id: "doc-runbook", title: "Runbook", collectionId: "col-eng" },
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "search.expand", {
      query: "runbook",
      mode: "titles",
      collectionQuery: "Engineering",
      expandLimit: 1,
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "documents.search_titles",
      "documents.info",
    ]);
    assert.equal(output.tool, "search.expand");
    assert.equal(output.result.resolution.collectionId.id, "col-eng");
    assert.equal(output.result.expanded[0]?.id, "doc-runbook");
  });
});

test("documents.answer resolves remembered collection and user filters before answering", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.list") {
            assert.equal(body.query, "Engineering");
            return { body: { ok: true, data: [{ id: "col-eng", name: "Engineering" }] } };
          }
          if (method === "collections.info") {
            assert.deepEqual(body, { id: "col-eng" });
            return { body: { ok: true, data: { id: "col-eng", name: "Engineering" } } };
          }
          if (method === "users.list") {
            assert.equal(body.query, "alice@example.com");
            return {
              body: {
                ok: true,
                data: [{ id: "user-alice", name: "Alice Example", email: "alice@example.com" }],
              },
            };
          }
          if (method === "users.info") {
            assert.deepEqual(body, { id: "user-alice" });
            return {
              body: {
                ok: true,
                data: { id: "user-alice", name: "Alice Example", email: "alice@example.com" },
              },
            };
          }
          assert.equal(method, "documents.answerQuestion");
          assert.deepEqual(body, {
            collectionId: "col-eng",
            userId: "user-alice",
            query: "How do we handle incidents?",
          });
          return {
            body: {
              ok: true,
              answer: "Use the incident runbook.",
              citations: [{ documentId: "doc-incident" }],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.answer", {
      question: "How do we handle incidents?",
      collectionQuery: "Engineering",
      userQuery: "alice@example.com",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "users.list",
      "users.info",
      "documents.answerQuestion",
    ]);
    assert.equal(output.tool, "documents.answer");
    assert.equal(output.result.resolution.collectionId.id, "col-eng");
    assert.equal(output.result.resolution.userId.id, "user-alice");
    assert.equal(output.result.answer, "Use the incident runbook.");
  });
});

test("documents.answer resolves remembered document refs and reuses hydration for unsupported fallback", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.search_titles") {
            assert.equal(body.query, "Incident Runbook");
            return {
              body: {
                ok: true,
                data: [{ id: "doc-runbook", title: "Incident Runbook", collectionId: "col-eng" }],
              },
            };
          }
          if (method === "documents.info") {
            assert.deepEqual(body, { id: "doc-runbook" });
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-runbook",
                  title: "Incident Runbook",
                  collectionId: "col-eng",
                  text: "Escalate to the incident commander.",
                },
              },
            };
          }
          assert.equal(method, "documents.answerQuestion");
          assert.deepEqual(body, {
            documentId: "doc-runbook",
            query: "Who do we escalate to?",
          });
          throw new ApiError("Not Found", {
            status: 404,
            url: "https://example.com/api/documents.answerQuestion",
          });
        },
      },
    };

    const output = await invokeTool(ctx, "documents.answer", {
      question: "Who do we escalate to?",
      documentQuery: "Incident Runbook",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "documents.answerQuestion",
    ]);
    assert.equal(output.tool, "documents.answer");
    assert.equal(output.result.fallbackUsed, true);
    assert.equal(output.result.fallbackTool, "documents.info");
    assert.equal(output.result.resolution.documentId.id, "doc-runbook");
    assert.equal(output.result.documents[0]?.id, "doc-runbook");
  });
});

test("documents.answer_batch reuses a resolved global collection scope", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.list") {
            assert.equal(body.query, "Engineering");
            return { body: { ok: true, data: [{ id: "col-eng", name: "Engineering" }] } };
          }
          if (method === "collections.info") {
            assert.deepEqual(body, { id: "col-eng" });
            return { body: { ok: true, data: { id: "col-eng", name: "Engineering" } } };
          }
          assert.equal(method, "documents.answerQuestion");
          assert.equal(body.collectionId, "col-eng");
          return {
            body: {
              ok: true,
              answer: `answer:${body.query}`,
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.answer_batch", {
      questions: ["Where is the runbook?", "Who owns incidents?"],
      collectionQuery: "Engineering",
      concurrency: 1,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "documents.answerQuestion",
      "documents.answerQuestion",
    ]);
    assert.equal(output.tool, "documents.answer_batch");
    assert.equal(output.result.succeeded, 2);
    assert.equal(output.result.items[0]?.result?.resolution?.collectionId?.id, "col-eng");
    assert.equal(output.result.items[1]?.result?.answer, "answer:Who owns incidents?");
  });
});

test("documents.resolve can return remembered candidates without live search", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-runbook",
                  title: "Incident Runbook",
                  collectionId: "col-eng",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                  urlId: "incident-runbook-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "incident runbook",
      mode: "titles",
      view: "summary",
      compact: false,
    });

    const output = await invokeTool(ctx, "documents.resolve", {
      query: "Incident Runbook",
      refresh: false,
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles"]);
    assert.equal(output.tool, "documents.resolve");
    assert.equal(output.result.bestMatch?.id, "doc-runbook");
    assert.deepEqual(output.result.bestMatch?.sources, ["memory"]);
    assert.equal(output.result.stats.memoryOnly, true);
    assert.equal(output.result.stats.memoryHits, 1);
  });
});

test("documents.resolve_urls can resolve remembered document URLs without live search", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-runbook",
                  title: "Incident Runbook",
                  collectionId: "col-eng",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                  urlId: "incident-runbook-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "incident runbook",
      mode: "titles",
      view: "summary",
      compact: false,
    });

    const output = await invokeTool(ctx, "documents.resolve_urls", {
      url: "https://handbook.example.com/doc/incident-runbook-AbCdEf12#d-AbCdEf12",
      refresh: false,
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles"]);
    assert.equal(output.tool, "documents.resolve_urls");
    assert.equal(output.result.bestMatch?.id, "doc-runbook");
    assert.deepEqual(output.result.bestMatch?.sources, ["memory_url"]);
    assert.equal(output.result.stats.memoryOnly, true);
    assert.equal(output.result.stats.memoryHits, 1);
  });
});

test("documents.open reads an exact id in one call and records local memory", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          assert.equal(method, "documents.info");
          return {
            body: {
              ok: true,
              policies: [{ id: "policy-top" }],
              data: {
                id: body.id,
                title: "Direct Operations Runbook",
                revision: 5,
                url: "/doc/direct-operations-runbook-DirOps1",
                policies: [{ id: "policy-doc" }],
              },
            },
          };
        },
      },
    };

    const opened = await invokeTool(ctx, "documents.open", {
      id: "doc-direct",
      view: "summary",
      compact: false,
    });

    assert.equal(opened.tool, "documents.open");
    assert.equal(opened.result.ok, true);
    assert.equal(opened.result.document.id, "doc-direct");
    assert.equal(opened.result.document.title, "Direct Operations Runbook");
    assert.equal(opened.result.document.sourceUrl, "https://handbook.example.com/doc/direct-operations-runbook-DirOps1");
    assert.equal(opened.result.response.policies, undefined);
    assert.equal(opened.result.response.data.policies, undefined);
    assert.deepEqual(calls.map((call) => call.method), ["documents.info"]);

    const lookup = await invokeTool(ctx, "memory.lookup", {
      query: "Direct Operations Runbook",
      type: "document",
      compact: false,
    });
    assert.equal(lookup.result.items[0]?.id, "doc-direct");
  });
});

test("documents.open rejects cross-profile exact id live reads", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          throw new Error("documents.open should reject before live read");
        },
      },
    };

    await assert.rejects(
      () => invokeTool(ctx, "documents.open", {
        id: "doc-direct",
        profile: "dev",
        refresh: false,
        compact: false,
      }),
      /documents\.open live read requires args\.profile/
    );
    assert.equal(calls.length, 0);
  });
});

test("documents.open resolves a remembered title and hydrates the document", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Engineering Handbook",
                  revision: 9,
                  urlId: "engineering-handbook-AbCdEf12",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-handbook",
                  title: "Engineering Handbook",
                  urlId: "engineering-handbook-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      compact: false,
    });

    const opened = await invokeTool(ctx, "documents.open", {
      query: "Engineering Handbook",
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles", "documents.info"]);
    assert.equal(opened.result.ok, true);
    assert.equal(opened.result.mode, "memory");
    assert.equal(opened.result.document.id, "doc-handbook");
    assert.equal(opened.result.document.sourceUrl, "https://handbook.example.com/doc/engineering-handbook-AbCdEf12");
    assert.equal(opened.result.candidate.score, 100);
  });
});

test("documents.open falls back to live title search on a cold query", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Cold Start Runbook",
                  revision: 3,
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-cold",
                  title: "Cold Start Runbook",
                },
              ],
            },
          };
        },
      },
    };

    const opened = await invokeTool(ctx, "documents.open", {
      query: "cold start runbook",
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles", "documents.info"]);
    assert.equal(opened.result.ok, true);
    assert.equal(opened.result.document.id, "doc-cold");
    assert.equal(opened.result.memory.fallback?.observed, 1);
  });
});

test("documents.open strict mode does not hydrate weak local matches when fallback is disabled", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-weak",
                  title: "Incident Overview",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "incident overview",
      mode: "titles",
      compact: false,
    });

    const opened = await invokeTool(ctx, "documents.open", {
      query: "security incident runbook",
      fallbackSearch: false,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles"]);
    assert.equal(opened.result.ok, false);
    assert.equal(opened.result.status, "not_found");
    assert.equal(opened.result.document, null);
  });
});

test("documents.open_batch opens repeated titles and ids with deduplicated hydration", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: body.id === "doc-direct" ? "Direct Operations Runbook" : "Engineering Handbook",
                  revision: body.id === "doc-direct" ? 7 : 9,
                  urlId: body.id === "doc-direct" ? "direct-operations-runbook-DirOps1" : "engineering-handbook-AbCdEf12",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-handbook",
                  title: "Engineering Handbook",
                  urlId: "engineering-handbook-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      compact: false,
    });

    const opened = await invokeTool(ctx, "documents.open_batch", {
      refs: ["Engineering Handbook", "Engineering Handbook"],
      ids: ["doc-direct", "doc-direct"],
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "documents.info",
    ]);
    assert.equal(opened.tool, "documents.open_batch");
    assert.equal(opened.result.referenceCount, 4);
    assert.equal(opened.result.ok, 4);
    assert.deepEqual(opened.result.items.map((item) => item.document?.id), [
      "doc-handbook",
      "doc-handbook",
      "doc-direct",
      "doc-direct",
    ]);
    assert.deepEqual(opened.result.items.map((item) => item.document?.sourceUrl), [
      "https://handbook.example.com/doc/engineering-handbook-AbCdEf12",
      "https://handbook.example.com/doc/engineering-handbook-AbCdEf12",
      "https://handbook.example.com/doc/direct-operations-runbook-DirOps1",
      "https://handbook.example.com/doc/direct-operations-runbook-DirOps1",
    ]);
    assert.deepEqual(opened.result.items.map((item) => item.index), [0, 1, 2, 3]);
  });
});

test("documents.open_batch returns per-reference misses without blocking successful rows", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Direct Operations Runbook",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [],
            },
          };
        },
      },
    };

    const opened = await invokeTool(ctx, "documents.open_batch", {
      queries: ["missing runbook"],
      ids: ["doc-direct"],
      fallbackSearch: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.info",
      "documents.search_titles",
    ]);
    assert.equal(opened.result.referenceCount, 2);
    assert.equal(opened.result.ok, 1);
    assert.equal(opened.result.failed, 1);
    assert.equal(opened.result.items[0]?.status, "not_found");
    assert.equal(opened.result.items[1]?.document?.id, "doc-direct");
  });
});

test("documents.backlinks resolves a document title before listing backlinks", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Seed Document",
                  urlId: "seed-document-AbCdEf12",
                },
              },
            };
          }
          if (method === "documents.list") {
            assert.equal(body.backlinkDocumentId, "doc-seed");
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-source",
                    title: "Backlink Source",
                  },
                ],
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-seed",
                  title: "Seed Document",
                  urlId: "seed-document-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.backlinks", {
      query: "Seed Document",
      view: "ids",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "documents.list",
    ]);
    assert.equal(output.tool, "documents.backlinks");
    assert.equal(output.result.data[0]?.id, "doc-source");
    assert.equal(output.result.resolution.resolved[0]?.id, "doc-seed");
  });
});

test("documents.graph_neighbors resolves document titles before graph expansion", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Seed Document",
                  urlId: "seed-document-AbCdEf12",
                },
              },
            };
          }
          if (method === "documents.list") {
            assert.equal(body.backlinkDocumentId, "doc-seed");
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-neighbor",
                    title: "Neighbor Document",
                  },
                ],
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-seed",
                  title: "Seed Document",
                  urlId: "seed-document-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.graph_neighbors", {
      query: "Seed Document",
      includeBacklinks: true,
      includeSearchNeighbors: false,
      view: "ids",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "documents.list",
    ]);
    assert.equal(output.tool, "documents.graph_neighbors");
    assert.deepEqual(output.result.sourceIds, ["doc-seed"]);
    assert.equal(output.result.resolution.resolved[0]?.id, "doc-seed");
    assert.equal(output.result.nodes[0]?.id, "doc-neighbor");
  });
});

test("documents.graph_report resolves seed titles before bounded BFS", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Seed Document",
                  urlId: "seed-document-AbCdEf12",
                },
              },
            };
          }
          if (method === "documents.list") {
            assert.equal(body.backlinkDocumentId, "doc-seed");
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-neighbor",
                    title: "Neighbor Document",
                  },
                ],
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-seed",
                  title: "Seed Document",
                  urlId: "seed-document-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.graph_report", {
      seedQuery: "Seed Document",
      depth: 1,
      includeBacklinks: true,
      includeSearchNeighbors: false,
      view: "ids",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "documents.list",
    ]);
    assert.equal(output.tool, "documents.graph_report");
    assert.deepEqual(output.result.seedIds, ["doc-seed"]);
    assert.equal(output.result.requestedSeedCount, 1);
    assert.equal(output.result.resolution.resolved[0]?.id, "doc-seed");
    assert.equal(output.result.nodeCount, 2);
    assert.deepEqual(output.result.nodes.map((node) => node.id), ["doc-neighbor", "doc-seed"]);
    assert.deepEqual(output.result.edges, [
      {
        sourceId: "doc-seed",
        targetId: "doc-neighbor",
        type: "backlink",
        query: "",
        rank: 1,
      },
    ]);
  });
});

test("documents.issue_refs resolves a document title before extracting refs", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Incident Notes",
                  urlId: "incident-notes-AbCdEf12",
                  text: "Ticket ABC-1 and https://jira.example.com/browse/ABC-2",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-incident",
                  title: "Incident Notes",
                  urlId: "incident-notes-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.issue_refs", {
      query: "Incident Notes",
      issueDomains: ["jira.example.com"],
      keyPattern: "[A-Z]+-\\d+",
      view: "ids",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "documents.info",
    ]);
    assert.equal(output.tool, "documents.issue_refs");
    assert.deepEqual(output.result.requestedIds, ["doc-incident"]);
    assert.equal(output.result.resolution.resolved[0]?.id, "doc-incident");
    assert.deepEqual(output.result.keys, ["ABC-1", "ABC-2"]);
  });
});

test("local memory is scoped by profile and supports collection observations", async () => {
  await withTmpMemory(async (memoryFile) => {
    const baseCtx = {
      memory: { enabled: true, file: memoryFile },
      client: {
        async call() {
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "col-1",
                  name: "Engineering",
                  description: "Engineering docs",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool({ ...baseCtx, profile: { id: "prod" } }, "collections.list", {
      query: "engineering",
      compact: false,
    });

    const prodLookup = await invokeTool({ ...baseCtx, profile: { id: "prod" } }, "memory.lookup", {
      query: "Engineering",
      type: "collection",
      compact: false,
    });
    const devLookup = await invokeTool({ ...baseCtx, profile: { id: "dev" } }, "memory.lookup", {
      query: "Engineering",
      type: "collection",
      compact: false,
    });

    assert.equal(prodLookup.result.items[0]?.id, "col-1");
    assert.deepEqual(devLookup.result.items, []);
  });
});

test("collections.open reads an exact id in one call and records local memory", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          assert.equal(method, "collections.info");
          return {
            body: {
              ok: true,
              policies: [{ id: "policy-top" }],
              data: {
                id: body.id,
                name: "Engineering",
                description: "Engineering docs",
                permission: "read_write",
                updatedAt: "2026-06-03T00:00:00.000Z",
                policies: [{ id: "policy-collection" }],
              },
            },
          };
        },
      },
    };

    const opened = await invokeTool(ctx, "collections.open", {
      id: "col-direct",
      view: "summary",
      compact: false,
    });

    assert.equal(opened.tool, "collections.open");
    assert.equal(opened.result.ok, true);
    assert.equal(opened.result.collection.id, "col-direct");
    assert.equal(opened.result.collection.name, "Engineering");
    assert.equal(opened.result.response.policies, undefined);
    assert.equal(opened.result.response.data.policies, undefined);
    assert.deepEqual(calls.map((call) => call.method), ["collections.info"]);

    const lookup = await invokeTool(ctx, "memory.lookup", {
      query: "Engineering",
      type: "collection",
      compact: false,
    });
    assert.equal(lookup.result.items[0]?.id, "col-direct");
  });
});

test("collections.open resolves remembered names and URLs before hydrating", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  name: "Engineering",
                  description: "Fresh collection metadata",
                  permission: "read_write",
                  urlId: "engineering-AbCdEf12",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "col-eng",
                  name: "Engineering",
                  description: "Engineering docs",
                  urlId: "engineering-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "collections.list", {
      query: "engineering",
      compact: false,
    });

    const byName = await invokeTool(ctx, "collections.open", {
      query: "Engineering",
      view: "summary",
      compact: false,
    });
    const byUrl = await invokeTool(ctx, "collections.open", {
      url: "https://handbook.example.com/collection/engineering-AbCdEf12",
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "collections.info",
    ]);
    assert.equal(byName.result.ok, true);
    assert.equal(byName.result.mode, "memory");
    assert.equal(byName.result.collection.id, "col-eng");
    assert.equal(byName.result.candidate.score, 100);
    assert.equal(byUrl.result.ok, true);
    assert.equal(byUrl.result.collection.id, "col-eng");
    assert.equal(byUrl.result.candidate.score, 100);
  });
});

test("collections.open_batch opens repeated collection refs with deduplicated hydration", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  name: body.id === "col-direct" ? "Operations" : "Engineering",
                  description: body.id === "col-direct" ? "Operations docs" : "Engineering docs",
                  permission: "read_write",
                  urlId: body.id === "col-direct" ? "operations-DirOps1" : "engineering-AbCdEf12",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "col-eng",
                  name: "Engineering",
                  description: "Engineering docs",
                  urlId: "engineering-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "collections.list", {
      query: "engineering",
      compact: false,
    });

    const opened = await invokeTool(ctx, "collections.open_batch", {
      refs: ["Engineering", "Engineering"],
      ids: ["col-direct", "col-direct"],
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "collections.info",
    ]);
    assert.equal(opened.tool, "collections.open_batch");
    assert.equal(opened.result.referenceCount, 4);
    assert.equal(opened.result.ok, 4);
    assert.deepEqual(opened.result.items.map((item) => item.collection?.id), [
      "col-eng",
      "col-eng",
      "col-direct",
      "col-direct",
    ]);
    assert.deepEqual(opened.result.items.map((item) => item.index), [0, 1, 2, 3]);
    assert.equal(calls.filter((call) => call.method === "collections.info" && call.body.id === "col-eng").length, 1);
    assert.equal(calls.filter((call) => call.method === "collections.info" && call.body.id === "col-direct").length, 1);
  });
});

test("collections.tree resolves a collection name before listing documents", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  name: "Engineering",
                  description: "Engineering docs",
                  urlId: "engineering-AbCdEf12",
                },
              },
            };
          }
          if (method === "documents.list") {
            assert.equal(body.collectionId, "col-eng");
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-root",
                    title: "Engineering Home",
                    collectionId: "col-eng",
                    parentDocumentId: null,
                    publishedAt: "2026-06-03T00:00:00.000Z",
                  },
                  {
                    id: "doc-child",
                    title: "Onboarding",
                    collectionId: "col-eng",
                    parentDocumentId: "doc-root",
                    publishedAt: "2026-06-03T00:00:00.000Z",
                  },
                ],
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "col-eng",
                  name: "Engineering",
                  description: "Engineering docs",
                  urlId: "engineering-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const tree = await invokeTool(ctx, "collections.tree", {
      query: "Engineering",
      maxDepth: 2,
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "documents.list",
    ]);
    assert.equal(tree.tool, "collections.tree");
    assert.equal(tree.collectionId, "col-eng");
    assert.equal(tree.result.ok, true);
    assert.equal(tree.result.collection.id, "col-eng");
    assert.equal(tree.result.rootCount, 1);
    assert.equal(tree.result.tree[0]?.id, "doc-root");
    assert.equal(tree.result.tree[0]?.children[0]?.id, "doc-child");
  });
});

test("collections.tree returns a structured miss without listing documents", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          throw new Error("collections.tree should not call live APIs when fallbackSearch is false and memory misses");
        },
      },
    };

    const tree = await invokeTool(ctx, "collections.tree", {
      query: "missing collection",
      fallbackSearch: false,
      compact: false,
    });

    assert.deepEqual(calls, []);
    assert.equal(tree.result.ok, false);
    assert.equal(tree.result.status, "not_found");
    assert.deepEqual(tree.result.tree, []);
  });
});

test("comments.review_queue resolves document titles before listing comments", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-comment");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-comment",
                  title: "Commented Doc",
                  urlId: "commented-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "comments.list") {
            assert.equal(body.documentId, "doc-comment");
            assert.equal(body.includeReplies, true);
            assert.equal(body.limit, 30);
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "comment-1",
                    documentId: "doc-comment",
                    text: "Needs review",
                    createdAt: "2026-06-01T00:00:00.000Z",
                    updatedAt: "2026-06-02T00:00:00.000Z",
                  },
                ],
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-comment",
                  title: "Commented Doc",
                  urlId: "commented-doc-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "comments.review_queue", {
      query: "Commented Doc",
      includeReplies: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "comments.list",
    ]);
    assert.equal(output.tool, "comments.review_queue");
    assert.deepEqual(output.result.scope.documentIds, ["doc-comment"]);
    assert.equal(output.result.scope.documentResolution.resolved[0]?.id, "doc-comment");
    assert.equal(output.result.rowCount, 1);
    assert.equal(output.result.rows[0]?.commentId, "comment-1");
  });
});

test("comments.review_queue resolves collection names before listing scoped documents", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.info") {
            assert.equal(body.id, "col-eng");
            return {
              body: {
                ok: true,
                data: {
                  id: "col-eng",
                  name: "Engineering",
                  urlId: "engineering-AbCdEf12",
                },
              },
            };
          }
          if (method === "documents.list") {
            assert.equal(body.collectionId, "col-eng");
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-a",
                    title: "Engineering Home",
                    collectionId: "col-eng",
                  },
                ],
              },
            };
          }
          if (method === "comments.list") {
            assert.equal(body.documentId, "doc-a");
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "comment-a",
                    documentId: "doc-a",
                    text: "Collection scoped review",
                    createdAt: "2026-06-01T00:00:00.000Z",
                    updatedAt: "2026-06-01T00:00:00.000Z",
                  },
                ],
              },
            };
          }
          assert.equal(method, "collections.list");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "col-eng",
                  name: "Engineering",
                  urlId: "engineering-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "comments.review_queue", {
      collectionQuery: "Engineering",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "documents.list",
      "comments.list",
    ]);
    assert.equal(output.tool, "comments.review_queue");
    assert.equal(output.result.scope.collectionId, "col-eng");
    assert.equal(output.result.scope.collectionResolution.resolved.id, "col-eng");
    assert.deepEqual(output.result.scope.documentIds, ["doc-a"]);
    assert.equal(output.result.rowCount, 1);
  });
});

test("comments.list resolves document titles before listing comments", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-comments-list");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-comments-list",
                  title: "Comment List Doc",
                  urlId: "comment-list-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "comments.list") {
            assert.deepEqual(body, {
              documentId: "doc-comments-list",
              includeReplies: true,
              limit: 20,
            });
            return {
              body: {
                ok: true,
                data: [{ id: "comment-1", documentId: "doc-comments-list" }],
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-comments-list",
                  title: "Comment List Doc",
                  urlId: "comment-list-doc-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "comments.list", {
      query: "Comment List Doc",
      includeReplies: true,
      limit: 20,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "comments.list",
    ]);
    assert.equal(output.tool, "comments.list");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.documentId, "doc-comments-list");
    assert.equal(output.result.resolution.id, "doc-comments-list");
    assert.equal(output.result.data[0]?.id, "comment-1");
  });
});

test("comments.create resolves document titles before creating comments", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-comment-create");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-comment-create",
                  title: "Comment Create Doc",
                  urlId: "comment-create-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "comments.create") {
            assert.deepEqual(body, {
              documentId: "doc-comment-create",
              text: "Looks good.",
            });
            return {
              body: {
                ok: true,
                data: { id: "comment-created", documentId: "doc-comment-create", text: "Looks good." },
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-comment-create",
                  title: "Comment Create Doc",
                  urlId: "comment-create-doc-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "comments.create", {
      query: "Comment Create Doc",
      text: "Looks good.",
      performAction: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "comments.create",
    ]);
    assert.equal(output.tool, "comments.create");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.documentId, "doc-comment-create");
    assert.equal(output.result.resolution.id, "doc-comment-create");
    assert.equal(output.result.data.id, "comment-created");
  });
});

test("shares.list resolves document titles without consuming the shares query filter", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-share-list");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-share-list",
                  title: "Share List Doc",
                  urlId: "share-list-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "shares.list") {
            assert.deepEqual(body, {
              query: "published",
              documentId: "doc-share-list",
              limit: 10,
            });
            return {
              body: {
                ok: true,
                data: [{ id: "share-1", documentId: "doc-share-list" }],
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-share-list",
                  title: "Share List Doc",
                  urlId: "share-list-doc-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "shares.list", {
      query: "published",
      documentQuery: "Share List Doc",
      limit: 10,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "shares.list",
    ]);
    assert.equal(output.tool, "shares.list");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.documentId, "doc-share-list");
    assert.equal(output.result.resolution.id, "doc-share-list");
    assert.equal(output.result.data[0]?.id, "share-1");
  });
});

test("shares.info resolves document titles before reading share details", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-share-info");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-share-info",
                  title: "Share Info Doc",
                  urlId: "share-info-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "shares.info") {
            assert.deepEqual(body, {
              documentId: "doc-share-info",
            });
            return {
              body: {
                ok: true,
                data: { id: "share-info-1", documentId: "doc-share-info" },
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-share-info",
                  title: "Share Info Doc",
                  urlId: "share-info-doc-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "shares.info", {
      query: "Share Info Doc",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "shares.info",
    ]);
    assert.equal(output.tool, "shares.info");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.documentId, "doc-share-info");
    assert.equal(output.result.resolution.id, "doc-share-info");
    assert.equal(output.result.data?.id, "share-info-1");
  });
});

test("shares.create resolves document titles before creating shares", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-share-create");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-share-create",
                  title: "Share Create Doc",
                  urlId: "share-create-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "shares.create") {
            assert.deepEqual(body, {
              documentId: "doc-share-create",
              published: true,
            });
            return {
              body: {
                ok: true,
                data: { id: "share-created", documentId: "doc-share-create" },
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-share-create",
                  title: "Share Create Doc",
                  urlId: "share-create-doc-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "shares.create", {
      documentQuery: "Share Create Doc",
      published: true,
      performAction: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "shares.create",
    ]);
    assert.equal(output.tool, "shares.create");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.documentId, "doc-share-create");
    assert.equal(output.result.resolution.id, "doc-share-create");
    assert.equal(output.result.data.id, "share-created");
  });
});

test("events.list resolves remembered document collection and actor filters", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-event");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-event",
                  title: "Event Scope Doc",
                  collectionId: "col-event",
                  urlId: "event-scope-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "collections.info") {
            assert.equal(body.id, "col-event");
            return {
              body: {
                ok: true,
                data: {
                  id: "col-event",
                  name: "Event Collection",
                  urlId: "event-collection-AbCdEf12",
                },
              },
            };
          }
          if (method === "users.info") {
            assert.equal(body.id, "user-event");
            return {
              body: {
                ok: true,
                data: {
                  id: "user-event",
                  name: "Event Actor",
                  email: "actor@example.com",
                },
              },
            };
          }
          if (method === "events.list") {
            assert.deepEqual(body, {
              auditLog: true,
              limit: 10,
              documentId: "doc-event",
              collectionId: "col-event",
              actorId: "user-event",
            });
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "event-1",
                    name: "documents.update",
                    documentId: "doc-event",
                    collectionId: "col-event",
                    actorId: "user-event",
                  },
                ],
              },
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    };

    await invokeTool(ctx, "memory.remember", {
      type: "document",
      id: "doc-event",
      title: "Event Scope Doc",
      performAction: true,
    });
    await invokeTool(ctx, "memory.remember", {
      type: "collection",
      id: "col-event",
      name: "Event Collection",
      performAction: true,
    });
    await invokeTool(ctx, "memory.remember", {
      type: "user",
      id: "user-event",
      name: "Event Actor",
      email: "actor@example.com",
      performAction: true,
    });

    const output = await invokeTool(ctx, "events.list", {
      documentQuery: "Event Scope Doc",
      collectionQuery: "Event Collection",
      userQuery: "actor@example.com",
      auditLog: true,
      limit: 10,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.info",
      "collections.info",
      "users.info",
      "events.list",
    ]);
    assert.equal(output.tool, "events.list");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.documentId, "doc-event");
    assert.equal(output.result.collectionId, "col-event");
    assert.equal(output.result.actorId, "user-event");
    assert.equal(output.result.resolution.documentId.id, "doc-event");
    assert.equal(output.result.resolution.collectionId.id, "col-event");
    assert.equal(output.result.resolution.actorId.id, "user-event");
    assert.equal(output.result.data[0]?.id, "event-1");
  });
});

test("documents archived and deleted resolve remembered collection filters", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.info") {
            assert.equal(body.id, "col-history");
            return {
              body: {
                ok: true,
                data: {
                  id: "col-history",
                  name: "History Collection",
                  urlId: "history-collection-AbCdEf12",
                },
              },
            };
          }
          if (method === "documents.archived") {
            assert.deepEqual(body, {
              collectionId: "col-history",
              limit: 5,
            });
            return {
              body: {
                ok: true,
                data: [{ id: "archived-doc", collectionId: "col-history" }],
              },
            };
          }
          if (method === "documents.deleted") {
            assert.deepEqual(body, {
              collectionId: "col-history",
              limit: 5,
            });
            return {
              body: {
                ok: true,
                data: [{ id: "deleted-doc", collectionId: "col-history" }],
              },
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    };

    await invokeTool(ctx, "memory.remember", {
      type: "collection",
      id: "col-history",
      name: "History Collection",
      performAction: true,
    });

    const archived = await invokeTool(ctx, "documents.archived", {
      collectionQuery: "History Collection",
      limit: 5,
      compact: false,
    });
    const deleted = await invokeTool(ctx, "documents.deleted", {
      collectionQuery: "History Collection",
      limit: 5,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.info",
      "documents.archived",
      "collections.info",
      "documents.deleted",
    ]);
    assert.equal(archived.tool, "documents.archived");
    assert.equal(archived.result.collectionId, "col-history");
    assert.equal(archived.result.resolution.id, "col-history");
    assert.equal(archived.result.data[0]?.id, "archived-doc");
    assert.equal(deleted.tool, "documents.deleted");
    assert.equal(deleted.result.collectionId, "col-history");
    assert.equal(deleted.result.resolution.id, "col-history");
    assert.equal(deleted.result.data[0]?.id, "deleted-doc");
  });
});

test("template reads populate memory and resolve remembered template names", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "templates.list") {
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "template-incident",
                    title: "Incident Postmortem",
                    collectionId: "col-eng",
                    updatedAt: "2026-06-01T00:00:00.000Z",
                  },
                ],
              },
            };
          }
          if (method === "templates.info") {
            assert.equal(body.id, "template-incident");
            return {
              body: {
                ok: true,
                data: {
                  id: "template-incident",
                  title: "Incident Postmortem",
                  collectionId: "col-eng",
                  data: {},
                },
              },
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    };

    await invokeTool(ctx, "templates.list", {
      query: "incident",
      limit: 5,
      compact: false,
    });

    const lookup = await invokeTool(ctx, "memory.lookup", {
      query: "Incident Postmortem",
      type: "template",
      compact: false,
    });
    const info = await invokeTool(ctx, "templates.info", {
      templateQuery: "Incident Postmortem",
      refresh: false,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "templates.list",
      "templates.info",
    ]);
    assert.equal(lookup.result.items[0]?.id, "template-incident");
    assert.equal(lookup.result.items[0]?.type, "template");
    assert.equal(info.tool, "templates.info");
    assert.equal(info.result.templateId, "template-incident");
    assert.equal(info.result.resolution.id, "template-incident");
    assert.equal(info.result.data?.id, "template-incident");
  });
});

test("templates.extract_placeholders resolves remembered template names before reading", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "templates.info") {
            assert.deepEqual(body, { id: "template-incident" });
            return {
              body: {
                ok: true,
                data: {
                  id: "template-incident",
                  title: "Incident Postmortem",
                  data: {
                    type: "doc",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "Owner {{owner}} reviews {{service_name}}" }],
                      },
                    ],
                  },
                },
              },
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    };

    await invokeTool(ctx, "memory.remember", {
      type: "template",
      id: "template-incident",
      title: "Incident Postmortem",
      performAction: true,
    });

    const output = await invokeTool(ctx, "templates.extract_placeholders", {
      templateQuery: "Incident Postmortem",
      refresh: false,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["templates.info"]);
    assert.equal(output.tool, "templates.extract_placeholders");
    assert.equal(output.result.templateId, "template-incident");
    assert.equal(output.result.resolution.id, "template-incident");
    assert.deepEqual(output.result.placeholders, ["owner", "service_name"]);
  });
});

test("documents.create_from_template resolves remembered template names before creating", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.create") {
            assert.deepEqual(body, {
              templateId: "template-incident",
              title: "Incident 123",
              publish: false,
            });
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-from-template",
                  title: "Incident 123",
                  templateId: "template-incident",
                },
              },
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    };

    await invokeTool(ctx, "memory.remember", {
      type: "template",
      id: "template-incident",
      title: "Incident Postmortem",
      performAction: true,
    });

    const output = await invokeTool(ctx, "documents.create_from_template", {
      templateQuery: "Incident Postmortem",
      refresh: false,
      title: "Incident 123",
      performAction: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.create"]);
    assert.equal(output.tool, "documents.create_from_template");
    assert.equal(output.result.success, true);
    assert.equal(output.result.templateId, "template-incident");
    assert.equal(output.result.resolution.id, "template-incident");
    assert.equal(output.result.document.id, "doc-from-template");
  });
});

test("users.info resolves remembered users before reading details", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "users.list") {
            assert.equal(body.query, "Alice Example");
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "user-alice",
                    name: "Alice Example",
                    email: "alice@example.com",
                  },
                ],
              },
            };
          }
          assert.equal(method, "users.info");
          assert.deepEqual(body, { id: "user-alice" });
          return {
            body: {
              ok: true,
              data: {
                id: "user-alice",
                name: "Alice Example",
                email: "alice@example.com",
              },
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "users.info", {
      query: "Alice Example",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "users.list",
      "users.info",
      "users.info",
    ]);
    assert.equal(output.tool, "users.info");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.userId, "user-alice");
    assert.equal(output.result.resolution.id, "user-alice");
    assert.equal(output.result.data?.email, "alice@example.com");
  });
});

test("groups.memberships resolves remembered groups before listing members", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "groups.list") {
            assert.equal(body.query, "Engineering");
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "group-eng",
                    name: "Engineering",
                    memberCount: 2,
                  },
                ],
              },
            };
          }
          if (method === "groups.info") {
            assert.deepEqual(body, { id: "group-eng" });
            return {
              body: {
                ok: true,
                data: {
                  id: "group-eng",
                  name: "Engineering",
                  memberCount: 2,
                },
              },
            };
          }
          assert.equal(method, "groups.memberships");
          assert.deepEqual(body, {
            id: "group-eng",
            limit: 10,
          });
          return {
            body: {
              ok: true,
              data: [{ id: "membership-1", userId: "user-alice" }],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "groups.memberships", {
      query: "Engineering",
      limit: 10,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "groups.list",
      "groups.info",
      "groups.memberships",
    ]);
    assert.equal(output.tool, "groups.memberships");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.groupId, "group-eng");
    assert.equal(output.result.resolution.id, "group-eng");
    assert.equal(output.result.data[0]?.id, "membership-1");
  });
});

test("documents.add_user resolves document and user references before mutating", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.search_titles") {
            assert.equal(body.query, "Incident Runbook");
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-incident",
                    title: "Incident Runbook",
                    urlId: "incident-runbook-AbCdEf12",
                  },
                ],
              },
            };
          }
          if (method === "users.list") {
            assert.equal(body.query, "alice@example.com");
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "user-alice",
                    name: "Alice Example",
                    email: "alice@example.com",
                  },
                ],
              },
            };
          }
          if (method === "documents.info") {
            assert.deepEqual(body, { id: "doc-incident" });
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-incident",
                  title: "Incident Runbook",
                  urlId: "incident-runbook-AbCdEf12",
                },
              },
            };
          }
          if (method === "users.info") {
            assert.deepEqual(body, { id: "user-alice" });
            return {
              body: {
                ok: true,
                data: {
                  id: "user-alice",
                  name: "Alice Example",
                  email: "alice@example.com",
                },
              },
            };
          }
          assert.equal(method, "documents.add_user");
          assert.deepEqual(body, {
            id: "doc-incident",
            userId: "user-alice",
            permission: "read",
          });
          return {
            body: {
              ok: true,
              data: { id: "membership-1", documentId: "doc-incident", userId: "user-alice" },
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.add_user", {
      documentQuery: "Incident Runbook",
      userQuery: "alice@example.com",
      permission: "read",
      performAction: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "users.list",
      "users.info",
      "documents.add_user",
    ]);
    assert.equal(output.tool, "documents.add_user");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.documentId, "doc-incident");
    assert.equal(output.result.userId, "user-alice");
    assert.equal(output.result.resolution.documentId.id, "doc-incident");
    assert.equal(output.result.resolution.userId.id, "user-alice");
  });
});

test("collections.add_group resolves collection and group references before mutating", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.list") {
            assert.equal(body.query, "Engineering");
            return {
              body: {
                ok: true,
                data: [{ id: "col-eng", name: "Engineering" }],
              },
            };
          }
          if (method === "groups.list") {
            assert.equal(body.query, "Security");
            return {
              body: {
                ok: true,
                data: [{ id: "group-sec", name: "Security" }],
              },
            };
          }
          if (method === "collections.info") {
            assert.deepEqual(body, { id: "col-eng" });
            return {
              body: {
                ok: true,
                data: { id: "col-eng", name: "Engineering" },
              },
            };
          }
          if (method === "groups.info") {
            assert.deepEqual(body, { id: "group-sec" });
            return {
              body: {
                ok: true,
                data: { id: "group-sec", name: "Security" },
              },
            };
          }
          assert.equal(method, "collections.add_group");
          assert.deepEqual(body, {
            id: "col-eng",
            groupId: "group-sec",
            permission: "read_write",
          });
          return {
            body: {
              ok: true,
              data: { id: "membership-2", collectionId: "col-eng", groupId: "group-sec" },
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "collections.add_group", {
      query: "Engineering",
      groupQuery: "Security",
      permission: "read_write",
      performAction: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "groups.list",
      "groups.info",
      "collections.add_group",
    ]);
    assert.equal(output.tool, "collections.add_group");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.collectionId, "col-eng");
    assert.equal(output.result.groupId, "group-sec");
    assert.equal(output.result.resolution.collectionId.id, "col-eng");
    assert.equal(output.result.resolution.groupId.id, "group-sec");
  });
});

test("groups.add_user resolves group and user references before mutating", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "groups.list") {
            assert.equal(body.query, "Engineering");
            return {
              body: {
                ok: true,
                data: [{ id: "group-eng", name: "Engineering" }],
              },
            };
          }
          if (method === "users.list") {
            assert.equal(body.query, "Alice Example");
            return {
              body: {
                ok: true,
                data: [{ id: "user-alice", name: "Alice Example", email: "alice@example.com" }],
              },
            };
          }
          if (method === "groups.info") {
            assert.deepEqual(body, { id: "group-eng" });
            return {
              body: {
                ok: true,
                data: { id: "group-eng", name: "Engineering" },
              },
            };
          }
          if (method === "users.info") {
            assert.deepEqual(body, { id: "user-alice" });
            return {
              body: {
                ok: true,
                data: { id: "user-alice", name: "Alice Example", email: "alice@example.com" },
              },
            };
          }
          assert.equal(method, "groups.add_user");
          assert.deepEqual(body, {
            id: "group-eng",
            userId: "user-alice",
          });
          return {
            body: {
              ok: true,
              data: { id: "membership-3", groupId: "group-eng", userId: "user-alice" },
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "groups.add_user", {
      groupQuery: "Engineering",
      userQuery: "Alice Example",
      performAction: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "groups.list",
      "groups.info",
      "users.list",
      "users.info",
      "groups.add_user",
    ]);
    assert.equal(output.tool, "groups.add_user");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.groupId, "group-eng");
    assert.equal(output.result.userId, "user-alice");
    assert.equal(output.result.resolution.groupId.id, "group-eng");
    assert.equal(output.result.resolution.userId.id, "user-alice");
  });
});

test("documents.attachments resolves document titles before extracting refs", async () => {
  await withTmpMemory(async (memoryFile) => {
    const attachmentId = "15831936-7fef-4a58-b17b-121a65c3d787";
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-assets");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-assets",
                  title: "Asset Doc",
                  urlId: "asset-doc-AbCdEf12",
                  text: `![Asset](/api/attachments.redirect?id=${attachmentId})`,
                },
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-assets",
                  title: "Asset Doc",
                  urlId: "asset-doc-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.attachments", {
      query: "Asset Doc",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles", "documents.info"]);
    assert.equal(output.tool, "documents.attachments");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.document.id, "doc-assets");
    assert.equal(output.result.resolution.id, "doc-assets");
    assert.equal(output.result.total, 1);
    assert.equal(output.result.attachments[0]?.id, attachmentId);
  });
});

test("documents.download_attachments resolves document titles before saving refs", async () => {
  await withTmpMemory(async (memoryFile) => {
    const attachmentId = "15831936-7fef-4a58-b17b-121a65c3d787";
    const calls = [];
    const downloads = [];
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-cli-downloads-"));
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-assets");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-assets",
                  title: "Asset Doc",
                  urlId: "asset-doc-AbCdEf12",
                  text: `![Asset](/api/attachments.redirect?id=${attachmentId})`,
                },
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-assets",
                  title: "Asset Doc",
                  urlId: "asset-doc-AbCdEf12",
                },
              ],
            },
          };
        },
        async download(method, body) {
          downloads.push({ method, body });
          assert.equal(method, "attachments.redirect");
          assert.equal(body.id, attachmentId);
          return {
            status: 200,
            headers: {
              "content-type": "image/png",
            },
            body: Buffer.from("asset-bytes"),
            url: `https://signed.example.com/${attachmentId}.png`,
          };
        },
      },
    };

    try {
      const output = await invokeTool(ctx, "documents.download_attachments", {
        query: "Asset Doc",
        outputDir: dir,
        overwrite: true,
        compact: false,
      });

      assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles", "documents.info"]);
      assert.deepEqual(downloads.map((call) => call.method), ["attachments.redirect"]);
      assert.equal(output.tool, "documents.download_attachments");
      assert.equal(output.result.ok, true);
      assert.equal(output.result.document.id, "doc-assets");
      assert.equal(output.result.resolution.id, "doc-assets");
      assert.equal(output.result.total, 1);
      assert.equal(output.result.succeeded, 1);
      assert.equal(await fs.readFile(output.result.items[0].filePath, "utf8"), "asset-bytes");
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("documents.diff resolves document titles before comparing proposed text", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-diff");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-diff",
                  title: "Diff Doc",
                  revision: 7,
                  urlId: "diff-doc-AbCdEf12",
                  text: "# Diff Doc\n\nOld body",
                },
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-diff",
                  title: "Diff Doc",
                  urlId: "diff-doc-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.diff", {
      query: "Diff Doc",
      proposedText: "# Diff Doc\n\nNew body",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles", "documents.info"]);
    assert.equal(output.tool, "documents.diff");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.id, "doc-diff");
    assert.equal(output.result.revision, 7);
    assert.equal(output.result.resolution.id, "doc-diff");
    assert.equal(output.result.stats.added, 1);
    assert.equal(output.result.stats.removed, 1);
  });
});

test("revisions.list resolves document titles before listing history", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-history");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-history",
                  title: "History Doc",
                  revision: 9,
                  urlId: "history-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "revisions.list") {
            assert.equal(body.documentId, "doc-history");
            assert.equal(body.limit, 5);
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "rev-1",
                    documentId: "doc-history",
                    title: "History Doc",
                    createdAt: "2026-06-01T00:00:00.000Z",
                    createdBy: { id: "user-1", name: "Alice" },
                  },
                ],
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-history",
                  title: "History Doc",
                  urlId: "history-doc-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "revisions.list", {
      query: "History Doc",
      limit: 5,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "revisions.list",
    ]);
    assert.equal(output.tool, "revisions.list");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.documentId, "doc-history");
    assert.equal(output.result.resolution.id, "doc-history");
    assert.equal(output.result.revisionCount, 1);
    assert.equal(output.result.data[0]?.id, "rev-1");
  });
});

test("revisions.diff resolves a document title and compares latest revisions", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const revisionsById = {
      "rev-old": {
        id: "rev-old",
        documentId: "doc-history",
        title: "History Doc",
        text: "alpha\nbravo",
        createdAt: "2026-06-01T00:00:00.000Z",
      },
      "rev-new": {
        id: "rev-new",
        documentId: "doc-history",
        title: "History Doc",
        text: "alpha\nbeta\ncharlie",
        createdAt: "2026-06-02T00:00:00.000Z",
      },
    };
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.search_titles") {
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-history",
                    title: "History Doc",
                    urlId: "history-doc-AbCdEf12",
                  },
                ],
              },
            };
          }
          if (method === "documents.info") {
            assert.equal(body.id, "doc-history");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-history",
                  title: "History Doc",
                  revision: 9,
                  urlId: "history-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "revisions.list") {
            assert.deepEqual(body, {
              documentId: "doc-history",
              limit: 2,
              offset: 0,
            });
            return {
              body: {
                ok: true,
                data: [
                  { id: "rev-new", documentId: "doc-history", title: "History Doc" },
                  { id: "rev-old", documentId: "doc-history", title: "History Doc" },
                ],
              },
            };
          }
          if (method === "revisions.info") {
            return {
              body: {
                ok: true,
                data: revisionsById[body.id],
              },
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    };

    const output = await invokeTool(ctx, "revisions.diff", {
      query: "History Doc",
      revisionPair: "latest",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "revisions.list",
      "revisions.info",
      "revisions.info",
    ]);
    assert.equal(output.tool, "revisions.diff");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.id, "doc-history");
    assert.equal(output.result.resolution.id, "doc-history");
    assert.equal(output.result.revisionPair, "latest");
    assert.equal(output.result.baseRevisionId, "rev-old");
    assert.equal(output.result.targetRevisionId, "rev-new");
    assert.equal(output.result.stats.added, 2);
    assert.equal(output.result.stats.removed, 1);
  });
});

test("documents.safe_update resolves document titles before guarded updates", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body, options) {
          calls.push({ method, body, options });
          if (method === "documents.search_titles") {
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-safe-update",
                    title: "Safe Update Doc",
                    revision: 4,
                    urlId: "safe-update-doc-AbCdEf12",
                  },
                ],
              },
            };
          }
          if (method === "documents.info") {
            assert.equal(body.id, "doc-safe-update");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-safe-update",
                  title: "Safe Update Doc",
                  text: "Old",
                  revision: 4,
                  urlId: "safe-update-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "documents.update") {
            assert.deepEqual(body, {
              id: "doc-safe-update",
              text: "\n\nNew section",
              editMode: "append",
            });
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-safe-update",
                  title: "Safe Update Doc",
                  text: "Old\n\nNew section",
                  revision: 5,
                  urlId: "safe-update-doc-AbCdEf12",
                },
              },
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    };

    const output = await invokeTool(ctx, "documents.safe_update", {
      documentQuery: "Safe Update Doc",
      expectedRevision: "latest",
      text: "\n\nNew section",
      editMode: "append",
      performAction: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "documents.info",
      "documents.update",
    ]);
    assert.equal(output.tool, "documents.safe_update");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.id, "doc-safe-update");
    assert.equal(output.result.resolution.id, "doc-safe-update");
    assert.equal(output.result.expectedRevision, 4);
    assert.equal(output.result.expectedRevisionSource, "latest");
    assert.equal(output.result.previousRevision, 4);
    assert.equal(output.result.currentRevision, 5);
  });
});

test("documents.apply_patch_safe resolves document titles before applying guarded patches", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body, options) {
          calls.push({ method, body, options });
          if (method === "documents.search_titles") {
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-safe-patch",
                    title: "Safe Patch Doc",
                    revision: 7,
                    urlId: "safe-patch-doc-AbCdEf12",
                  },
                ],
              },
            };
          }
          if (method === "documents.info") {
            assert.equal(body.id, "doc-safe-patch");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-safe-patch",
                  title: "Safe Patch Doc",
                  text: "Old",
                  revision: 7,
                  urlId: "safe-patch-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "documents.update") {
            assert.deepEqual(body, {
              id: "doc-safe-patch",
              text: "New",
              editMode: "replace",
            });
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-safe-patch",
                  title: "Safe Patch Doc",
                  text: "New",
                  revision: 8,
                  urlId: "safe-patch-doc-AbCdEf12",
                },
              },
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    };

    const output = await invokeTool(ctx, "documents.apply_patch_safe", {
      query: "Safe Patch Doc",
      expectedRevision: "latest",
      mode: "unified",
      patch: "@@ -1,1 +1,1 @@\n-Old\n+New",
      performAction: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "documents.info",
      "documents.update",
    ]);
    assert.equal(output.tool, "documents.apply_patch_safe");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.id, "doc-safe-patch");
    assert.equal(output.result.resolution.id, "doc-safe-patch");
    assert.equal(output.result.expectedRevision, 7);
    assert.equal(output.result.expectedRevisionSource, "latest");
    assert.equal(output.result.previousRevision, 7);
    assert.equal(output.result.currentRevision, 8);
  });
});

test("documents.batch_update resolves document titles before guarded item updates", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body, options) {
          calls.push({ method, body, options });
          if (method === "documents.search_titles") {
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-batch-update",
                    title: "Batch Update Doc",
                    revision: 11,
                    urlId: "batch-update-doc-AbCdEf12",
                  },
                ],
              },
            };
          }
          if (method === "documents.info") {
            assert.equal(body.id, "doc-batch-update");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-batch-update",
                  title: "Batch Update Doc",
                  text: "Old",
                  revision: 11,
                  urlId: "batch-update-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "documents.update") {
            assert.deepEqual(body, {
              id: "doc-batch-update",
              text: "\n\nBatch section",
              editMode: "append",
            });
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-batch-update",
                  title: "Batch Update Doc",
                  text: "Old\n\nBatch section",
                  revision: 12,
                  urlId: "batch-update-doc-AbCdEf12",
                },
              },
            };
          }
          throw new Error(`unexpected method ${method}`);
        },
      },
    };

    const output = await invokeTool(ctx, "documents.batch_update", {
      updates: [
        {
          query: "Batch Update Doc",
          expectedRevision: "latest",
          text: "\n\nBatch section",
          editMode: "append",
        },
      ],
      performAction: true,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "documents.info",
      "documents.update",
    ]);
    assert.equal(output.tool, "documents.batch_update");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.total, 1);
    assert.equal(output.result.items[0]?.id, "doc-batch-update");
    assert.equal(output.result.items[0]?.ok, true);
    assert.equal(output.result.items[0]?.result.resolution.id, "doc-batch-update");
    assert.equal(output.result.items[0]?.result.expectedRevision, 11);
    assert.equal(output.result.items[0]?.result.expectedRevisionSource, "latest");
  });
});

test("documents.users resolves document titles before listing effective access", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            assert.equal(body.id, "doc-access");
            return {
              body: {
                ok: true,
                data: {
                  id: "doc-access",
                  title: "Access Doc",
                  urlId: "access-doc-AbCdEf12",
                },
              },
            };
          }
          if (method === "documents.users") {
            assert.deepEqual(body, {
              id: "doc-access",
              limit: 10,
            });
            return {
              body: {
                ok: true,
                data: [{ id: "user-1", name: "Alice" }],
              },
            };
          }
          assert.equal(method, "documents.search_titles");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-access",
                  title: "Access Doc",
                  urlId: "access-doc-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "documents.users", {
      query: "Access Doc",
      limit: 10,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
      "documents.users",
    ]);
    assert.equal(output.tool, "documents.users");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.documentId, "doc-access");
    assert.equal(output.result.resolution.id, "doc-access");
    assert.equal(output.result.data[0]?.id, "user-1");
  });
});

test("collections.memberships resolves collection names before listing memberships", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod", baseUrl: "https://handbook.example.com" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "collections.info") {
            assert.equal(body.id, "col-access");
            return {
              body: {
                ok: true,
                data: {
                  id: "col-access",
                  name: "Access Collection",
                  urlId: "access-collection-AbCdEf12",
                },
              },
            };
          }
          if (method === "collections.memberships") {
            assert.deepEqual(body, {
              id: "col-access",
              limit: 5,
            });
            return {
              body: {
                ok: true,
                data: [{ id: "membership-1", userId: "user-1" }],
              },
            };
          }
          assert.equal(method, "collections.list");
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "col-access",
                  name: "Access Collection",
                  urlId: "access-collection-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const output = await invokeTool(ctx, "collections.memberships", {
      query: "Access Collection",
      limit: 5,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "collections.list",
      "collections.info",
      "collections.memberships",
    ]);
    assert.equal(output.tool, "collections.memberships");
    assert.equal(output.result.ok, true);
    assert.equal(output.result.collectionId, "col-access");
    assert.equal(output.result.resolution.id, "col-access");
    assert.equal(output.result.data[0]?.id, "membership-1");
  });
});

test("memory.resolve hydrates a remembered document in one tool call", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Engineering Handbook",
                  collectionId: "col-1",
                  revision: 4,
                  updatedAt: "2026-06-02T00:00:00.000Z",
                  urlId: "eng-handbook-AbCdEf12",
                  text: "# Engineering Handbook\n\nFresh live body",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Engineering Handbook",
                  collectionId: "col-1",
                  revision: 3,
                  updatedAt: "2026-06-01T00:00:00.000Z",
                  urlId: "eng-handbook-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      compact: false,
    });

    const resolved = await invokeTool(ctx, "memory.resolve", {
      query: "Engineering Handbook",
      type: "document",
      hydrateLimit: 1,
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles", "documents.info"]);
    assert.equal(resolved.tool, "memory.resolve");
    assert.equal(resolved.result.candidates[0]?.id, "doc-1");
    assert.equal(resolved.result.live[0]?.ok, true);
    assert.equal(resolved.result.live[0]?.endpoint, "documents.info");
    assert.equal(resolved.result.live[0]?.result?.data?.revision, 4);
    assert.equal(resolved.result.live[0]?.result?.data?.text, undefined);
  });
});

test("memory.resolve can return remembered candidates without live refresh", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method) {
          calls.push({ method });
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "col-1",
                  name: "Engineering",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "collections.list", {
      query: "engineering",
      compact: false,
    });
    const resolved = await invokeTool(ctx, "memory.resolve", {
      query: "Engineering",
      type: "collection",
      refresh: false,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["collections.list"]);
    assert.equal(resolved.result.candidates[0]?.id, "col-1");
    assert.deepEqual(resolved.result.live, []);
    assert.equal(resolved.result.memory.refreshed, false);
  });
});

test("memory.resolve falls back to live search on cold miss and remembers the result", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Cold Start Runbook",
                  revision: 2,
                  updatedAt: "2026-06-04T00:00:00.000Z",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-cold",
                  title: "Cold Start Runbook",
                  updatedAt: "2026-06-04T00:00:00.000Z",
                },
              ],
            },
          };
        },
      },
    };

    const resolved = await invokeTool(ctx, "memory.resolve", {
      query: "cold start runbook",
      type: "document",
      hydrateLimit: 1,
      compact: false,
    });
    const lookup = await invokeTool(ctx, "memory.lookup", {
      query: "Cold Start",
      type: "document",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles", "documents.info"]);
    assert.equal(resolved.result.candidates[0]?.id, "doc-cold");
    assert.equal(resolved.result.live[0]?.result?.data?.revision, 2);
    assert.equal(resolved.result.memory.fallback?.observed, 1);
    assert.equal(lookup.result.items[0]?.id, "doc-cold");
  });
});

test("memory.resolve uses URL title hints for cold fallback search", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Cold Start Runbook",
                  revision: 3,
                  urlId: "cold-start-runbook-AbCdEf12",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-cold",
                  title: "Cold Start Runbook",
                  urlId: "cold-start-runbook-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    const resolved = await invokeTool(ctx, "memory.resolve", {
      url: "https://handbook.example.com/doc/cold-start-runbook-AbCdEf12#d-AbCdEf12",
      type: "document",
      hydrateLimit: 1,
      compact: false,
    });

    assert.equal(calls[0]?.method, "documents.search_titles");
    assert.equal(calls[0]?.body?.query, "cold start runbook");
    assert.equal(resolved.result.candidates[0]?.id, "doc-cold");
    assert.equal(resolved.result.memory.fallback?.searchQuery, "cold start runbook");
  });
});

test("memory.resolve falls back when the best local memory score is below threshold", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: body.id === "doc-target" ? "Security Incident Runbook" : "Incident Overview",
                  revision: body.id === "doc-target" ? 4 : 1,
                },
              },
            };
          }
          if (method === "documents.search_titles" && body.query === "security incident runbook") {
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-target",
                    title: "Security Incident Runbook",
                  },
                ],
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-weak",
                  title: "Incident Overview",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "incident overview",
      mode: "titles",
      compact: false,
    });

    const resolved = await invokeTool(ctx, "memory.resolve", {
      query: "security incident runbook",
      type: "document",
      fallbackMinScore: 90,
      hydrateLimit: 1,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.search_titles",
      "documents.info",
    ]);
    assert.equal(resolved.result.candidates[0]?.id, "doc-target");
    assert.equal(resolved.result.memory.fallback?.observed, 1);
    assert.equal(resolved.result.live[0]?.result?.data?.revision, 4);
  });
});

test("memory.resolve can disable cold fallback search", async () => {
  await withTmpMemory(async (memoryFile) => {
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call() {
          throw new Error("fallbackSearch=false should not call Outline");
        },
      },
    };

    const resolved = await invokeTool(ctx, "memory.resolve", {
      query: "missing",
      type: "document",
      fallbackSearch: false,
      compact: false,
    });

    assert.deepEqual(resolved.result.candidates, []);
    assert.deepEqual(resolved.result.live, []);
    assert.equal(resolved.result.memory.fallback, null);
  });
});

test("memory.resolve_batch deduplicates live hydration across remembered queries", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Engineering Handbook",
                  collectionId: "col-1",
                  revision: 5,
                  updatedAt: "2026-06-03T00:00:00.000Z",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Engineering Handbook",
                  collectionId: "col-1",
                  revision: 3,
                  updatedAt: "2026-06-01T00:00:00.000Z",
                  urlId: "eng-handbook-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      compact: false,
    });

    const resolved = await invokeTool(ctx, "memory.resolve_batch", {
      queries: ["Engineering Handbook", "doc-1"],
      type: "document",
      hydrateLimit: 1,
      view: "summary",
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
    ]);
    assert.equal(resolved.tool, "memory.resolve_batch");
    assert.equal(resolved.result.queryCount, 2);
    assert.equal(resolved.result.hydrationRequested, 1);
    assert.equal(resolved.result.items[0]?.live[0]?.result?.data?.revision, 5);
    assert.equal(resolved.result.items[1]?.live[0]?.result?.data?.revision, 5);
  });
});

test("memory.resolve_batch accepts mixed queries ids urlIds and urls", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Engineering Handbook",
                  revision: 7,
                  urlId: "eng-handbook-AbCdEf12",
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Engineering Handbook",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                  urlId: "eng-handbook-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      compact: false,
    });
    const resolved = await invokeTool(ctx, "memory.resolve_batch", {
      queries: ["Engineering Handbook"],
      ids: ["doc-1"],
      urlIds: ["eng-handbook-AbCdEf12"],
      urls: ["https://handbook.example.com/doc/eng-handbook-AbCdEf12#d-AbCdEf12"],
      type: "document",
      hydrateLimit: 1,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
    ]);
    assert.equal(resolved.result.queryCount, 4);
    assert.equal(resolved.result.hydrationRequested, 1);
    assert.equal(resolved.result.items.every((item) => item.candidates[0]?.id === "doc-1"), true);
    assert.equal(resolved.result.items[3]?.live[0]?.result?.data?.revision, 7);
  });
});

test("memory.resolve_batch uses one cold fallback for duplicate remembered target", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: "Cold Start Runbook",
                  revision: 6,
                },
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-cold",
                  title: "Cold Start Runbook",
                },
              ],
            },
          };
        },
      },
    };

    const resolved = await invokeTool(ctx, "memory.resolve_batch", {
      queries: ["Cold Start Runbook", "doc-cold"],
      type: "document",
      hydrateLimit: 1,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.info",
    ]);
    assert.equal(resolved.result.hydrationRequested, 1);
    assert.equal(resolved.result.items[0]?.candidates[0]?.id, "doc-cold");
    assert.equal(resolved.result.items[1]?.candidates[0]?.id, "doc-cold");
    assert.equal(resolved.result.items[1]?.memory?.fallback, null);
  });
});

test("memory.resolve_batch only falls back for low-score remembered items", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.info") {
            return {
              body: {
                ok: true,
                data: {
                  id: body.id,
                  title: body.id === "doc-target" ? "Security Incident Runbook" : "Incident Overview",
                  revision: body.id === "doc-target" ? 8 : 2,
                },
              },
            };
          }
          if (method === "documents.search_titles" && body.query === "security incident runbook") {
            return {
              body: {
                ok: true,
                data: [
                  {
                    id: "doc-target",
                    title: "Security Incident Runbook",
                  },
                ],
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-weak",
                  title: "Incident Overview",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "incident overview",
      mode: "titles",
      compact: false,
    });

    const resolved = await invokeTool(ctx, "memory.resolve_batch", {
      queries: ["Incident Overview", "security incident runbook"],
      type: "document",
      fallbackMinScore: 90,
      hydrateLimit: 1,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.search_titles",
      "documents.info",
      "documents.info",
    ]);
    assert.equal(resolved.result.items[0]?.candidates[0]?.id, "doc-weak");
    assert.equal(resolved.result.items[0]?.memory?.fallback, null);
    assert.equal(resolved.result.items[1]?.candidates[0]?.id, "doc-target");
    assert.equal(resolved.result.items[1]?.memory?.fallback?.observed, 1);
    assert.equal(resolved.result.hydrationRequested, 2);
  });
});

test("memory.resolve_batch can resolve several remembered refs without live refresh", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Engineering Handbook",
                  collectionId: "col-1",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
                {
                  id: "doc-2",
                  title: "Oncall Escalation",
                  collectionId: "col-1",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "engineering oncall",
      mode: "titles",
      compact: false,
    });
    const resolved = await invokeTool(ctx, "memory.resolve_batch", {
      queries: ["Engineering", "Oncall"],
      type: "document",
      refresh: false,
      compact: false,
    });

    assert.deepEqual(calls.map((call) => call.method), ["documents.search_titles"]);
    assert.equal(resolved.result.items.length, 2);
    assert.equal(resolved.result.items[0]?.candidates[0]?.id, "doc-1");
    assert.equal(resolved.result.items[1]?.candidates[0]?.id, "doc-2");
    assert.deepEqual(resolved.result.items[0]?.live, []);
    assert.equal(resolved.result.memory.refreshed, false);
  });
});

test("memory.resolve_batch honors profile override only for local lookup without live refresh", async () => {
  await withTmpMemory(async (memoryFile) => {
    const baseCtx = {
      memory: { enabled: true, file: memoryFile },
      client: {
        async call() {
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Engineering Handbook",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool({ ...baseCtx, profile: { id: "prod" } }, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      compact: false,
    });

    const resolved = await invokeTool({ ...baseCtx, profile: { id: "dev" } }, "memory.resolve_batch", {
      profile: "prod",
      queries: ["Engineering"],
      type: "document",
      refresh: false,
      compact: false,
    });

    assert.equal(resolved.profile, "prod");
    assert.equal(resolved.result.items[0]?.candidates[0]?.id, "doc-1");

    await assert.rejects(
      () => invokeTool({ ...baseCtx, profile: { id: "dev" } }, "memory.resolve_batch", {
        profile: "prod",
        queries: ["Engineering"],
        type: "document",
        compact: false,
      }),
      /live refresh requires args\.profile to match/
    );
  });
});

test("memory.recent lists profile-scoped local history without network calls", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method) {
          calls.push(method);
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Engineering Handbook",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      compact: false,
    });

    const recent = await invokeTool(ctx, "memory.recent", {
      type: "document",
      compact: false,
    });

    assert.deepEqual(calls, ["documents.search_titles"]);
    assert.equal(recent.tool, "memory.recent");
    assert.equal(recent.result.items[0]?.id, "doc-1");
    assert.equal(recent.result.items[0]?.title, "Engineering Handbook");
  });
});

test("memory.remember is action-gated and stores manual aliases", async () => {
  await withTmpMemory(async (memoryFile) => {
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call() {
          throw new Error("memory.remember should not call Outline");
        },
      },
    };

    await assert.rejects(
      () => invokeTool(ctx, "memory.remember", {
        type: "document",
        id: "doc-1",
        title: "Incident Runbook",
        aliases: ["runbook"],
        compact: false,
      }),
      /Set args\.performAction=true/
    );

    const remembered = await invokeTool(ctx, "memory.remember", {
      type: "document",
      id: "doc-1",
      title: "Incident Runbook",
      url: "https://handbook.example.com/doc/incident-runbook-AbCdEf12",
      aliases: ["runbook"],
      query: "production incident process",
      performAction: true,
      compact: false,
    });
    const lookup = await invokeTool(ctx, "memory.lookup", {
      query: "runbook",
      type: "document",
      compact: false,
    });
    const urlLookup = await invokeTool(ctx, "memory.lookup", {
      url: "https://handbook.example.com/doc/incident-runbook-AbCdEf12",
      type: "document",
      compact: false,
    });

    assert.equal(remembered.result.item.id, "doc-1");
    assert.equal(lookup.result.items[0]?.id, "doc-1");
    assert.equal(lookup.result.items[0]?.title, "Incident Runbook");
    assert.equal(urlLookup.result.items[0]?.id, "doc-1");
    assert.equal(lookup.result.items[0]?.sourceTools[0]?.tool, "memory.remember");
  });
});

test("memory.resolve tombstones remembered entries when live refresh returns not found", async () => {
  await withTmpMemory(async (memoryFile) => {
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method) {
          if (method === "documents.info") {
            throw new ApiError("Not found", {
              status: 404,
              body: { ok: false, error: "not_found" },
              url: "https://handbook.example.com/api/documents.info",
            });
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Retired Runbook",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "retired runbook",
      mode: "titles",
      compact: false,
    });

    const resolved = await invokeTool(ctx, "memory.resolve", {
      query: "Retired Runbook",
      type: "document",
      fallbackSearch: false,
      compact: false,
    });
    const lookup = await invokeTool(ctx, "memory.lookup", {
      query: "Retired Runbook",
      type: "document",
      compact: false,
    });
    const stats = await invokeTool(ctx, "memory.stats", { compact: false });

    assert.equal(resolved.result.live[0]?.ok, false);
    assert.equal(resolved.result.live[0]?.status, 404);
    assert.equal(resolved.result.live[0]?.memory?.tombstoned, true);
    assert.deepEqual(lookup.result.items, []);
    assert.equal(stats.result.profiles[0]?.tombstoned, 1);
  });
});

test("memory.resolve keeps remembered entries on transient live refresh failures", async () => {
  await withTmpMemory(async (memoryFile) => {
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method) {
          if (method === "documents.info") {
            throw new ApiError("Server error", {
              status: 500,
              body: { ok: false, error: "server_error" },
              url: "https://handbook.example.com/api/documents.info",
            });
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Flaky Runbook",
                  updatedAt: "2026-06-01T00:00:00.000Z",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "flaky runbook",
      mode: "titles",
      compact: false,
    });

    const resolved = await invokeTool(ctx, "memory.resolve", {
      query: "Flaky Runbook",
      type: "document",
      fallbackSearch: false,
      compact: false,
    });
    const lookup = await invokeTool(ctx, "memory.lookup", {
      query: "Flaky Runbook",
      type: "document",
      compact: false,
    });

    assert.equal(resolved.result.live[0]?.status, 500);
    assert.equal(resolved.result.live[0]?.memory, undefined);
    assert.equal(lookup.result.items[0]?.id, "doc-1");
  });
});

test("delete observations tombstone remembered documents and hide stale search results", async () => {
  await withTmpMemory(async (memoryFile) => {
    const calls = [];
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          calls.push({ method, body });
          if (method === "documents.permanent_delete") {
            return {
              body: {
                success: true,
                id: body.id,
              },
            };
          }
          return {
            body: {
              ok: true,
              data: [
                {
                  id: "doc-1",
                  title: "Engineering Handbook",
                  collectionId: "col-1",
                  revision: 3,
                  updatedAt: "2026-06-01T00:00:00.000Z",
                  urlId: "eng-handbook-AbCdEf12",
                },
              ],
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      compact: false,
    });
    await invokeTool(ctx, "documents.permanent_delete", {
      id: "doc-1",
      performAction: true,
      compact: false,
    });
    await invokeTool(ctx, "documents.search", {
      query: "engineering handbook",
      mode: "titles",
      compact: false,
    });

    const lookup = await invokeTool(ctx, "memory.lookup", {
      query: "Engineering Handbook",
      type: "document",
      compact: false,
    });
    const stats = await invokeTool(ctx, "memory.stats", { compact: false });

    assert.deepEqual(calls.map((call) => call.method), [
      "documents.search_titles",
      "documents.permanent_delete",
      "documents.search_titles",
    ]);
    assert.deepEqual(lookup.result.items, []);
    assert.equal(stats.result.profiles[0]?.total, 1);
    assert.equal(stats.result.profiles[0]?.active, 0);
    assert.equal(stats.result.profiles[0]?.tombstoned, 1);
    assert.equal(stats.result.profiles[0]?.tombstonedByType?.document, 1);
  });
});

test("authoritative live reads can revive tombstoned memory entries", async () => {
  await withTmpMemory(async (memoryFile) => {
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call(method, body) {
          if (method === "documents.permanent_delete") {
            return {
              body: {
                success: true,
                id: body.id,
              },
            };
          }
          return {
            body: {
              ok: true,
              data: {
                id: "doc-1",
                title: "Engineering Handbook Restored",
                collectionId: "col-1",
                revision: 4,
                updatedAt: "2026-06-02T00:00:00.000Z",
              },
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.info", {
      id: "doc-1",
      compact: false,
    });
    await invokeTool(ctx, "documents.permanent_delete", {
      id: "doc-1",
      performAction: true,
      compact: false,
    });
    await invokeTool(ctx, "documents.info", {
      id: "doc-1",
      compact: false,
    });

    const lookup = await invokeTool(ctx, "memory.lookup", {
      query: "Restored",
      type: "document",
      compact: false,
    });
    const stats = await invokeTool(ctx, "memory.stats", { compact: false });

    assert.equal(lookup.result.items[0]?.id, "doc-1");
    assert.equal(lookup.result.items[0]?.title, "Engineering Handbook Restored");
    assert.equal(stats.result.profiles[0]?.active, 1);
    assert.equal(stats.result.profiles[0]?.tombstoned, 0);
  });
});

test("memory.clear is action-gated and clears the selected profile", async () => {
  await withTmpMemory(async (memoryFile) => {
    const ctx = {
      profile: { id: "prod" },
      memory: { enabled: true, file: memoryFile },
      client: {
        async call() {
          return {
            body: {
              ok: true,
              data: {
                id: "doc-1",
                title: "Runbook",
                revision: 1,
              },
            },
          };
        },
      },
    };

    await invokeTool(ctx, "documents.info", {
      id: "doc-1",
      compact: false,
    });

    await assert.rejects(
      () => invokeTool(ctx, "memory.clear", { compact: false }),
      /Set args\.performAction=true/
    );

    const cleared = await invokeTool(ctx, "memory.clear", {
      performAction: true,
      compact: false,
    });
    const stats = await invokeTool(ctx, "memory.stats", { compact: false });

    assert.deepEqual(cleared.result.clearedProfiles, ["prod"]);
    assert.deepEqual(stats.result.profiles, []);
  });
});
