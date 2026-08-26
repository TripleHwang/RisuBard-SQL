import { describe, expect, it, vi } from 'vitest'
vi.mock('./nodeStorage', () => ({ NodeStorage: class {} }))
import { AutoStorage } from './autoStorage'

describe('AutoStorage.importRisum', () => {
    it('forwards the original File and progress callback to NodeStorage', async () => {
        const storage = new AutoStorage()
        const file = new File(['archive'], 'module.risum')
        const importRisum = vi.fn().mockResolvedValue({ module: { id: 'module' }, assets: 0 })
        storage.realStorage = { importRisum } as any
        const progress = vi.fn()

        await expect(storage.importRisum(file, progress)).resolves.toMatchObject({ module: { id: 'module' } })
        expect(importRisum).toHaveBeenCalledWith(file, progress)
    })
})
