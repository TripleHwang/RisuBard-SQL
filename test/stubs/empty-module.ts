/**
 * bits-ui 2.17.3 ships `export * from "./types.js"` in its dist entry, but only
 * `types.d.ts` exists -- the re-export is type-only and has no runtime file.
 * Rollup erases it during the app build; Vite's SSR transform (which vitest
 * uses) resolves it eagerly and fails. Aliasing it to an empty module is exact:
 * the module contributes no runtime bindings either way.
 */
export {}
