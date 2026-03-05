import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliError } from "../src/errors.js";
import { ResultStore } from "../src/result-store.js";
import { TOOL_ARG_SCHEMAS, validateToolArgs } from "../src/tool-arg-schemas.js";
import { EXTENDED_TOOLS } from "../src/tools.extended.js";
import { MUTATION_TOOLS } from "../src/tools.mutation.js";

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

test("groups.memberships is exposed as a first-class extended wrapper", async () => {
  const contract = EXTENDED_TOOLS["groups.memberships"];
  assert.ok(contract);
  assert.equal(typeof contract.handler, "function");
  assert.equal(contract.usageExample?.tool, "groups.memberships");

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        return {
          body: {
            data: [{ id: "membership-1", userId: "user-1" }],
            policies: [{ id: "policy-1" }],
          },
        };
      },
    },
  };

  const output = await contract.handler(ctx, {
    id: "group-1",
    limit: 10,
    offset: 0,
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "groups.memberships");
  assert.deepEqual(calls[0].body, {
    id: "group-1",
    limit: 10,
    offset: 0,
  });
  assert.equal(calls[0].options?.maxAttempts, 2);

  assert.equal(output.tool, "groups.memberships");
  assert.equal(output.profile, "profile-hardening");
  assert.deepEqual(output.result, {
    data: [{ id: "membership-1", userId: "user-1" }],
  });
});

test("users lifecycle wrappers and documents.users wrapper enforce gating and deterministic envelopes", async () => {
  for (const method of [
    "users.invite",
    "users.update_role",
    "users.activate",
    "users.suspend",
    "documents.users",
  ]) {
    assert.ok(EXTENDED_TOOLS[method], `${method} should be registered`);
  }

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        if (method === "documents.users") {
          return {
            body: {
              data: [{ id: "user-1", documentId: body.id }],
              policies: [{ id: "policy-1" }],
            },
          };
        }
        return {
          body: {
            data: { id: `user-op-${calls.length}` },
            policies: [{ id: "policy-1" }],
          },
        };
      },
    },
  };

  const usersRes = await EXTENDED_TOOLS["documents.users"].handler(ctx, {
    id: "doc-1",
    limit: 10,
    offset: 0,
  });
  const inviteRes = await EXTENDED_TOOLS["users.invite"].handler(ctx, {
    email: "new.user@example.com",
    role: "member",
    performAction: true,
  });
  const updateRoleRes = await EXTENDED_TOOLS["users.update_role"].handler(ctx, {
    id: "user-1",
    role: "viewer",
    performAction: true,
  });
  await EXTENDED_TOOLS["users.activate"].handler(ctx, {
    id: "user-1",
    performAction: true,
  });
  const suspendRes = await EXTENDED_TOOLS["users.suspend"].handler(ctx, {
    id: "user-2",
    performAction: true,
  });

  assert.deepEqual(
    calls.map((call) => call.method),
    ["documents.users", "users.invite", "users.update_role", "users.activate", "users.suspend"]
  );
  assert.deepEqual(calls[0].body, { id: "doc-1", limit: 10, offset: 0 });
  assert.deepEqual(calls[1].body, { email: "new.user@example.com", role: "member" });
  assert.deepEqual(calls[2].body, { id: "user-1", role: "viewer" });
  assert.deepEqual(calls[3].body, { id: "user-1" });
  assert.deepEqual(calls[4].body, { id: "user-2" });
  assert.equal(calls[0].options?.maxAttempts, 2);
  assert.equal(calls[1].options?.maxAttempts, 1);
  assert.equal(calls[4].options?.maxAttempts, 1);

  assert.equal(usersRes.tool, "documents.users");
  assert.deepEqual(usersRes.result, { data: [{ id: "user-1", documentId: "doc-1" }] });
  assert.deepEqual(inviteRes.result, { data: { id: "user-op-2" } });
  assert.deepEqual(updateRoleRes.result, { data: { id: "user-op-3" } });
  assert.deepEqual(suspendRes.result, { data: { id: "user-op-5" } });

  await assert.rejects(
    () =>
      EXTENDED_TOOLS["users.suspend"].handler(ctx, {
        id: "user-3",
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /performAction/);
      return true;
    }
  );
  assert.equal(calls.length, 5);
});

test("data_attributes wrappers map to dataAttributes RPC methods with action gating", async () => {
  const methods = [
    "data_attributes.list",
    "data_attributes.info",
    "data_attributes.create",
    "data_attributes.update",
    "data_attributes.delete",
  ];
  for (const method of methods) {
    assert.ok(EXTENDED_TOOLS[method], `${method} should be registered`);
  }

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        if (method === "dataAttributes.delete") {
          return { body: { success: true } };
        }
        return {
          body: {
            data: { id: "attr-1", name: "Status" },
            policies: [{ id: "policy-1" }],
          },
        };
      },
    },
  };

  const listRes = await EXTENDED_TOOLS["data_attributes.list"].handler(ctx, {
    limit: 10,
    offset: 0,
  });
  const infoRes = await EXTENDED_TOOLS["data_attributes.info"].handler(ctx, { id: "attr-1" });
  await EXTENDED_TOOLS["data_attributes.create"].handler(ctx, {
    name: "Status",
    dataType: "string",
    performAction: true,
  });
  await EXTENDED_TOOLS["data_attributes.update"].handler(ctx, {
    id: "attr-1",
    name: "Status",
    performAction: true,
  });
  const deleteRes = await EXTENDED_TOOLS["data_attributes.delete"].handler(ctx, {
    id: "attr-1",
    performAction: true,
  });

  assert.deepEqual(
    calls.map((call) => call.method),
    [
      "dataAttributes.list",
      "dataAttributes.info",
      "dataAttributes.create",
      "dataAttributes.update",
      "dataAttributes.delete",
    ]
  );
  assert.equal(calls[0].options?.maxAttempts, 2);
  assert.equal(calls[2].options?.maxAttempts, 1);
  assert.equal(calls[4].options?.maxAttempts, 1);
  assert.equal(listRes.tool, "data_attributes.list");
  assert.equal(infoRes.tool, "data_attributes.info");
  assert.deepEqual(listRes.result, {
    data: { id: "attr-1", name: "Status" },
  });
  assert.deepEqual(deleteRes.result, { success: true });

  await assert.rejects(
    () =>
      EXTENDED_TOOLS["data_attributes.create"].handler(ctx, {
        name: "Status",
        dataType: "string",
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.match(err.message, /performAction/);
      return true;
    }
  );
  assert.equal(calls.length, 5);
});

