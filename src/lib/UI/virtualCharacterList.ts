export function visibleRange(input: { count: number; scrollTop: number; height: number; rowHeight: number; overscan: number }) {
    const maxScrollTop = Math.max(0, input.count * input.rowHeight - input.height)
    const scrollTop = Math.min(Math.max(0, input.scrollTop), maxScrollTop)
    return {
        start: Math.max(0, Math.floor(scrollTop / input.rowHeight) - input.overscan),
        end: Math.min(input.count, Math.ceil((scrollTop + input.height) / input.rowHeight) + input.overscan),
    }
}

export function nextRovingIndex(current: number, key: string, count: number) {
    if (key === 'Home') return 0
    if (key === 'End') return Math.max(0, count - 1)
    if (key === 'ArrowUp') return Math.max(0, current - 1)
    if (key === 'ArrowDown') return Math.min(Math.max(0, count - 1), current + 1)
    return current
}

export function scrollTopForIndex(index: number, scrollTop: number, height: number, rowHeight: number) {
    const top = index * rowHeight
    const bottom = top + rowHeight
    if (top < scrollTop) return top
    if (bottom > scrollTop + height) return bottom - height
    return scrollTop
}

export function reconcileFocus<T extends string | number>(keys: T[], focusedKey: T | null, fallbackIndex: number) {
    const retained = focusedKey === null ? -1 : keys.indexOf(focusedKey)
    const index = retained >= 0 ? retained : Math.min(Math.max(0, fallbackIndex), Math.max(0, keys.length - 1))
    return { key: keys[index] ?? null, index }
}

export function shouldRecoverListFocus(hasListFocus: boolean, focusedMounted: boolean) {
    return hasListFocus && !focusedMounted
}
