import { readFile } from 'node:fs/promises'
import { describe, expect, test } from 'vitest'

const dispatchCall = 'dispatchCommittedChatOutput(pluginV2.chatOutput'

function findMatchingBrace(source: string, openBrace: number) {
    let depth = 0
    let quote: '"' | "'" | '`' | null = null
    let lineComment = false
    let blockComment = false

    for (let index = openBrace; index < source.length; index++) {
        const current = source[index]
        const next = source[index + 1]

        if (lineComment) {
            if (current === '\n') lineComment = false
            continue
        }
        if (blockComment) {
            if (current === '*' && next === '/') {
                blockComment = false
                index++
            }
            continue
        }
        if (quote) {
            if (current === '\\') {
                index++
            }
            else if (current === quote) {
                quote = null
            }
            continue
        }
        if (current === '/' && next === '/') {
            lineComment = true
            index++
            continue
        }
        if (current === '/' && next === '*') {
            blockComment = true
            index++
            continue
        }
        if (current === '"' || current === "'" || current === '`') {
            quote = current
            continue
        }
        if (current === '{') depth++
        if (current === '}' && --depth === 0) return index
    }

    throw new Error('Unclosed source block')
}

function countDispatches(source: string) {
    return source.split(dispatchCall).length - 1
}

describe('chat output listener placement', () => {
    test('anchors each committed-output dispatch after its branch processing', async () => {
        const source = await readFile('src/ts/process/index.svelte.ts', 'utf8')
        const streamingStart = source.indexOf("if(req.type === 'streaming')")
        expect(streamingStart).toBeGreaterThan(-1)
        const streamingOpenBrace = source.indexOf('{', streamingStart)
        const streamingEndBrace = findMatchingBrace(source, streamingOpenBrace)
        const streamingBranch = source.slice(streamingOpenBrace + 1, streamingEndBrace)

        const nextElse = source.indexOf('else{', streamingEndBrace)
        expect(source.slice(streamingEndBrace + 1, nextElse).trim()).toBe('')
        const nonStreamingOpenBrace = source.indexOf('{', nextElse)
        const nonStreamingEndBrace = findMatchingBrace(source, nonStreamingOpenBrace)
        const nonStreamingBranch = source.slice(nonStreamingOpenBrace + 1, nonStreamingEndBrace)

        const streamReaderExit = streamingBranch.indexOf('if(streamAborted || abortSignal.aborted)')
        const streamTrigger = streamingBranch.indexOf("await runTrigger(currentChar, 'output'")
        const streamInlayAwait = streamingBranch.indexOf('await inlayr.promise')
        const streamDispatch = streamingBranch.indexOf(dispatchCall)
        expect(countDispatches(streamingBranch)).toBe(1)
        expect(countDispatches(streamingBranch.slice(0, streamReaderExit))).toBe(0)
        expect(streamReaderExit).toBeGreaterThan(-1)
        expect(streamTrigger).toBeGreaterThan(streamReaderExit)
        expect(streamInlayAwait).toBeGreaterThan(streamTrigger)
        expect(streamDispatch).toBeGreaterThan(streamInlayAwait)

        const messageLoopStart = nonStreamingBranch.indexOf('for(let i=0;i<msgs.length;i++)')
        const messageLoopOpenBrace = nonStreamingBranch.indexOf('{', messageLoopStart)
        const messageLoopEndBrace = findMatchingBrace(nonStreamingBranch, messageLoopOpenBrace)
        const nonStreamRunCurrentChat = nonStreamingBranch.indexOf('runCurrentChatFunction', messageLoopEndBrace)
        const nonStreamTrigger = nonStreamingBranch.indexOf("await runTrigger(currentChar, 'output'", nonStreamRunCurrentChat)
        const nonStreamDispatch = nonStreamingBranch.indexOf(dispatchCall)
        expect(countDispatches(nonStreamingBranch)).toBe(1)
        expect(nonStreamingBranch.slice(messageLoopStart, messageLoopEndBrace)).toContain('runInlayScreen')
        expect(nonStreamRunCurrentChat).toBeGreaterThan(messageLoopEndBrace)
        expect(nonStreamTrigger).toBeGreaterThan(nonStreamRunCurrentChat)
        expect(nonStreamDispatch).toBeGreaterThan(nonStreamTrigger)
    })
})
