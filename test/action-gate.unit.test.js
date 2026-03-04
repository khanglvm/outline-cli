import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { CliError } from "../src/errors.js";
import {
  assertPerformAction,
  consumeDocumentDeleteReadReceipt,
  getActionGateStorePath,
  getDocumentDeleteReadReceipt,
  issueDocumentDeleteReadReceipt,
} from "../src/action-gate.js";

test("assertPerformAction blocks when performAction is not true", () => {
  assert.throws(
    () =>
      assertPerformAction({}, {
        tool: "documents.update",
        action: "update a document",
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.details?.code, "ACTION_GATED");
      return true;
    }
  );

  assert.doesNotThrow(() =>
    assertPerformAction({ performAction: true }, {
      tool: "documents.update",
      action: "update a document",
    })
  );
});

test("delete read receipt lifecycle: issue -> validate -> consume", async () => {
  const previousTmp = process.env.OUTLINE_AGENT_TMP_DIR;
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "outline-agent-action-gate-"));
  process.env.OUTLINE_AGENT_TMP_DIR = tmpDir;

  try {
    const issued = await issueDocumentDeleteReadReceipt({
      profileId: "test-profile",
      documentId: "doc-123",
      revision: 7,
      title: "Doc 123",
      ttlSeconds: 600,
    });

    assert.ok(typeof issued.token === "string" && issued.token.length > 0);
    assert.equal(issued.documentId, "doc-123");
    assert.equal(issued.revision, 7);

    const storePath = getActionGateStorePath();
    assert.ok(storePath.startsWith(path.resolve(tmpDir)));

    const fetched = await getDocumentDeleteReadReceipt({
      token: issued.token,
      profileId: "test-profile",
      documentId: "doc-123",
    });
    assert.equal(fetched.documentId, "doc-123");
    assert.equal(fetched.revision, 7);

    await assert.rejects(
      () =>
        getDocumentDeleteReadReceipt({
          token: issued.token,
          profileId: "test-profile",
          documentId: "doc-999",
        }),
      (err) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.details?.code, "DELETE_READ_TOKEN_DOCUMENT_MISMATCH");
        return true;
      }
    );

    const consumed = await consumeDocumentDeleteReadReceipt(issued.token);
    assert.equal(consumed, true);

    await assert.rejects(
      () =>
        getDocumentDeleteReadReceipt({
          token: issued.token,
          profileId: "test-profile",
          documentId: "doc-123",
        }),
      (err) => {
        assert.ok(err instanceof CliError);
        assert.equal(err.details?.code, "DELETE_READ_TOKEN_INVALID");
        return true;
      }
    );
  } finally {
    if (previousTmp == null) {
      delete process.env.OUTLINE_AGENT_TMP_DIR;
    } else {
      process.env.OUTLINE_AGENT_TMP_DIR = previousTmp;
    }
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