test("import and file operation wrappers expose deterministic envelopes and action gating", async () => {
  for (const method of [
    "documents.import",
    "documents.import_file",
    "file_operations.list",
    "file_operations.info",
    "file_operations.delete",
  ]) {
    assert.ok(EXTENDED_TOOLS[method], `${method} should be registered`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-cli-import-wrapper-"));
  const filePath = path.join(tmpDir, "legacy-wiki.md");
  await fs.writeFile(filePath, "# Legacy Wiki\n\nImported content.\n", "utf8");

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        return {
          body: {
            data: { id: `file-op-${calls.length}` },
            policies: [{ id: "policy-1" }],
          },
        };
      },
    },
  };

  try {
    const importRes = await EXTENDED_TOOLS["documents.import"].handler(ctx, {
      collectionId: "collection-1",
      publish: false,
      performAction: true,
    });
    const importFileRes = await EXTENDED_TOOLS["documents.import_file"].handler(ctx, {
      filePath,
      collectionId: "collection-1",
      publish: false,
      performAction: true,
    });
    const listRes = await EXTENDED_TOOLS["file_operations.list"].handler(ctx, {
      limit: 10,
      offset: 0,
    });
    const infoRes = await EXTENDED_TOOLS["file_operations.info"].handler(ctx, {
      id: "file-op-1",
    });
    const deleteRes = await EXTENDED_TOOLS["file_operations.delete"].handler(ctx, {
      id: "file-op-1",
      performAction: true,
    });

    assert.deepEqual(
      calls.map((call) => call.method),
      [
        "documents.import",
        "documents.import",
        "fileOperations.list",
        "fileOperations.info",
        "fileOperations.delete",
      ]
    );
    assert.deepEqual(calls[0].body, {
      collectionId: "collection-1",
      publish: false,
    });
    assert.equal(calls[0].options?.maxAttempts, 1);

    assert.equal(calls[1].options?.bodyType, "multipart");
    assert.equal(calls[1].options?.maxAttempts, 1);
    assert.ok(calls[1].body instanceof FormData);
    const multipartEntries = Array.from(calls[1].body.entries());
    const filePart = multipartEntries.find(([key]) => key === "file")?.[1];
    const collectionPart = multipartEntries.find(([key]) => key === "collectionId")?.[1];
    const publishPart = multipartEntries.find(([key]) => key === "publish")?.[1];
    assert.ok(filePart instanceof Blob);
    assert.equal(filePart.name, "legacy-wiki.md");
    assert.equal(collectionPart, "collection-1");
    assert.equal(publishPart, "false");

    assert.deepEqual(importRes.result, { data: { id: "file-op-1" } });
    assert.deepEqual(importFileRes.result, { data: { id: "file-op-2" } });
    assert.deepEqual(listRes.result, { data: { id: "file-op-3" } });
    assert.deepEqual(infoRes.result, { data: { id: "file-op-4" } });
    assert.deepEqual(deleteRes.result, { data: { id: "file-op-5" } });

    await assert.rejects(
      () =>
        EXTENDED_TOOLS["documents.import"].handler(ctx, {
          collectionId: "collection-1",
        }),
      (err) => {
        assert.ok(err instanceof CliError);
        assert.match(err.message, /performAction/);
        return true;
      }
    );

    await assert.rejects(
      () =>
        EXTENDED_TOOLS["documents.import_file"].handler(ctx, {
          filePath,
        }),
      (err) => {
        assert.ok(err instanceof CliError);
        assert.match(err.message, /performAction/);
        return true;
      }
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
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
  assert.doesNotThrow(() =>
    validateToolArgs("groups.memberships", {
      id: "group-1",
      limit: 20,
      offset: 0,
      view: "summary",
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("documents.import", {
      collectionId: "collection-1",
      publish: false,
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("documents.import_file", {
      filePath: "./tmp/wiki.md",
      collectionId: "collection-1",
      publish: false,
      performAction: true,
    })
  );
  assert.doesNotThrow(() => validateToolArgs("file_operations.list", { limit: 10 }));
  assert.doesNotThrow(() => validateToolArgs("file_operations.info", { id: "file-op-1" }));
  assert.doesNotThrow(() =>
    validateToolArgs("file_operations.delete", { id: "file-op-1", performAction: true })
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

  assert.throws(
    () => validateToolArgs("documents.import_file", { performAction: true }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.filePath"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.import_file", {
        filePath: "./tmp/wiki.md",
        collectionId: "collection-1",
        parentDocumentId: "doc-1",
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.parentDocumentId"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("file_operations.info", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );
});

test("templates.extract_placeholders returns deterministic sorted placeholders and counts", async () => {
  const contract = EXTENDED_TOOLS["templates.extract_placeholders"];
  assert.ok(contract);
  assert.equal(typeof contract.handler, "function");

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        assert.equal(method, "templates.info");
        return {
          body: {
            data: {
              id: "template-1",
              title: "Incident Template",
              data: {
                type: "doc",
                content: [
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Owner {{owner}} handles {{service_name}}" }],
                  },
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "Escalate {{owner}} by {{target_date}}" }],
                  },
                  {
                    type: "paragraph",
                    content: [{ type: "text", text: "No placeholder here" }],
                  },
                ],
              },
            },
          },
        };
      },
    },
  };

  const output = await contract.handler(ctx, { id: "template-1" });

  assert.deepEqual(calls, [
    {
      method: "templates.info",
      body: { id: "template-1" },
      options: { maxAttempts: 2 },
    },
  ]);
  assert.equal(output.tool, "templates.extract_placeholders");
  assert.equal(output.profile, "profile-hardening");
  assert.deepEqual(output.result.id, "template-1");
  assert.deepEqual(output.result.placeholders, ["owner", "service_name", "target_date"]);
  assert.deepEqual(output.result.counts, [
    { key: "owner", count: 2 },
    { key: "service_name", count: 1 },
    { key: "target_date", count: 1 },
  ]);
  assert.equal(output.result.meta.placeholderTokenCount, 4);
  assert.equal(output.result.meta.uniquePlaceholderCount, 3);
  assert.equal(output.result.meta.textNodeCount, 3);
  assert.equal(typeof output.result.meta.scannedCharacterCount, "number");
  assert.ok(output.result.meta.scannedCharacterCount > 0);
});

test("documents.create_from_template enforces strict unresolved placeholders without publishing", async () => {
  const contract = EXTENDED_TOOLS["documents.create_from_template"];
  assert.ok(contract);
  assert.equal(typeof contract.handler, "function");

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        if (method === "documents.create") {
          return {
            body: {
              data: {
                id: "doc-from-template-1",
                title: "Incident Runbook",
                collectionId: "collection-1",
                parentDocumentId: "",
                updatedAt: "2026-03-05T00:00:00.000Z",
                publishedAt: "",
                urlId: "incident-runbook",
                emoji: ":memo:",
                text: "Owner {{owner}} handles {{service_name}} by {{target_date}}",
              },
            },
          };
        }

        if (method === "documents.update") {
          assert.deepEqual(body, {
            id: "doc-from-template-1",
            text: "Owner Alice handles {{service_name}} by {{target_date}}",
            publish: false,
          });
          return {
            body: {
              data: {
                id: "doc-from-template-1",
                title: "Incident Runbook",
                collectionId: "collection-1",
                parentDocumentId: "",
                updatedAt: "2026-03-05T00:01:00.000Z",
                publishedAt: "",
                urlId: "incident-runbook",
                emoji: ":memo:",
                text: "Owner Alice handles {{service_name}} by {{target_date}}",
              },
            },
          };
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  };

  const output = await contract.handler(ctx, {
    templateId: "template-1",
    title: "Incident Runbook",
    collectionId: "collection-1",
    publish: true,
    placeholderValues: {
      owner: "Alice",
    },
    strictPlaceholders: true,
    performAction: true,
    view: "summary",
  });

  assert.deepEqual(calls, [
    {
      method: "documents.create",
      body: {
        templateId: "template-1",
        title: "Incident Runbook",
        collectionId: "collection-1",
        publish: false,
      },
      options: { maxAttempts: 1 },
    },
    {
      method: "documents.update",
      body: {
        id: "doc-from-template-1",
        text: "Owner Alice handles {{service_name}} by {{target_date}}",
        publish: false,
      },
      options: { maxAttempts: 1 },
    },
  ]);
  assert.equal(output.tool, "documents.create_from_template");
  assert.equal(output.profile, "profile-hardening");
  assert.equal(output.result.success, false);
  assert.equal(output.result.code, "STRICT_PLACEHOLDERS_UNRESOLVED");
  assert.equal(output.result.publishRequested, true);
  assert.equal(output.result.published, false);
  assert.equal(output.result.safeBehavior, "left_unpublished_draft");
  assert.deepEqual(output.result.placeholders.providedKeys, ["owner"]);
  assert.deepEqual(output.result.placeholders.unresolved, ["service_name", "target_date"]);
  assert.equal(output.result.placeholders.unresolvedCount, 2);
  assert.deepEqual(output.result.placeholders.replacedByPlaceholder, [{ key: "owner", count: 1 }]);
  assert.deepEqual(output.result.actions, {
    create: true,
    updateText: true,
    publish: false,
  });
});

test("template pipeline schemas enforce strict id and placeholderValues validation", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("templates.extract_placeholders", {
      id: "template-1",
    })
  );

  assert.doesNotThrow(() =>
    validateToolArgs("documents.create_from_template", {
      templateId: "template-1",
      title: "Incident Runbook",
      publish: true,
      placeholderValues: {
        owner: "Alice",
        service_name: "Payments API",
      },
      strictPlaceholders: true,
      view: "summary",
      performAction: true,
    })
  );

  assert.throws(
    () => validateToolArgs("templates.extract_placeholders", { id: " " }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.create_from_template", {
        templateId: "",
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.templateId"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.create_from_template", {
        templateId: "template-1",
        placeholderValues: {
          owner: 42,
        },
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.placeholderValues.owner"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.create_from_template", {
        templateId: "template-1",
        view: "ids",
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.view"));
      return true;
    }
  );
});

test("data_attributes schemas and document dataAttributes alignment validate valid and invalid inputs", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("data_attributes.list", {
      limit: 25,
      offset: 0,
      view: "summary",
    })
  );
  assert.doesNotThrow(() => validateToolArgs("data_attributes.info", { id: "attr-1" }));
  assert.doesNotThrow(() =>
    validateToolArgs("data_attributes.create", {
      name: "Status",
      dataType: "list",
      options: {
        icon: "status",
        options: [{ value: "In Progress", color: "#0366d6" }],
      },
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("data_attributes.update", {
      id: "attr-1",
      name: "Status",
      pinned: true,
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("data_attributes.delete", {
      id: "attr-1",
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("documents.create", {
      title: "Release plan",
      dataAttributes: [{ dataAttributeId: "attr-1", value: "In Progress" }],
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("documents.update", {
      id: "doc-1",
      dataAttributes: [{ dataAttributeId: "attr-1", value: "Done" }],
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("documents.safe_update", {
      id: "doc-1",
      expectedRevision: 3,
      dataAttributes: [{ dataAttributeId: "attr-1", value: true }],
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("documents.batch_update", {
      updates: [
        {
          id: "doc-1",
          dataAttributes: [{ dataAttributeId: "attr-1", value: 42 }],
        },
      ],
      performAction: true,
    })
  );

  assert.throws(
    () => validateToolArgs("data_attributes.list", { limit: 251 }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.limit"));
      return true;
    }
  );
  assert.throws(
    () => validateToolArgs("data_attributes.info", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );
  assert.throws(
    () =>
      validateToolArgs("data_attributes.create", {
        name: "Status",
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.dataType"));
      return true;
    }
  );
  assert.throws(
    () =>
      validateToolArgs("data_attributes.create", {
        name: "Status",
        dataType: "date",
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.dataType"));
      return true;
    }
  );
  assert.throws(
    () =>
      validateToolArgs("data_attributes.update", {
        id: "attr-1",
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.name"));
      return true;
    }
  );
  assert.throws(
    () => validateToolArgs("data_attributes.delete", { performAction: true }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );
  assert.throws(
    () =>
      validateToolArgs("documents.create", {
        title: "Release plan",
        dataAttributes: { dataAttributeId: "attr-1", value: "In Progress" },
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.dataAttributes"));
      return true;
    }
  );
  assert.throws(
    () =>
      validateToolArgs("documents.safe_update", {
        id: "doc-1",
        expectedRevision: 3,
        dataAttributes: "invalid",
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.dataAttributes"));
      return true;
    }
  );
  assert.throws(
    () =>
      validateToolArgs("documents.batch_update", {
        updates: [{ id: "doc-1", dataAttributes: { dataAttributeId: "attr-1", value: "In Progress" } }],
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.updates[0].dataAttributes"));
      return true;
    }
  );
});

test("users/groups schemas enforce deterministic id selector constraints", () => {
  assert.doesNotThrow(() => validateToolArgs("users.info", { id: "user-1" }));
  assert.doesNotThrow(() => validateToolArgs("users.info", { ids: ["user-1", "user-2"] }));
  assert.doesNotThrow(() => validateToolArgs("groups.info", { id: "group-1" }));
  assert.doesNotThrow(() => validateToolArgs("groups.info", { ids: ["group-1"] }));

  assert.throws(
    () => validateToolArgs("users.info", { ids: [] }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.ids"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("users.info", { id: "user-1", ids: ["user-2"] }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.ids"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("groups.info", { ids: [] }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.ids"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("groups.info", { id: "group-1", ids: ["group-2"] }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.ids"));
      return true;
    }
  );
});

test("user lifecycle and documents.users schemas enforce required selectors and role enum", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("users.invite", {
      email: "new.user@example.com",
      role: "member",
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("users.update_role", {
      id: "user-1",
      role: "viewer",
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("users.activate", {
      id: "user-1",
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("users.suspend", {
      id: "user-1",
      performAction: true,
    })
  );
  assert.doesNotThrow(() =>
    validateToolArgs("documents.users", {
      id: "doc-1",
      limit: 20,
      offset: 0,
      view: "summary",
    })
  );

  assert.throws(
    () => validateToolArgs("users.invite", { performAction: true }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.email"));
      return true;
    }
  );
  assert.throws(
    () =>
      validateToolArgs("users.invite", {
        email: "new.user@example.com",
        role: "owner",
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.role"));
      return true;
    }
  );
  assert.throws(
    () =>
      validateToolArgs("users.update_role", {
        id: "user-1",
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.role"));
      return true;
    }
  );
  assert.throws(
    () =>
      validateToolArgs("users.activate", {
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );
  assert.throws(
    () =>
      validateToolArgs("users.suspend", {
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );
  assert.throws(
    () => validateToolArgs("documents.users", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );
});

test("groups.create schema requires non-empty memberIds when provided", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("groups.create", {
      name: "Engineering",
      memberIds: ["user-1"],
      performAction: true,
    })
  );

  assert.throws(
    () =>
      validateToolArgs("groups.create", {
        name: "Engineering",
        memberIds: [],
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.memberIds"));
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

test("revisions.diff is exposed as a first-class mutation wrapper with deterministic payload", async () => {
  const contract = MUTATION_TOOLS["revisions.diff"];
  assert.ok(contract);
  assert.equal(typeof contract.handler, "function");
  assert.equal(contract.usageExample?.tool, "revisions.diff");

  const calls = [];
  const revisionsById = {
    "rev-base": {
      id: "rev-base",
      documentId: "doc-1",
      title: "Incident RCA",
      text: "alpha\nbravo\ncharlie",
      createdAt: "2026-03-01T00:00:00.000Z",
      createdBy: { id: "user-1", name: "Alice" },
    },
    "rev-target": {
      id: "rev-target",
      documentId: "doc-1",
      title: "Incident RCA",
      text: "alpha\nbeta\ncharlie\ndelta",
      createdAt: "2026-03-02T00:00:00.000Z",
      createdBy: { id: "user-2", name: "Bob" },
    },
  };

  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        assert.equal(method, "revisions.info");
        return {
          body: {
            data: revisionsById[body.id],
          },
        };
      },
    },
  };

  const output = await contract.handler(ctx, {
    id: "doc-1",
    baseRevisionId: "rev-base",
    targetRevisionId: "rev-target",
    hunkLimit: 6,
    hunkLineLimit: 8,
    view: "summary",
  });

  assert.deepEqual(calls, [
    {
      method: "revisions.info",
      body: { id: "rev-base" },
      options: { maxAttempts: 2 },
    },
    {
      method: "revisions.info",
      body: { id: "rev-target" },
      options: { maxAttempts: 2 },
    },
  ]);

  assert.equal(output.tool, "revisions.diff");
  assert.equal(output.profile, "profile-hardening");
  assert.deepEqual(output.result, {
    ok: true,
    id: "doc-1",
    baseRevisionId: "rev-base",
    targetRevisionId: "rev-target",
    baseRevision: {
      id: "rev-base",
      documentId: "doc-1",
      title: "Incident RCA",
      createdAt: "2026-03-01T00:00:00.000Z",
      createdBy: { id: "user-1", name: "Alice" },
    },
    targetRevision: {
      id: "rev-target",
      documentId: "doc-1",
      title: "Incident RCA",
      createdAt: "2026-03-02T00:00:00.000Z",
      createdBy: { id: "user-2", name: "Bob" },
    },
    stats: {
      added: 2,
      removed: 1,
      changed: 1,
      unchanged: 2,
      totalCurrentLines: 3,
      totalProposedLines: 4,
    },
    hunks: [
      {
        kind: "change",
        oldStart: 2,
        newStart: 2,
        lines: [
          { type: "remove", line: "bravo" },
          { type: "add", line: "beta" },
        ],
        truncated: false,
      },
      {
        kind: "add",
        oldStart: 4,
        newStart: 4,
        lines: [{ type: "add", line: "delta" }],
        truncated: false,
      },
    ],
    truncated: true,
  });
});

test("revisions.diff schema validates valid and invalid inputs with deterministic issues", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("revisions.diff", {
      id: "doc-1",
      baseRevisionId: "rev-1",
      targetRevisionId: "rev-2",
      includeFullHunks: false,
      hunkLimit: 8,
      hunkLineLimit: 12,
      view: "summary",
      maxAttempts: 2,
    })
  );

  assert.throws(
    () => validateToolArgs("revisions.diff", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.details?.code, "ARG_VALIDATION_FAILED");
      assert.deepEqual(
        err.details?.issues?.map((issue) => issue.path),
        ["args.id", "args.baseRevisionId", "args.targetRevisionId"]
      );
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("revisions.diff", {
        id: "doc-1",
        baseRevisionId: "rev-1",
        targetRevisionId: "rev-2",
        hunkLimit: 0,
        view: "ids",
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.details?.code, "ARG_VALIDATION_FAILED");
      assert.deepEqual(
        err.details?.issues?.map((issue) => issue.path),
        ["args.hunkLimit", "args.view"]
      );
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

test("graph schemas enforce selector constraints and strict bounds", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("documents.backlinks", {
      id: "doc-1",
      limit: 25,
      offset: 0,
      direction: "DESC",
      view: "summary",
      maxAttempts: 2,
    })
  );

  assert.doesNotThrow(() =>
    validateToolArgs("documents.graph_neighbors", {
      id: "doc-1",
      includeBacklinks: true,
      includeSearchNeighbors: true,
      searchQueries: ["incident response"],
      limitPerSource: 10,
      view: "ids",
    })
  );

  assert.doesNotThrow(() =>
    validateToolArgs("documents.graph_report", {
      seedIds: ["doc-1", "doc-2"],
      depth: 2,
      maxNodes: 50,
      includeBacklinks: true,
      includeSearchNeighbors: false,
      limitPerSource: 6,
      view: "summary",
    })
  );

  assert.throws(
    () => validateToolArgs("documents.backlinks", { id: "", limit: 251 }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.limit"));
      return true;
    }
  );

  assert.throws(
    () => validateToolArgs("documents.graph_neighbors", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.graph_neighbors", {
        id: "doc-1",
        ids: ["doc-2"],
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.ids"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.graph_neighbors", {
        id: "doc-1",
        includeBacklinks: false,
        includeSearchNeighbors: false,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.includeBacklinks"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.graph_neighbors", {
        id: "doc-1",
        includeSearchNeighbors: false,
        searchQueries: ["incident response"],
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.includeSearchNeighbors"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.graph_report", {
        seedIds: [],
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.seedIds"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.graph_report", {
        seedIds: ["doc-1"],
        depth: 7,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.depth"));
      return true;
    }
  );
});

test("issue reference schemas enforce selector, query, and regex constraints", () => {
  assert.doesNotThrow(() =>
    validateToolArgs("documents.issue_refs", {
      ids: ["doc-1", "doc-2"],
      issueDomains: ["jira.example.com"],
      keyPattern: "[A-Z]+-\\d+",
      view: "summary",
      maxAttempts: 2,
    })
  );

  assert.doesNotThrow(() =>
    validateToolArgs("documents.issue_ref_report", {
      query: "incident runbook",
      collectionId: "collection-1",
      issueDomains: ["jira.example.com", "github.com"],
      keyPattern: "[A-Z]+-\\d+",
      limit: 10,
      view: "ids",
      maxAttempts: 2,
    })
  );

  assert.throws(
    () => validateToolArgs("documents.issue_refs", {}),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.id"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.issue_refs", {
        ids: [""],
        keyPattern: "[",
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.ids[0]"));
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.keyPattern"));
      return true;
    }
  );

  assert.throws(
    () =>
      validateToolArgs("documents.issue_ref_report", {
        queries: [],
        limit: 101,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.query"));
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.queries"));
      assert.ok(err.details?.issues?.some((issue) => issue.path === "args.limit"));
      return true;
    }
  );
});

test("documents.backlinks wraps documents.list with backlinkDocumentId", async () => {
  const contract = EXTENDED_TOOLS["documents.backlinks"];
  assert.ok(contract);
  assert.equal(typeof contract.handler, "function");

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        return {
          body: {
            data: [
              {
                id: "doc-2",
                title: "Backlink Source A",
              },
              {
                id: "doc-3",
                title: "Backlink Source B",
              },
            ],
            policies: [{ id: "policy-1" }],
          },
        };
      },
    },
  };

  const output = await contract.handler(ctx, {
    id: "doc-root",
    limit: 2,
    offset: 1,
    sort: "updatedAt",
    direction: "DESC",
    view: "ids",
    maxAttempts: 3,
  });

  assert.deepEqual(calls, [
    {
      method: "documents.list",
      body: {
        backlinkDocumentId: "doc-root",
        limit: 2,
        offset: 1,
        sort: "updatedAt",
        direction: "DESC",
      },
      options: { maxAttempts: 3 },
    },
  ]);
  assert.equal(output.tool, "documents.backlinks");
  assert.equal(output.profile, "profile-hardening");
  assert.deepEqual(output.result, {
    data: [
      { id: "doc-2", title: "Backlink Source A" },
      { id: "doc-3", title: "Backlink Source B" },
    ],
  });
});

test("documents.graph_neighbors returns deterministic nodes and edges", async () => {
  const contract = EXTENDED_TOOLS["documents.graph_neighbors"];
  assert.ok(contract);
  assert.equal(typeof contract.handler, "function");

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        if (method === "documents.info") {
          return {
            body: {
              data: {
                id: "doc-1",
                title: "Seed Document",
              },
            },
          };
        }
        if (method === "documents.list") {
          return {
            body: {
              data: [
                {
                  id: "doc-2",
                  title: "Runbook",
                  collectionId: "col-1",
                  parentDocumentId: "",
                  updatedAt: "2026-03-01T00:00:00.000Z",
                  publishedAt: "2026-03-01T00:00:00.000Z",
                  urlId: "runbook",
                  emoji: ":blue_book:",
                },
                {
                  id: "doc-3",
                  title: "Escalation Policy",
                  collectionId: "col-1",
                  parentDocumentId: "",
                  updatedAt: "2026-03-02T00:00:00.000Z",
                  publishedAt: "2026-03-02T00:00:00.000Z",
                  urlId: "escalation-policy",
                  emoji: ":green_book:",
                },
              ],
            },
          };
        }
        if (method === "documents.search_titles") {
          return {
            body: {
              data: [
                {
                  id: "doc-3",
                  title: "Escalation Policy",
                  ranking: 0.9,
                  updatedAt: "2026-03-02T00:00:00.000Z",
                },
                {
                  id: "doc-4",
                  title: "Incident Checklist",
                  ranking: 0.7,
                  collectionId: "col-2",
                  updatedAt: "2026-03-03T00:00:00.000Z",
                },
              ],
            },
          };
        }
        throw new Error(`Unexpected method: ${method}`);
      },
    },
  };

  const output = await contract.handler(ctx, {
    id: "doc-1",
    includeBacklinks: true,
    includeSearchNeighbors: true,
    searchQueries: ["incident"],
    limitPerSource: 2,
    view: "summary",
  });

  assert.deepEqual(
    calls.map((call) => call.method),
    ["documents.info", "documents.list", "documents.search_titles"]
  );
  assert.deepEqual(calls[0], {
    method: "documents.info",
    body: { id: "doc-1" },
    options: { maxAttempts: 2 },
  });
  assert.deepEqual(calls[1], {
    method: "documents.list",
    body: {
      backlinkDocumentId: "doc-1",
      limit: 2,
      offset: 0,
      sort: "updatedAt",
      direction: "DESC",
    },
    options: { maxAttempts: 2 },
  });
  assert.deepEqual(calls[2], {
    method: "documents.search_titles",
    body: {
      query: "incident",
      limit: 2,
      offset: 0,
    },
    options: { maxAttempts: 2 },
  });

  assert.equal(output.tool, "documents.graph_neighbors");
  assert.equal(output.profile, "profile-hardening");
  assert.deepEqual(output.result, {
    sourceIds: ["doc-1"],
    includeBacklinks: true,
    includeSearchNeighbors: true,
    searchQueries: ["incident"],
    limitPerSource: 2,
    nodeCount: 4,
    edgeCount: 4,
    nodes: [
      {
        id: "doc-1",
        title: "Seed Document",
        collectionId: "",
        parentDocumentId: "",
        updatedAt: "",
        publishedAt: "",
        urlId: "",
        emoji: "",
      },
      {
        id: "doc-2",
        title: "Runbook",
        collectionId: "col-1",
        parentDocumentId: "",
        updatedAt: "2026-03-01T00:00:00.000Z",
        publishedAt: "2026-03-01T00:00:00.000Z",
        urlId: "runbook",
        emoji: ":blue_book:",
      },
      {
        id: "doc-3",
        title: "Escalation Policy",
        collectionId: "col-1",
        parentDocumentId: "",
        updatedAt: "2026-03-02T00:00:00.000Z",
        publishedAt: "2026-03-02T00:00:00.000Z",
        urlId: "escalation-policy",
        emoji: ":green_book:",
      },
      {
        id: "doc-4",
        title: "Incident Checklist",
        collectionId: "col-2",
        parentDocumentId: "",
        updatedAt: "2026-03-03T00:00:00.000Z",
        publishedAt: "",
        urlId: "",
        emoji: "",
      },
    ],
    edges: [
      {
        sourceId: "doc-1",
        targetId: "doc-2",
        type: "backlink",
        query: "",
        rank: 1,
      },
      {
        sourceId: "doc-1",
        targetId: "doc-3",
        type: "backlink",
        query: "",
        rank: 2,
      },
      {
        sourceId: "doc-1",
        targetId: "doc-3",
        type: "search",
        query: "incident",
        rank: 1,
      },
      {
        sourceId: "doc-1",
        targetId: "doc-4",
        type: "search",
        query: "incident",
        rank: 2,
      },
    ],
    errors: [],
  });
});

test("documents.graph_report performs bounded BFS with stable output ordering", async () => {
  const contract = EXTENDED_TOOLS["documents.graph_report"];
  assert.ok(contract);
  assert.equal(typeof contract.handler, "function");

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        if (method !== "documents.list") {
          throw new Error(`Unexpected method: ${method}`);
        }
        return {
          body: {
            data: [
              { id: "doc-2", title: "Neighbor A" },
              { id: "doc-3", title: "Neighbor B" },
              { id: "doc-4", title: "Neighbor C" },
            ],
          },
        };
      },
    },
  };

  const output = await contract.handler(ctx, {
    seedIds: ["doc-1"],
    depth: 1,
    maxNodes: 3,
    includeBacklinks: true,
    includeSearchNeighbors: false,
    limitPerSource: 3,
    view: "ids",
  });

  assert.deepEqual(calls, [
    {
      method: "documents.list",
      body: {
        backlinkDocumentId: "doc-1",
        limit: 3,
        offset: 0,
        sort: "updatedAt",
        direction: "DESC",
      },
      options: { maxAttempts: 2 },
    },
  ]);
  assert.equal(output.tool, "documents.graph_report");
  assert.equal(output.profile, "profile-hardening");
  assert.deepEqual(output.result, {
    seedIds: ["doc-1"],
    requestedSeedCount: 1,
    depth: 1,
    exploredDepth: 1,
    maxNodes: 3,
    includeBacklinks: true,
    includeSearchNeighbors: false,
    limitPerSource: 3,
    truncated: true,
    nodeCount: 3,
    edgeCount: 2,
    nodes: [
      { id: "doc-1", title: "" },
      { id: "doc-2", title: "Neighbor A" },
      { id: "doc-3", title: "Neighbor B" },
    ],
    edges: [
      {
        sourceId: "doc-1",
        targetId: "doc-2",
        type: "backlink",
        query: "",
        rank: 1,
      },
      {
        sourceId: "doc-1",
        targetId: "doc-3",
        type: "backlink",
        query: "",
        rank: 2,
      },
    ],
    errors: [],
  });
});

test("documents.issue_refs extracts deterministic issue URLs and keys per document", async () => {
  const contract = EXTENDED_TOOLS["documents.issue_refs"];
  assert.ok(contract);
  assert.equal(typeof contract.handler, "function");

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });
        assert.equal(method, "documents.info");

        if (body.id === "doc-1") {
          return {
            body: {
              data: {
                id: "doc-1",
                title: "Incident Notes",
                text:
                  "Ticket ABC-1 and https://jira.example.com/browse/ABC-2 plus https://github.com/acme/repo/issues/42",
              },
            },
          };
        }
        if (body.id === "doc-2") {
          return {
            body: {
              data: {
                id: "doc-2",
                title: "Release Checklist",
                text:
                  "OPS-2 and https://jira.example.com/browse/OPS-1 plus https://example.com/out-of-scope",
              },
            },
          };
        }
        throw new Error(`Unexpected id: ${body.id}`);
      },
    },
  };

  const output = await contract.handler(ctx, {
    ids: ["doc-2", "doc-1"],
    issueDomains: ["jira.example.com", "github.com"],
    keyPattern: "[A-Z]+-\\d+",
    view: "ids",
    maxAttempts: 3,
  });

  assert.deepEqual(calls, [
    {
      method: "documents.info",
      body: { id: "doc-1" },
      options: { maxAttempts: 3 },
    },
    {
      method: "documents.info",
      body: { id: "doc-2" },
      options: { maxAttempts: 3 },
    },
  ]);

  assert.equal(output.tool, "documents.issue_refs");
  assert.equal(output.profile, "profile-hardening");
  assert.deepEqual(output.result.requestedIds, ["doc-1", "doc-2"]);
  assert.deepEqual(output.result.issueDomains, ["github.com", "jira.example.com"]);
  assert.equal(output.result.keyPattern, "[A-Z]+-\\d+");
  assert.equal(output.result.documentCount, 2);
  assert.equal(output.result.documentsWithRefs, 2);
  assert.equal(output.result.refCount, 5);
  assert.equal(output.result.keyCount, 4);
  assert.equal(output.result.mentionCount, 5);
  assert.deepEqual(output.result.keys, ["ABC-1", "ABC-2", "OPS-1", "OPS-2"]);
  assert.deepEqual(output.result.errors, []);

  assert.deepEqual(output.result.documents, [
    {
      document: {
        id: "doc-1",
        title: "Incident Notes",
      },
      summary: {
        refCount: 3,
        urlRefCount: 2,
        keyRefCount: 2,
        keyCount: 2,
        mentionCount: 3,
        textLength: 98,
      },
      keys: ["ABC-1", "ABC-2"],
      refs: [
        {
          key: "",
          url: "https://github.com/acme/repo/issues/42",
          domain: "github.com",
          sources: ["url"],
          count: 1,
        },
        {
          key: "ABC-1",
          url: "",
          domain: "",
          sources: ["key_pattern"],
          count: 1,
        },
        {
          key: "ABC-2",
          url: "https://jira.example.com/browse/ABC-2",
          domain: "jira.example.com",
          sources: ["key_pattern", "url"],
          count: 1,
        },
      ],
    },
    {
      document: {
        id: "doc-2",
        title: "Release Checklist",
      },
      summary: {
        refCount: 2,
        urlRefCount: 1,
        keyRefCount: 2,
        keyCount: 2,
        mentionCount: 2,
        textLength: 85,
      },
      keys: ["OPS-1", "OPS-2"],
      refs: [
        {
          key: "OPS-1",
          url: "https://jira.example.com/browse/OPS-1",
          domain: "jira.example.com",
          sources: ["key_pattern", "url"],
          count: 1,
        },
        {
          key: "OPS-2",
          url: "",
          domain: "",
          sources: ["key_pattern"],
          count: 1,
        },
      ],
    },
  ]);
});

test("documents.issue_ref_report resolves candidates via search and extracts deterministic refs", async () => {
  const contract = EXTENDED_TOOLS["documents.issue_ref_report"];
  assert.ok(contract);
  assert.equal(typeof contract.handler, "function");

  const calls = [];
  const ctx = {
    profile: { id: "profile-hardening" },
    client: {
      async call(method, body, options) {
        calls.push({ method, body, options });

        if (method === "documents.search_titles") {
          return {
            body: {
              data: [
                {
                  id: "doc-b",
                  title: "Runbook",
                  collectionId: "col-1",
                  updatedAt: "2026-03-02T00:00:00.000Z",
                  publishedAt: "2026-03-02T00:00:00.000Z",
                  urlId: "runbook",
                  ranking: 0.8,
                },
                {
                  id: "doc-a",
                  title: "Incident Notes",
                  collectionId: "col-1",
                  updatedAt: "2026-03-01T00:00:00.000Z",
                  publishedAt: "2026-03-01T00:00:00.000Z",
                  urlId: "incident-notes",
                  ranking: 0.9,
                },
              ],
            },
          };
        }

        if (method === "documents.search") {
          return {
            body: {
              data: [
                {
                  document: {
                    id: "doc-c",
                    title: "Postmortem",
                    collectionId: "col-1",
                    updatedAt: "2026-03-03T00:00:00.000Z",
                    publishedAt: "2026-03-03T00:00:00.000Z",
                    urlId: "postmortem",
                  },
                  ranking: 0.95,
                  context: "Contains OPS-77 context",
                },
                {
                  document: {
                    id: "doc-a",
                    title: "Incident Notes",
                    collectionId: "col-1",
                    updatedAt: "2026-03-04T00:00:00.000Z",
                    publishedAt: "2026-03-04T00:00:00.000Z",
                    urlId: "incident-notes",
                  },
                  ranking: 0.7,
                  context: "See ABC-9 context",
                },
              ],
            },
          };
        }

        if (method === "documents.info") {
          if (body.id === "doc-a") {
            return {
              body: {
                data: {
                  id: "doc-a",
                  title: "Incident Notes",
                  text: "Link https://jira.example.com/browse/ABC-9 and plain ABC-8",
                },
              },
            };
          }
          if (body.id === "doc-b") {
            return {
              body: {
                data: {
                  id: "doc-b",
                  title: "Runbook",
                  text: "No issue references here",
                },
              },
            };
          }
          if (body.id === "doc-c") {
            return {
              body: {
                data: {
                  id: "doc-c",
                  title: "Postmortem",
                  text:
                    "Track https://jira.example.com/browse/OPS-77 and ignore https://example.com/not-issue",
                },
              },
            };
          }
          throw new Error(`Unexpected document id: ${body.id}`);
        }

        throw new Error(`Unexpected method: ${method}`);
      },
    },
  };

  const output = await contract.handler(ctx, {
    query: "incident runbook",
    collectionId: "col-1",
    issueDomains: ["jira.example.com"],
    keyPattern: "[A-Z]+-\\d+",
    limit: 3,
    view: "summary",
    maxAttempts: 2,
  });

  assert.deepEqual(calls[0], {
    method: "documents.search_titles",
    body: {
      query: "incident runbook",
      collectionId: "col-1",
      limit: 3,
      offset: 0,
    },
    options: { maxAttempts: 2 },
  });
  assert.deepEqual(calls[1], {
    method: "documents.search",
    body: {
      query: "incident runbook",
      collectionId: "col-1",
      limit: 3,
      offset: 0,
      snippetMinWords: 16,
      snippetMaxWords: 24,
    },
    options: { maxAttempts: 2 },
  });
  assert.deepEqual(
    calls
      .filter((call) => call.method === "documents.info")
      .map((call) => call.body.id)
      .sort(),
    ["doc-a", "doc-b", "doc-c"]
  );

  assert.equal(output.tool, "documents.issue_ref_report");
  assert.equal(output.profile, "profile-hardening");
  assert.deepEqual(output.result.queries, ["incident runbook"]);
  assert.equal(output.result.collectionId, "col-1");
  assert.equal(output.result.limit, 3);
  assert.equal(output.result.candidateCount, 3);
  assert.deepEqual(
    output.result.candidates.map((item) => item.id),
    ["doc-c", "doc-a", "doc-b"]
  );
  assert.equal(output.result.documentCount, 3);
  assert.equal(output.result.documentsWithRefs, 2);
  assert.equal(output.result.refCount, 3);
  assert.equal(output.result.keyCount, 3);
  assert.equal(output.result.mentionCount, 3);
  assert.deepEqual(output.result.keys, ["ABC-8", "ABC-9", "OPS-77"]);
  assert.deepEqual(output.result.errors, []);
  assert.equal(output.result.perQuery.length, 1);
  assert.equal(output.result.perQuery[0].query, "incident runbook");
  assert.equal(output.result.perQuery[0].hitCount, 3);
  assert.deepEqual(output.result.documents.map((item) => item.document.id), ["doc-a", "doc-b", "doc-c"]);
  assert.equal(output.result.documents[0].summary.refCount, 2);
  assert.equal(output.result.documents[1].summary.refCount, 0);
  assert.equal(output.result.documents[2].summary.refCount, 1);
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
