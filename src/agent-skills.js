import { CliError } from "./errors.js";

const AI_SKILL_DATA_VERSION = "2026-03-05";
const AI_HELP_SECTION_ID = "ai-skills";

const AI_GLOBAL_GUIDANCE = {
  principles: [
    "Use ids/summary views first, then hydrate only selected records.",
    "Prefer batch operations (queries, ids, or batch command) before multi-call loops.",
    "Keep mutating calls action-gated and explicit with performAction=true only at execute time.",
    "Capture audit evidence (events/revisions/policies) immediately after high-impact changes.",
  ],
  executionLoop: [
    "Discover scope with list/search in compact views.",
    "Plan deterministic targets and explicit safety gates.",
    "Execute minimal mutations with performAction=true only when approved.",
    "Verify with read-back and event/revision evidence.",
  ],
};

const AI_SKILLS = [
  {
    id: "faq_semantic_qa",
    title: "FAQ semantic Q&A pipeline",
    scenarios: ["UC-04", "UC-15"],
    objective: "Answer FAQ-style questions with bounded scope and deterministic follow-up.",
    featureUpdates: [
      "documents.answer and documents.answer_batch wrappers for permission-aware AI responses.",
      "ids/summary-first flow aligned with low-token retrieval loops.",
    ],
    sequence: [
      {
        step: 1,
        tool: "documents.search",
        purpose: "Resolve candidate FAQ documents with compact summary rows.",
      },
      {
        step: 2,
        tool: "documents.answer",
        purpose: "Ask scoped question with collection/document bounds.",
      },
      {
        step: 3,
        tool: "documents.answer_batch",
        purpose: "Run deterministic multi-question checks on the same scope.",
      },
      {
        step: 4,
        tool: "documents.info",
        purpose: "Hydrate only cited or ambiguous docs for verification.",
      },
    ],
    efficiencyTips: [
      "Use specific question phrasing and explicit collectionId/documentId scope.",
      "Keep batch concurrency low for stable latency and predictable cost.",
    ],
    safetyChecks: [
      "Treat empty answer/citation gaps as a re-scope signal, not immediate mutation trigger.",
      "Use includePolicies only when diagnosing permission visibility issues.",
    ],
  },
  {
    id: "public_docs_sharing",
    title: "Public help-doc sharing lifecycle",
    scenarios: ["UC-05"],
    objective: "Create, update, and revoke share links with explicit auditability.",
    featureUpdates: [
      "shares.list/info/create/update/revoke wrappers with deterministic envelopes.",
      "Mutation gating retained across sharing lifecycle operations.",
    ],
    sequence: [
      {
        step: 1,
        tool: "documents.search",
        purpose: "Resolve target public-help docs by query.",
      },
      {
        step: 2,
        tool: "shares.create",
        purpose: "Create share artifact only for approved doc targets.",
      },
      {
        step: 3,
        tool: "shares.update",
        purpose: "Apply controlled publish/visibility updates.",
      },
      {
        step: 4,
        tool: "shares.info",
        purpose: "Confirm final share state and metadata.",
      },
      {
        step: 5,
        tool: "shares.revoke",
        purpose: "Revoke stale or deprecated share links.",
      },
    ],
    efficiencyTips: [
      "Persist share ids once discovered to avoid repeated broad list calls.",
      "Use summary view for routine checks; hydrate full payload only for exceptions.",
    ],
    safetyChecks: [
      "Always require performAction=true for share mutations.",
      "Re-verify target document identity before revocation in automated cleanup loops.",
    ],
  },
  {
    id: "department_access_control",
    title: "Department-space role and membership control",
    scenarios: ["UC-06"],
    objective: "Apply least-privilege access controls and verify visibility by group and collection.",
    featureUpdates: [
      "groups.memberships wrapper added for group membership reads.",
      "documents.users and collection/document membership wrappers available for audits.",
    ],
    sequence: [
      {
        step: 1,
        tool: "groups.list",
        purpose: "Discover department groups and resolve IDs.",
      },
      {
        step: 2,
        tool: "groups.memberships",
        purpose: "Read current group-user mappings for baseline audit.",
      },
      {
        step: 3,
        tool: "collections.add_group",
        purpose: "Grant group access to scoped collection.",
      },
      {
        step: 4,
        tool: "collections.group_memberships",
        purpose: "Verify collection permission propagation.",
      },
      {
        step: 5,
        tool: "events.list",
        purpose: "Capture audit evidence for access changes.",
      },
    ],
    efficiencyTips: [
      "Prefer group grants over per-user grants for lower operational churn.",
      "Use paginated memberships reads for deterministic audits.",
    ],
    safetyChecks: [
      "Treat role/membership writes as high-impact and keep performAction explicit.",
      "Record before/after membership snapshots for rollback readiness.",
    ],
  },
  {
    id: "issue_tracker_linkage",
    title: "Issue tracker linkage and safe patch flow",
    scenarios: ["UC-07"],
    objective: "Extract issue refs from docs and patch links safely with revision guards.",
    featureUpdates: [
      "documents.issue_refs and documents.issue_ref_report wrappers added.",
      "data_attributes wrappers support project metadata enrichment workflows.",
    ],
    sequence: [
      {
        step: 1,
        tool: "documents.issue_ref_report",
        purpose: "Find candidate docs and summarize linked issue references.",
      },
      {
        step: 2,
        tool: "documents.issue_refs",
        purpose: "Extract deterministic issue refs for selected IDs.",
      },
      {
        step: 3,
        tool: "revisions.info",
        purpose: "Capture current revision before any patch plan.",
      },
      {
        step: 4,
        tool: "documents.apply_patch_safe",
        purpose: "Apply revision-guarded patch updates only on expected revision.",
      },
      {
        step: 5,
        tool: "events.list",
        purpose: "Audit resulting mutation events.",
      },
    ],
    efficiencyTips: [
      "Pass issueDomains and keyPattern to reduce extraction noise.",
      "Run ids-first extraction before any content mutation proposal.",
    ],
    safetyChecks: [
      "Block patch apply when expected revision drifts.",
      "Never apply mutation from synthetic issue refs without doc hydration.",
    ],
  },
  {
    id: "rollback_safe_editing",
    title: "Rollback-safe postmortem editing",
    scenarios: ["UC-09"],
    objective: "Plan and apply edits with revision diff evidence and deterministic rollback paths.",
    featureUpdates: [
      "revisions.diff and documents.apply_patch_safe wrappers added.",
      "Revision safety checks included in schema validation and tests.",
    ],
    sequence: [
      {
        step: 1,
        tool: "documents.info",
        purpose: "Read target document and revision baseline.",
      },
      {
        step: 2,
        tool: "revisions.list",
        purpose: "Inspect recent revision timeline for concurrent edits.",
      },
      {
        step: 3,
        tool: "revisions.diff",
        purpose: "Diff candidate revisions for precise change context.",
      },
      {
        step: 4,
        tool: "documents.apply_patch_safe",
        purpose: "Apply guarded patch with explicit expectedRevision.",
      },
      {
        step: 5,
        tool: "revisions.info",
        purpose: "Confirm final revision and patch provenance.",
      },
    ],
    efficiencyTips: [
      "Prefer small patch hunks over full document rewrite when coordinating multiple agents.",
      "Use summary views for revision triage, then hydrate final comparison only.",
    ],
    safetyChecks: [
      "Require expectedRevision for every patch-safe write.",
      "Treat diff mismatch as retry/read signal, not force-write signal.",
    ],
  },
  {
    id: "knowledge_graph_mapping",
    title: "Cross-linked knowledge graph mapping",
    scenarios: ["UC-10"],
    objective: "Build deterministic graph views of document relationships for navigation and audit.",
    featureUpdates: [
      "documents.backlinks, documents.graph_neighbors, and documents.graph_report wrappers added.",
      "Stable node and edge sorting for reproducible graph outputs.",
    ],
    sequence: [
      {
        step: 1,
        tool: "documents.backlinks",
        purpose: "Collect direct references to seed documents.",
      },
      {
        step: 2,
        tool: "documents.graph_neighbors",
        purpose: "Expand one-hop neighborhood with bounded limitPerSource.",
      },
      {
        step: 3,
        tool: "documents.graph_report",
        purpose: "Generate bounded BFS report for downstream indexing or review.",
      },
      {
        step: 4,
        tool: "documents.info",
        purpose: "Hydrate selected hub nodes for human-readable context.",
      },
    ],
    efficiencyTips: [
      "Start with small depth/maxNodes bounds, then expand only when needed.",
      "Use view=ids for planning cycles and preserve token budget.",
    ],
    safetyChecks: [
      "Keep includeSearchNeighbors disabled unless semantic expansion is required.",
      "Cap maxNodes for deterministic runtime and predictable output size.",
    ],
  },
  {
    id: "template_pipeline_execution",
    title: "Template-driven document pipeline",
    scenarios: ["UC-11"],
    objective: "Generate consistent documents from templates with strict placeholder enforcement.",
    featureUpdates: [
      "templates.extract_placeholders and documents.create_from_template wrappers added.",
      "Strict unresolved placeholder checks to block unsafe publishes.",
    ],
    sequence: [
      {
        step: 1,
        tool: "templates.extract_placeholders",
        purpose: "Resolve required placeholder keys and counts.",
      },
      {
        step: 2,
        tool: "documents.create_from_template",
        purpose: "Create draft/published docs with explicit placeholderValues.",
      },
      {
        step: 3,
        tool: "documents.info",
        purpose: "Verify output title, location, and publication state.",
      },
      {
        step: 4,
        tool: "events.list",
        purpose: "Capture creation audit trail for pipeline runs.",
      },
    ],
    efficiencyTips: [
      "Reuse extracted placeholder keys to validate payload before creation.",
      "Use summary view for pipeline loop status checks.",
    ],
    safetyChecks: [
      "Keep strictPlaceholders=true in automation by default.",
      "Only set performAction=true at final create step after validation passes.",
    ],
  },
  {
    id: "legacy_wiki_migration",
    title: "Legacy wiki migration execution",
    scenarios: ["UC-12"],
    objective: "Import legacy content, track async file operations, and clean up safely.",
    featureUpdates: [
      "documents.import_file multipart wrapper added.",
      "file_operations.list/info/delete wrappers added for import tracking lifecycle.",
    ],
    sequence: [
      {
        step: 1,
        tool: "documents.import_file",
        purpose: "Submit local export file import request.",
      },
      {
        step: 2,
        tool: "file_operations.info",
        purpose: "Poll async import status for the returned operation id.",
      },
      {
        step: 3,
        tool: "documents.search",
        purpose: "Verify imported docs by title/content probes.",
      },
      {
        step: 4,
        tool: "file_operations.delete",
        purpose: "Cleanup stale operation artifacts once verified.",
      },
    ],
    efficiencyTips: [
      "Use compact import metadata and poll by operation id rather than repeated broad lists.",
      "Validate in small content batches to isolate failures early.",
    ],
    safetyChecks: [
      "Keep performAction=true explicit on import and file operation delete steps.",
      "Require deterministic collection/parent targeting before import submission.",
    ],
  },
  {
    id: "workspace_lifecycle_automation",
    title: "Workspace lifecycle automation",
    scenarios: ["UC-13"],
    objective: "Automate users/groups/permissions lifecycle changes with explicit verification.",
    featureUpdates: [
      "users lifecycle wrappers (invite, update_role, activate, suspend) added.",
      "documents.users and membership wrappers improve scoped permission checks.",
    ],
    sequence: [
      {
        step: 1,
        tool: "users.list",
        purpose: "Resolve baseline users and target principals.",
      },
      {
        step: 2,
        tool: "groups.list",
        purpose: "Resolve target groups for planned policy changes.",
      },
      {
        step: 3,
        tool: "users.update_role",
        purpose: "Apply role changes under explicit action gate.",
      },
      {
        step: 4,
        tool: "groups.add_user",
        purpose: "Apply group membership updates.",
      },
      {
        step: 5,
        tool: "documents.users",
        purpose: "Verify effective document access after changes.",
      },
      {
        step: 6,
        tool: "events.list",
        purpose: "Capture automation evidence for audit trails.",
      },
    ],
    efficiencyTips: [
      "Batch read operations (ids/queries) before any mutation stage.",
      "Separate planning output from execution payload for reliable reruns.",
    ],
    safetyChecks: [
      "Never combine unknown target resolution and mutation in the same step.",
      "Use performAction=true only on approved write calls.",
    ],
  },
  {
    id: "event_driven_cleanup",
    title: "Event-driven cleanup and lifecycle governance",
    scenarios: ["UC-14", "UC-20"],
    objective: "Handle deletion and cleanup workflows with strict read-confirm and action gating.",
    featureUpdates: [
      "documents.permanent_delete wrapper added with action gating.",
      "Delete read-receipt flow supports safe delete confirmation before destructive actions.",
    ],
    sequence: [
      {
        step: 1,
        tool: "documents.info",
        purpose: "Arm delete read token with armDelete=true and capture revision.",
      },
      {
        step: 2,
        tool: "documents.permanent_delete",
        purpose: "Run explicit destructive delete under performAction gate.",
      },
      {
        step: 3,
        tool: "webhooks.list",
        purpose: "Confirm event-driven integrations observing target resources.",
      },
      {
        step: 4,
        tool: "events.list",
        purpose: "Collect deletion and webhook-event evidence.",
      },
    ],
    efficiencyTips: [
      "Use summary hydration first to avoid accidental destructive scope drift.",
      "Capture read token metadata in execution logs for reproducibility.",
    ],
    safetyChecks: [
      "Fail delete if read token is missing, stale, mismatched, or expired.",
      "Never run permanent delete in batch loops without per-item read confirmation.",
    ],
  },
  {
    id: "federated_sync_acl_reconciliation",
    title: "Federated search sync and ACL reconciliation",
    scenarios: ["UC-16"],
    objective: "Track sync freshness and permission parity for external index integrations.",
    featureUpdates: [
      "federated.sync_manifest, federated.sync_probe, and federated.permission_snapshot wrappers added.",
      "Deterministic per-query and per-document rows for drift monitoring.",
    ],
    sequence: [
      {
        step: 1,
        tool: "federated.sync_manifest",
        purpose: "Generate incremental sync manifest from content scope.",
      },
      {
        step: 2,
        tool: "federated.sync_probe",
        purpose: "Probe search findability across title/semantic channels.",
      },
      {
        step: 3,
        tool: "federated.permission_snapshot",
        purpose: "Snapshot ACL memberships for resolver parity checks.",
      },
      {
        step: 4,
        tool: "events.list",
        purpose: "Audit indexing and permission-related lifecycle events.",
      },
    ],
    efficiencyTips: [
      "Use since + pagination for incremental sync windows.",
      "Persist missing[] and item.errors trends for regression alerts.",
    ],
    safetyChecks: [
      "Treat partial permission errors as scoped findings, not full-run hard failures.",
      "Use explicit ids for ACL snapshots when deterministic comparisons are required.",
    ],
  },
  {
    id: "editorial_review_orchestration",
    title: "Multi-team editorial review orchestration",
    scenarios: ["UC-17"],
    objective: "Build deterministic review queues and close loops with comment evidence.",
    featureUpdates: [
      "comments.review_queue wrapper added for scoped editorial queues.",
      "Thread/reply and anchor metadata can be included for full review context.",
    ],
    sequence: [
      {
        step: 1,
        tool: "comments.review_queue",
        purpose: "Build bounded review queue for target docs/collection.",
      },
      {
        step: 2,
        tool: "comments.list",
        purpose: "Hydrate specific comment threads when deeper context is needed.",
      },
      {
        step: 3,
        tool: "documents.info",
        purpose: "Hydrate only docs requiring editorial action.",
      },
      {
        step: 4,
        tool: "events.list",
        purpose: "Track review completion and discussion churn.",
      },
    ],
    efficiencyTips: [
      "Scope review_queue to explicit documentIds whenever possible.",
      "Use limitPerDocument to control queue growth and rerun with cursor-like cadence.",
    ],
    safetyChecks: [
      "Treat truncated queues as incomplete and rerun with higher limit before sign-off.",
      "Keep comment mutations separately approved when operating in shared workspaces.",
    ],
  },
  {
    id: "terminology_refactor_governance",
    title: "Controlled terminology refactor governance",
    scenarios: ["UC-18"],
    objective: "Plan large terminology updates safely before batch mutation execution.",
    featureUpdates: [
      "documents.plan_terminology_refactor wrapper added for glossary/map-driven planning.",
      "Plan output is compatible with documents.batch_update execution workflows.",
    ],
    sequence: [
      {
        step: 1,
        tool: "documents.plan_terminology_refactor",
        purpose: "Generate deterministic refactor plan with impacts and plan hash.",
      },
      {
        step: 2,
        tool: "documents.plan_batch_update",
        purpose: "Cross-check mutation plan and bounded hunk diffs.",
      },
      {
        step: 3,
        tool: "documents.batch_update",
        purpose: "Apply approved plan with action gate.",
      },
      {
        step: 4,
        tool: "revisions.diff",
        purpose: "Validate pre/post terminology deltas.",
      },
      {
        step: 5,
        tool: "events.list",
        purpose: "Persist governance evidence and mutation trace.",
      },
    ],
    efficiencyTips: [
      "Use map/glossary inputs with explicit scope filters to bound search space.",
      "Review plan hashes and impact counts before any batch apply.",
    ],
    safetyChecks: [
      "Treat plan review as mandatory approval gate before documents.batch_update.",
      "Require performAction=true only at final execution stage.",
    ],
  },
  {
    id: "oauth_compliance_audit",
    title: "OAuth lifecycle compliance audit",
    scenarios: ["UC-19"],
    objective: "Audit OAuth client/authentication lifecycle with non-destructive checks by default.",
    featureUpdates: [
      "oauth_clients.* and oauth_authentications.* wrappers added.",
      "Compatibility aliases retained for oauthClients.* and oauthAuthentications.* delete flows.",
    ],
    sequence: [
      {
        step: 1,
        tool: "oauth_clients.list",
        purpose: "Discover OAuth clients in compact summary mode.",
      },
      {
        step: 2,
        tool: "oauth_clients.info",
        purpose: "Hydrate selected client metadata for compliance checks.",
      },
      {
        step: 3,
        tool: "oauth_authentications.list",
        purpose: "Review active authentications and linkage state.",
      },
      {
        step: 4,
        tool: "events.list",
        purpose: "Collect lifecycle event evidence for audits.",
      },
    ],
    efficiencyTips: [
      "Start with read-only probes and low limits for compliance smoke checks.",
      "Use compatibility aliases only when integrating with legacy automation names.",
    ],
    safetyChecks: [
      "Treat oauth delete/rotate operations as explicit, approved mutations only.",
      "Skip gracefully on deployment-policy-dependent 401/403/404/405/501 responses in read checks.",
    ],
  },
];

