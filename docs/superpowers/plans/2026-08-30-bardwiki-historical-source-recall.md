# BardWiki Historical Source Recall Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Recover small, old narrative details from the original chat without embeddings or an auxiliary model call, while keeping the existing inquiry token budget fixed.

**Architecture:** The browser scans already-loaded historical messages with bounded sparse scoring and sends at most eight compact matches to the local inquiry endpoint. The server combines those matches with Markdown wiki candidates, boosts messages routed by selected linked event documents, and admits at most two source excerpts inside the existing inquiry token budget. Existing character history and event links provide the coarse arc map; direct source matches remain available so the map cannot become a hard failure gate.

**Tech Stack:** TypeScript, Svelte application runtime, Node local server, Vitest, cl100k token counting

---

### Task 1: Bounded historical-message matching

**Files:**
- Create: `src/ts/risubard/historicalSourceRecall.ts`
- Create: `src/ts/risubard/historicalSourceRecall.test.ts`

- [ ] **Step 1: Write the failing long-chat recall test**

Create 1,000 synthetic turns, place `플러피풋의 사과 에일` in an early assistant response, and assert that a query about the last ale before leaving the Shire returns that message while excluding the current/recent window.

- [ ] **Step 2: Run the focused test and confirm it fails because the matcher is missing**

Run: `pnpm vitest run src/ts/risubard/historicalSourceRecall.test.ts`

- [ ] **Step 3: Implement the bounded matcher**

Implement `findHistoricalSourceMatches({ currentInput, messages, excludeRecentMessages })` with normalized sparse terms, document-frequency weighting, a maximum of eight matches, and excerpts capped at 1,200 characters. Ignore disabled, comment, ID-less, current, and recent messages.

- [ ] **Step 4: Run the focused test and confirm it passes**

Run: `pnpm vitest run src/ts/risubard/historicalSourceRecall.test.ts`

### Task 2: Merge source evidence into Markdown inquiry

**Files:**
- Modify: `server/node/risubard-markdown-inquiry.test.ts`
- Modify: `server/node/risubard-markdown-inquiry.ts`
- Modify: `server/node/risubard-markdown-wiki.ts`
- Modify: `server/node/risubard-memory-routes.test.ts`
- Modify: `server/node/risubard-memory-routes.cjs`

- [ ] **Step 1: Write failing inquiry and route tests**

Assert that an old source match is returned as `narrative-memory:source:*`, that a linked event whose `sourceMessageIds` contains the old message boosts it over an unrelated match, and that malformed or oversized source matches are rejected.

- [ ] **Step 2: Run the focused server tests and confirm the new assertions fail**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/risubard-markdown-inquiry.test.ts server/node/risubard-memory-routes.test.ts`

- [ ] **Step 3: Implement bounded source-candidate admission**

Accept at most eight validated matches. During historical/detail inquiry, rank them by sparse score plus a boost from candidate documents' `sourceMessageIds`, admit at most two, label them as original historical evidence, and count them inside the existing target/maximum token and twelve-source limits.

- [ ] **Step 4: Run the focused server tests and confirm they pass**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/risubard-markdown-inquiry.test.ts server/node/risubard-memory-routes.test.ts`

### Task 3: Wire loaded chat history into inquiry

**Files:**
- Modify: `src/ts/risubard/narrativeContext.test.ts`
- Modify: `src/ts/risubard/narrativeContext.ts`
- Modify: `src/ts/process/index.svelte.ts`

- [ ] **Step 1: Write a failing transport test**

Assert that `loadNarrativeInquiry` sends no more than eight bounded `sourceMatches` and preserves message ID, role, excerpt, score, and original order.

- [ ] **Step 2: Run the client tests and confirm the request assertion fails**

Run: `pnpm vitest run src/ts/risubard/narrativeContext.test.ts src/ts/risubard/historicalSourceRecall.test.ts`

- [ ] **Step 3: Implement transport and generation-path wiring**

Compute matches from the already-loaded chat before the local inquiry request, exclude the configured recent-message window, pass matches through the strict endpoint, and update the evidence rules so original excerpts outrank summaries for exact historical details.

- [ ] **Step 4: Run focused client and server verification**

Run: `pnpm vitest run src/ts/risubard/narrativeContext.test.ts src/ts/risubard/historicalSourceRecall.test.ts`

Run: `pnpm vitest run --config vitest.config.server.ts server/node/risubard-markdown-inquiry.test.ts server/node/risubard-memory-routes.test.ts`

### Task 4: Record the retrieval contract

**Files:**
- Modify: `../project_wiki/inquiry_context_compiler.md`
- Modify: `../project_wiki/context_pipeline_architecture.md`

- [ ] **Step 1: Document the source-recall lane**

Specify that original-message scanning is programmatic, bounded, body-free in logs, uses no embeddings or auxiliary LLM, treats arc/event routing as a boost rather than a gate, and injects only selected excerpts under the existing token budget.

- [ ] **Step 2: Verify changed files and targeted checks**

Run: `git diff --check`

Run the focused client and server commands from Task 3 once more after all edits.
