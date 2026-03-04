# UC-15: AI semantic Q&A with permission-aware answers

## Scenario
- use_case_id: UC-15
- name: AI semantic Q&A over workspace knowledge with permission-aware answers
- primary_goal: Return direct, citation-backed answers from workspace knowledge while strictly respecting each caller's access scope.
- typical_actors: support lead, IT/helpdesk operator, compliance owner, team lead, AI automation agent.
- core_workflow:
  1. A user asks a natural-language question (CLI/agent/chat workflow).
  2. The system performs semantic retrieval across permitted workspace content.
  3. The system returns an answer plus source citations and machine-readable answer metadata.
  4. If no safe answer is available, the response explicitly reports no-answer/limited-access conditions.
  5. Operators iterate with narrowed filters (`collectionId`, `documentId`) or expand retrieval for follow-up.

## Why this is real (source links)
- Outline documents native "Search & AI answers" that generate direct answers from workspace knowledge and surface them in search and Slack.
  - source: https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06
- The same Outline doc explicitly states answers are restricted to what the current user can access, which is the core permission-aware requirement for enterprise Q&A.
  - source: https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06
- Outline also documents answer references/citations to source documents, matching auditability requirements for internal Q&A.
  - source: https://docs.getoutline.com/s/guide/doc/search-ai-answers-NIKPvYrx06
- Outline's OpenAI integration doc describes the implementation pattern this use case needs: semantic indexing + related-document retrieval + answer generation.
  - source: https://docs.getoutline.com/s/hosting/doc/openai-iiTYCN9Nct
- The OpenAI integration doc repeats the access-control boundary for AI answers and calls out operational limits (indexing latency, attachment-content not yet indexed).
  - source: https://docs.getoutline.com/s/hosting/doc/openai-iiTYCN9Nct

## Current support in outline-agent
- Retrieval foundations already exist:
  - `documents.search` supports `mode: 'semantic'|'titles'`, multi-query batching, and compact `ids|summary|full` views.
  - `search.expand` and `search.research` provide evidence expansion/merge and follow-up cursors for iterative Q&A loops.
- Permission/context signals are partly available:
  - `includePolicies` is supported on search/info/list tools and can expose policy payloads when needed.
  - repository note: Outline API permissions are enforced server-side and not bypassed by the CLI.
- Raw endpoint fallback exists:
  - `api.call` can invoke uncovered methods, including `documents.answerQuestion` exposed by Outline OpenAPI.
  - source: https://github.com/outline/openapi/blob/main/spec3.json
- Live suite already validates search-centric behavior (`documents.search`, `search.expand`, `search.research`) for the retrieval half of semantic Q&A.

## Current limits/gaps in this repo
- G1: No first-class AI-answer wrapper.
  - There is no dedicated `documents.answer*` tool contract even though Outline exposes `documents.answerQuestion`.
- G2: No deterministic permission-aware answer envelope.
  - Current tools provide retrieval rows, but not a stable `answer + citations + no_answer_reason + permission_scope` structure for agent orchestration.
- G3: No batch Q&A wrapper.
  - Multi-question support/helpdesk workloads require manual loops instead of one bounded tool call with per-item isolation.
- G4: Permission-awareness is implicit, not surfaced.
  - The repo depends on server-side permission filtering but does not normalize explicit answer-state signals (e.g., `no_answer_possible_due_to_access`) for automation.
- G5: No live tests for native AI-answer path.
  - `test/live.integration.test.js` covers search/research flows but not `documents.answerQuestion` response handling.
- G6: No docs playbook for semantic Q&A + permission troubleshooting.
  - `README.md` and `docs/TOOL_CONTRACTS.md` do not define an end-to-end answer workflow contract.

## Improvement proposal (specific wrappers/schema/tests/docs)
- P1: Add first-class answer wrappers in navigation tools.
  - `documents.answer(args: { question: string; collectionId?: string; documentId?: string; userId?: string; statusFilter?: string|string[]; dateFilter?: 'day'|'week'|'month'|'year'; view?: 'summary'|'full'; includePolicies?: boolean; includeEvidenceDocs?: boolean; maxAttempts?: number; })`
  - behavior: map `question -> query` for `documents.answerQuestion`, return deterministic fields:
    - `question`, `answer`, `citations[]`, `documents[]`, `answerState` (`answered|no_answer`), `noAnswerReason` (`not_found|possibly_restricted|not_indexed|unknown`).
