# Character Canonical Reliability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make confirmed character state changes reliably update the existing canonical page and make the response path inject the character's current-state sections without increasing default inquiry budgets or adding an unconditional model call.

**Architecture:** Keep Markdown as the sole source of truth and retain the existing analysis-plus-canonical-rewrite pipeline. Improve the information passed between those two existing calls, add a deterministic exact-title recovery path when analysis detects a character state change but omits its update candidate, and share one section-aware Markdown excerpt selector between canonical analysis and response inquiry. Do not add the proposed second-pass verifier in the first release; first collect omission evidence after these zero-extra-call changes.

**Tech Stack:** TypeScript, Node.js, Svelte client integration, Vitest, existing BardWiki Markdown service and structured model requests.

**Implementation status (2026-08-27):** Tasks 0-6 are implemented. Focused client and server suites pass. Aggregate verification is currently blocked by concurrent pre-existing work: `memoryWiki.test.ts` references an unavailable `snapshotWikiBeforeTurn`, one reboot fixture lacks the newly required recovery service, and `svelte-check` reports reboot-recovery typing/test syntax errors. These are recorded in the implementation handoff and were not overwritten by this plan.

---

## Decision and boundaries

- Keep the existing two structured calls for a turn that updates canon: memory analysis, then canonical batch rewrite.
- Do not change the default inquiry target, inquiry maximum, recent-message counts, or analysis token limit.
- Do not add embeddings, a vector store, persistent graph state, a JSON index, or new frontmatter fields.
- Do not make every character document `context: always`.
- Do not add an unconditional verification call. It would lengthen background wiki completion and extend the interval in which a rapidly-started next response can still see the old canon.
- Preserve event immutability, snapshot/hash preconditions, per-document partial failure, and body-free persistent observability.
- Treat exact-title recovery as safe only when one active character document matches. Ambiguous or absent matches remain warnings; they must not silently update a guessed file.

## Success criteria

1. A confirmed `대학원 재학 → 석사 취득` change reaches the canonical rewrite input as a structured state change, even if the event Markdown summary is compressed.
2. When that state change names exactly one existing character but the analysis model omits `canonicalUpdateCandidates`, the program schedules an update to that existing page rather than losing the change.
3. Rewriting a character page preserves unrelated stable identity facts such as breed, while obsolete current-state text is removed from current-state sections.
4. A character document longer than 2,000 characters contributes title/current-state/identity sections plus the query-matched section; an early long history section cannot crowd current state out.
5. Event and non-character excerpt behavior remains query-centered and bounded.
6. A normal character update still performs exactly two model calls. A turn with no canonical update still performs only the analysis call.

## File map

- Create `server/node/risubard-markdown-excerpt.ts`: pure Markdown section parsing and bounded excerpt selection.
- Create `server/node/risubard-markdown-excerpt.test.ts`: section ordering, bounds, and multilingual heading regression tests.
- Modify `server/node/risubard-markdown-inquiry.ts`: delegate response excerpts to the shared selector.
- Modify `server/node/risubard-markdown-inquiry.test.ts`: cover long character current-state recall and unchanged event behavior.
- Modify `server/node/risubard-memory-analysis.ts`: pass structured semantic changes to canonical rewrite, recover exact character targets, and use section-aware existing notes.
- Modify `server/node/risubard-memory-analysis.test.ts`: cover state-update handoff, omitted-candidate recovery, ambiguity, stable-fact preservation contract, and call counts.
- Modify `src/ts/risubard/narrativeContext.ts`: make current canonical state explicitly outrank history and unsupported completion.
- Modify `src/ts/risubard/narrativeContext.test.ts`: assert the response grounding contract.
- Modify `src/ts/process/index.svelte.ts`: reject ordinary response generation while any BardWiki write operation is active.
- Modify `src/lib/ChatScreens/DefaultChatScreen.svelte`: preserve the draft and disable send/reroll/continue controls during BardWiki generation.
- Modify `src/lib/ChatScreens/RisuBardWikiRebootConnections.test.ts`, `src/lang/ko.ts`, and `src/lang/en.ts`: cover and explain the generation lock.
- Modify `project_wiki/markdown_narrative_wiki.md`, `project_wiki/inquiry_context_compiler.md`, and `project_wiki/context_pipeline_architecture.md`: record the reviewed contracts after implementation behavior is accepted.