function normalizeView(view = "summary") {
  const normalized = String(view || "summary").toLowerCase();
  if (normalized !== "summary" && normalized !== "full") {
    throw new CliError("Invalid view for ai-skills help. Expected summary or full.", {
      code: "AI_HELP_INVALID_VIEW",
      view,
    });
  }
  return normalized;
}

function normalizeScenario(input) {
  if (!input) {
    return null;
  }
  return String(input).trim().toUpperCase();
}

function normalizeSkillId(input) {
  if (!input) {
    return null;
  }
  return String(input).trim().toLowerCase();
}

function scoreSkillQuery(skill, rawQuery) {
  const query = String(rawQuery || "").trim().toLowerCase();
  if (!query) {
    return 0;
  }

  let score = 0;
  if (skill.id.includes(query)) {
    score += 8;
  }
  if (skill.title.toLowerCase().includes(query)) {
    score += 6;
  }
  for (const scenario of skill.scenarios) {
    if (scenario.toLowerCase().includes(query)) {
      score += 5;
    }
  }
  for (const item of skill.featureUpdates) {
    if (item.toLowerCase().includes(query)) {
      score += 4;
    }
  }
  for (const row of skill.sequence) {
    if (String(row.tool).toLowerCase().includes(query)) {
      score += 7;
    }
    if (String(row.purpose).toLowerCase().includes(query)) {
      score += 2;
    }
  }
  return score;
}

