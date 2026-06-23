import test from "node:test";
import assert from "node:assert/strict";

import { __commentInternals } from "../src/tools.extended.js";
import { invokeTool } from "../src/tools.js";
import { CliError } from "../src/errors.js";

function makeCommentCtx({ users = SAMPLE_USERS } = {}) {
  const calls = [];
  const ctx = {
    profile: { id: "prod" },
    client: {
      async call(method, body) {
        calls.push({ method, body });
        if (method === "users.list") {
          return { body: { ok: true, status: 200, data: users, pagination: { total: users.length } } };
        }
        if (method === "comments.create") {
          return { body: { ok: true, status: 200, data: { id: "comment-1", ...body } } };
        }
        return { body: { ok: true, status: 200, data: [] } };
      },
    },
  };
  return { ctx, calls };
}

const {
  COMMENT_TEXT_LIMIT,
  buildCommentData,
  commentTextLength,
  splitCommentParagraphs,
  firstNameToken,
  resolveMentionToken,
  usersFromListBody,
} = __commentInternals;

const SAMPLE_USERS = [
  { id: "11111111-1111-1111-1111-111111111111", name: "Quan, Tran Le", email: "quan@example.com" },
  { id: "22222222-2222-2222-2222-222222222222", name: "Alice Example", email: "alice@example.com" },
  { id: "33333333-3333-3333-3333-333333333333", name: "Quan Nguyen", email: "quan.nguyen@example.com" },
];

test("splitCommentParagraphs splits on blank lines and keeps single newlines as lines", () => {
  const paras = splitCommentParagraphs("first line\nsecond line\n\nsecond paragraph");
  assert.deepEqual(paras, [["first line", "second line"], ["second paragraph"]]);
});

test("buildCommentData builds a ProseMirror doc with paragraphs and line breaks", () => {
  const doc = buildCommentData("hello\nworld\n\nbye");
  assert.equal(doc.type, "doc");
  assert.equal(doc.content.length, 2);
  // first paragraph: text "hello", br, text "world"
  assert.deepEqual(doc.content[0].content, [
    { type: "text", text: "hello" },
    { type: "br" },
    { type: "text", text: "world" },
  ]);
  assert.deepEqual(doc.content[1].content, [{ type: "text", text: "bye" }]);
});

test("buildCommentData prepends mention nodes with fresh UUIDs at the start", () => {
  const mentions = [
    { userId: "11111111-1111-1111-1111-111111111111", label: "Quan, Tran Le" },
  ];
  const doc = buildCommentData("please review", mentions);
  const inline = doc.content[0].content;
  assert.equal(inline[0].type, "mention");
  assert.equal(inline[0].attrs.type, "user");
  assert.equal(inline[0].attrs.modelId, "11111111-1111-1111-1111-111111111111");
  assert.equal(inline[0].attrs.label, "Quan, Tran Le");
  assert.equal(inline[0].attrs.actorId, null);
  assert.match(inline[0].attrs.id, /^[0-9a-f-]{36}$/i);
  // space then the text
  assert.deepEqual(inline[1], { type: "text", text: " " });
  assert.deepEqual(inline[2], { type: "text", text: "please review" });
});

test("buildCommentData generates a unique id per mention node", () => {
  const mentions = [
    { userId: "11111111-1111-1111-1111-111111111111", label: "A" },
    { userId: "22222222-2222-2222-2222-222222222222", label: "B" },
  ];
  const doc = buildCommentData("hi", mentions);
  const mentionNodes = doc.content[0].content.filter((n) => n.type === "mention");
  assert.equal(mentionNodes.length, 2);
  assert.notEqual(mentionNodes[0].attrs.id, mentionNodes[1].attrs.id);
});

test("buildCommentData supports mention-only comments (no text)", () => {
  const doc = buildCommentData("", [{ userId: "x", label: "A" }]);
  const mentionNodes = doc.content.flatMap((p) => (p.content || []).filter((n) => n.type === "mention"));
  assert.equal(mentionNodes.length, 1);
});

test("commentTextLength counts text plus @label per mention, not JSON", () => {
  const len = commentTextLength("hello", [{ userId: "x", label: "Quan" }]);
  // "hello" = 5, mention "@Quan " ~ 1 + 4 + 1 = 6
  assert.equal(len, 11);
});

test("COMMENT_TEXT_LIMIT is 1000", () => {
  assert.equal(COMMENT_TEXT_LIMIT, 1000);
});

test("firstNameToken handles 'Last, First' and 'First Last' to the same token", () => {
  assert.equal(firstNameToken("Quan, Tran Le"), "tran");
  assert.equal(firstNameToken("Tran Le Quan"), "tran");
  assert.equal(firstNameToken("Alice Example"), "alice");
});

test("resolveMentionToken resolves an exact userId", () => {
  const out = resolveMentionToken("22222222-2222-2222-2222-222222222222", SAMPLE_USERS);
  assert.equal(out.resolved.userId, "22222222-2222-2222-2222-222222222222");
  assert.equal(out.resolved.label, "Alice Example");
});

test("resolveMentionToken resolves an exact email", () => {
  const out = resolveMentionToken("alice@example.com", SAMPLE_USERS);
  assert.equal(out.resolved.userId, "22222222-2222-2222-2222-222222222222");
});

test("resolveMentionToken matches first-name token across display-name order", () => {
  // "Tran Le Quan" (Jira order) should match Outline's "Quan, Tran Le" by first name "tran"
  const out = resolveMentionToken("Tran Le Quan", SAMPLE_USERS);
  assert.equal(out.resolved.userId, "11111111-1111-1111-1111-111111111111");
});

