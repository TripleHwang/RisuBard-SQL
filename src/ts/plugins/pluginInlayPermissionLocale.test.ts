import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

describe('plugin inlay permission localization', () => {
    test('declares the dedicated inlay consent text in every shipped language', async () => {
        for (const language of ['en', 'ko', 'cn', 'de', 'es', 'vi', 'zh-Hant']) {
            const dictionary = await readFile(
                `src/lang/${language}.ts`,
                'utf8',
            )
            expect(dictionary).toContain('inlayPermissionConsent')
        }
    })
})
