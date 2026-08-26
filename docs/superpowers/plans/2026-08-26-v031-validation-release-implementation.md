# RisuVault v0.3.1 Validation and Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the v0.3.1 bounded-loading and streaming-import design against generated reference data and real mobile devices, then publish a stable `v0.3.1` release.

**Architecture:** Add content-free performance reports and repeatable generated fixtures, enforce automated functional and memory-bound contracts in CI, and use a written iPhone/Android gate for WebKit behavior that automation cannot measure. Release only after all preceding v0.3.1 implementation plans are merged into the feature branch and every gate has evidence.

**Tech Stack:** TypeScript, Node.js 24, Vitest, Svelte 5, GitHub Actions, Safari/PWA real-device profiling

---

### Task 1: Add a content-free performance report

**Files:**
- Create: `src/ts/performance/performanceReport.ts`
- Create: `src/ts/performance/performanceReport.test.ts`
- Modify: `src/lib/_dev/DevPanel.svelte`

- [ ] **Step 1: Write the failing bounded-report tests**

Add tests that record durations and resource counters, cap each metric series at 100 samples, and prove that arbitrary labels or content cannot enter the export.

```ts
import { describe, expect, test } from 'vitest'
import { createPerformanceReport } from './performanceReport'

describe('performance report', () => {
  test('bounds samples and exports only approved numeric fields', () => {
    const report = createPerformanceReport({ sampleLimit: 100 })
    for (let i = 0; i < 125; i++) report.recordDuration('bootstrap-fetch', i)
    report.recordDuration('long-task', 120)
    report.recordResources({ hydratedChats: 2, mountedMessages: 60, imageCacheBytes: 1024 })

    expect(report.export().durations['bootstrap-fetch']).toHaveLength(100)
    expect(JSON.stringify(report.export())).not.toContain('messageText')
  })
})
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
.\node_modules\.bin\vitest.cmd run src/ts/performance/performanceReport.test.ts
```

Expected: FAIL because `performanceReport.ts` does not exist.

- [ ] **Step 3: Implement the fixed metric vocabulary and ring buffers**

Use an explicit union so callers cannot add user-controlled names.

```ts
export type DurationMetric =
  | 'bootstrap-fetch' | 'bootstrap-json' | 'first-interactive'
  | 'character-hydration' | 'message-page-fetch' | 'sql-commit'
  | 'render-batch' | 'chat-selection' | 'long-task'

export type ResourceSample = {
  hydratedChats: number
  mountedMessages: number
  imageCacheBytes: number
}

export function createPerformanceReport(options = { sampleLimit: 100 }) {
  const durations = new Map<DurationMetric, number[]>()
  let resources: ResourceSample[] = []
  const push = <T>(items: T[], value: T) => [...items, value].slice(-options.sampleLimit)
  return {
    recordDuration(name: DurationMetric, value: number) {
      durations.set(name, push(durations.get(name) ?? [], value))
    },
    recordResources(value: ResourceSample) { resources = push(resources, value) },
    export() {
      return { schemaVersion: 1, sessionDurationMs: performance.now(), durations: Object.fromEntries(durations), resources: [...resources] }
    },
  }
}
```

Wire the existing development panel to download this JSON report. Do not include character IDs, names, message text, asset keys, URLs, prompts, or plugin data.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Commit the report**

```powershell
git add src/ts/performance/performanceReport.ts src/ts/performance/performanceReport.test.ts src/lib/_dev/DevPanel.svelte
git commit -m "feat(perf): add bounded diagnostic reports"
```

### Task 2: Generate the reference database without storing user data

**Files:**
- Create: `server/node/performance-fixture.cjs`
- Create: `server/node/performance-fixture.test.ts`
- Create: `scripts/perf/generate-reference-fixture.mjs`

- [ ] **Step 1: Write the failing deterministic fixture test**

The fixture must contain exactly 200 characters and 20,000 messages while using generated neutral strings only.

```ts
test('creates the v0.3.1 reference profile deterministically', async () => {
  const root = await mkdtemp(join(tmpdir(), 'risuvault-perf-'))
  try {
    const summary = await createReferenceFixture(root, {
      characters: 200,
      messages: 20_000,
      logicalAssetBytes: 20 * 1024 ** 3,
    })
    expect(summary).toEqual({ characters: 200, messages: 20_000, logicalAssetBytes: 20 * 1024 ** 3 })
    expect(await inspectReferenceFixture(root)).toMatchObject({ characters: 200, messages: 20_000 })
  } finally { await rm(root, { recursive: true, force: true }) }
})
```