test("resolveMentionToken errors with candidates when first name is ambiguous", () => {
  const ambiguous = [
    { id: "a", name: "Quan One", email: "q1@example.com" },
    { id: "b", name: "Quan Two", email: "q2@example.com" },
  ];
  const out = resolveMentionToken("Quan", ambiguous);
  assert.equal(out.resolved, undefined);
  assert.equal(out.error.status, "ambiguous");
  assert.equal(out.error.candidates.length, 2);
});

test("resolveMentionToken disambiguates an ambiguous name via 'name <email>'", () => {
  const ambiguous = [
    { id: "a", name: "Quan One", email: "q1@example.com" },
    { id: "b", name: "Quan Two", email: "q2@example.com" },
  ];
  const out = resolveMentionToken("Quan <q2@example.com>", ambiguous);
  assert.equal(out.resolved.userId, "b");
});

test("resolveMentionToken reports not_found for an unknown name", () => {
  const out = resolveMentionToken("Zephyr", SAMPLE_USERS);
  assert.equal(out.error.status, "not_found");
});

test("usersFromListBody reads the Outline { data: [...] } shape", () => {
  assert.deepEqual(usersFromListBody({ data: SAMPLE_USERS }), SAMPLE_USERS);
  assert.deepEqual(usersFromListBody(SAMPLE_USERS), SAMPLE_USERS);
  assert.deepEqual(usersFromListBody({}), []);
});

// --- Handler integration (mocked client) -----------------------------------

test("comments.create builds data doc from text and sends data (not text)", async () => {
  const { ctx, calls } = makeCommentCtx();
  await invokeTool(ctx, "comments.create", {
    documentId: "doc-1",
    text: "Looks good.",
    performAction: true,
  });
  const createCall = calls.find((c) => c.method === "comments.create");
  assert.ok(createCall, "comments.create was called");
  assert.equal(createCall.body.text, undefined, "raw text must not be sent");
  assert.equal(createCall.body.data?.type, "doc");
  assert.equal(createCall.body.documentId, "doc-1");
  // No mentions => users.list not called.
  assert.equal(calls.some((c) => c.method === "users.list"), false);
});

test("comments.create resolves mentions and inserts mention nodes", async () => {
  const { ctx, calls } = makeCommentCtx();
  await invokeTool(ctx, "comments.create", {
    documentId: "doc-1",
    text: "please review",
    mentions: ["Tran Le Quan", "alice@example.com"],
    performAction: true,
  });
  assert.equal(calls.some((c) => c.method === "users.list"), true);
  const createCall = calls.find((c) => c.method === "comments.create");
  const mentionNodes = createCall.body.data.content.flatMap((p) =>
    (p.content || []).filter((n) => n.type === "mention")
  );
  assert.equal(mentionNodes.length, 2);
  assert.equal(mentionNodes[0].attrs.modelId, "11111111-1111-1111-1111-111111111111");
  assert.equal(mentionNodes[1].attrs.modelId, "22222222-2222-2222-2222-222222222222");
  assert.equal(createCall.body.mentions, undefined, "convenience mentions key must be stripped");
});

test("comments.create passes parentCommentId for replies", async () => {
  const { ctx, calls } = makeCommentCtx();
  await invokeTool(ctx, "comments.create", {
    documentId: "doc-1",
    text: "replying",
    parentCommentId: "comment-parent",
    performAction: true,
  });
  const createCall = calls.find((c) => c.method === "comments.create");
  assert.equal(createCall.body.parentCommentId, "comment-parent");
});

test("comments.create enforces the 1000-char text limit pre-flight", async () => {
  const { ctx, calls } = makeCommentCtx();
  await assert.rejects(
    () =>
      invokeTool(ctx, "comments.create", {
        documentId: "doc-1",
        text: "x".repeat(1001),
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.details?.code, "COMMENT_TOO_LONG");
      assert.equal(err.details?.limit, 1000);
      return true;
    }
  );
  // Never reached the network.
  assert.equal(calls.some((c) => c.method === "comments.create"), false);
});

test("comments.create errors clearly on an ambiguous mention with candidates", async () => {
  const { ctx } = makeCommentCtx({
    users: [
      { id: "a", name: "Quan One", email: "q1@example.com" },
      { id: "b", name: "Quan Two", email: "q2@example.com" },
    ],
  });
  await assert.rejects(
    () =>
      invokeTool(ctx, "comments.create", {
        documentId: "doc-1",
        text: "hi",
        mentions: ["Quan"],
        performAction: true,
      }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.details?.code, "MENTION_UNRESOLVED");
      assert.equal(err.details?.failures?.[0]?.status, "ambiguous");
      assert.equal(err.details?.failures?.[0]?.candidates?.length, 2);
      return true;
    }
  );
});

test("comments.create is action-gated (requires performAction)", async () => {
  const { ctx, calls } = makeCommentCtx();
  await assert.rejects(
    () => invokeTool(ctx, "comments.create", { documentId: "doc-1", text: "no gate" }),
    (err) => {
      assert.equal(err.details?.code, "ACTION_GATED");
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test("comments.post alias works identically to comments.create", async () => {
  const { ctx, calls } = makeCommentCtx();
  await invokeTool(ctx, "comments.post", {
    documentId: "doc-1",
    text: "via alias",
    mentions: ["alice@example.com"],
    performAction: true,
  });
  const createCall = calls.find((c) => c.method === "comments.create");
  assert.ok(createCall, "comments.post dispatches to comments.create method");
  assert.equal(createCall.body.data?.type, "doc");
  const mentionNodes = createCall.body.data.content.flatMap((p) =>
    (p.content || []).filter((n) => n.type === "mention")
  );
  assert.equal(mentionNodes.length, 1);
});