function summarizeSkill(skill) {
  return {
    id: skill.id,
    title: skill.title,
    scenarios: skill.scenarios,
    objective: skill.objective,
    focusTools: skill.sequence.map((row) => row.tool),
    featureUpdates: skill.featureUpdates,
  };
}

function sortSkills(rows) {
  return [...rows].sort((a, b) => a.id.localeCompare(b.id));
}

function applyFilters({ scenario, query, skillId }) {
  const requestedScenario = normalizeScenario(scenario);
  const requestedSkillId = normalizeSkillId(skillId);
  const requestedQuery = String(query || "").trim();

  const filtered = AI_SKILLS.filter((skill) => {
    if (requestedScenario && !skill.scenarios.map((x) => x.toUpperCase()).includes(requestedScenario)) {
      return false;
    }
    if (requestedSkillId && skill.id !== requestedSkillId) {
      return false;
    }
    const score = scoreSkillQuery(skill, requestedQuery);
    if (requestedQuery && score === 0) {
      return false;
    }
    return true;
  });

  const sorted = sortSkills(filtered);
  return {
    requestedScenario,
    requestedSkillId,
    requestedQuery: requestedQuery || null,
    skills: requestedQuery
      ? sorted.sort((a, b) => scoreSkillQuery(b, requestedQuery) - scoreSkillQuery(a, requestedQuery))
      : sorted,
  };
}

export function getAgentSkillHelp(options = {}) {
  const view = normalizeView(options.view || "summary");
  const { requestedScenario, requestedSkillId, requestedQuery, skills } = applyFilters({
    scenario: options.scenario,
    query: options.query,
    skillId: options.skill || options.skillId,
  });

  return {
    section: AI_HELP_SECTION_ID,
    version: AI_SKILL_DATA_VERSION,
    view,
    filters: {
      scenario: requestedScenario,
      skill: requestedSkillId,
      query: requestedQuery,
    },
    globalGuidance: AI_GLOBAL_GUIDANCE,
    totalSkills: AI_SKILLS.length,
    returnedSkills: skills.length,
    skills: skills.map((skill) => (view === "full" ? skill : summarizeSkill(skill))),
  };
}

export function listHelpSections() {
  return [
    {
      id: AI_HELP_SECTION_ID,
      title: "AI instruction skills",
      description: "Scenario-guided tool sequences and safety/efficiency patterns for agent execution.",
      commandExample: "outline-cli tools help ai-skills --view summary",
    },
  ];
}