---

### Task 0: Block new responses until BardWiki generation settles

**Files:**
- Modify: `src/ts/process/index.svelte.ts`
- Modify: `src/lib/ChatScreens/DefaultChatScreen.svelte`
- Modify: `src/lib/ChatScreens/RisuBardWikiRebootConnections.test.ts`
- Modify: `src/lang/ko.ts`
- Modify: `src/lang/en.ts`

- [ ] Add a failing connection test proving the programmatic `sendChat` guard and composer controls depend on `isWikiGenerating`.
- [ ] Run the focused test and confirm it fails because ordinary wiki activity only animates the icon today.
- [ ] Reject non-preview `sendChat` calls before generation state, pending-send markers, chat messages, or drafts are mutated.
- [ ] In the composer, preserve the typed draft, reject send/reroll/continue/resume entry points, and disable inline/fullscreen send controls while `$isWikiGenerating` is true.
- [ ] Add localized lock text explaining that the response becomes available when BardWiki finishes.
- [ ] Keep `endWikiGeneration` in every operation's `finally` block so success and failure both release the lock.
- [ ] Re-run the focused connection test and the wiki-generation-state unit test.

---

### Task 1: Preserve structured state changes across the existing two-call pipeline

**Files:**
- Modify: `server/node/risubard-memory-analysis.test.ts`
- Modify: `server/node/risubard-memory-analysis.ts:1000-1075`

- [ ] **Step 1: Write a failing canonical-input regression test**

Add a test beside `updates the model-selected canonical ID immediately after the event` which supplies an old character page and returns this analysis draft:

```ts
const stateUpdateDraft = {
    schemaVersion: 1,
    title: '학위 취득',
    establishedEvents: ['[[루치아]]가 석사 학위를 취득했다.'],
    stateChanges: [{
        subject: '루치아의 학력 상태',
        before: '대학원 재학 중',
        after: '석사 학위 취득 완료',
    }],
    characterKnowledge: [],
    persistentFacts: ['루치아는 석사 학위를 보유한다.'],
    openContinuity: [],
    canonicalUpdateCandidates: [{
        type: 'character',
        title: '루치아',
        reason: '학력 상태가 변경되었다.',
        action: 'update',
        targetDocumentId: 'character.lucia',
        confidence: 0.98,
    }],
}
```

In the `canonical-batch` branch, parse `request.input` and assert the structured fields survive independently of `confirmedEvent`:

```ts
const input = JSON.parse(request.input)
expect(input.semanticUpdate).toEqual({
    stateChanges: stateUpdateDraft.stateChanges,
    characterKnowledge: [],
    persistentFacts: stateUpdateDraft.persistentFacts,
    openContinuity: [],
})
expect(input.targets[0].target.markdown).toContain('대학원 재학 중')
expect(request.system).toContain(
    'Remove superseded facts from current-state sections'
)
return canonicalBatch([
    '## 루치아',
    '',
    '### 현재 상태',
    '',
    '- 석사 학위 취득 완료',
    '',
    '### 정체성',
    '',
    '- 수의사',
].join('\n'))
```

After the runner completes, assert that saved Markdown contains the new state and not the obsolete current state.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts -t "passes structured state changes to canonical rewrite"
```

Expected: FAIL because `semanticUpdate` is absent and the canonical system contract does not contain the supersession rule.

- [ ] **Step 3: Add the structured semantic payload without another model request**

Inside `canonicalInput`, add one shared object next to `targets`, `confirmedEvent`, and `confirmedMessages`:

```ts
semanticUpdate: {
    stateChanges: draft.stateChanges,
    characterKnowledge: draft.characterKnowledge,
    persistentFacts: draft.persistentFacts,
    openContinuity: draft.openContinuity,
},
```

Extend `canonicalSystem` with these exact responsibilities:

```ts
'Use semanticUpdate as a structured coverage checklist, but verify every item against confirmedMessages before applying it.',
'For character documents, keep current identity and current-state facts near the top. Remove superseded facts from current-state sections; retain an old state only as a clearly historical transition when it remains narratively useful.',
'Preserve unrelated established identity facts, relationships, knowledge, goals, possessions, constraints, and unresolved continuity unless confirmedMessages explicitly change them.',
'Apply the stateChanges.after values and relevant persistentFacts, characterKnowledge, and openContinuity to the correct subject document. Do not copy another character\'s facts into this target.',
```

This reuses data already produced by the first model call. It adds input tokens to the rewrite request but no network round trip.

- [ ] **Step 4: Run the focused test and verify success**

Run the command from Step 2.

Expected: PASS; the mock observes `semanticUpdate` and one saved canonical update.

- [ ] **Step 5: Run the existing canonical batch tests**

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts -t "canonical"
```

