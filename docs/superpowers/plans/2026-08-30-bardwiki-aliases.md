# BardWiki Aliases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store alternative entity names on one BardWiki document and use them consistently for editing, retrieval, linking, automatic updates, and BARDCHAT combination.

**Architecture:** Add the Obsidian-standard `aliases` YAML list to each Markdown document, defaulting legacy files to an empty list. Treat title and aliases as identity keys but resolve only unique keys. Carry aliases through browser/server mutation APIs, expose them in the editor, let automatic analysis propose evidence-backed aliases, and make COMBINE inherit redundant document titles and aliases into the survivor.

**Tech Stack:** TypeScript, Svelte 5, Node filesystem Markdown storage, Vitest, Obsidian YAML frontmatter.

---

### Task 1: Markdown alias storage and mutation API

**Files:**
- Modify: `server/node/risubard-markdown-wiki.test.ts`
- Modify: `server/node/risubard-markdown-wiki.ts`
- Modify: `server/node/risubard-memory-routes.test.ts`
- Modify: `server/node/risubard-memory-routes.cjs`
- Modify: `src/ts/risubard/memoryWiki.test.ts`
- Modify: `src/ts/risubard/memoryWiki.ts`

- [ ] Add failing tests for `aliases` frontmatter round-trip, legacy empty aliases, normalization/deduplication, manual-save route validation, and browser request payload.
- [ ] Run the focused tests and verify the failures are caused by missing alias support.
- [ ] Add `aliases: string[]` to document types; serialize/parse the YAML list; validate at most 32 unique 1–160 character aliases; preserve aliases when omitted and add an old title on rename.
- [ ] Carry aliases through canonical/manual save routes and the browser client.
- [ ] Re-run the focused tests and verify they pass.

### Task 2: Alias-aware inquiry and link resolution

**Files:**
- Modify: `server/node/risubard-markdown-inquiry.test.ts`
- Modify: `server/node/risubard-markdown-inquiry.ts`
- Modify: `server/node/risubard-markdown-wiki.test.ts`
- Modify: `server/node/risubard-markdown-wiki.ts`

- [ ] Add failing tests that an alias retrieves its single document, an alias wikilink resolves to that document, and a colliding alias does not choose either target.
- [ ] Run the tests and verify the expected failures.
- [ ] Include aliases in normalized keys, lexical scoring, term weights, character anchors, generated related links, and health resolution; build target maps from unique keys only.
- [ ] Re-run inquiry and storage tests.

### Task 3: Automatic identity resolution

**Files:**
- Modify: `src/ts/risubard/automaticWikiUpdate.ts`
- Modify: `server/node/risubard-memory-writer.test.ts`
- Modify: `server/node/risubard-memory-writer.ts`
- Modify: `src/ts/risubard/skills/bardwiki-memory-writer/SKILL.md`
- Modify: `src/ts/risubard/skills/bardwiki-memory-writer/references/event-schema.md`
- Modify: `src/ts/risubard/skills/bardwiki-memory-writer/references/english-contract.md`
- Modify: `server/node/risubard-memory-analysis.test.ts`
- Modify: `server/node/risubard-memory-analysis.ts`

- [ ] Add failing tests for optional candidate aliases, alias metadata in existing notes, resolving a create candidate whose title is an existing alias, and persisting only aliases present in confirmed evidence.
- [ ] Run the tests and verify the failures.
- [ ] Extend the structured candidate schema with optional `aliases`, default it to `[]`, include aliases in document descriptors and analysis notes, resolve targets by unique title/alias keys, and merge evidence-backed aliases into canonical saves.
- [ ] Re-run memory writer and analysis tests.

### Task 4: Editor and BARDCHAT combination

**Files:**
- Modify: `src/lib/Others/RisuBardWikiEditor.test.ts`
- Modify: `src/lib/Others/RisuBardWikiEditor.svelte`
- Modify: `src/ts/risubard/directWikiCommand.test.ts`
- Modify: `src/ts/risubard/directWikiCommand.ts`
- Modify: `src/ts/process/index.svelte.ts`

- [ ] Add failing tests for editing newline-separated aliases and for COMBINE passing redundant titles/aliases to the survivor save.
- [ ] Run the tests and verify the failures.
- [ ] Add an alias field to the editor and mutation call. For COMBINE, merge survivor aliases with every later trashed document title and aliases, excluding the survivor title, and pass the result through the existing safe save callback.
- [ ] Re-run editor and direct-command tests.

### Task 5: Canonical contract and verification

**Files:**
- Modify: `project_wiki/markdown_narrative_wiki.md`

- [ ] Document aliases as a non-document Obsidian property, unique alias resolution, ambiguity behavior, automatic evidence boundary, and COMBINE inheritance.
- [ ] Run focused client, server, editor, inquiry, writer, analysis, and direct-command tests.
- [ ] Run whitespace/conflict-marker checks and inspect the final diff without changing unrelated user work.
