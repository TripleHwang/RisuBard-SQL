# Historical Memory Grounding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make past-event and causal questions retrieve detailed event evidence within the existing fixed token budget, then prevent compressed summaries from turning omitted details or chronology into false facts.

**Architecture:** Keep the current lexical search and two-hop Markdown link graph. Add a deterministic historical-evidence lane that reserves up to two fitting linked event excerpts before ordinary score-order filling, without adding an LLM call or increasing the configured target budget. Add a short evidence hierarchy to the generated response context and strengthen the shared event/canonical writing policy so compression preserves targets, locations, causality, and character knowledge boundaries.

**Tech Stack:** TypeScript, Vitest, Markdown Memory Wiki, `@dqbd/tiktoken`

---

### Task 1: Reserve Detailed Event Evidence for Historical Questions

**Files:**
- Modify: `server/node/risubard-markdown-inquiry.test.ts`
- Modify: `server/node/risubard-markdown-inquiry.ts`

- [x] **Step 1: Write the failing regression test**

Add a test whose high-scoring character summary competes inside a 256-token target while two linked event documents preserve the exact action target and the true order of relationship damage:

```ts
test('reserves linked event evidence for past causal analysis', () => {
    const result = inquireMarkdownDocuments({
        currentInput: '진우가 초반에 주인공 자리를 잃은 원인과 세부 사건을 분석해 줘.',
        tokenBudget: { target: 256, maximum: 512 },
        documents: [
            document({
                id: 'jinwoo', type: 'character', title: '진우',
                relativePath: 'characters/jinwoo.md',
                content: [
                    '# 진우',
                    '',
                    '## 작중 행적',
                    '',
                    '- [[교실의 폭발]] 뒤 관계가 악화됐다.',
                    '- [[훼손된 신발]] 뒤 범행을 고백했다.',
                    '',
                    '초반 주인공 자리와 원인을 다루는 압축 요약이다. '.repeat(2),
                ].join('\n'),
                links: ['교실의 폭발', '훼손된 신발'],
            }),
            document({
                id: 'outburst', type: 'event', title: '교실의 폭발',
                relativePath: 'events/outburst.md',
                content: '# 교실의 폭발\n\n진우는 필통을 책상에 내던지며 미나에게 소리쳤다. 필통은 미나에게 던진 것이 아니며, 행동의 대상과 고함의 대상은 구분된다. 이 사건 뒤 진우는 교실을 나갔다.',
            }),
            document({
                id: 'shoes', type: 'event', title: '훼손된 신발',
                relativePath: 'events/shoes.md',
                content: '# 훼손된 신발\n\n미나는 이미 진우와 대화를 거부했고, 신발을 훼손한 범인이 진우라는 사실은 나중의 고백 전까지 몰랐다. 따라서 신발 훼손은 미나가 당시에 진우를 거부한 원인이 아니며, 범인에 관한 지식은 고백 뒤에 생겼다.',
            }),
        ],
    })

    expect(result.sources.map((source) => source.id)).toEqual(
        expect.arrayContaining([
            'narrative-memory:wiki:events/outburst.md',
            'narrative-memory:wiki:events/shoes.md',
        ])
    )
    expect(result.metrics.selectedTokens).toBeLessThanOrEqual(256)
    expect(result.metrics.auxiliaryModelCalls).toBe(0)
})
```

- [x] **Step 2: Run the regression test and verify the old selector fails**

Run: `npx vitest run --config vitest.config.server.ts server/node/risubard-markdown-inquiry.test.ts -t "reserves linked event evidence"`

Expected: FAIL because score-order budget filling selects the long character summary before both linked event documents.

- [x] **Step 3: Implement a bounded historical-evidence lane**

In `server/node/risubard-markdown-inquiry.ts`, add a fixed cap and explicit intent detector:

```ts
const MAX_RESERVED_HISTORICAL_EVENTS = 2

function hasHistoricalEvidenceIntent(value: string): boolean {
    const past = /(?:과거|예전|이전|당시|처음|초반|원래|회상|기억|past|previous|before|earlier|formerly|used to|昔|以前|当時)/i
        .test(value)
    const causalOrDetail = /(?:왜|원인|이유|계기|인과|영향|분석|세부|근거|why|cause|reason|trigger|analysis|detail|evidence)/i
        .test(value)
    return past || causalOrDetail
}
```