Expected: PASS, including split batches, bounded recovery, hash conflicts, and partial failures.

- [ ] **Step 6: Create an implementation checkpoint**

Inspect:

```powershell
git diff --check -- server/node/risubard-memory-analysis.ts server/node/risubard-memory-analysis.test.ts
```

Expected: exit code 0. Do not commit unless the user explicitly requests commits for the implementation session.

---

### Task 2: Recover an omitted character update from an unambiguous structured state change

**Files:**
- Modify: `server/node/risubard-memory-analysis.test.ts`
- Modify: `server/node/risubard-memory-analysis.ts:580-650,860-1012`

- [ ] **Step 1: Add three failing recovery tests**

Add focused tests with these cases:

```ts
it('recovers one exact character target when a state change candidate is omitted')
it('does not recover an ambiguous character state target')
it('does not recover a target from a persistent fact without a named subject')
```

For the positive case, return `stateUpdateDraft` from Task 1 with `canonicalUpdateCandidates: []`, load only `character.lucia`, and expect one canonical-batch call plus an update save. For ambiguity, load same-length character titles `민서` and `민재` and use the subject `민서와 민재의 공동 상태`; expect no canonical-batch call and one receipt warning. For the persistent-fact-only case, leave `stateChanges` empty; expect no synthesized update.

- [ ] **Step 2: Run the three tests and verify failure**

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts -t "recover"
```

Expected: the positive case fails because no canonical target is produced.

- [ ] **Step 3: Implement conservative exact-title recovery**

Add a helper close to `resolveCanonicalTarget`:

```ts
function normalizeCanonicalMatch(value: string): string {
    return value.normalize('NFKC').toLocaleLowerCase()
        .replace(/[\s\p{P}\p{S}]+/gu, '')
}

function recoverCharacterStateCandidates(
    draft: MemoryWriterDraft,
    documents: readonly LoadedCanonicalDocument[],
    excludedDocumentIds: ReadonlySet<string>
): MemoryWriterDraft['canonicalUpdateCandidates'] {
    const existingTargets = new Set(draft.canonicalUpdateCandidates
        .map((candidate) => candidate.targetDocumentId)
        .filter((id): id is string => typeof id === 'string'))
    const recovered: MemoryWriterDraft['canonicalUpdateCandidates'] = []
    for (const change of draft.stateChanges) {
        const subject = normalizeCanonicalMatch(change.subject)
        const matches = documents.filter((document) =>
            document.type === 'character'
            && !excludedDocumentIds.has(document.id)
            && !existingTargets.has(document.id)
            && normalizeCanonicalMatch(document.title).length >= 2
            && subject.includes(normalizeCanonicalMatch(document.title))
        )
        const longest = Math.max(0, ...matches.map((document) =>
            normalizeCanonicalMatch(document.title).length))
        const winners = matches.filter((document) =>
            normalizeCanonicalMatch(document.title).length === longest)
        if (winners.length !== 1) continue
        const target = winners[0]
        existingTargets.add(target.id)
        recovered.push({
            type: 'character',
            title: target.title,
            reason: `${change.subject}: ${change.before ?? '미확인'} → ${change.after}`,
            action: 'update',
            targetDocumentId: target.id,
            confidence: 1,
        })
    }
    return recovered
}
```

After the additional-search loop and before `hasMemoryWriterContent`, append only recovered candidates:

```ts
const recoveredCandidates = recoverCharacterStateCandidates(
    draft,
    documents,
    excludedDocumentIds
)
if (recoveredCandidates.length > 0) {
    draft = {
        ...draft,
        canonicalUpdateCandidates: [
            ...draft.canonicalUpdateCandidates,
            ...recoveredCandidates,
        ],
    }
}
```

Do not synthesize from free-form `persistentFacts`; only structured `stateChanges.subject` is eligible.

- [ ] **Step 4: Record recovery and ambiguity in the existing receipt warning channel**

When recovered candidates are non-empty, add one warning per target after `receiptWarnings` is created:

```ts
for (const candidate of recoveredCandidates) {
    receiptWarnings.push(
        `상태 변화에서 정본 갱신 후보 복구: ${candidate.title}`
    )
}
```

If a state change names character-like text but has zero or multiple exact catalog matches, add one bounded summary warning rather than guessing a target. Do not store the full state-change body in persistent request logs.

- [ ] **Step 5: Run recovery and full memory-analysis tests**

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts -t "recover"
pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts
```

