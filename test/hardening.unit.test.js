import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliError } from "../src/errors.js";
import { ResultStore } from "../src/result-store.js";
import { TOOL_ARG_SCHEMAS, validateToolArgs } from "../src/tool-arg-schemas.js";

test("validateToolArgs rejects unknown args by default", () => {
  assert.throws(
    () => validateToolArgs("auth.info", { view: "summary", unexpected: true }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.details?.code, "ARG_VALIDATION_FAILED");
      assert.ok(Array.isArray(err.details?.issues));
      assert.ok(err.details.issues.some((issue) => issue.path === "args.unexpected"));
      return true;
    }
  );
});

test("validateToolArgs supports allowUnknown opt-out", () => {
  const toolName = "__test.allow_unknown";
  TOOL_ARG_SCHEMAS[toolName] = {
    allowUnknown: true,
    properties: {
      known: { type: "string" },
    },
  };

  try {
    assert.doesNotThrow(() => {
      validateToolArgs(toolName, {
        known: "ok",
        extra: true,
      });
    });
  } finally {
    delete TOOL_ARG_SCHEMAS[toolName];
  }
});

test("api.call accepts method or endpoint and rejects when both missing", () => {
  assert.doesNotThrow(() => {
    validateToolArgs("api.call", { method: "documents.info" });
  });

  assert.doesNotThrow(() => {
    validateToolArgs("api.call", { endpoint: "documents.info" });
  });

  assert.throws(
    () => validateToolArgs("api.call", { body: {} }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.details?.code, "ARG_VALIDATION_FAILED");
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.method"));
      return true;
    }
  );
});

test("validateToolArgs covers new scenario wrapper schemas", () => {
  assert.doesNotThrow(() => validateToolArgs("shares.info", { id: "share-1" }));
  assert.doesNotThrow(() => validateToolArgs("templates.create", { title: "Template", data: {} }));
  assert.doesNotThrow(() =>
    validateToolArgs("comments.create", {
      documentId: "doc-1",
      text: "looks good",
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("events.list", {
      auditLog: true,
      limit: 5,
      view: "summary",
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("documents.answer_batch", {
      questions: ["What changed?"],
      concurrency: 1,
    })
  );
  assert.doesNotThrow(() => validateToolArgs("documents.cleanup_test", { deleteMode: "safe" }));
  assert.doesNotThrow(() =>
    validateToolArgs("collections.add_user", {
      id: "collection-1",
      userId: "user-1",
      performAction: true,
    })
  );

  assert.throws(
    () => validateToolArgs("shares.info", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("templates.update", { title: "Missing id" }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("comments.create", { documentId: "doc-1" }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.text"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("webhooks.create", { name: "w", url: "https://example.com", events: [] }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.events"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("documents.answer_batch", { questions: ["  "] }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.questions[0]"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("documents.cleanup_test", { deleteMode: "unsafe" }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.deleteMode"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("documents.remove_group", { groupId: "group-1", performAction: true }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );
});

test("shares lifecycle schemas enforce deterministic selectors and update requirements", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("shares.list", {
      query: "help docs",
      limit: 10,
      offset: 0,
      sort: "updatedAt",
      direction: "DESC",
      view: "summary",
    })
  );
  assert.doesNotThrow(() => validateToolArgs("shares.info", { id: "share-1" }));
  assert.doesNotThrow(() => validateToolArgs("shares.info", { documentId: "doc-1" }));
  assert.doesNotThrow(() =>
    validateToolArgs("shares.create", {
      documentId: "doc-1",
      published: true,
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("shares.update", {
      id: "share-1",
      published: false,
      performAction: true,
    })
  );
  assert.doesNotThrow(() => validateToolArgs("shares.revoke", { id: "share-1", performAction: true }));

  assert.throws(
    () => validateToolArgs("shares.list", { limit: 0 }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.limit"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("shares.info", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("shares.info", { id: "share-1", documentId: "doc-1" }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.documentId"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("shares.create", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.documentId"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("shares.update", { id: "share-1" }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.published"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("shares.update", { id: "share-1", published: "true" }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.published"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("shares.revoke", { performAction: true }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("shares.revoke", { id: "share-1", performAction: "yes" }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.performAction"));
      return true;
    }
  );
});

test("documents.apply_patch accepts optional expectedRevision and validates bounds", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("documents.apply_patch", {
      id: "doc-1",
      patch: "@@ -1,1 +1,1 @@\n-a\n+b",
      expectedRevision: 3,
    })
  );

  assert.throws(
    () =>
      validateToolArgs("documents.apply_patch", {
        id: "doc-1",
        patch: "@@ -1,1 +1,1 @@\n-a\n+b",
        expectedRevision: -1,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.expectedRevision"));
      return true;
    }
  );
});

test("comments.review_queue schema enforces scope selector", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("comments.review_queue", {
      documentIds: ["doc-1"],
      limitPerDocument: 3,
      view: "summary",
    })
  );

  assert.doesNotThrow(() =>
    validateToolArgs("comments.review_queue", {
      collectionId: "col-1",
      includeReplies: true,
    })
  );

  assert.throws(
    () => validateToolArgs("comments.review_queue", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.documentIds"));
      return true;
    }
  );
});

test("federated.sync_manifest schema validates timestamp and bounds", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("federated.sync_manifest", {
      query: "policy",
      since: "2026-01-01T00:00:00.000Z",
      limit: 5,
      view: "summary",
    })
  );

  assert.throws(
    () =>
      validateToolArgs("federated.sync_manifest", {
        since: "yesterday",
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.since"));
      return true;
    }
  );
});

test("federated.sync_probe schema requires ids or queries", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("federated.sync_probe", {
      ids: ["doc-1"],
      mode: "both",
      freshnessHours: 6,
      view: "summary",
    })
  );

  assert.throws(
    () => validateToolArgs("federated.sync_probe", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.ids"));
      return true;
    }
  );
});

test("federated.permission_snapshot schema requires non-empty ids", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("federated.permission_snapshot", {
      ids: ["doc-1", "doc-2"],
      includeDocumentMemberships: true,
      view: "summary",
    })
  );

  assert.throws(
    () => validateToolArgs("federated.permission_snapshot", { ids: [] }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.ids"));
      return true;
    }
  );
});