- P2: Add bounded batch wrapper for operational Q&A.
  - `documents.answer_batch(args: { questions: string[]; collectionId?: string; documentId?: string; userId?: string; statusFilter?: string|string[]; dateFilter?: 'day'|'week'|'month'|'year'; view?: 'summary'|'full'; includePolicies?: boolean; includeEvidenceDocs?: boolean; concurrency?: number; maxAttempts?: number; })`
  - behavior: dedupe questions, cap batch size/concurrency, return per-item deterministic envelopes with partial-failure isolation.
- P3: Add strict arg schemas in `src/tool-arg-schemas.js`.
  - require non-empty `question` / non-empty `questions[]`.
  - enforce `view` enum and numeric bounds (`concurrency >= 1`, max batch size guard).
  - enforce filter types and reject unknown args for contract stability.
- P4: Add live integration tests in `test/live.integration.test.js`.
  - happy path: ask a question expected to retrieve an indexed, accessible test fixture and assert deterministic answer envelope keys.
  - no-answer path: ask nonsense query and assert explicit `answerState=no_answer` with populated `noAnswerReason`.
  - batch path: assert per-item isolation (`ok/error` per question) and stable schema.
  - permission-aware path (guarded by env with two profiles): compare answers from broader-vs-restricted profile and assert restricted profile does not expose disallowed evidence.
- P5: Update docs and contracts.
  - `docs/TOOL_CONTRACTS.md`: add `documents.answer` and `documents.answer_batch` signatures/examples + response envelope fields.
  - `README.md`: add semantic Q&A playbook (`ids/summary-first`, answer call, no-answer fallback, permission diagnosis using `includePolicies`).
  - keep this UC-15 as scenario reference for permission-aware AI-answer implementation.

## Issue resolution matrix
| Issue | Risk if unaddressed | Proposed remediation | Verification step |
| --- | --- | --- | --- |
| G1: No first-class AI-answer wrapper. | Agents must rely on raw `api.call`, increasing contract drift risk and reducing deterministic orchestration. | Implement `documents.answer` as a first-class wrapper over `documents.answerQuestion` with stable response shaping. | Run live test for `documents.answer` happy path and assert stable top-level keys (`question`, `answer`, `citations`, `answerState`). |
| G2: No deterministic permission-aware answer envelope. | Downstream automation cannot reliably branch on no-answer vs answered states or audit citation payloads. | Standardize envelope fields (`answer`, `citations`, `documents`, `answerState`, `noAnswerReason`, optional permission context). | Add schema assertions in live tests for both answered and no-answer flows; confirm required fields always exist. |
| G3: No batch Q&A wrapper. | Helpdesk/support workloads pay extra round trips and have fragile manual loop/error handling. | Add `documents.answer_batch` with bounded concurrency, dedupe, and per-item isolation. | Execute batch test with mixed questions and verify per-item status plus partial-failure isolation. |
| G4: Permission-awareness is implicit, not surfaced. | Automation may misclassify restricted-access outcomes as retrieval failures and leak incorrect diagnostics. | Normalize explicit answer-state signals, including restricted/uncertain no-answer reasons tied to access constraints. | In guarded multi-profile test, compare broader vs restricted outputs and confirm restricted result does not expose disallowed evidence and returns explicit no-answer signaling when applicable. |
| G5: No live tests for native AI-answer path. | Regressions in wrapper behavior or response shaping can ship unnoticed. | Extend `test/live.integration.test.js` with native answer-path coverage (happy, no-answer, batch, permission-delta). | Run `npm test` and confirm all new AI-answer subtests pass in live environment. |
| G6: No docs playbook for semantic Q&A + permission troubleshooting. | Operators and agent builders apply inconsistent patterns and cannot diagnose permission/indexing gaps quickly. | Update `README.md` and `docs/TOOL_CONTRACTS.md` with an end-to-end Q&A workflow and troubleshooting guidance. | Validate docs include wrapper signatures, envelope fields, and a permission troubleshooting flow aligned with tool contracts. |

## Process checklist
1. Validate expected behavior against Outline Search/AI Answers and OpenAI integration docs before coding.
2. Confirm raw endpoint contract for `documents.answerQuestion` against Outline OpenAPI.
3. Implement `documents.answer` and `documents.answer_batch` wrappers in navigation/tool registry.
4. Add/validate arg schemas for all new wrapper args in `src/tool-arg-schemas.js`.
5. Implement deterministic response shaping including `answerState` and `noAnswerReason`.
6. Add live integration subtests (happy path, no-answer, batch, guarded permission-delta profile test).
7. Run `npm run check` and `npm test`.
8. Update `docs/TOOL_CONTRACTS.md` and `README.md` to match final contracts.