Expected: PASS; ordinary create/update target resolution remains unchanged.

- [ ] **Step 6: Create an implementation checkpoint**

Run:

```powershell
git diff --check -- server/node/risubard-memory-analysis.ts server/node/risubard-memory-analysis.test.ts
```

Expected: exit code 0. Do not commit unless explicitly authorized.

---

### Task 3: Select character current-state sections instead of one arbitrary matching section

**Files:**
- Create: `server/node/risubard-markdown-excerpt.ts`
- Create: `server/node/risubard-markdown-excerpt.test.ts`
- Modify: `server/node/risubard-markdown-inquiry.ts:255-330`
- Modify: `server/node/risubard-markdown-inquiry.test.ts`

- [ ] **Step 1: Add failing pure excerpt tests**

Create `server/node/risubard-markdown-excerpt.test.ts` with these fixtures:

```ts
const longCharacter = [
    '## 체사레',
    '',
    '### 작중 행적',
    '',
    `- ${'오래된 사건 '.repeat(500)}`,
    '',
    '### 현재 상태',
    '',
    '- 쉽독이다.',
    '- 이탈리아에 남기로 했다.',
    '',
    '### 관계',
    '',
    '- 연인과 교제한 지 21개월이다.',
    '',
    '### 목표',
    '',
    '- 유럽에서 취업한다.',
].join('\n')
```

Assert:

```ts
const excerpt = selectMarkdownExcerpt({
    content: longCharacter,
    documentType: 'character',
    query: '체사레가 산책을 계속한다.',
    maximumCharacters: 2_000,
    chronologyIntent: false,
})
expect(excerpt).toContain('## 체사레')
expect(excerpt).toContain('### 현재 상태')
expect(excerpt).toContain('쉽독이다')
expect(excerpt).toContain('### 관계')
expect(excerpt).not.toContain('오래된 사건 오래된 사건 오래된 사건')
expect(excerpt.length).toBeLessThanOrEqual(2_000)
```

Add separate cases asserting that an explicit chronology query includes `작중 행적`, an English `Current State`/`Identity` document works, and an event document remains centered on its matching phrase.

- [ ] **Step 2: Run the new test and verify failure**

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/risubard-markdown-excerpt.test.ts
```

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement the pure section selector**

Create `server/node/risubard-markdown-excerpt.ts` with this public contract:

```ts
export type ExcerptDocumentType =
    | 'event' | 'scene' | 'character' | 'location'
    | 'faction' | 'item' | 'concept' | 'other'

export interface MarkdownExcerptInput {
    content: string
    documentType: ExcerptDocumentType
    query: string
    maximumCharacters: number
    chronologyIntent: boolean
}

