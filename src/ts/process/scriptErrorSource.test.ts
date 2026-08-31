import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const scriptings = readFileSync(resolve(process.cwd(), 'src/ts/process/scriptings.ts'), 'utf8')
const triggers = readFileSync(resolve(process.cwd(), 'src/ts/process/triggers.ts'), 'utf8')

/**
 * A Lua error reads `[string "..."]:698: attempt to index a nil value`. It names
 * the line inside an anonymous chunk and nothing else -- not the trigger, not
 * the module that shipped it. A user with several script modules installed has
 * no way to tell which one failed, which is exactly what happened.
 *
 * Read from source: `scriptings.ts` pulls in the Lua engine and cannot be
 * imported under vitest, the same reason the startup contracts in
 * bootstrapStartup.test.ts are written this way.
 */
describe('a failing script says where it came from', () => {
    it('logs the trigger and its module instead of a bare error', () => {
        expect(scriptings).toContain('function describeScriptSource(')
        expect(scriptings).toMatch(/catch \(error\) \{\s*console\.error\(`\[script\] \$\{describeScriptSource\(arg\)\}/)
        // A module id is a UUID on its own, which tells the user nothing.
        expect(scriptings).toContain("getDatabase().modules?.find((item) => item?.id === arg.moduleId)")
        expect(scriptings).toContain('module?.name ?? arg.moduleId')
    })

    it('is given the trigger name by the trigger runner', () => {
        expect(triggers).toMatch(/moduleId: trigger\.moduleId,\s*triggerName: trigger\.comment,/)
    })
})
