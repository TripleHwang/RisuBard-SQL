# Modal Surface Unification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every modal use one theme-safe overlay, surface, header, and close-button visual contract without changing modal behavior or sizing.

**Architecture:** Define four semantic modal classes in `src/styles.css`, consume them in the three shared dialog primitives, and attach them to legacy modal implementations that cannot yet be migrated to Bits UI safely. A source contract test inventories every supported modal family and prevents visual drift.

**Tech Stack:** Svelte 5, TypeScript, Tailwind CSS v4 theme tokens, Bits UI, Vitest

---

### Task 1: Shared modal visual contract

**Files:**
- Create: `src/lib/UI/GUI/ModalSurfaceContract.test.ts`
- Modify: `src/styles.css`
- Modify: `src/lib/UI/GUI/ShDialog.svelte`
- Modify: `src/lib/UI/GUI/ShAlertDialog.svelte`
- Modify: `src/lib/UI/GUI/ShLoadingDialog.svelte`

- [ ] **Step 1: Write the failing shared-contract test**

```ts
test('shared dialog primitives use the canonical modal classes', () => {
  for (const file of ['ShDialog.svelte', 'ShAlertDialog.svelte', 'ShLoadingDialog.svelte']) {
    const source = read(file)
    expect(source).toContain('risu-modal-overlay')
    expect(source).toContain('risu-modal-surface')
  }
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/lib/UI/GUI/ModalSurfaceContract.test.ts`

Expected: FAIL because the semantic classes do not exist yet.

- [ ] **Step 3: Add the canonical classes and wire the primitives**

```css
.risu-modal-overlay {
  background: color-mix(in srgb, var(--color-overlay) 58%, transparent);
  backdrop-filter: blur(4px);
}
.risu-modal-surface {
  color: var(--color-textcolor);
  background: var(--color-darkbg);
  border: 1px solid var(--color-darkborderc);
  border-radius: 1rem;
  box-shadow: 0 1.5rem 4rem color-mix(in srgb, var(--color-shadow) 32%, transparent);
}
.risu-modal-header {
  padding-bottom: .85rem;
  border-bottom: 1px solid color-mix(in srgb, var(--color-darkborderc) 72%, transparent);
}
.risu-modal-close {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  place-items: center;
  border-radius: 999px;
  color: var(--color-textcolor2);
}
```

Add `risu-modal-overlay` to each shared overlay, `risu-modal-surface` to each shared content surface, `risu-modal-header` to the standard header, and `risu-modal-close` to the standard close control.

- [ ] **Step 4: Run the shared contract and theme token tests**

Run: `npx vitest run src/lib/UI/GUI/ModalSurfaceContract.test.ts src/lib/UI/GUI/ThemeTokenContract.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/styles.css src/lib/UI/GUI/ShDialog.svelte src/lib/UI/GUI/ShAlertDialog.svelte src/lib/UI/GUI/ShLoadingDialog.svelte src/lib/UI/GUI/ModalSurfaceContract.test.ts docs/superpowers/plans/2026-08-27-modal-surface-unification.md
git commit -m "style: define shared modal surface contract"
```

### Task 2: Legacy modal adoption

**Files:**
- Modify: `src/lib/Others/AlertComp.svelte`
- Modify: `src/lib/Others/BookmarkList.svelte`
- Modify: `src/lib/Others/ChatList.svelte`
- Modify: `src/lib/Others/HypaV3Modal.svelte`
- Modify: `src/lib/Others/HypaV3Modal/category-manager-modal.svelte`
- Modify: `src/lib/Others/HypaV3Modal/tag-manager-modal.svelte`
- Modify: `src/lib/Others/LoadingOverlay.svelte`
- Modify: `src/lib/Others/PersonaManager.svelte`
- Modify: `src/lib/Others/PluginAlertModal.svelte`
- Modify: `src/lib/Others/PopupEditor.svelte`
- Modify: `src/lib/Others/PromptDiffModal.svelte`
- Modify: `src/lib/FirstMessageStudio/FirstMessageStudioEditor.svelte`
- Modify: `src/lib/ChatScreens/PartialEditController.svelte`
- Modify: `src/lib/Setting/listedHypaV3Preset.svelte`
- Modify: `src/lib/Setting/listedPersona.svelte`
- Modify: `src/lib/Setting/lorepreset.svelte`
- Modify: `src/lib/Setting/modelpreset.svelte`
- Modify: `src/lib/Setting/modelProfileBrowser.svelte`
- Modify: `src/lib/Setting/themepreset.svelte`
- Modify: `src/lib/Setting/Pages/Module/ModuleChatMenu.svelte`
- Modify: `src/lib/UI/ModelList.svelte`
- Modify: `src/lib/UI/ModelPresetList.svelte`
- Modify: `src/lib/UI/OpenrouterProviderList.svelte`
- Test: `src/lib/UI/GUI/ModalSurfaceContract.test.ts`

- [ ] **Step 1: Extend the inventory test and verify RED**

Add the exact files above to a `legacyModalFiles` array. Require `risu-modal-overlay` in each file and `risu-modal-surface` in every file that renders a panel rather than a spinner-only loading state. Run the contract test and expect the inventory assertions to fail.

- [ ] **Step 2: Apply semantic classes without changing behavior**

For every backdrop opening tag, add `risu-modal-overlay`. For every modal panel opening tag, add `risu-modal-surface`. Add `risu-modal-header` to visible title/action rows and `risu-modal-close` to their close buttons. Keep existing width, height, overflow, z-index, click handling, resizers, and full-screen mobile media rules unchanged.

- [ ] **Step 3: Remove conflicting bespoke surface treatments**

Change `CharacterVaultDialog.svelte` and `RisuBardSaveSlotsDialog.svelte` outer gradients to `var(--color-darkbg)`. Change the local Persona Manager and First Message Studio backdrop/surface declarations to the same overlay and surface token values while preserving their scoped layout rules.

- [ ] **Step 4: Run the contract test**

Run: `npx vitest run src/lib/UI/GUI/ModalSurfaceContract.test.ts`

Expected: PASS with every inventoried modal using the shared contract.

- [ ] **Step 5: Commit**

```bash
git add src/lib src/lib/UI/GUI/ModalSurfaceContract.test.ts
git commit -m "style: unify legacy modal surfaces"
```

### Task 3: Verification

**Files:**
- Test: `src/lib/UI/GUI/ModalSurfaceContract.test.ts`
- Test: `src/lib/UI/GUI/ThemeTokenContract.test.ts`

- [ ] **Step 1: Run focused UI tests**

Run: `npx vitest run src/lib/UI/GUI/ModalSurfaceContract.test.ts src/lib/UI/GUI/ThemeTokenContract.test.ts src/lib/UI/GUI/DialogLayering.test.ts src/lib/UI/GUI/DialogFocusPolicy.test.ts`

Expected: PASS.

- [ ] **Step 2: Run Svelte diagnostics**

Run: `npx svelte-check --tsconfig ./tsconfig.json`

Expected: 0 errors and 0 warnings.

- [ ] **Step 3: Run the full test suite**

Run: `npm test`

Expected: all client and server tests pass.

- [ ] **Step 4: Inspect and commit any verification-only correction**

Run: `git diff --check` and commit only if a correction was required.