export function selectMarkdownExcerpt(
    input: MarkdownExcerptInput
): string
```

Use these normalized heading lanes in order:

```ts
const TITLE_HEADING = /^#{1,2}\s+/u
const CURRENT_HEADINGS = /^(?:현재\s*상태|정체성|프로필|학력|직업|관계|지식|목표|소지품|제약|current\s+state|identity|profile|education|occupation|relationships?|knowledge|goals?|inventory|constraints?)$/iu
const HISTORY_HEADINGS = /^(?:작중\s*행적|이야기\s*요약|story\s+history|story\s+summary|history|timeline)$/iu
```

Parse every ATX heading and its body. For character documents, select the title section, all current-heading sections that fit, then query-matched sections; add history only when `chronologyIntent` is true. For other document types, select query-matched sections first and fall back to the first section. Deduplicate sections, truncate only the final selected section when the remaining budget is smaller, join with one blank line, and hard-slice the final result to `maximumCharacters`.

The helper must not count tokens, read files, inspect frontmatter, or mutate content.

- [ ] **Step 4: Run pure excerpt tests and verify success**

Run the command from Step 2.

Expected: PASS for Korean/English current headings, chronology opt-in, event matching, and the 2,000-character hard bound.

- [ ] **Step 5: Replace the private single-section response excerpt**

In `risubard-markdown-inquiry.ts`, import the helper and replace the call that prepares each candidate:

```ts
const content = selectMarkdownExcerpt({
    content: candidate.document.content,
    documentType: candidate.document.type,
    query: input.currentInput,
    maximumCharacters: MAX_SOURCE_CHARACTERS,
    chronologyIntent,
})
```

Remove `firstHeading`, `matchingIndex`, `centeredExcerpt`, and `relevantExcerpt` only after all callers have moved. Keep lexical candidate scoring, candidate limits, document limits, and token budgets unchanged.

- [ ] **Step 6: Add inquiry integration regressions**

In `risubard-markdown-inquiry.test.ts`, add a long `체사레` document using the fixture above. Assert that `currentInput: '체사레와 산책한다.'` selects the document and the source content contains `쉽독이다`. Preserve the existing chronology, historical evidence, stopword-only, and token-bound tests.

- [ ] **Step 7: Run inquiry tests**

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/risubard-markdown-excerpt.test.ts server/node/risubard-markdown-inquiry.test.ts
```

Expected: PASS; no source exceeds 2,000 characters and no default token value changes.

- [ ] **Step 8: Create an implementation checkpoint**

Run:

```powershell
git diff --check -- server/node/risubard-markdown-excerpt.ts server/node/risubard-markdown-excerpt.test.ts server/node/risubard-markdown-inquiry.ts server/node/risubard-markdown-inquiry.test.ts
```

Expected: exit code 0. Do not commit unless explicitly authorized.

---

### Task 4: Use the same section-aware selection when analysis compares existing canon

**Files:**
- Modify: `server/node/risubard-memory-analysis.ts:665-690,790-840`
- Modify: `server/node/risubard-memory-analysis.test.ts`

- [ ] **Step 1: Add a failing existing-note regression**

Load a character document whose first 8,000 characters are history and whose later `현재 상태` says `대학원 재학 중`. Supply a confirmed message saying `석사 학위를 취득했다`. In the analysis request branch, assert:

```ts
const input = JSON.parse(request.input)
expect(input.existingNotes[0].content).toContain('### 현재 상태')
expect(input.existingNotes[0].content).toContain('대학원 재학 중')
```

The document must be selected by the existing inquiry mock so this test isolates note excerpting rather than candidate retrieval.

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts -t "current-state sections in existing notes"
```

Expected: FAIL because `analysisNotes` currently slices each document from the beginning.

- [ ] **Step 3: Pass the analysis query into `analysisNotes`**

Change the helper signature:

```ts
function analysisNotes(
    documents: readonly LoadedCanonicalDocument[],
    tokenLimit: number,
    query: string
): Array<{ id: string; type: string; title: string; content: string }>
```

Build the query once from the same bounded evidence already used for inquiry:

```ts
const analysisQuery = contextMessages.map((message) =>
    message.content
).join('\n').slice(-4_096)
```

Use `analysisQuery` both for `markdownWikiService.inquire` and `analysisNotes`.

- [ ] **Step 4: Select bounded existing-note sections**

Within `analysisNotes`, replace prefix slicing with:

```ts
const maximumCharacters = Math.min(4_000, remainingCharacters)
const content = selectMarkdownExcerpt({
    content: document.content,
    documentType: document.type as ExcerptDocumentType,
    query,
    maximumCharacters,
    chronologyIntent: false,
})
remainingCharacters -= content.length
```

Keep the existing total character budget derived from `analysisTokenLimit`; this changes selection quality, not the configured analysis budget.

- [ ] **Step 5: Run focused and full analysis tests**

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts -t "current-state sections in existing notes"
pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts
```

