# RisuVault v0.3.1 performance checkpoint handoff

Date: 2026-08-26

Branch: `feat/v0.3.1-performance`

Base commit: `3e0cec80dc0820323d321a1a3bb698566c6add59`

Package version at checkpoint: `0.3.0.2` (the `0.3.1` release bump has not been made)

## Purpose

This is a resumable checkpoint, not a release-ready declaration. The branch contains the implemented v0.3.1 startup, runtime-memory, rendering, thumbnail, and large-import work completed so far. Device validation, the opt-in multi-GiB harness, full cross-suite verification, release metadata, PR review, and release publication remain for a later session.

## Resume in a new session

```powershell
git fetch origin
git switch feat/v0.3.1-performance
git pull --ff-only
```

Use these plans as the source of truth:

- `docs/superpowers/plans/2026-08-26-v031-startup-hydration-implementation.md`
- `docs/superpowers/plans/2026-08-26-v031-runtime-persistence-rendering-implementation.md`
- `docs/superpowers/plans/2026-08-26-v031-large-imports-implementation.md`
- `docs/superpowers/plans/2026-08-26-v031-validation-release-implementation.md`

Recommended opening prompt for the next session:

> Continue RisuVault v0.3.1 from `docs/superpowers/plans/2026-08-26-v031-checkpoint-handoff.md` on branch `feat/v0.3.1-performance`. Use Terra/medium subagents for implementation and independent review. Start by checking branch status and fresh verification, then complete Large Import Tasks 9-10 and the validation/release plan. Do not rewrite history or amend shared commits.

## Completed at this checkpoint

### Startup and bounded SQL hydration

- Metadata-first Node SQL bootstrap replaces the normal full `/api/sql/snapshot` startup path.
- Character detail and reverse message pages are loaded through bounded authenticated reads.
- Initial chat window is the newest 40 messages; hydrated chat bodies are limited by a global two-chat LRU.
- Partial histories are protected from destructive SQL manifests, exports, cloning, recovery, and plugin APIs.
- Degraded recovery remains explicit; unsupported/old-server bootstrap errors do not silently take the unsafe path.

### Runtime persistence and responsiveness

- Dirty Registry and row-scoped SQL commits replace whole-database clone/delta work in normal metadata-first operation.
- Retry, conflict observation, sparse message positions, deletes, preset ordering, and mutation-site dirty marking are covered.
- Chat DOM uses stable message IDs and a 60-row normal / 40-row saver window with bounded reverse-page anchoring.
- Streaming display uses latest-value requestAnimationFrame batching with durable character/chat/message lookup and abort-safe teardown.
- Runtime metrics use fixed, content-free public names and per-invocation internal marks to avoid concurrent measurement races.

### Automatic saver mode and media

- Automatic Saver Mode reacts to lifecycle, long-task/cache pressure, and heavy import/export scopes.
- Saver entry flushes persistence before eviction/cache reclamation; exit uses a 30-second quiet period and is retry-safe.
- Server thumbnails are WebP, source/transform fingerprinted, metadata-revalidated, concurrency limited, and byte-bounded.
- Mobile/Simple character list virtualization uses fixed rows, overscan, stable keys, and focus retention.

### Large imports and uploads

- CharX hotfix work remains in history, including prefixed archive support and correct published asset keys.
- Common disk spool and RPack range decoder use bounded chunks, fsync, abort cleanup, and explicit size/disk errors.
- Node `.risum` import is disk-backed and streams the original browser `File` to an authenticated NDJSON route.
- `.risum` metadata/assets are decoded, hashed, quota-checked, deduplicated, and published only after validation.
- File-KV staged full replacement prepares every object before one manifest swap, preserves queued mutations, and guards GC/alias races.
- Save-folder ZIP migration no longer uses `Buffer.concat` or whole-archive `fflate.unzip`; it validates ZIP structure/security/CRC/limits, extracts sequentially to disk, and publishes once.
- Save-folder progress is throttled/backpressured on the server and incrementally parsed by the client.
- Node asset values larger than 8 MiB use a raw binary upload rather than JSON/Base64; the route is size/headroom/abort/timeout safe.

## Final reviewed checkpoints

The following feature groups received independent Critical/Important review and passed after follow-up fixes:

- Startup Tasks 1-6
- Runtime Tasks 1-9
- Large Import Tasks 1-7
- Large Import Task 8, including the slow-upload timeout follow-up

Representative recent commits:

