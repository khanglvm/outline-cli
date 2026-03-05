import test from "node:test";
import assert from "node:assert/strict";
import {
  buildProfile,
  normalizeBaseUrlWithHints,
  suggestProfileMetadata,
  suggestProfiles,
} from "../src/config-store.js";

test("normalizeBaseUrlWithHints auto-corrects official and document URLs", () => {
  const official = normalizeBaseUrlWithHints("https://www.getoutline.com");
  assert.equal(official.baseUrl, "https://app.getoutline.com");
  assert.equal(official.corrected, true);
  assert.ok(official.corrections.includes("mapped_official_outline_host"));

  const docUrl = normalizeBaseUrlWithHints(
    "https://handbook.acme.example/doc/event-tracking-data-A7hLXuHZJl#d-A7hLXuHZJl"
  );
  assert.equal(docUrl.baseUrl, "https://handbook.acme.example");
  assert.equal(docUrl.corrected, true);
  assert.ok(docUrl.corrections.includes("trimmed_ui_path"));

  const reverseProxy = normalizeBaseUrlWithHints("https://wiki.example.com/outline/api/auth.info");
  assert.equal(reverseProxy.baseUrl, "https://wiki.example.com/outline");
  assert.ok(reverseProxy.corrections.includes("trimmed_path_after_api"));
});

test("buildProfile persists optional description and keywords metadata", () => {
  const profile = buildProfile({
    id: "acme-handbook",
    name: "Acme Handbook",
    description: "Tracking and campaign specs",
    keywords: ["tracking", "campaign", "tracking", " event "],
    baseUrl: "https://handbook.acme.example/doc/event-tracking-data-A7hLXuHZJl",
    authType: "apiKey",
    apiKey: "ol_api_example",
  });

  assert.equal(profile.description, "Tracking and campaign specs");
  assert.deepEqual(profile.keywords, ["tracking", "campaign", "event"]);
  assert.equal(profile.baseUrl, "https://handbook.acme.example");
});

test("suggestProfiles ranks profiles by keywords/description/host signals", () => {
  const config = {
    version: 1,
    defaultProfile: "engineering",
    profiles: {
      engineering: {
        name: "Engineering",
        baseUrl: "https://wiki.example.com",
        description: "Runbooks and incident policy",
        keywords: ["incident", "runbook", "sre"],
        auth: { type: "apiKey", apiKey: "ol_api_eng" },
      },
      marketing: {
        name: "Acme Handbook",
        baseUrl: "https://handbook.acme.example",
        description: "Marketing campaign and event tracking handbook",
        keywords: ["tracking", "campaign", "analytics"],
        auth: { type: "apiKey", apiKey: "ol_api_marketing" },
      },
    },
  };

  const result = suggestProfiles(config, "campaign tracking handbook", { limit: 2 });
  assert.equal(result.matches.length, 2);
  assert.equal(result.matches[0].id, "marketing");
  assert.ok(result.matches[0].score > result.matches[1].score);
  assert.ok(Array.isArray(result.matches[0].matchedOn));
});

test("suggestProfileMetadata can generate and enrich metadata from hints", () => {
  const next = suggestProfileMetadata({
    id: "acme-handbook",
    name: "Acme Handbook",
    baseUrl: "https://handbook.acme.example",
    hints: [
      "implement tracking collection for landing page",
      "campaign detail page",
    ],
  }, { maxKeywords: 12 });

  assert.ok(next.description.includes("Acme Handbook"));
  assert.ok(next.keywords.includes("tracking"));
  assert.ok(next.keywords.includes("landing page"));
  assert.ok(next.keywords.includes("campaign detail"));
  assert.equal(next.generated.hintsUsed, 2);
});