After candidate excerpts and token counts are prepared, preselect at most two non-required event candidates when historical evidence is requested and chronology-summary mode is not active. Each reserved event must fit the same `selectedTokenBudget`; then run the existing score-order loop while skipping already selected IDs:

```ts
const selected: typeof prepared = []
const selectedIds = new Set<string>()
let selectedTokens = 0

const addIfFits = (candidate: (typeof prepared)[number]): boolean => {
    if (selectedIds.has(candidate.document.id)
        || selectedTokens + candidate.tokens > selectedTokenBudget) return false
    selected.push(candidate)
    selectedIds.add(candidate.document.id)
    selectedTokens += candidate.tokens
    return true
}

if (historicalEvidenceIntent && !chronologyIntent) {
    for (const candidate of prepared.filter((item) =>
        !requiredIds.has(item.document.id)
        && item.document.type === 'event'
    ).slice(0, MAX_RESERVED_HISTORICAL_EVENTS)) {
        addIfFits(candidate)
    }
}
```

Preserve required-document validation against the absolute maximum before optional reservation. Do not raise the target budget, increase graph traversal limits, or add model calls.

- [x] **Step 4: Run the focused server inquiry suite**

Run: `npx vitest run --config vitest.config.server.ts server/node/risubard-markdown-inquiry.test.ts`

Expected: PASS, including the existing chronology test that intentionally uses only the compressed `작중 행적` section.

- [x] **Step 5: Commit the retrieval change**

```bash
git add server/node/risubard-markdown-inquiry.ts server/node/risubard-markdown-inquiry.test.ts
git commit -m "fix: reserve event evidence for historical inquiry"
```

### Task 2: Ground the Final Answer in Evidence Hierarchy

**Files:**
- Modify: `src/ts/risubard/narrativeContext.test.ts`
- Modify: `src/ts/risubard/narrativeContext.ts`

- [x] **Step 1: Write the failing prompt-composition test**

Add a test that requires the response prompt to explain the event/source hierarchy and prohibit the three observed inference errors:

```ts
it('grounds historical answers without inventing omitted relations', () => {
    const prompt = createNarrativeSourcesPrompt([{
        id: 'narrative-memory:wiki:events/outburst.md',
        kind: 'memory',
        role: 'system',
        content: '진우는 필통을 책상에 내던지며 미나에게 소리쳤다.',
        tokens: 24,
        priority: 120,
    }], '')!

    expect(prompt).toContain('event documents are the detailed evidence')
    expect(prompt).toContain('Do not invent an omitted action target or location')
    expect(prompt).toContain('Do not turn temporal order into causation')
    expect(prompt).toContain('character knowledge boundary')
})
```

- [x] **Step 2: Run the focused test and verify it fails**

Run: `npx vitest run src/ts/risubard/narrativeContext.test.ts -t "grounds historical answers"`

Expected: FAIL because the current prompt labels all selected material only as `Relevant narrative memory`.

- [x] **Step 3: Add a compact evidence contract to source prompts**

In `createNarrativeSourcesPrompt`, prepend the following section only when at least one inquiry source exists:

```ts
const NARRATIVE_EVIDENCE_RULES = [
    'Narrative evidence rules:',
    '- For past details, event documents are the detailed evidence; canonical summaries are compressed navigation and current-state context.',
    '- Do not invent an omitted action target or location, turn temporal order into causation, or cross a character knowledge boundary.',
    '- If sources do not establish a detail, preserve uncertainty instead of completing it.',
].join('\n')
```

Keep the rules inside the existing `characterBudget` slice and before source bodies so truncation cannot remove the instruction while leaving unqualified evidence.

- [x] **Step 4: Run the narrative context suite**

Run: `npx vitest run src/ts/risubard/narrativeContext.test.ts`

Expected: PASS.

- [x] **Step 5: Commit the response-grounding change**

```bash
git add src/ts/risubard/narrativeContext.ts src/ts/risubard/narrativeContext.test.ts
git commit -m "fix: ground responses in detailed event evidence"
```

### Task 3: Make Compression Relation-Preserving

**Files:**
- Modify: `src/ts/risubard/risuBardSettings.test.ts`
- Modify: `src/ts/risubard/risuBardSettings.ts`

- [x] **Step 1: Write the failing writing-policy assertions**

