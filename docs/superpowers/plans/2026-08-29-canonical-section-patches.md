# Canonical Section Patches Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace full-document BardWiki canonical rewrites with bounded section patches that preserve untouched Markdown and reduce model output tokens.

**Architecture:** The canonical model returns only changed H3 section bodies, identified by heading, plus an optional preamble patch. A deterministic server helper validates and applies those patches to the hash-checked existing document before the existing atomic save path runs; new documents are assembled from their returned sections. The semantic analysis call, revision history, source attribution, and conflict checks remain unchanged.

**Tech Stack:** TypeScript, Vitest, JSON Schema, Markdown

---

### Task 1: Define and validate the section-patch response

**Files:**
- Modify: `server/node/risubard-memory-writer.ts`
- Test: `server/node/risubard-memory-writer.test.ts`

- [ ] **Step 1: Write the failing parser test**

Add a test that parses a document shaped as `{ candidateIndex, sections: [{ heading, operation, content }] }`, rejects duplicate headings and rejects the legacy full-document `markdown` field.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-writer.test.ts`

Expected: FAIL because `canonicalBatchSchema` and `parseCanonicalBatch` still require `markdown`.

- [ ] **Step 3: Implement the minimal schema and parser**

Define `CanonicalSectionPatch` with `heading`, `operation: 'upsert' | 'delete'`, and `content`. Change `CanonicalBatch.documents` to contain `sections`; validate exact fields, bounded sizes, unique normalized headings, non-empty upserts, and empty deletes.

- [ ] **Step 4: Run the parser test**

Run the command from Step 2.

Expected: PASS.

### Task 2: Apply patches without regenerating untouched sections

**Files:**
- Create: `server/node/risubard-markdown-section-patch.ts`
- Create: `server/node/risubard-markdown-section-patch.test.ts`

- [ ] **Step 1: Write failing merge tests**

Cover replacing one existing H3 section while preserving another byte-for-byte, inserting a new section, deleting a section, patching the preamble with an empty heading, and assembling a new H2 document.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/risubard-markdown-section-patch.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement deterministic section merging**

Parse the H1/H2 title and H3 section boundaries, match headings with NFKC case-folding, and apply patches in order. Preserve every untouched segment; reject invalid source Markdown, duplicate source headings, missing delete targets, title-shaped content, and an empty resulting document.

- [ ] **Step 4: Run merge tests**

Run the command from Step 2.

Expected: PASS.

### Task 3: Use patches in canonical generation and saving

**Files:**
- Modify: `server/node/risubard-memory-analysis.ts`
- Modify: `server/node/risubard-memory-analysis.test.ts`
- Modify: `src/ts/risubard/memoryAnalysisClient.test.ts`

- [ ] **Step 1: Write the failing integration test**

Return only a `현재 상태` patch for an existing character containing both `현재 상태` and `정체성`. Assert the model prompt requests changed sections only and the saved Markdown contains the new state plus the untouched identity.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts`

Expected: FAIL because the runner still expects complete Markdown.

- [ ] **Step 3: Implement patch generation and merge**

Change the canonical system contract to omit unchanged sections, retain the existing target Markdown as read-only evidence, parse section patches, merge them deterministically, and pass only the merged document to the existing hash-checked save service. Keep one response per candidate and the existing retry/split behavior.

- [ ] **Step 4: Update existing canonical fixtures**

Convert canonical response fixtures to the section-patch schema while preserving their behavioral assertions. Assert the native client exposes the new schema fields.

- [ ] **Step 5: Run affected tests**

Run:

```text
pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-writer.test.ts server/node/risubard-markdown-section-patch.test.ts server/node/risubard-memory-analysis.test.ts
pnpm vitest run src/ts/risubard/memoryAnalysisClient.test.ts
```

Expected: PASS.

### Task 4: Update the canonical contract and verify the affected package

**Files:**
- Modify: `../project_wiki/markdown_narrative_wiki.md`
- Modify: `../project_wiki/context_pipeline_architecture.md`
- Modify: `docs/ko/memory-wiki.md`

- [ ] **Step 1: Document the section-patch contract**

State that existing canonical documents return only changed H3 sections, the program merges them against the content hash, untouched sections are never regenerated, new documents provide all initial sections, and detailed history remains in event documents.

- [ ] **Step 2: Run focused verification**

Run: `pnpm run verify:risubard-memory-wiki`

Expected: PASS.

- [ ] **Step 3: Run static checks and inspect the diff**

Run:

```text
pnpm run check
git diff --check
git status --short
```

Expected: zero test/check failures and no unrelated modified files.
