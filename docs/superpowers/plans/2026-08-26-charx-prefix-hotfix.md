# CharX Prefix Archive Hotfix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow the NodeOnly CharX importer to accept structurally valid ZIP archives preceded by a JPEG or other byte prefix, while retaining strict central-directory validation.

**Architecture:** Derive one non-negative archive offset bias from the EOCD's actual position, declared central-directory size, and declared central-directory offset. Validate the central directory at the biased position and apply the exact same bias to every local-header offset; all existing entry, boundary, CRC, path, and limit checks remain mandatory.

**Tech Stack:** Node.js CommonJS, TypeScript Vitest, fflate ZIP fixtures

---

### Task 1: Accept consistently prefixed CharX ZIP archives

**Files:**
- Modify: `server/node/charx-import.cjs:74-108`
- Test: `server/node/charx-import.test.ts`

- [ ] **Step 1: Write the failing prefixed-archive test**

Add a test that prepends JPEG-like bytes to a normal `zipSync` archive without rewriting the ZIP-relative offsets. Import it through `importCharXStream`, then assert the card and asset mapping are returned and publishing occurs.

```ts
test('imports a valid ZIP with a JPEG prefix using one consistent offset bias', async () => {
  const stagingRoot = await mkdtemp(join(tmpdir(), 'charx-test-'));
  const archive = zipSync({
    'card.json': strToU8('{"spec":"chara_card_v3","name":"Prefixed"}'),
    'a.png': strToU8('pixels'),
  });
  const prefixed = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]), archive]);
  let published = 0;
  try {
    const result = await importCharXStream(chunks(prefixed), {
      stagingRoot,
      publishAssets: async () => { published += 1; },
    });
    expect(result.card.name).toBe('Prefixed');
    expect(result.assets['a.png']).toMatch(/^assets\/[a-f0-9]{64}\.png$/);
    expect(published).toBe(1);
  } finally { await rm(stagingRoot, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.server.ts server/node/charx-import.test.ts -t "imports a valid ZIP with a JPEG prefix"
```

Expected: FAIL with `Invalid ZIP central directory`.

- [ ] **Step 3: Implement the minimal consistent offset-bias validation**

In `validateCentralDirectory`, calculate:

```js
const actualCentralOffset = eocdOffset - centralSize;
const offsetBias = actualCentralOffset - centralOffset;
```

Reject a negative bias or any disk/count inconsistency. Start reading central records at `actualCentralOffset`, keep the declared central size as the exact boundary, and translate every central-directory local offset with `localOffset + offsetBias`. Validate every translated local header and data boundary exactly as before. Do not scan for arbitrary signatures and do not weaken encryption, method, ZIP64, name, CRC, count, or size checks.

- [ ] **Step 4: Add a forged-inconsistent-bias rejection test**

Create a valid prefixed archive, alter one central entry's local offset so that it does not point to a valid local header after the shared bias, and assert `INVALID_CHARX` with no publish call.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node node_modules/vitest/vitest.mjs run --config vitest.config.server.ts server/node/charx-import.test.ts
```

Expected: all tests pass, including the two new prefix tests.

- [ ] **Step 6: Validate the supplied 138,974,195-byte sample without publishing content**

Run `importCharXStream` against `C:/Users/choi/Downloads/aaaa.charx` with a temporary staging root and a no-op `publishAssets`. Report only success, byte count, entry-derived asset count, and warning count; never print card or asset contents.

- [ ] **Step 7: Commit the hotfix**

```powershell
git add server/node/charx-import.cjs server/node/charx-import.test.ts docs/superpowers/plans/2026-08-26-charx-prefix-hotfix.md
git commit -m "fix(server): accept prefixed CharX archives"
```

### Task 2: Verify and publish RisuVault v0.3.0-hotfix1 (`0.3.0.1` internally)

**Files:**
- No production files beyond Task 1

- [ ] **Step 1: Run server, compatibility, client checks, and production build**

Run the repository's server and compatibility Vitest configurations, `pnpm check`, and `pnpm build`. All commands must exit zero; existing documented build warnings may remain.

- [ ] **Step 2: Obtain independent spec and code-quality approval**

Review the diff against this plan, with special attention to arbitrary signature scanning, integer/bounds safety, unchanged zero-prefix behavior, and forged offset rejection. Resolve all Critical and Important findings and re-run focused tests.

- [ ] **Step 3: Push, create and merge the pull request**

Push `hotfix/charx-prefix-archive`, create a PR targeting `main`, wait for required checks, and merge only when checks and reviews pass.

- [ ] **Step 4: Publish RisuVault v0.3.0-hotfix1**

Create the repository's standard release tag `v0.3.0.1` and artifacts/update manifest using the internal stable version `0.3.0.1`. After the workflow succeeds, use GitHub's release edit for tag `v0.3.0.1` to rename the generated draft from `RisuVault v0.3.0.1` to the public title **RisuVault v0.3.0-hotfix1**, then publish it as the latest stable release while retaining `0.3.0.1` for the internal package, tag, and update manifest. This numeric fourth segment is deliberately used because the already-installed v0.3.0 updater compares `0.3.0-hotfix1` as an older prerelease, whereas its existing version comparison recognizes `0.3.0.1` as newer than `0.3.0`.
