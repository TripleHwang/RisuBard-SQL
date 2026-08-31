# Story Arc Plot Tab Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated read-only `아크 플롯` view to BardWiki that projects the reserved Story Arc Plot document, reports checkpoint progress before creation, and opens the canonical document in the existing workspace editor.

**Architecture:** Keep the Markdown document under `notes/` as the only canonical data. A pure client helper resolves Korean, English, and legacy plot titles, calculates confirmed-event progress from the checkpoint marker, and extracts wiki links. A focused Svelte view renders that model; `RisuBardMemoryWiki` only owns tab navigation and editor handoff.

**Tech Stack:** TypeScript, Svelte 5, markdown-it, Vitest, Testing Library DOM events.

---

### Task 1: Story arc view model

**Files:**
- Create: `src/ts/risubard/storyArcView.ts`
- Create: `src/ts/risubard/storyArcView.test.ts`

- [ ] **Step 1: Write the failing view-model tests**

Cover these real inputs:

```ts
expect(buildStoryArcView(documents, 8)).toMatchObject({
  document: undefined,
  pendingEventCount: 3,
  remainingEventCount: 5,
})
expect(findStoryArcDocument(legacyDocuments)?.title).toBe('스토리 아크 지도')
expect(extractStoryArcLinks('[[출발]] · [[귀환|마지막 귀환]]'))
  .toEqual([{ target: '출발', label: '출발' }, { target: '귀환', label: '마지막 귀환' }])
```

- [ ] **Step 2: Run the test and verify RED**

Run: `npx vitest run src/ts/risubard/storyArcView.test.ts`

Expected: FAIL because `storyArcView.ts` does not exist.

- [ ] **Step 3: Implement the pure helper**

Export `findStoryArcDocument`, `extractStoryArcLinks`, `storyArcDisplayMarkdown`, and `buildStoryArcView`. Recognize `스토리 아크 플롯`, `Story Arc Plot`, `스토리 아크 지도`, and `Story Arc Map`; count only active event documents; use the last `risubard-story-arc-checkpoint` marker when a plot already exists; never mutate documents.

- [ ] **Step 4: Run the test and verify GREEN**

Run: `npx vitest run src/ts/risubard/storyArcView.test.ts`

Expected: all view-model tests pass.

### Task 2: Dedicated BardWiki tab

**Files:**
- Create: `src/lib/Others/RisuBardStoryArcPlot.svelte`
- Modify: `src/lib/Others/RisuBardMemoryWiki.svelte`
- Modify: `src/lib/Others/RisuBardMemoryWiki.test.ts`

- [ ] **Step 1: Write failing integration tests**

Add assertions that Markdown BardWiki exposes `[data-memory-view="arc-plot"]` between story and log, displays `확정 사건 3/8개` when the document does not yet exist, renders a resolved plot and its event links, and returns to the workspace with that canonical document selected when `작업 공간에서 편집` is pressed.

- [ ] **Step 2: Run the integration test and verify RED**

Run: `npx vitest run src/lib/Others/RisuBardMemoryWiki.test.ts`

Expected: FAIL because the arc-plot tab and view are absent.

- [ ] **Step 3: Implement the read-only view**

Create `RisuBardStoryArcPlot.svelte` with:

```svelte
<section data-story-arc-plot aria-label="아크 플롯">
  <!-- header, enabled/checkpoint status, empty state or safe markdown preview -->
  <!-- resolved [[event]] links and a workspace edit button -->
</section>
```

Use `markdown-it({ html: false, linkify: false })`, existing `--risu-theme-*` tokens, a restrained editorial hierarchy matching `지금까지의 이야기`, and responsive wrapping. Do not save or rewrite Markdown in this component.

- [ ] **Step 4: Integrate the tab**

Extend `activeView` to `'workspace' | 'story' | 'arc-plot' | 'log'`, render the new button between story and log, pass normalized global Archplotter settings, and use the existing editor selection path for `onEdit`.

- [ ] **Step 5: Run integration and helper tests and verify GREEN**

Run: `npx vitest run src/ts/risubard/storyArcView.test.ts src/lib/Others/RisuBardMemoryWiki.test.ts`

Expected: all tests pass.

### Task 3: Focused verification

**Files:**
- Verify all files from Tasks 1 and 2.

- [ ] **Step 1: Run Svelte diagnostics**

Run: `npm run check`

Expected: 0 errors and 0 warnings.

- [ ] **Step 2: Run theme and affected UI tests**

Run: `npx vitest run src/ts/risubard/storyArcView.test.ts src/lib/Others/RisuBardMemoryWiki.test.ts src/lib/UI/GUI/ThemeTokenContract.test.ts`

Expected: all tests pass.

- [ ] **Step 3: Inspect the final diff**

Run: `git diff --check -- <changed files>` and verify the tab does not create new storage, alter writer schemas, or change the canonical document path.

## Self-review

- Spec coverage: dedicated tab, pre-generation progress, read-only plot, event links, editor handoff, disabled state, and no duplicate storage are covered.
- Placeholder scan: no implementation placeholders or unspecified error-handling steps remain.
- Type consistency: the view model consumes `NarrativeMemoryWikiMarkdown['documents']`; the Svelte component and parent use the same document IDs and existing editor selection callback.
- Execution choice: the user explicitly requested immediate implementation, so this plan will be executed inline in the current checkout. No commit is included because the checkout already contains user changes and no commit was requested.
