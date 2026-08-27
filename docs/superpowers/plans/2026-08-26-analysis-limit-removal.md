# BardWiki Analysis Limit Removal

**Goal:** Remove arbitrary raw-input and configurable-setting ceilings without changing defaults or disabling model-request budgets and storage integrity checks.

**Architecture:** Raw message validation checks structure, roles and stable IDs, not total characters or fixed message counts. User-selected finite integer budgets flow unchanged through settings, projection, analysis and canonical output; retrieval still selects bounded relevant context.

**Tech stack:** TypeScript, Svelte 5, Vitest.

## 1. Regression tests

- [x] Add server tests accepting context over 128,000 characters, confirmed text over 64,000 characters, and message arrays beyond the previous fixed counts. Verify inquiry still receives only the last 4,096 characters and the model-input adapter still respects the chosen token budget.
- [x] Update `src/ts/risubard/risuBardSettings.test.ts` to preserve 99,999-token settings, 99 searches/targets and message counts above 100, while retaining minimum/default validation and target ≤ maximum.
- [x] Update UI contract tests for global/current-chat settings without numeric `max` attributes, projection tests above 100, and canonical schema/parser tests above eight candidates.
- [x] Run the affected Vitest files and verify failure on the old limits before implementation.

## 2. Minimal implementation

- [x] Remove raw input size/count rejection from `server/node/risubard-memory-analysis.ts`, retaining nonempty dense arrays, unique IDs, valid roles and exact-key validation.
- [x] Remove hard numeric maxima from `src/ts/risubard/risuBardSettings.ts`, `narrativeContext.ts`, `memoryAnalysisClient.ts`, `RisuBardChatSettings.svelte`, and `RisuBardCurrentChatSettings.svelte`. Normalize only finite safe integer settings with the existing minimum/default values.
- [x] Remove the redundant structured-analysis output-size gate and canonical-output 32,768-token clamp. Preserve configured token fitting.
- [x] Allow more than eight canonical candidates in the model schema/parser while retaining candidate-index membership/uniqueness and the user-selected target budget.
- [x] Correct analysis-setting help text to describe its input-budget behavior.
- [x] Match persistence and HTTP validation to the new settings: preserve message counts after database reload, accept expanded inquiry budgets/source IDs, record every canonical change and warning, and remove retraction/additional-analysis source count ceilings.

## 3. Verification and handoff

- [x] Run frontend analysis, settings, projection, UI contract, wiki-client and database persistence tests: 97 passed across six files.
- [x] Run server analysis, writer, inquiry, HTTP routes, storage, runtime and wiki smoke tests: 150 passed across seven files.
- [x] Verify real storage with 13 source IDs, 10 canonical changes and 40 warnings; reload and undo every document. Verify 101-source retraction and 65 excluded canonical IDs.
- [x] Compile both modified Svelte settings components and run `git diff --check` successfully.
- [x] Review the diff and correct the integration gaps identified in review.
- [ ] Update official wiki numeric-range descriptions after separate review approval. The attempted official documentation edit was denied; no official wiki files were changed and no alternate write was attempted.
- [x] Preserve the pre-existing `patchnote/0.8.12.md` edit. No commit, push, private-version change or worktree creation.

Unchanged boundaries: user-selected request budgets and defaults, actual model context/output limits, retrieval query/top-k selection, concise per-document writing policy, HTTP payload protections, and schema/provenance/path/hash validation. Retired graph and fixed reboot-batch contracts are outside this change.
