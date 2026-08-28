import { svelte } from "@sveltejs/vite-plugin-svelte"
import { defineConfig } from 'vitest/config'
import { existsSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'

const emptyModule = fileURLToPath(new URL('./test/stubs/empty-module.ts', import.meta.url))

/**
 * bits-ui 2.17.3 re-exports type-only modules as runtime ones -- dist/index.js
 * has `export * from "./types.js"` and dist/shared/index.js has the same for
 * "./types.js" and "./attributes.js" -- but ships no matching .js files.
 * Rollup erases those specifiers during the app build; Vite's SSR transform,
 * which vitest uses, resolves them eagerly and fails the entire module graph,
 * taking every test that touches a bits-ui component with it.
 *
 * Only redirect specifiers that genuinely have no file on disk, so a real
 * bits-ui module is never silently replaced by an empty one.
 */
const bitsUiTypeOnlyReexports = {
  name: 'bits-ui-type-only-reexports',
  enforce: 'pre' as const,
  resolveId(source: string, importer?: string) {
    if (!importer?.includes('bits-ui') || !source.startsWith('./')) return null
    return existsSync(resolvePath(dirname(importer), source)) ? null : emptyModule
  },
}


export default defineConfig({
  plugins: [
    bitsUiTypeOnlyReexports,
    svelte(),
  ],
  resolve: {
    alias: {
      src: '/src',
    },
    conditions: ['browser'],
  },
  test: {
    environment: 'happy-dom',
    setupFiles: ['vitest.setup.ts'],
    // File-local teardown must run before the shared post-test cleanup below.
    sequence: { hooks: 'stack' },
    // compat/server suites have their own node-environment configs
    // (vitest.config.compat.ts / vitest.config.server.ts); exclude here so
    // `pnpm test` doesn't pick them up under the wrong environment.
    exclude: ['node_modules/**', 'test/compat/**', 'server/node/**'],
  },
})
