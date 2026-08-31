import { svelte } from '@sveltejs/vite-plugin-svelte'
import { defineConfig } from 'vitest/config'

/**
 * Measurement runs, kept out of `pnpm test`.
 *
 * These files print numbers rather than asserting budgets, and some of them
 * build databases large enough to take tens of seconds. They are run on
 * purpose:
 *
 *   npx vitest run --config vitest.config.perf.ts
 */
export default defineConfig({
    plugins: [svelte()],
    resolve: {
        alias: { src: '/src' },
        conditions: ['browser'],
    },
    test: {
        environment: 'node',
        include: ['scripts/perf/**/*.bench.ts'],
        testTimeout: 600_000,
        // One file at a time: these measure wall time, and parallel workers
        // sharing cores would make every number a measurement of the scheduler.
        fileParallelism: false,
        pool: 'forks',
        maxForks: 1,
        minForks: 1,
    },
})