Expected: PASS; analysis sees old current state and the canonical rewrite receives both old canon and structured new state.

- [ ] **Step 6: Create an implementation checkpoint**

Run:

```powershell
git diff --check -- server/node/risubard-memory-analysis.ts server/node/risubard-memory-analysis.test.ts
```

Expected: exit code 0. Do not commit unless explicitly authorized.

---

### Task 5: Make source precedence explicit without a verifier call

**Files:**
- Modify: `src/ts/risubard/narrativeContext.ts:53-58`
- Modify: `src/ts/risubard/narrativeContext.test.ts`

- [ ] **Step 1: Add a failing prompt-contract test**

Extend the `createNarrativeSourcesPrompt` tests:

```ts
const prompt = createNarrativeSourcesPrompt([{
    id: 'narrative-memory:wiki:characters/체사레.md',
    kind: 'memory',
    role: 'system',
    content: '## 체사레\n\n### 현재 상태\n\n- 쉽독이다.',
    tokens: 20,
    priority: 120,
}])
expect(prompt).toContain(
    'Current-state sections in canonical character documents outrank older historical descriptions'
)
expect(prompt).toContain(
    'Do not replace an established identity, status, relationship, duration, location, or goal with an unsupported detail'
)
```

- [ ] **Step 2: Run the focused frontend test and verify failure**

Run:

```powershell
pnpm vitest run src/ts/risubard/narrativeContext.test.ts -t "canonical current-state precedence"
```

Expected: FAIL because the precedence sentences are absent.

- [ ] **Step 3: Extend `NARRATIVE_EVIDENCE_RULES`**

Add:

```ts
'- Current-state sections in canonical character documents outrank older historical descriptions and unsupported continuation assumptions.',
'- Do not replace an established identity, status, relationship, duration, location, or goal with an unsupported detail. If the sources do not establish a replacement, keep the canonical fact unchanged.',
```

Keep the existing uncertainty, causation, and knowledge-boundary rules.

- [ ] **Step 4: Run narrative-context tests**

Run:

```powershell
pnpm vitest run src/ts/risubard/narrativeContext.test.ts
```

Expected: PASS. This changes prompt text only when at least one BardWiki source was selected.

- [ ] **Step 5: Verify model-call count remains unchanged**

Add or extend a memory-analysis test to assert:

```ts
expect(analyze).toHaveBeenCalledTimes(2)
expect(analyze.mock.calls.map(([request]) => request.format)).toEqual([
    'memory-draft',
    'canonical-batch',
])
```

Run:

```powershell
pnpm vitest run --config vitest.config.server.ts server/node/risubard-memory-analysis.test.ts -t "keeps character update to two model calls"
```

Expected: PASS. No verifier call is present.

---

### Task 6: Update canonical architecture documents and verify the integrated change

**Files:**
- Modify: `project_wiki/markdown_narrative_wiki.md`
- Modify: `project_wiki/inquiry_context_compiler.md`
- Modify: `project_wiki/context_pipeline_architecture.md`
- Test: all affected suites listed below

- [ ] **Step 1: Update the reviewed Markdown-wiki contract**

In `markdown_narrative_wiki.md`, add these decisions to the character-canon section:

```markdown
캐릭터 정본 재작성 입력은 기존 정본과 확정 원문뿐 아니라 같은 분석 호출이 만든 상태 변화, 인물별 지식, 지속 사실과 미해결 연속성을 구조화된 coverage 입력으로 함께 받는다. 새 현재 상태는 현재 상태 절에서 폐기된 이전 상태를 대체하며, 이전 상태가 인과상 필요할 때만 작중 행적에 역사적 전환으로 남긴다. 관련 없는 정체성·관계·지식·목표·소지품·제약은 확정 근거가 바꾸지 않는 한 보존한다.

분석 결과에 명시적 상태 변화가 있으나 정본 후보가 빠진 경우, 프로그램은 상태 변화의 주체 문자열과 정확히 대응하는 활성 캐릭터 정본이 하나뿐일 때만 갱신 후보를 복구할 수 있다. 후보가 없거나 둘 이상이면 추측해 저장하지 않고 경고한다.
```