- `43cbe30` — isolate concurrent runtime marks
- `586110f` — recover failed Saver Mode exit and cover heavy scopes
- `1c47b9a` — enforce `.risum` limits on every decoded chunk
- `83f5ba1` / `74e9aa0` / `c134d78` — server and client `.risum` streaming integration
- `175d372` / `6125e7d` — atomic staged file-KV replacement and serialization
- `ed0480c` / `87d4fa0` — disk-streaming save-folder ZIP and bounded progress streams
- `1ee641b` / `3b83d4e` — raw large-asset uploads and slow-upload timeout safety

## Verification already run during implementation

Focused suites were run after each slice. Most recent reported gates include:

- Runtime metrics focused tests: 34/34 after concurrency fix; `pnpm check` 0 errors/warnings.
- Saver/import scope focused tests: 43 passing; `pnpm check` 0 errors/warnings.
- Disk spool + RPack: 32 passing.
- `.risum` parser/RPack: 38 passing.
- `.risum` route/client integration: 32 passing; `pnpm check` 0 errors/warnings.
- File-KV staged replacement: 24/24; `pnpm check` 0 errors/warnings.
- Save-folder ZIP focused server tests: 9/9; incremental client parser: 2/2; `pnpm check` 0 errors/warnings.
- Raw asset upload before timeout follow-up: server 8/8, client 2/2; timeout follow-up server 12/12; `pnpm check` 0 errors/warnings.

These are slice-level results. They do not replace the fresh checkpoint/full-suite run described below.

## Remaining work

### 1. Finish Large Import Tasks 9-10

- Add the opt-in, disk-generated 3 GiB regression harness without committing large fixtures.
- Run the consolidated large-import verification and independent final review.
- Re-run `test/compat/remote-block-migration.test.ts` in a clean server fixture. During Task 7 work it showed cascading failures after the first integration case; reviewers believed the pattern was environment/cross-test-state related, but this has not been conclusively closed.

### 2. Fresh repository-wide gates

Run separately and record exact results:

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm build
pnpm test
pnpm test:compat
pnpm test:server
pnpm check:standalone-release
git diff --check
```

Do not claim release readiness if any command fails. Classify pre-existing warnings separately, but fix all regressions introduced by this branch.

### 3. Device/manual validation

Not run in this session:

- iPhone 13 or newer, iOS 17+, Safari/PWA over Tailscale: 10 cold starts, target interactive list <=5s and p95 <=8s.
- Chat switch p95 <=1.5s; reverse history loading and streaming without anchor jumps or lost drafts.
- 30-minute navigation/image/chat stress with no WebKit termination/reload; keep practical process usage below the 1.5 GiB WebKit ceiling through automatic degradation (not an absolute OS-level guarantee).
- Android Chrome: CharX, multi-GiB `.risum`, chat, thumbnail, and save-folder migration regressions.
- Generated 3 GiB `.risum`/save-folder fixtures with bounded client memory and bounded server RSS/disk-headroom behavior.

### 4. Release work

- Decide/finalize version `0.3.1` only after all gates pass.
- Update package/release metadata and lockfile only where the repository format requires it.
- Prepare release notes describing metadata-first startup, row-scoped persistence, automatic saver mode, bounded rendering/media, and streamed imports.
- Open a PR from `feat/v0.3.1-performance`, let CI/review complete, merge through the repository's normal policy, then tag/publish the release.
- Do not publish or mark latest before updater/standalone artifacts and device gates pass.

## Known constraints and decisions

- The 1.5 GiB target is an application design budget, not a hard WebKit process guarantee; decoded images/GPU/browser overhead are outside direct JS control.
- Recent devices are the primary target. Automatic Saver Mode is preferred over a permanent low-memory UI.
- No whole-schema migration was introduced. The existing relational schema is used through bounded reads and row-scoped commits.
- Browser-only `.risum` local decode is allowed only up to 128 MiB; larger modules require Node mode to avoid browser OOM.
- Standard non-ZIP64 save-folder archives are supported by the new bounded ZIP importer; ZIP64 remains deliberately rejected.
- Character virtualization at this checkpoint covers the Mobile/Simple catalog mode, not every desktop grid/detail/trash presentation.

## Git safety for continuation

- Use additive commits only. Do not amend/rebase the shared branch: an earlier concurrent amend race was already recovered.
- Before staging, run `git status --short` and stage only the current task's files; multiple subagents share one worktree.
- Preserve the worktree until PR feedback is complete.