test("documents.plan_terminology_refactor schema validates glossary and scope", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("documents.plan_terminology_refactor", {
      glossary: [
        {
          find: "KPI",
          replace: "Key Performance Indicator",
          field: "text",
        },
      ],
      query: "metrics",
      includeTitleSearch: true,
      includeSemanticSearch: true,
    })
  );

  assert.throws(
    () =>
      validateToolArgs("documents.plan_terminology_refactor", {
        glossary: [{ find: "SLA", replace: "SLA" }],
        query: "ops",
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.glossary[0].replace"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.plan_terminology_refactor", {
        glossary: [{ find: "SLO", replace: "Service Level Objective" }],
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.ids"));
      return true;
    }
  );
});

test("documents.answer and documents.answer_batch schema match handler inputs", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("documents.answer", {
      query: "What changed this week?",
    })
  );

  assert.throws(
    () => validateToolArgs("documents.answer", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.question"));
      return true;
    }
  );

  assert.doesNotThrow(() =>
    validateToolArgs("documents.answer_batch", {
      question: "Where is the runbook?",
      questions: [{ query: "Who owns incident response?" }],
      concurrency: 1,
    })
  );

  assert.throws(
    () =>
      validateToolArgs("documents.answer_batch", {
        questions: [{}],
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.questions[0].question"));
      return true;
    }
  );
});

test("ResultStore.resolve restricts access to managed tmp dir", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-cli-hardening-"));
  const store = new ResultStore({ tmpDir });

  try {
    const insideRelative = store.resolve("result.json");
    assert.equal(insideRelative, path.resolve(tmpDir, "result.json"));

    const insideAbsolute = path.join(tmpDir, "nested", "result.json");
    assert.equal(store.resolve(insideAbsolute), path.resolve(insideAbsolute));

    const outsideAbsolute = path.resolve(tmpDir, "..", "outside.json");
    assert.throws(() => store.resolve(outsideAbsolute), /outside tmp dir/);

    assert.throws(() => store.resolve("../outside.json"), /outside tmp dir/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
