import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const sideChatList = readFileSync(resolve(
    process.cwd(),
    'src/lib/SideBars/SideChatList.svelte'
), 'utf8')
const chat = readFileSync(resolve(
    process.cwd(),
    'src/lib/ChatScreens/Chat.svelte'
), 'utf8')
const globalApi = readFileSync(resolve(
    process.cwd(),
    'src/ts/globalApi.svelte.ts'
), 'utf8')

describe('chat memory fork connections', () => {
    test('full copy awaits the memory fork before inserting or reporting success', () => {
        const flow = sideChatList.slice(
            sideChatList.indexOf('async function copyChatWithMemory'),
            sideChatList.indexOf('const createStb')
        )
        expect(flow.indexOf('await forkMemoryWiki'))
            .toBeLessThan(flow.indexOf('chara.chats.unshift(newChat)'))
        expect(flow.indexOf('chara.chats.unshift(newChat)'))
            .toBeLessThan(flow.indexOf('rejectOnFailure: true'))
        expect(flow).toContain("action: 'discard'")
        expect(flow.indexOf("action: 'finalize'"))
            .toBeLessThan(flow.indexOf('changeChatTo(0)'))
        expect(flow.indexOf("action: 'finalize'"))
            .toBeLessThan(flow.indexOf('notifySuccess(language.copyChatSuccess)'))
    })

    test('historical branch starts without copied wiki state before mutating chats', () => {
        expect(chat).toContain('forkMemoryWiki')
        const call = chat.lastIndexOf('await forkMemoryWiki')
        expect(call).toBeGreaterThan(0)
        expect(call).toBeLessThan(chat.indexOf(
            'if(DBState.db.createFolderOnBranch',
            call
        ))
        expect(call).toBeLessThan(chat.indexOf(
            '.chats.unshift(newChat)',
            call
        ))
        expect(chat).toContain('retainedMessageIds')
        expect(chat).toContain('isHistoricalBranch')
        expect(chat).toContain('resetImportedBardWikiState(newChat)')
        expect(chat).toContain('if(!historicalBranch)')
        expect(chat).toContain('language.bardWikiHistoricalBranchCreated')
        expect(chat).toContain('await requestImmediateSave({')
        expect(chat).toContain('rejectOnFailure: true')
        expect(chat).toContain("action: 'discard'")
        const finalize = chat.indexOf("action: 'finalize'", call)
        expect(finalize).toBeGreaterThan(chat.indexOf(
            'rejectOnFailure: true',
            call
        ))
        expect(finalize).toBeLessThan(chat.indexOf('changeChatTo(0)', call))
    })

    test('immediate saves can propagate persistence failures to fork callers', () => {
        expect(globalApi).toContain('rejectOnFailure?: boolean')
        expect(globalApi).toContain('if (options?.rejectOnFailure)')
        expect(globalApi).toContain('throw error')
    })
})
