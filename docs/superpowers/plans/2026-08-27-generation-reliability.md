# Generation Reliability Implementation Plan

> **For agentic workers:** Use subagent-driven-development for the isolated adapter task, then review specification and code quality. Execute integrated response recovery in this session. Do not create a worktree, commit, push, or modify user data.

**Goal:** Make chat and BardWiki requests respect their controls, distinguish unusable model output, and recover within bounded cost without saving incomplete data.

**Architecture:** Keep the existing provider adapters and storage validation. Carry provider completion metadata through the non-streaming request boundary. Use one shared, provider-neutral response classifier and bounded structured-call recovery; retain strict semantic validation and existing snapshot/hash protection. Never replay tools or an entire partially applied write workflow.

**Tech Stack:** TypeScript, Svelte, Vitest; existing provider adapters and Markdown wiki runner.

## Task 1 — Authoritative request controls

Files: `src/ts/preset/adapter/openaiCompatible.ts`, `anthropicMessages.ts`, their tests, and a focused helper only if needed.

- [x] Add failing wire-body tests: `temperature: 0`, `maxOutputTokens: 12000` override preset values on structured requests; ordinary requests remain unchanged.
- [x] Map output limits to the appropriate provider field (`max_tokens` / `max_completion_tokens`), avoiding conflicting fields. Respect model-specific sampling restrictions and Anthropic thinking requirements.
- [x] Run affected adapter tests before and after implementation, then all adapter suites together.
- [x] Review specification, then code quality.

## Task 2 — Response quality and metadata

Files: `packages/risubard-core/src/modelOutput.ts`, its tests; `src/ts/process/request/request.ts`; new focused response-result helper/test if necessary.

- [x] Reproduce empty/reasoning-only results and provider `length` / `max_tokens` termination with tests.
- [x] Preserve finish reason and token usage for internal callers. Keep reasoning out of structured result text while retaining normal chat display.
- [x] Reject incomplete structured output even when a JSON prefix can be parsed; retain ambiguity and semantic validation. Use typed, content-free diagnostics.
- [x] Verify ordinary text/tool results are not silently discarded or replayed.

## Task 3 — Bounded wiki recovery

Files: `src/ts/risubard/memoryAnalysisClient.ts`, `directWikiCommand.ts`, `markdownWikiWriter.ts`, related tests; shared `packages/risubard-core/src/modelResponse.ts`; the existing runner's canonical batch path.

- [x] Add failing tests for a bad first result followed by a valid result, persistently malformed output, known truncation, and cancellation/auth failures.
- [x] Share recovery for analysis/admin calls: validate before writes; at most one repair attempt, same settings/IDs, no unbounded budget growth, no retry on auth/cancellation/refusal.
- [x] Send the schema and specific formatting feedback on repair. Do not send model reasoning or log story content/credentials.
- [x] Split an oversized/failed multi-document canonical rewrite into bounded per-document requests when safe; never apply an incomplete batch or repeat already applied writes.
- [x] Preserve existing documents when generation fails; retain confirmed events and record warnings for partial canonical-update failures.

## Task 4 — Streaming termination and verification

Files: `src/ts/process/request/presetStreamPump.ts`, provider stream parsers and focused tests only where a reproducible failure is found.

- [x] Audit empty stream, reasoning-only stream, transport failure and completion signalling; add regression tests for confirmed failures before modifying production code.
- [x] Retain partial visible chat output on failures, release readers/timers and report failure once. Never automatically replay a stream after text/tools have been emitted.
- [x] Run all affected adapter/client/core/runner suites and relevant server tests, inspect `git diff --check`, and review integrated changes.
- [x] Document verified coverage and live-provider limitations; do not claim that remote models can never fail.

## Verification and limits

- Final affected suites: 599 frontend/core/adapter tests and 75 server tests passed (674 total). The frontend run printed a localhost:3000 connection warning but exited successfully with no failing tests. Scoped diff check passed.
- Red/green regressions include refusal metadata, missing batch targets, nested retry limits, non-replayable results, and a real slow-consumer `ReadableStream` failure.
- Integrated code review completed; reported gaps were reproduced and fixed.
- Scoped TypeScript syntactic/semantic diagnostics: zero across changed production code and loaded tests. Full `tsc --noEmit` remains blocked by the unchanged `src/ts/plugins/apiV3/risuai.d.ts:1716` comment syntax and cascading errors.
- No live/paid provider requests, release build, deployment, commit, or push. Remote provider reliability is not guaranteed.