Extend `keeps character canon compact while preserving detailed event evidence`:

```ts
expect(policy).toContain('원문에 없는 행동 대상이나 장소를 보충하지 않는다')
expect(policy).toContain('시간적 선후를 인과로 바꾸지 않는다')
expect(policy).toContain('사건 당시 인물별 지식 경계를 유지한다')
```

- [x] **Step 2: Run the focused settings test and verify it fails**

Run: `npx vitest run src/ts/risubard/risuBardSettings.test.ts -t "keeps character canon compact"`

Expected: FAIL because the existing concise style names the fields but does not explicitly prohibit relation completion or causal strengthening.

- [x] **Step 3: Add a mandatory fidelity rule shared by every writing style**

Add this line to `buildRisuBardEventWritingPolicy` after the selected style instruction, so standard, concise, ultra-concise, and custom styles all receive it:

```ts
'압축할 때도 원문에 없는 행동 대상이나 장소를 보충하지 않는다. 시간적 선후를 인과로 바꾸지 않으며 사건 당시 인물별 지식 경계를 유지한다.',
```

Do not duplicate detailed event prose into character canon; the existing `[[사건 문서 제목]]` link remains the lossless evidence path.

- [x] **Step 4: Run the settings suite**

Run: `npx vitest run src/ts/risubard/risuBardSettings.test.ts`

Expected: PASS.

- [x] **Step 5: Commit the compression-policy change**

```bash
git add src/ts/risubard/risuBardSettings.ts src/ts/risubard/risuBardSettings.test.ts
git commit -m "fix: preserve relations in canonical compression"
```

### Task 4: Align the Written Contract and Verify the Accuracy Boundary

**Files:**
- Modify: `E:/Risuwork/JellyBard/project_wiki/inquiry_context_compiler.md`
- Modify: `E:/Risuwork/JellyBard/project_wiki/markdown_narrative_wiki.md`
- Modify: `src/ts/risubard/README.md`

- [x] **Step 1: Update the canonical inquiry contract**

Replace selection rule 6 in `project_wiki/inquiry_context_compiler.md` with:

```md
6. 현재 상태 질문은 지속 정본에 작은 lane affinity를 준다. 과거·회상·원인·세부 검증 질문은 연결된 사건 후보가 목표 token 예산 안에 존재하면 점수순 일반 선택 전에 사건을 최대 2개 보존한다. 사건 보존은 목표 token 예산, 문서 수, 탐색 깊이와 보조 모델 0회 상한을 늘리지 않는다. 작중 행적을 순서대로 나열하는 질문은 압축된 캐릭터 `작중 행적`을 우선해 사건 보존을 적용하지 않는다. 소설가 결과에 관련 지속 정본과 사건 후보가 모두 존재하면 한 종류가 전체 상한을 독점하지 않도록 각각 최소 한 자리를 보존한다.
```

- [x] **Step 2: Document evidence precedence**

Add to `project_wiki/markdown_narrative_wiki.md` after the inquiry excerpt paragraph:

```md
과거 세부사항에서는 사건 문서가 압축 정본보다 우선하는 상세 근거다. 응답은 정본에서 생략된 행동 대상·장소를 추정하거나 시간적 선후를 인과로 강화하거나 사건 당시의 인물별 지식 경계를 넘지 않는다. 근거가 세부사항을 확정하지 않으면 임의로 완성하지 않고 불확실성을 유지한다.
```

- [x] **Step 3: Update the adapter note**

In `src/ts/risubard/README.md`, replace the stale statement that event documents need their own positive lexical match with a description of direct seeds, two-hop links, and the bounded historical-event reservation.

- [x] **Step 4: Run targeted verification**

Run:

```bash
npx vitest run src/ts/risubard/narrativeContext.test.ts src/ts/risubard/risuBardSettings.test.ts
npx vitest run --config vitest.config.server.ts server/node/risubard-markdown-inquiry.test.ts
git diff --check
```

Expected: all tests PASS and `git diff --check` exits 0. The regression must report no auxiliary model calls and no selected-token increase beyond the configured 256-token target.

- [x] **Step 5: Commit public documentation**

```bash
git add src/ts/risubard/README.md
git commit -m "docs: describe historical event grounding"
```

The canonical `project_wiki/` files live outside the public Git repository, so report those edits separately rather than staging them in `RisuBard-public`.
