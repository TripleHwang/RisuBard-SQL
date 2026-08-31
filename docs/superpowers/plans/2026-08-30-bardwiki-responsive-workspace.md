# BardWiki Responsive Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the BardWiki workspace as a compact responsive editor with a collapsible document sidebar and an always-reachable Bardchat dock.

**Architecture:** Preserve the existing Svelte components and theme tokens. `RisuBardWikiEditor` keeps the desktop two-column layout but turns the document tree into an overlay drawer below a container-width breakpoint. `RisuBardMemoryWiki` retains the bounded editor/Bardchat grid, while `RisuBardWikiCommandTerminal` switches to a compact container-responsive control layout.

**Tech Stack:** Svelte 5, TypeScript, component-scoped CSS, Vitest, happy-dom

---

### Task 1: Responsive document sidebar

**Files:**
- Modify: `src/lib/Others/RisuBardWikiEditor.test.ts`
- Modify: `src/lib/Others/RisuBardWikiEditor.svelte`

- [ ] Add a failing interaction test proving the document drawer starts closed, opens from the document button, and closes from its scrim.
- [ ] Run `pnpm vitest run src/lib/Others/RisuBardWikiEditor.test.ts` and confirm the new test fails because the scrim and closed default do not exist.
- [ ] Add the scrim, closed initial state, drawer accessibility state, and container-responsive drawer CSS while preserving the desktop sidebar.
- [ ] Run the editor test again and confirm it passes.

### Task 2: Persistent responsive Bardchat dock

**Files:**
- Modify: `src/lib/Others/RisuBardMemoryWiki.test.ts`
- Modify: `src/lib/Others/RisuBardMemoryWiki.svelte`
- Modify: `src/lib/Others/RisuBardWikiCommandTerminal.test.ts`
- Modify: `src/lib/Others/RisuBardWikiCommandTerminal.svelte`

- [ ] Add failing layout-contract tests for a container-responsive bottom dock, a permanently reachable collapsed header, and a compact terminal toolbar.
- [ ] Run the three targeted component tests and confirm the new assertions fail on the old orientation-only layout.
- [ ] Replace orientation-only rules with dock-width container rules, reserve the bottom dock row, and compact Bardchat identity, context chips, input, and actions without changing command behavior.
- [ ] Run the targeted tests and confirm they pass.

### Task 3: Responsive toolbar and verification

**Files:**
- Modify: `src/lib/Others/RisuBardMemoryWiki.svelte`

- [ ] Compact the title/action toolbar at narrow dock widths while preserving labels through `aria-label` and `title` attributes.
- [ ] Run `pnpm vitest run src/lib/Others/RisuBardMemoryWiki.test.ts src/lib/Others/RisuBardWikiEditor.test.ts src/lib/Others/RisuBardWikiCommandTerminal.test.ts`.
- [ ] Run `pnpm check:theme-tokens` and `pnpm check`.
- [ ] Run the local app through the webapp-testing server helper and inspect narrow and desktop screenshots when the route is reachable.
