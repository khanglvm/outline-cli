import test from "node:test";
import assert from "node:assert/strict";

import { getAgentSkillHelp, getQuickStartAgentHelp, listHelpSections } from "../src/agent-skills.js";
import { CliError } from "../src/errors.js";

test("listHelpSections exposes ai-skills section", () => {
  const sections = listHelpSections();
  assert.ok(Array.isArray(sections));
  assert.ok(sections.some((section) => section.id === "quick-start-agent"));
  assert.ok(sections.some((section) => section.id === "ai-skills"));
});

test("getQuickStartAgentHelp returns summary by default", () => {
  const payload = getQuickStartAgentHelp();

  assert.equal(payload.section, "quick-start-agent");
  assert.equal(payload.view, "summary");
  assert.ok(Array.isArray(payload.steps));
  assert.ok(payload.steps.length >= 4);
  assert.ok(
    payload.steps.some(
      (row) => Array.isArray(row.commands) && row.commands.includes("outline-cli --version")
    )
  );
  assert.ok(
    payload.steps.some(
      (row) =>
        typeof row.question === "string" &&
        row.question.toLowerCase().includes("install the outline-cli skill")
    )
  );
  assert.ok(
    payload.steps.some(
      (row) =>
        Array.isArray(row.commandTemplates) &&
        row.commandTemplates.some(
          (cmd) => cmd.includes("npx skills add") && cmd.includes("--skill outline-cli -y") && !cmd.includes("--agent")
        )
    )
  );
  assert.ok(
    payload.steps.some(
      (row) =>
        typeof row.question === "string" &&
        row.question.toLowerCase().includes("base url")
    )
  );
  assert.equal(payload.nextCommand, "outline-cli tools help quick-start-agent --view full");
});

test("getQuickStartAgentHelp returns full payload and validates view", () => {
  const payload = getQuickStartAgentHelp({ view: "full" });
  assert.equal(payload.section, "quick-start-agent");
  assert.equal(payload.view, "full");
  assert.ok(Array.isArray(payload.steps));
  assert.ok(payload.steps.some((row) => row.command === "outline-cli profile list"));
  assert.ok(
    payload.steps.some(
      (row) =>
        row.command &&
        row.command.includes("--auth-type apiKey") &&
        row.command.includes("--api-key")
    )
  );
  assert.ok(
    payload.steps.some(
      (row) =>
        Array.isArray(row.commandTemplates) &&
        row.commandTemplates.includes(
          "npx skills add https://github.com/khanglvm/skills --skill outline-cli -y"
        ) &&
        Array.isArray(row.decisionRules) &&
        row.decisionRules.some((rule) => rule.toLowerCase().includes("explicitly approves"))
    )
  );
  assert.ok(
    payload.steps.some(
      (row) =>
        row.apiKeySettingsUrlTemplate === "<base-url>/settings/api-and-apps" &&
        Array.isArray(row.apiKeyConfigTemplate) &&
        row.apiKeyConfigTemplate.length >= 3
    )
  );
  assert.ok(
    payload.steps.some(
      (row) =>
        row.minimumPromptCount >= 10 &&
        Array.isArray(row.naturalLanguagePrompts) &&
        row.naturalLanguagePrompts.length >= 10
    )
  );
  assert.ok(Array.isArray(payload.interactionRules));

  assert.throws(
    () => getQuickStartAgentHelp({ view: "compact" }),
    (err) => {
      assert.ok(err instanceof CliError);
      assert.equal(err.details?.code, "QUICK_START_HELP_INVALID_VIEW");
      return true;
    }
  );
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
