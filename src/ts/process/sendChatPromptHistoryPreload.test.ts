import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * `sendChat` cannot be executed under test -- it reaches the whole application
 * graph -- so the repo checks its invariants against its source, the same way
 * `sendChatFailureCleanup.test.ts` does. What is checked here is an ordering
 * property, and ordering is exactly what the source can prove.
 *
 * The property: the prompt-history preload is the FIRST await in `sendChat`,
 * and between it and the point where the function re-reads the selected chat
 * out of `DBState` there is a check that it is still the same chat.
 *
 * Before the preload, the window guard and the read of the chat the prompt is
 * built from sat in one synchronous block, so they could not disagree. The
 * preload puts several HTTP round trips between them. A reader who switches
 * chats while those pages are in the air would otherwise have the send build
 * its prompt from a chat that was never preloaded -- one sitting on its opening
 * 40 messages -- which is the silent truncation the whole guard exists to stop.
 */
describe('sendChat prompt-history preload', () => {
    const source = readFileSync(
        resolve(process.cwd(), 'src/ts/process/index.svelte.ts'),
        'utf8',
    )
    const sendChatStart = source.indexOf('export async function sendChat(')
    const nowChatroomRead = source.indexOf(
        'const nowChatroom = DBState.db.characters[selectedChar]',
        sendChatStart,
    )
    const preloadCall = source.indexOf('await ensurePromptHistoryResident(', sendChatStart)

    it('preloads the history instead of telling the reader to scroll', () => {
        expect(sendChatStart).toBeGreaterThanOrEqual(0)
        expect(preloadCall).toBeGreaterThan(sendChatStart)
        // The refusals the preload replaced must not have come back.
        expect(source).not.toContain('Load earlier messages before generating')
        expect(source).not.toContain('Jump to the latest messages before generating')
    })

    it('re-checks the selected chat after the preload and before building the prompt', () => {
        expect(nowChatroomRead).toBeGreaterThan(preloadCall)
        const between = source.slice(preloadCall, nowChatroomRead)
        expect(between).toContain('promptPreloadTargetMoved(preloadTarget')
        // The check is a refusal, not a warning that falls through into the send.
        const checkStart = between.indexOf('promptPreloadTargetMoved(preloadTarget')
        expect(between.slice(checkStart, checkStart + 800)).toContain('return false')
    })

    it('has no other await between the preload and that re-check', () => {
        // The race window this guards is exactly as long as the preload. An
        // await added in between would widen it past what the check covers.
        const preloadBlockEnd = source.indexOf(
            'if (promptPreloadTargetMoved(preloadTarget',
            preloadCall,
        )
        expect(preloadBlockEnd).toBeGreaterThan(preloadCall)
        const tail = source.slice(
            source.indexOf('if (progressShown) alertClear()', preloadCall),
            preloadBlockEnd,
        )
        expect(tail).not.toContain('await ')
    })

    it('is the first await in sendChat, so nothing runs against an unchecked window', () => {
        const head = source.slice(sendChatStart, preloadCall)
        // `await` appears in the preload's own argument object (the `measure`
        // callback); nothing before the call itself may await.
        const beforeCall = head.slice(0, head.lastIndexOf('try {'))
        expect(beforeCall).not.toContain('await ')
    })
})
