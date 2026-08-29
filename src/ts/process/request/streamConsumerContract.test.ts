import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'

test('chat recovers the received tail before propagating the stream failure', () => {
    const source = readFileSync('src/ts/process/index.svelte.ts', 'utf8')
    const readLoop = source.slice(source.indexOf('while(streamAborted === false)'), source.indexOf('if(streamAborted || abortSignal.aborted)'))
    expect(readLoop.includes('getPartialPresetStreamText(error)')).toBe(true)
    expect(readLoop.includes('readed = { done: false, value: { "0": partial } }')).toBe(true)
    expect(readLoop.indexOf('if (readFailure) throw readFailure')).toBeGreaterThan(readLoop.indexOf('pendingStreamingResult = result'))
})

test('plugin providers are drained when the caller disables streaming', () => {
    const source = readFileSync('src/ts/process/request/request.ts', 'utf8')
    const branchStart = source.indexOf('else if(d.content instanceof ReadableStream)')
    const branchEnd = source.indexOf('\n        else{', branchStart)
    const streamBranch = source.slice(branchStart, branchEnd)

    expect(branchStart).toBeGreaterThan(-1)
    expect(branchEnd).toBeGreaterThan(branchStart)
    expect(streamBranch).toContain('if(arg.useStreaming === false)')
    expect(streamBranch.indexOf('collectStreamingText(statusStream)'))
        .toBeLessThan(streamBranch.indexOf("type: 'streaming'"))
})