- [ ] **Step 2: Run the server test and verify RED**

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.config.server.ts server/node/performance-fixture.test.ts
```

Expected: FAIL because the fixture helper does not exist.

- [ ] **Step 3: Implement batched relational inserts**

Create the schema through the production relational adapter and insert deterministic rows in transactions of at most 1,000 statements. Asset capacity is represented as generated catalog metadata; do not create or check in 20 GiB of files.

```js
async function createReferenceFixture(root, options) {
  const store = createRelationalSqlite({ dataRoot: root })
  const batch = []
  for (let c = 0; c < options.characters; c++) {
    batch.push(characterStatement(c))
    const perCharacter = Math.floor(options.messages / options.characters)
    for (let m = 0; m < perCharacter; m++) batch.push(messageStatement(c, m))
    if (batch.length >= 1000) commitBatch(store, batch.splice(0))
  }
  if (batch.length) commitBatch(store, batch)
  return { ...options }
}
```

The CLI accepts only numeric flags, requires an explicit output directory, refuses a nonempty directory, and prints counts rather than generated content.

- [ ] **Step 4: Run the test and verify GREEN**

Run the Step 2 command. Expected: PASS with the exact counts.

- [ ] **Step 5: Commit the generator**

```powershell
git add server/node/performance-fixture.cjs server/node/performance-fixture.test.ts scripts/perf/generate-reference-fixture.mjs
git commit -m "test(perf): generate the v0.3.1 reference profile"
```

### Task 3: Enforce automated performance contracts

**Files:**
- Create: `server/node/performance-contract.test.ts`
- Create: `scripts/perf/check-performance-report.mjs`
- Create: `scripts/perf/check-performance-report.test.ts`
- Modify: `package.json`

- [ ] **Step 1: Write failing report-threshold tests**

```ts
test('rejects reports outside the approved p95 thresholds', () => {
  const result = evaluatePerformanceReport({
    durations: {
      'first-interactive': [4_900, 5_100, 8_100],
      'chat-selection': [1_600],
      'render-batch': [60],
      'long-task': [120, 130, 140],
    },
    sessionDurationMs: 60_000,
    resources: [{ hydratedChats: 3, mountedMessages: 61, imageCacheBytes: 0 }],
  })
  expect(result.ok).toBe(false)
  expect(result.failures).toEqual(expect.arrayContaining([
    expect.stringContaining('first-interactive'),
    expect.stringContaining('hydratedChats'),
  ]))
})
```

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
.\node_modules\.bin\vitest.cmd run scripts/perf/check-performance-report.test.ts
```

Expected: FAIL because the checker is absent.

- [ ] **Step 3: Implement percentile and resource checks**

```js
export const LIMITS = Object.freeze({
  firstInteractiveMedianMs: 5_000,
  firstInteractiveP95Ms: 8_000,
  chatSelectionP95Ms: 1_500,
  renderBatchP95Ms: 50,
  longTasksOver100MsPerMinute: 2,
  hydratedChats: 2,
  mountedMessages: 60,
})

export function percentile95(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0
}

export function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}
```

Add `test:performance-contract` to `package.json`; it runs only deterministic generated-fixture contracts and never claims to replace the real iPhone gate.

- [ ] **Step 4: Add bounded server API assertions**

Using the generated reference fixture, assert:

```ts
expect(JSON.stringify(store.bootstrap()).length).toBeLessThan(2_000_000)
expect(store.loadChatMessages(chatId, undefined, 40).messages).toHaveLength(40)
expect(store.loadChatMessages(chatId, undefined, 40).messages).not.toContainEqual(
  expect.objectContaining({ content: expect.stringContaining('unloaded-sentinel') }),
)
```

Also assert the bootstrap payload size does not increase when messages increase from 20,000 to 40,000 while character summaries remain unchanged.

- [ ] **Step 5: Run performance contracts and verify GREEN**

```powershell
pnpm test:performance-contract
```

Expected: all deterministic contracts pass.

- [ ] **Step 6: Commit the contracts**

```powershell
git add server/node/performance-contract.test.ts scripts/perf/check-performance-report.mjs scripts/perf/check-performance-report.test.ts package.json
git commit -m "test(perf): enforce bounded runtime contracts"
```

### Task 4: Add the real-device release checklist

**Files:**
- Create: `docs/ko/v0.3.1-performance-release-checklist.md`
- Create: `docs/superpowers/plans/2026-08-26-v031-device-results.md`

