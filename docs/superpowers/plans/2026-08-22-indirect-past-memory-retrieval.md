# Indirect Past Memory Retrieval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retrieve the older stone-door puzzle together with the newer skull sphere for an indirect Korean recollection query, without selecting unrelated linked events.

**Architecture:** Keep the bounded Markdown sparse inquiry and zero auxiliary-model-call contract. Normalize a small set of Korean suffixes, treat exact character-title terms as traversal anchors instead of relevance evidence in every linked document, merge direct and link evidence for the same candidate, and reserve historical events before the 12-document cutoff.

**Tech Stack:** TypeScript, Vitest, Markdown Memory Wiki, `@dqbd/tiktoken`

---

### Task 1: Reproduce the Liria retrieval failure

**Files:**
- Modify: `server/node/risubard-markdown-inquiry.test.ts`

- [x] **Step 1: Add the failing regression test**

Create a character document linked to the old stone-door puzzle, the newer skull sphere event, and newer unrelated events. Use the original input `리리아는 전날 탈출하려다 발견했던 숨겨진 문과, 그 주변에 있던 문양들을 떠올리고, 구체를 들고 그리로 향한다.` and assert that both the puzzle and sphere event are selected while the token and document bounds remain intact.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```bash
npx vitest run --config vitest.config.server.ts server/node/risubard-markdown-inquiry.test.ts -t "retrieves an indirectly recalled old puzzle"
```

Expected: FAIL because the old puzzle source is absent.

### Task 2: Correct sparse candidate scoring and selection

**Files:**
- Modify: `server/node/risubard-markdown-inquiry.ts`
- Test: `server/node/risubard-markdown-inquiry.test.ts`

- [x] **Step 1: Add bounded Korean term normalization**

Normalize common Korean particles and the observed recollection endings so `구체를`, `문양들을`, `발견했던`, and `탈출하려다` produce the stable terms `구체`, `문양`, `발견`, and `탈출`. Keep the existing 32-term cap and do not add a dependency.

- [x] **Step 2: Separate character anchors from document relevance**

When a normalized query term exactly names a character document, retain its title match so the character is a direct seed, but do not award that term's body/link score to every event mentioning or linking the character.

- [x] **Step 3: Merge direct and graph evidence**

When link traversal reaches an existing direct candidate, retain the shortest hop and raise its link score instead of skipping it. This allows a weakly matched linked puzzle to outrank unrelated link-only events.

- [x] **Step 4: Reserve historical events before the document cutoff**

Recognize `전날`, `어제`, `지난`, `그때`, `앞서`, `전에`, and recollection wording. Prepare the bounded candidate pool before reservation, enforce the 12-document limit in `addOptionalIfFits`, and then fill remaining slots in score order.

- [x] **Step 5: Run the focused test and verify GREEN**

Run:

```bash
npx vitest run --config vitest.config.server.ts server/node/risubard-markdown-inquiry.test.ts -t "retrieves an indirectly recalled old puzzle"
```

Expected: PASS with both puzzle and sphere sources selected.

### Task 3: Verify the bounded inquiry contract

**Files:**
- Verify: `server/node/risubard-markdown-inquiry.test.ts`

- [x] **Step 1: Run the complete server inquiry suite**

Run:

```bash
npx vitest run --config vitest.config.server.ts server/node/risubard-markdown-inquiry.test.ts
```

Expected: all tests pass, selected documents remain at most 12, selected tokens stay within the configured budget, and auxiliary model calls remain zero.

- [x] **Step 2: Check the patch**

Run:

```bash
git diff --check
git status --short
```

Expected: no whitespace errors and only the planned inquiry, test, and plan files are changed.
