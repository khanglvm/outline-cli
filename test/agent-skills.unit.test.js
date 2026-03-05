import test from "node:test";
import assert from "node:assert/strict";

import { getAgentSkillHelp, listHelpSections } from "../src/agent-skills.js";
import { CliError } from "../src/errors.js";

test("listHelpSections exposes ai-skills section", () => {
  const sections = listHelpSections();
  assert.ok(Array.isArray(sections));
  assert.ok(sections.some((section) => section.id === "ai-skills"));
});

test("getAgentSkillHelp returns summary guidance by default", () => {
  const payload = getAgentSkillHelp();

  assert.equal(payload.section, "ai-skills");
  assert.equal(payload.view, "summary");
  assert.ok(payload.totalSkills >= 10);
  assert.equal(payload.skills.length, payload.returnedSkills);
  assert.ok(payload.globalGuidance?.principles?.length >= 1);
  assert.ok(payload.skills.some((skill) => skill.id === "legacy_wiki_migration"));
});

test("getAgentSkillHelp filters by scenario and query", () => {
  const byScenario = getAgentSkillHelp({ scenario: "uc-19" });
  assert.equal(byScenario.returnedSkills, 1);
  assert.equal(byScenario.skills[0].id, "oauth_compliance_audit");

  const byQuery = getAgentSkillHelp({ query: "documents.import_file" });
  assert.ok(byQuery.skills.some((skill) => skill.id === "legacy_wiki_migration"));
});

test("getAgentSkillHelp returns full skill payload and validates view", () => {
  const payload = getAgentSkillHelp({
    skill: "template_pipeline_execution",
    view: "full",
  });

  assert.equal(payload.returnedSkills, 1);
  assert.equal(payload.skills[0].id, "template_pipeline_execution");
  assert.ok(Array.isArray(payload.skills[0].sequence));
  assert.ok(payload.skills[0].sequence.some((step) => step.tool === "templates.extract_placeholders"));

  assert.throws(
    () => getAgentSkillHelp({ view: "compact" }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.details?.code, "AI_HELP_INVALID_VIEW");
      return true;
    }
  );
});
