import test from "node:test";
import assert from "node:assert/strict";
import { invokeTool } from "../src/tools.js";

function context() {
  const calls = [];
  return {
    calls,
    profile: { id: "url-regression" },
    client: {
      async call(method, body) {
        calls.push({ method, body });
        return { body: { ok: true, data: { id: body.id, title: "Fixture" } } };
      },
    },
  };
}

const slug = "example-AbCdEf1234";
const url = `https://docs.example.com/doc/${slug}?ref=test#heading`;
const uuid = "740bc299-9346-461b-bb22-b736820ebae5";

test("documents.info normalizes URLs supplied as id or url before the API call", async () => {
  for (const args of [{ id: url }, { url }, { id: `/doc/${slug}/#heading` }, { id: slug }, { id: uuid }]) {
    const ctx = context();
    const result = await invokeTool(ctx, "documents.info", { ...args, compact: false });
    assert.deepEqual(ctx.calls, [{ method: "documents.info", body: { id: args.id === uuid ? uuid : slug } }]);
    assert.equal(result.result.ok, true);
  }
});

test("documents.info deduplicates mixed URL and slug references after normalization", async () => {
  const ctx = context();
  const result = await invokeTool(ctx, "documents.info", { ids: [url, slug, uuid], compact: false });
  assert.deepEqual(ctx.calls.map((call) => call.body.id), [slug, uuid]);
  assert.equal(result.batched, true);
  assert.equal(result.result.total, 2);
  assert.equal(result.result.ok, 2);
});

test("documents.info rejects unsupported URLs and conflicting aliases before any API request", async () => {
  for (const args of [
    { url: "https://docs.example.com/share/example" },
    { id: "https://docs.example.com/doc/%2Fbad" },
    { id: "https://docs.example.com/doc/%zz" },
    { url, id: uuid },
  ]) {
    const ctx = context();
    await assert.rejects(invokeTool(ctx, "documents.info", args), { name: "CliError" });
    assert.equal(ctx.calls.length, 0);
  }
});

test("documents.info preserves shareId reads and collections.info identifiers", async () => {
  const ctx = context();
  await invokeTool(ctx, "documents.info", { shareId: "share-id" });
  await invokeTool(ctx, "collections.info", { id: url });
  assert.deepEqual(ctx.calls, [
    { method: "documents.info", body: { shareId: "share-id" } },
    { method: "collections.info", body: { id: url } },
  ]);
});
