# Editable theme tokens implementation plan

> **For agentic workers:** Use focused, non-overlapping worker tasks and review each result. Work directly in the current public checkout; do not create worktrees or commit unrelated work.

**Goal:** Make application-owned UI colors editable and theme-aware, including binding states and dialogue with legacy custom colors.

**Architecture:** Keep the existing ColorScheme and --risu-theme-* runtime bridge. Add optional uiColors overrides backed by a typed semantic registry and --color-* declarations in styles.css. Replace fixed chrome colors with these tokens; preserve user-authored content palettes and standalone export colors. Resolve text themes in a pure module, with optional rendered-only contrast correction.

**Tech Stack:** Svelte 5, TypeScript, Tailwind 4, Vitest/happy-dom.

## 1. Runtime token registry

Files: src/ts/gui/uiThemeTokens.ts, colorscheme.ts, colorschemeRuntime.test.ts, src/styles.css.

- [x] Add failing runtime tests: Light/Dark binding/background/text contrast, semantic foreground/background pairs, custom override reapplication, malformed old overrides falling back safely.
- [x] Run `pnpm exec vitest run src/ts/gui/colorschemeRuntime.test.ts` and confirm missing CSS-token assertions fail.
- [x] Define `ColorScheme.uiColors?: Partial<Record<UiThemeToken, string>>`; metadata has token, group, English/Korean label, dark/light defaults. Roles: binding, info, success, warning, danger, secondary, on-color foregrounds, overlays, shadows, media, switch thumb.
- [x] Apply all resolved tokens inside updateColorScheme, alongside existing palette variables. Declare matching --color-* aliases in styles.css. Custom values survive JSON export/import and built-ins reset overrides by selecting their palette.
- [x] Run the runtime, palette, and token-contract suites.

## 2. Editable skin and dialogue options

Files: src/lib/Setting/Pages/Display/CustomColorSchemeEditor.svelte, CustomTextThemeEditor.svelte, src/ts/setting/displaySettingsData.svelte.ts, src/ts/storage/database.svelte.ts, src/ts/gui/textTheme.ts, textTheme.test.ts.

- [x] Add failing resolver tests for legacy #FFB86C on light backgrounds, correct mode-specific missing quote defaults, opt-out, known-good colors preserved, and unknown text-theme fallback.
- [x] Implement `resolveTextTheme(theme, type, custom, {autoContrast, backgrounds})`; adjustments affect rendered CSS values only, never the custom source object.
- [x] Add optional textThemeAutoContrast to database/theme presets; absent means true. Save/apply round-trips the preference.
- [x] Expose skin editor for built-ins too. Editing first copies the current palette to Custom; grouped color fields and reset controls cover every registry token and base field. Opening the editor must not mutate the selected preset.
- [x] Expose dialogue fields (body, italic, bold, italic-bold, single/double quote), auto-contrast toggle and live sample; editing converts the current resolved text palette to Custom. A reset returns to theme-aware standard.
- [x] Add component/runtime/persistence regression tests and run them.

## 3. Application chrome migration

Files: src/lib application components, src/styles.css, app-owned style-producing src/ts code, src/lib/UI/GUI/RawUiColors.test.ts and ThemeTokenContract.test.ts.

- [x] Add failing raw-color/utility contract assertions before migration.
- [x] Use `binding` variant for pinned prompt/persona/toggle states: bg-binding text-binding-text border-binding-border. Solid primary buttons use text-accenttext.
- [x] Replace hardcoded utility palette colors by purpose: info, secondary, warning, danger, success, theme neutral surfaces/text. Pair solid fills with on-color foregrounds. Use media tokens where photos require a stable scrim/foreground.
- [x] Convert raw hex/rgb/named UI colors to --color-* or color-mix; do not use undefined variable aliases. Keep explicit authored palettes, previews of saved colors, brand artwork, and file-export values as narrowly documented exceptions.
- [x] Run affected component tests; review all replacement categories and remaining hits, not just search counts.
- [x] Replace bundled fixed tooltip/highlight palettes and Monaco's default dark theme; refresh the open code editor when its palette changes.

## 4. Verification and handoff

- [x] Verify runtime and settings edit/reset/import behavior for Light, Dark, and Custom.
- [x] Run the 12 focused runtime/palette/text/persistence/settings/binding/token-audit/tooltip/Monaco suites: 112 tests passed. Affected component suites were also tested during migration.
- [x] Run `pnpm check` and distinguish pre-existing errors from this change; compile frontend if broad CSS migration warrants it.
- [x] Inspect actual rendered light/dark UI and dialogue where the browser is available; never claim browser verification from unit tests alone.
- [x] Review changed files, preserve existing dirty work, run git diff --check, and report exact tested scope plus any content-style exceptions.

## Verification notes

- `pnpm build`: passed (26.61s), including the final tooltip and Monaco changes. Existing CSS-minifier/dependency/chunk-size warnings remain.
- `pnpm check`: one pre-existing error in `src/lib/SideBars/LoreBook/LoreBookWorkspace.test.ts:350` (`onChange.mock` on a mock/function union); no theme-change errors or warnings. The unrelated test was not changed by this task.
- `git -c core.safecrlf=false diff --check`: passed. The temporary browser verification server was stopped after testing.
- Browser verification used an isolated fixture with production Svelte components and an in-memory database; it did not touch user data. Verified Light/Dark/Pastel-to-Custom bindings, legacy dialogue contrast and opt-out, color edits, preserved Pastel button styling, and syntax highlighting.
- Monaco rendered a white Light surface and a dark Dark surface; editing the panel background to `#152a24` immediately changed the open editor to `rgb(21, 42, 36)`.
- Full application startup was unavailable in the frontend-only environment because the backend response was missing. Persistence and import/reset behavior were covered by automated tests, not claimed as a full-app browser session.
- Review corrections cover inactive text backdrops, active custom/waifu surfaces, inherited Pastel styling, and alpha-preserving color inputs. Contrast over an arbitrary image remains a best-effort estimate of the configured backdrop, not a pixel-by-pixel guarantee.
- Card-authored HTML/CSS, saved content palettes, branded artwork, and standalone export colors remain intentionally unchanged.