- [ ] **Step 1: Write the exact iPhone and Android procedures**

The checklist must require:

```text
Device A: iPhone 13+, iOS 17+, Safari and installed PWA, Tailscale
Device B: Android Chrome, Node environment, Tailscale
Data: 200 characters, 20,000 messages, logical 20 GiB asset catalog
Runs: 10 cold starts; 20 chat switches; 30 minutes scroll/stream/image activity
Import: generated 3 GiB .risum, cancel once during upload and once during asset processing
Evidence: content-free performance-report JSON, server max RSS, pass/fail observations
```

The result document contains a table for device/build identifiers, 10 startup samples, p95 values, forced reload count, draft-loss count, and cleanup verification. It contains no user content.

- [ ] **Step 2: Verify the checklist is complete**

```powershell
rg -n "10 cold starts|30 minutes|3 GiB|Tailscale|forced reload|draft" docs/ko/v0.3.1-performance-release-checklist.md
```

Expected: every required gate appears.

- [ ] **Step 3: Commit the checklist**

```powershell
git add docs/ko/v0.3.1-performance-release-checklist.md docs/superpowers/plans/2026-08-26-v031-device-results.md
git commit -m "docs: add v0.3.1 device release gates"
```

### Task 5: Run integration and real-device gates

**Files:**
- Modify after measurement: `docs/superpowers/plans/2026-08-26-v031-device-results.md`

- [ ] **Step 1: Run the complete automated suite**

```powershell
pnpm check
pnpm build
pnpm test
pnpm test:compat
pnpm test:performance-contract
pnpm check:standalone-release
```

Expected: every command exits zero. Record test counts and only pre-existing documented build warnings.

- [ ] **Step 2: Run the opt-in large `.risum` harness**

```powershell
$env:RISU_RUN_LARGE_IMPORT='1'
.\node_modules\.bin\vitest.cmd run --config vitest.config.server.ts server/node/large-import-harness.test.ts
Remove-Item Env:RISU_RUN_LARGE_IMPORT
```

Expected: 3 GiB generated stream imports successfully, peak server RSS increase is at most 512 MiB, and owned staging directories are removed.

- [ ] **Step 3: Run and record the iPhone and Android checklists**

Run the exact Task 4 procedure. The release is blocked by any WebKit termination, forced reload, lost draft, partial module, orphaned published asset, startup p95 over 8 seconds, chat selection p95 over 1.5 seconds, or mounted-resource cap violation.

- [ ] **Step 4: Commit content-free results**

```powershell
git add docs/superpowers/plans/2026-08-26-v031-device-results.md
git commit -m "test(perf): record v0.3.1 device validation"
```

### Task 6: Prepare and publish v0.3.1

**Files:**
- Modify: `package.json`
- Create: `patchnote/0.3.1.md`

- [ ] **Step 1: Bump the stable package version**

Change only the package version:

```json
"version": "0.3.1"
```

The lockfile has no root version field and must remain unchanged unless `pnpm install --frozen-lockfile` proves otherwise.

- [ ] **Step 2: Write the user-facing patch note**

Document metadata-first startup, bounded chat/image memory, row-scoped saves, automatic saver mode, server-assisted `.risum`, streaming save-folder import, compatibility behavior, and the reference device profile. Do not promise a universal 1.5 GiB WebKit guarantee.

- [ ] **Step 3: Verify release metadata**

```powershell
pnpm install --frozen-lockfile
pnpm check:standalone-release
node -p "require('./package.json').version"
```

Expected: install and contract checks exit zero; version prints `0.3.1`.

- [ ] **Step 4: Commit the release preparation**

```powershell
git add package.json patchnote/0.3.1.md
git commit -m "chore(release): prepare v0.3.1"
```

- [ ] **Step 5: Obtain final independent review**

Provide reviewers the approved design, all four implementation plans, base SHA, and head SHA. Resolve and re-review every Critical or Important finding. Re-run Task 5 Step 1 after the final code change.

- [ ] **Step 6: Push, open, and merge the pull request**

Push `feat/v0.3.1-performance`, create a PR targeting `main`, wait for every required GitHub check, and merge only after all checks pass.

- [ ] **Step 7: Tag and verify the stable release**

Create tag `v0.3.1` on the exact merge commit. Wait for portable-package and Docker workflows. Verify the latest release API reports `v0.3.1`, stable/non-draft, four portable artifacts, and `update-manifest.json` version `0.3.1` with matching artifact names and hashes.
