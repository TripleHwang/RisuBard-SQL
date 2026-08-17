import { createRequire } from 'node:module'
import { describe, expect, test, vi } from 'vitest'

const require = createRequire(import.meta.url)

describe('revealLocalFile', () => {
    test('selects the exact file in Windows Explorer without a command shell', () => {
        const child = { unref: vi.fn() }
        const spawnImpl = vi.fn(() => child)
        const { revealLocalFile } = require('./reveal-local-file.cjs')

        revealLocalFile('E:\\wiki\\characters\\라비안.md', {
            platform: 'win32',
            spawnImpl,
        })

        expect(spawnImpl).toHaveBeenCalledWith(
            'explorer.exe',
            ['/select,', 'E:\\wiki\\characters\\라비안.md'],
            { detached: true, stdio: 'ignore', windowsHide: true }
        )
        expect(child.unref).toHaveBeenCalledOnce()
    })
})
