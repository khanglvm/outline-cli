# Changelog

## 0.1.2 - 2026-03-06

- Changes since `v0.1.1`.
- docs(readme): remove redundant quick-start copy prompt (28ab2cd)
- feat(help): add quick-start-agent onboarding section (1d21814)
- docs(readme): rewrite quick start as AI agent instructions (2b3065b)
- docs(readme): remove duplicated intro wording (88eddcf)
- docs: remove tracked docs directory and refine README intro (7235f95)
- docs(readme): prioritize global install usage (052c31b)

## 0.1.1 - 2026-03-05

- Initial tagged release notes.
- feat(help): add ai skill guidance section for scenario workflows (81a6368)
- feat(uc19): add compliance oauth tests and docs (b97ab28)
- feat(uc19): add oauth client and auth wrappers (c1c31f8)
- feat(uc14): add permanent delete docs and tests (c336bb8)
- feat(uc14): add permanent delete wrapper (fa99d2e)
- feat(uc09): add apply_patch_safe tests and docs (41078ae)
- feat(uc09): add apply_patch_safe wrapper (bc87f7e)
- feat(uc07): add issue ref helper tests and docs (3254bf5)
- feat(uc07): add issue reference helper tools (ccf09bc)
- feat(uc13): add workspace automation tests and docs (75776b4)
- feat(uc13): add user lifecycle automation wrappers (877adbe)
- feat(uc12): add migration scenario tests and docs (db33d85)
- feat(uc12): add import and file operation primitives (25316c5)
- feat(uc11): add template pipeline tests and docs (c3b126d)
- feat(uc11): add placeholder pipeline tools (e5fe193)
- feat(uc10): add graph scenario tests and docs (e2f497a)
- feat(uc10): add graph traversal helpers (33432d9)
- feat(uc09): add rollback-safety scenario tests and docs (7bc947c)
- feat(uc09): add revisions diff helper (d94511e)
- feat(uc07): add issue-link scenario tests and docs (508281f)
- feat(uc07): add data-attribute wrappers and schema alignment (cec94ce)
- feat(uc06): add role-visibility scenario tests and docs (9f2b2ae)
- feat(uc06): harden role and membership contracts (76d33d7)
- feat(uc05): add sharing scenario tests and docs (fbc35a2)
- feat(uc05): harden share lifecycle contracts (6f594f0)
- feat(uc04): add internal-faq scenario coverage and docs (7cbb697)
- feat(uc03): add meeting-notes scenario coverage and docs (4f4fb0f)
- chore: checkpoint local outline-cli changes (9e75cd9)
- fix(validation): validate expectedRevision in documents.apply_patch (e51fb8b)
- test(schema): add coverage for federated and terminology tools (b925c48)
- feat(workflows): add federated and terminology composite tools (5b3fa36)
- test(schema): cover new scenario wrappers and safety rules (35401fb)
- feat(tools): add scenario-critical wrappers and safety hardening (d4d9fac)
- docs(usecases): improve UC-20 issue traceability (111f4fd)
- docs(usecases): improve UC-19 issue traceability (7dc1278)
- docs(usecases): improve UC-18 issue traceability (8d594f4)
- docs(usecases): improve UC-17 issue traceability (2da81d5)
- docs(usecases): improve UC-16 issue traceability (df28cb2)
- docs(usecases): improve UC-15 issue traceability (d831dac)
- docs(usecases): improve UC-14 issue traceability (9947f95)
- docs(usecases): improve UC-13 issue traceability (ecd07c7)
- docs(usecases): improve UC-12 issue traceability (7d3dfdc)
- docs(usecases): improve UC-11 issue traceability (1155797)
- docs(usecases): improve UC-10 issue traceability (8770670)
- docs(usecases): improve UC-09 issue traceability (01733dd)
- docs(usecases): improve UC-08 issue traceability (11b7892)
- docs(usecases): improve UC-07 issue traceability (66fd433)
- docs(usecases): improve UC-06 issue traceability (f769da8)
- docs(usecases): improve UC-05 issue traceability (0dc78b5)
- docs(usecases): improve UC-04 issue traceability (d8afaf4)
- docs(usecases): improve UC-03 issue traceability (b8ac03e)
- docs(usecases): improve UC-02 issue traceability (6305567)
- docs(usecases): improve UC-01 issue traceability (e3b3459)
- docs(usecases): add index for UC scenario artifacts (32ce730)
- docs(usecases): add UC-20 secure lifecycle governance improvement (3a5abe0)
- docs(usecases): add UC-19 compliance access auditability improvement (39a6843)
- docs(usecases): add UC-18 terminology refactor improvement (64e4df1)
- docs(usecases): add UC-17 editorial review lifecycle improvement (692cefa)
- docs(usecases): add UC-16 federated search sync improvement (b3bad9a)
- docs(usecases): add UC-15 ai semantic qa improvement (6cd384e)
- docs(usecases): add UC-14 webhook workflow improvement (9cadbea)
- docs(usecases): add UC-13 api driven workspace automation improvement (c80a6a9)
- docs(usecases): add UC-12 legacy wiki migration improvement (6c00a56)
- docs(usecases): add UC-11 template driven doc pipeline improvement (39a492b)
- docs(usecases): add UC-10 crosslinked knowledge graph improvement (4a90748)
- docs(usecases): add UC-09 postmortem rca rollback safety improvement (d6a02dd)
- docs(usecases): add UC-08 runbooks incident playbooks improvement (48df335)
- docs(usecases): add UC-07 project docs issue linkage improvement (c7804bb)
- docs(usecases): add UC-06 role based department spaces improvement (f3f14fe)
- docs(usecases): add UC-05 public docs sharing improvement (5f56b43)
- docs(usecases): add UC-04 internal faq knowledge base improvement (1d3c1c9)
- docs(usecases): add UC-03 meeting notes decision logs improvement (9a115d3)
- docs(usecases): add UC-02 sop policy wiki improvement (f34462e)
- docs(usecases): add UC-01 handbook onboarding improvement (1d41ab0)
- wip (5dae3ea)

All notable changes to this project are documented in this file.

The format follows Keep a Changelog principles and this project uses Semantic Versioning.

## Unreleased

### Changed

- Improved top-level documentation with a user-focused quickstart and clearer operational guidance.

### Added

- Added a compact AI-agent instruction section in `README.md` for deterministic low-token workflows.

## 0.1.0 - 2026-03-05

### Added

- Initial release baseline for `@khanglvm/outline-cli`.
- Agent-optimized Outline CLI with deterministic JSON/NDJSON outputs, profile management, and batch invocation.
- Mutation safety gates (`performAction`) and safe delete flow with read-token confirmation.
