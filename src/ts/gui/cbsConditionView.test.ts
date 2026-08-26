import { describe, expect, it } from 'vitest'
import { collectCbsVariables, parseCbsConditionView, summarizeCbsCondition } from './cbsConditionView'

const gate = '{{#if {{or::{{equal::{{getvar::cv_g8}}::1}}::{{equal::{{getvar::cv_spoiler}}::request}}::{{equal::{{getvar::cv_spoiler}}::open}}}}}}'

describe('CBS condition view', () => {
    it('collects static variable names and literal values without treating comparisons as definitions', () => {
        const variables = collectCbsVariables(gate + '{{setvar::cv_g8::0}}{{getvar::cv_g8}}{{getvar::{{getvar::key}}}}')
        expect(variables).toEqual([
            { name: 'cv_g8', values: ['1', '0'], reads: 2, writes: 1 },
            { name: 'cv_spoiler', values: ['request', 'open'], reads: 2, writes: 0 },
            { name: 'key', values: [], reads: 1, writes: 0 },
        ])
    })

    it('skips comments and literal blocks, and does not mistake addvar operands for possible values', () => {
        const source = '{{// {{getvar::comment}}}}{{#pure}}{{getvar::literal}}{{/pure}}{{addvar::score::5}}{{equal::active::{{getvar::mode}}}}'
        expect(collectCbsVariables(source)).toEqual([
            { name: 'score', values: [], reads: 0, writes: 1 },
            { name: 'mode', values: ['active'], reads: 1, writes: 0 },
        ])
    })

    it('keeps every source character, including extra braces and CRLF, in editable spans', () => {
        const source = `<Death>\r\n${gate}}}First paragraph.\r\n{{/if}}\r\n</Death>`
        const view = parseCbsConditionView(source)
        expect(view.valid).toBe(true)
        expect(view.parts.map(part => source.slice(part.from, part.to)).join('')).toBe(source)
        expect(view.parts.filter(part => part.kind === 'condition')).toHaveLength(1)
        const body = view.parts.find(part => source.slice(part.from, part.to).includes('First paragraph.'))!
        expect(body.kind).toBe('text')
        expect(body.depth).toBe(1)
        expect(source.slice(0, body.from) + 'Edited body.' + source.slice(body.to))
            .toBe(`<Death>\r\n${gate}Edited body.{{/if}}\r\n</Death>`)
    })

    it('shows actual binary OR semantics and flags extra arguments without evaluating anything', () => {
        const summary = summarizeCbsCondition(gate)
        expect(summary.text).toBe('($cv_g8 = "1") OR ($cv_spoiler = "request")')
        expect(summary.warnings).toEqual([{ name: 'or', expected: 2, actual: 3 }])
        expect(summary.expression).toMatchObject({
            kind: 'logical', operator: 'OR', children: [
                { kind: 'comparison', operator: '=', left: { kind: 'variable', text: '$cv_g8' }, right: { kind: 'literal', text: '"1"' } },
                { kind: 'comparison', operator: '=', left: { kind: 'variable', text: '$cv_spoiler' }, right: { kind: 'literal', text: '"request"' } },
            ],
        })
    })

    it('preserves expression groups and never splits operators inside literals or unknown macros', () => {
        const summary = summarizeCbsCondition('{{#if {{and::{{or::{{getvar::a}}::{{not::{{getvar::b}}}}}}::{{equal::{{custom::OR::<b>}}::A OR B AND C}}}}}}')
        expect(summary.expression).toMatchObject({
            kind: 'logical', operator: 'AND', children: [
                { kind: 'logical', operator: 'OR', children: [
                    { kind: 'variable', text: '$a' },
                    { kind: 'logical', operator: 'NOT', children: [{ kind: 'variable', text: '$b' }] },
                ] },
                { kind: 'comparison', left: { kind: 'raw', text: '{{custom::OR::<b>}}' }, right: { kind: 'literal', text: '"A OR B AND C"' } },
            ],
        })
        expect(summary.warnings).toEqual([])
    })

    it('summarizes nested conditions, and preserves unknown expressions verbatim', () => {
        expect(summarizeCbsCondition('{{#if {{and::{{not::{{getvar::hidden}}}}::{{equal::{{custom::a::b}}::yes}}}}}}').text)
            .toBe('(NOT ($hidden)) AND ({{custom::a::b}} = "yes")')
        expect(summarizeCbsCondition('{{#when::keep::{{getvar::flag}}::is::1}}').text)
            .toBe('#when::keep::{{getvar::flag}}::is::1')
    })

    it('tracks nested branches while leaving ordinary macros in the text', () => {
        const source = '{{#when {{getvar::a}}}}A{{char}}{{#if 1}}B{{/if}}{{:else}}C{{/when}}'
        const view = parseCbsConditionView(source)
        expect(view.valid).toBe(true)
        expect(view.parts.map(({ kind, depth }) => [kind, depth])).toEqual([
            ['condition', 0], ['text', 1], ['condition', 1], ['text', 2],
            ['end', 1], ['otherwise', 0], ['text', 1], ['end', 0],
        ])
        expect(view.parts.map(part => source.slice(part.from, part.to)).join('')).toBe(source)
    })

    it.each(['pure', 'puredisplay', 'pure_display', 'escape', 'each', 'func'])
        ('leaves conditions inside #%s blocks in the source', name => {
            const source = `{{#${name}}}{{#if 1}}literal{{/if}}{{/${name}}}`
            const view = parseCbsConditionView(source)
            expect(view.parts).toEqual([{ kind: 'text', from: 0, to: source.length, depth: 0 }])
        })

    it.each([
        '{{#if 1}}missing end', '{{/if}}', '{{#if 1}}x{{/when}}',
        '{{#when 1}}{{:else}}{{:else}}{{/when}}', '{{#if {{getvar::x}}',
    ])('falls back to the complete source for unbalanced input: %s', source => {
        const view = parseCbsConditionView(source)
        expect(view.valid).toBe(false)
        expect(view.parts).toEqual([{ kind: 'text', from: 0, to: source.length, depth: 0 }])
    })

    it('handles empty bodies and deeply nested macro input without discarding text', () => {
        expect(parseCbsConditionView('{{#if 1}}{{/if}}').parts.map(part => part.kind))
            .toEqual(['condition', 'text', 'end'])
        const source = '{{#if ' + '{{not::'.repeat(300) + '1' + '}}'.repeat(300) + '}}x{{/if}}'
        const view = parseCbsConditionView(source)
        expect(view.parts.map(part => source.slice(part.from, part.to)).join('')).toBe(source)
    })
})
