import { describe, expect, it } from 'vitest'
import { createIncrementalNdjsonParser } from './ndjsonStream'

describe('incremental NDJSON parser', () => {
    it('handles fragmented records and a final unterminated tail', () => {
        const seen: any[] = []
        const parser = createIncrementalNdjsonParser(value => seen.push(value))
        parser.drain('{"type":"progress","completed":1', false)
        parser.drain('{"type":"progress","completed":1}\n{"type":"do', false)
        parser.drain('{"type":"progress","completed":1}\n{"type":"done","result":{"imported":2}}', true)
        expect(seen).toEqual([{ type: 'progress', completed: 1 }, { type: 'done', result: { imported: 2 } }])
    })

    it('does not retain parsed high-count response segments', () => {
        let count = 0
        const parser = createIncrementalNdjsonParser(() => { count++ })
        let response = ''
        for (let i = 0; i < 20_000; i++) {
            response += JSON.stringify({ type: 'progress', completed: i }) + '\n'
            parser.drain(response, false)
        }
        expect(count).toBe(20_000)
        expect(parser.bufferedCharacters()).toBe(0)
    })
})