- [ ] **Step 2: Update inquiry and pipeline contracts**

In `inquiry_context_compiler.md`, state that character excerpts reserve title/current-state/identity lanes before query-matched detail and only include history by chronology intent. In `context_pipeline_architecture.md`, state that this section selector is shared by response inquiry and canonical-analysis existing notes, and that the first release adds no verification model call.

- [ ] **Step 3: Run all focused suites**

Run:

```powershell
pnpm vitest run server/node/risubard-markdown-excerpt.test.ts src/ts/risubard/narrativeContext.test.ts
pnpm vitest run --config vitest.config.server.ts server/node/risubard-markdown-excerpt.test.ts server/node/risubard-markdown-inquiry.test.ts server/node/risubard-memory-analysis.test.ts server/node/risubard-memory-routes.test.ts
```

Expected: all tests pass. If the first command does not load server-only Node APIs under the default config, run the excerpt test only under `vitest.config.server.ts` and retain `narrativeContext.test.ts` under the default config.

- [ ] **Step 4: Run the affected product verification command**

Run:

```powershell
pnpm run verify:risubard-memory-wiki
```

Expected: exit code 0. Unrelated pre-existing failures must be reported with their exact suite and must not be fixed as part of this plan.

- [ ] **Step 5: Inspect the final scoped diff**

Run:

```powershell
git diff --check -- project_wiki/markdown_narrative_wiki.md project_wiki/inquiry_context_compiler.md project_wiki/context_pipeline_architecture.md server/node/risubard-markdown-excerpt.ts server/node/risubard-markdown-excerpt.test.ts server/node/risubard-markdown-inquiry.ts server/node/risubard-markdown-inquiry.test.ts server/node/risubard-memory-analysis.ts server/node/risubard-memory-analysis.test.ts src/ts/risubard/narrativeContext.ts src/ts/risubard/narrativeContext.test.ts
```

Expected: exit code 0 and no unrelated files in the scoped diff.

- [ ] **Step 6: Record the latency decision**

Confirm in the implementation handoff:

```text
Model calls for one character canonical update: 2 (unchanged)
New network round trips: 0
New default token-budget changes: 0
Additional rewrite input: structured state/knowledge/fact/continuity fields already produced by analysis
```

Only propose a conditional verifier in a later plan if real receipts show that, after these changes, the canonical rewrite still omits or contradicts structured state changes. Its trigger must be limited to failed coverage or conflict evidence rather than every wiki update.

---

## Acceptance scenarios

Run these as named automated fixtures; do not depend on a 750,000-token live chat to reproduce bounded-pipeline defects.

1. **Education supersession:** old current state says graduate student; confirmed turn awards a master's; saved current state says degree completed and does not still claim enrollment.
2. **Stable identity preservation:** old canon says Cesare is a sheepdog; a later employment update rewrites the page; breed remains sheepdog.
3. **Goal replacement:** old goal says North American and European job search; confirmed turn establishes remaining in Italy; current goal no longer presents North America as active.
4. **Relationship duration:** existing exact duration/anchor survives an unrelated rewrite and is included in the response excerpt.
5. **Long-page excerpt:** a large history section cannot remove current identity/status from the 2,000-character response source.
6. **Ambiguous subject:** two possible character pages produce a warning and no guessed write.
7. **No state change:** ordinary event-only confirmation does not synthesize a character update or make a verifier call.

## Deferred verifier gate

The second-pass verifier is intentionally deferred. It becomes justified only if post-release evidence contains at least one of these after Tasks 1-6 are active:

- `semanticUpdate.stateChanges` reached the canonical request but the saved current-state section omitted the `after` state;
- a stable identity fact present in the previous canonical page disappeared during an unrelated rewrite;
- the saved current-state section contains both sides of a superseded state as simultaneously current.

If triggered, design a separate plan for one conditional batch verifier after canonical generation and before save. It must validate all changed documents in one request, preserve the existing hash precondition, and remain off for event-only turns and canon rewrites without risk signals.
