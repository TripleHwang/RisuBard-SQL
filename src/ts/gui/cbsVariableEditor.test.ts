import { describe, expect, it } from 'vitest'
import { buildCbsVariableRows, createCbsVariableContext, lorebookVariableContext } from './cbsVariableEditor'

const makeOwner = () => ({
    chaId: 'bot', name: 'Persona', chatPage: 0,
    defaultVariables: 'cv_g8=\ncv_spoiler=lock\nunused=7',
    chats: [{ id: 'one', name: 'Chat one', scriptstate: { $cv_spoiler: 'open', $zero: 0, $off: false } }],
})

describe('CBS variable editor', () => {
    it('lists unresolved references and defaults without initializing chat state', () => {
        const owner = makeOwner()
        const chat = { id: 'empty', name: 'Empty' }
        const context = createCbsVariableContext(owner, chat, () => 'cv_g8=0')
        const before = JSON.stringify({ owner, chat })
        const rows = buildCbsVariableRows([{ name: 'unknown', values: ['1'], reads: 1, writes: 0 }], context)
        expect(rows.find(row => row.name === 'unknown')).toMatchObject({ value: undefined, origin: 'unset', values: ['1'] })
        expect(rows.find(row => row.name === 'cv_g8')).toMatchObject({ value: '0', origin: 'template' })
        expect(rows.find(row => row.name === 'cv_spoiler')).toMatchObject({ value: 'lock', origin: 'character' })
        expect(JSON.stringify({ owner, chat })).toBe(before)
    })

    it('honors chat precedence including empty strings, zero and false', () => {
        const owner = makeOwner()
        const context = createCbsVariableContext(owner, owner.chats[0], () => '')
        const rows = buildCbsVariableRows([], context)
        expect(rows.find(row => row.name === 'cv_spoiler')).toMatchObject({ value: 'open', origin: 'chat', defaultValue: 'lock' })
        expect(rows.find(row => row.name === 'zero')?.value).toBe('0')
        expect(rows.find(row => row.name === 'off')?.value).toBe('false')
        expect(context.apply('cv_spoiler', '', 'chat')).toBe(true)
        expect(buildCbsVariableRows([], context).find(row => row.name === 'cv_spoiler'))
            .toMatchObject({ value: '', origin: 'chat' })
    })

    it('only updates the explicit target and preserves unrelated default lines', () => {
        const owner = makeOwner()
        const context = createCbsVariableContext(owner, owner.chats[0], () => '')
        expect(context.apply('cv_g8', '1', 'default')).toBe(true)
        expect(owner.defaultVariables).toBe('cv_g8=1\ncv_spoiler=lock\nunused=7')
        expect(Object.hasOwn(owner.chats[0].scriptstate, '$cv_g8')).toBe(false)
        expect(context.apply('cv_spoiler', 'request', 'chat')).toBe(true)
        expect(owner.chats[0].scriptstate.$cv_spoiler).toBe('request')
        expect(owner.defaultVariables).toContain('cv_spoiler=lock')
        expect(context.apply('cv_g8', 'bad=value', 'default')).toBe(false)
        expect(owner.defaultVariables).toContain('cv_g8=1')
    })

    it('binds to the lorebook owner, not another selected chat, and refuses stale writes', () => {
        const owner = makeOwner()
        const second = { id: 'two', name: 'Chat two', scriptstate: { $cv_spoiler: 'lock', $zero: 0, $off: false } }
        owner.chats.push(second)
        const db = { characters: [owner], templateDefaultVariables: '' }
        const context = lorebookVariableContext(db, JSON.stringify(['lorebook', 'chat', 'bot', 'two']))!
        expect(context.apply('cv_spoiler', 'request', 'chat')).toBe(true)
        expect(second.scriptstate.$cv_spoiler).toBe('request')
        expect(owner.chats[0].scriptstate.$cv_spoiler).toBe('open')
        db.characters = []
        expect(context.apply('cv_spoiler', 'open', 'chat')).toBe(false)
        expect(lorebookVariableContext(db, JSON.stringify(['lorebook', 'module', 'x']))).toBeUndefined()
    })
})
