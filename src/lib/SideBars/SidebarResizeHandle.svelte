<script lang="ts">
    import { DBState, SizeStore } from 'src/ts/stores.svelte'
    import { requestImmediateSave } from 'src/ts/globalApi.svelte'
    import { resizeHandle } from 'src/ts/gui/resizeHandle'
    import { normalizeChatListHeight, normalizeCharacterSidebarWidth } from 'src/ts/gui/sidebarLayout'

    let { axis, target, maxWidth = 720 }: {
        axis: 'width' | 'height'
        target: HTMLElement | undefined
        maxWidth?: number
    } = $props()
    const field = $derived(axis === 'height' ? 'chatListHeight' : 'characterSidebarWidth')
    const normalize = (value: unknown) => axis === 'height'
        ? normalizeChatListHeight(value, $SizeStore.h)
        : normalizeCharacterSidebarWidth(value, maxWidth)
    const currentSize = $derived(normalize(DBState.db[field]))

    function start() {
        if (!target) return
        const initial = target.getBoundingClientRect()[axis]
        return (dx: number, dy: number) => {
            const delta = axis === 'height' ? dy : dx
            if (delta) DBState.db[field] = normalize(initial + delta)
        }
    }
</script>

<button type="button"
    aria-label={`${axis === 'height' ? '챗 목록 높이 조절' : '캐릭터 사이드바 너비 조절'} · ${currentSize}px`}
    title="드래그 또는 방향키로 조절 · 두 번 클릭하거나 Home 키로 초기화"
    class="sidebar-resize-handle" class:is-width={axis === 'width'} class:is-height={axis === 'height'}
    data-sidebar-resize={axis}
    use:resizeHandle={{ start, reset: () => { delete DBState.db[field] }, end: () => { void requestImmediateSave() } }}
></button>

<style>
    .sidebar-resize-handle { padding: 0; border: 0; background: transparent; touch-action: none; flex-shrink: 0; }
    .sidebar-resize-handle::after { content: ''; position: absolute; border-radius: 999px; background: var(--color-darkborderc); transition: background-color .15s; }
    .is-height { position: relative; display: block; width: 100%; height: .875rem; margin-top: .25rem; cursor: row-resize; }
    .is-height::after { width: 2rem; height: 3px; top: calc(50% - 1.5px); left: calc(50% - 1rem); }
    .is-width { position: absolute; z-index: 20; right: 0; top: 0; bottom: 0; width: .5rem; cursor: col-resize; }
    .is-width::after { width: 2px; height: 3rem; top: calc(50% - 1.5rem); right: 1px; }
    .sidebar-resize-handle:hover, .sidebar-resize-handle:focus-visible, .sidebar-resize-handle:global([data-resizing]) { background: color-mix(in srgb, var(--color-borderc) 15%, transparent); outline: none; }
    .sidebar-resize-handle:hover::after, .sidebar-resize-handle:focus-visible::after, .sidebar-resize-handle:global([data-resizing])::after { background: var(--color-borderc); }
</style>
