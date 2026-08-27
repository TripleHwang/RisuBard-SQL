import { describe, expect, test, vi } from 'vitest'
import {
    beginWikiRebootBatch,
    cleanupWikiRebootWorkspace,
    completeWikiRebootBatch,
    prepareWikiRebootReplacement,
    recoverWikiRebootBatch,
    recordWikiRebootBatchReceipt,
} from './wikiRebootTransport'

const response = (value: unknown) => new Response(JSON.stringify(value), {
    status: 200, headers: { 'content-type': 'application/json' },
})

describe('BardWiki reboot transport', () => {
    test('prepares an atomic staging replacement', async () => {
        const fetchImpl = vi.fn(async () => response({
            mode: 'copy', sourceExists: true, destinationChatId: 'chat',
            warnings: [], forkToken: 'token',
        })) as unknown as typeof fetch
        await expect(prepareWikiRebootReplacement({
            characterId: 'character', stagingChatId: 'reboot-job', chatId: 'chat',
            fetchImpl, createAuth: async () => 'auth',
        })).resolves.toMatchObject({ forkToken: 'token' })
        expect(JSON.parse(String(vi.mocked(fetchImpl).mock.calls[0][1]?.body)))
            .toEqual({
                characterId: 'character', sourceChatId: 'reboot-job',
                destinationChatId: 'chat',
            })
    })

    test('cleans staging and recovers a persisted batch receipt', async () => {
        const receipt = {
            sourceMessageIds: ['u1', 'a1'],
            eventIds: ['event-1'], changes: [], warnings: [], recordedAt: 'now',
        }
        const fetchImpl = vi.fn()
            .mockResolvedValueOnce(response({ removed: true }))
            .mockResolvedValueOnce(response({ receipt })) as unknown as typeof fetch
        await expect(cleanupWikiRebootWorkspace({
            characterId: 'character', stagingChatId: 'reboot-job',
            fetchImpl, createAuth: async () => 'auth',
        })).resolves.toEqual({ removed: true })
        await expect(recoverWikiRebootBatch({
            characterId: 'character', stagingChatId: 'reboot-job',
            sourceMessageIds: ['u1', 'a1'], eventSourceGroups: [['u1', 'a1']],
            fetchImpl, createAuth: async () => 'auth',
        })).resolves.toEqual(receipt)
    })

    test('begins, records, and completes one bounded reboot batch', async () => {
        const receipt = {
            sourceMessageIds: ['u1', 'a1'], eventIds: [], changes: [],
            warnings: [], recordedAt: 'now',
        }
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(response({ canonicalCount: 3 }))
            .mockResolvedValueOnce(response(receipt))
            .mockResolvedValueOnce(response({ removed: true }))
        const fetchImpl = fetchMock as unknown as typeof fetch
        const base = {
            characterId: 'character', stagingChatId: 'reboot-job',
            fetchImpl, createAuth: async () => 'auth',
        }
        await expect(beginWikiRebootBatch({
            ...base, sourceMessageIds: ['u1', 'a1'],
            eventSourceGroups: [['u1', 'a1']],
        })).resolves.toEqual({ canonicalCount: 3 })
        await expect(recordWikiRebootBatchReceipt({
            ...base, receipt,
        })).resolves.toEqual(receipt)
        await expect(completeWikiRebootBatch({
            ...base, sourceMessageIds: ['u1', 'a1'],
        })).resolves.toEqual({ removed: true })
        expect(vi.mocked(fetchImpl).mock.calls.map((call) => call[0])).toEqual([
            '/api/risubard/memory/wiki/reboot/begin',
            '/api/risubard/memory/wiki/reboot/record',
            '/api/risubard/memory/wiki/reboot/complete',
        ])
    })
})
