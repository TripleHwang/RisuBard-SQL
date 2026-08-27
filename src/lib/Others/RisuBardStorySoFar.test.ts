// @vitest-environment happy-dom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, unmount } from 'svelte'
import RisuBardStorySoFar from './RisuBardStorySoFar.svelte'

let mounted: ReturnType<typeof mount> | undefined

afterEach(async () => {
    if (mounted) await unmount(mounted)
    mounted = undefined
    document.body.replaceChildren()
})

describe('RisuBardStorySoFar', () => {
    it('opens an event for editing while keeping source navigation separate', async () => {
        const onNavigate = vi.fn()
        const onEdit = vi.fn()
        mounted = mount(RisuBardStorySoFar, {
            target: document.body,
            props: {
                documents: [{
                    id: 'event.station', type: 'event', status: 'active',
                    title: '폐쇄된 역', relativePath: 'events/station.md',
                    sourceMessageIds: ['message-7'],
                    created: '2026-08-15T00:00:00.000Z',
                    updated: '2026-08-15T00:00:00.000Z',
                    content: '# 폐쇄된 역\n\n## 이야기 요약\n\n- 일행이 폐쇄된 역에 도착했다.',
                    links: [], contextMode: 'auto', contentHash: 'hash',
                }],
                onNavigate,
                onEdit,
            },
        })

        const entry = document.querySelector<HTMLElement>(
            '[data-story-entry="event.station"]'
        )
        expect(entry?.textContent).toContain('일행이 폐쇄된 역에 도착했다.')
        entry?.querySelector<HTMLButtonElement>('[data-story-edit]')?.click()
        expect(onEdit).toHaveBeenCalledWith('event.station')
        expect(onNavigate).not.toHaveBeenCalled()

        entry?.querySelector<HTMLButtonElement>('[data-story-source]')?.click()
        expect(onNavigate).toHaveBeenCalledWith({
            kind: 'chat', messageIds: ['message-7'],
        })
    })
})
