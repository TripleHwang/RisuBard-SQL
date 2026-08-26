export function visibleRange(input: { count: number; scrollTop: number; height: number; rowHeight: number; overscan: number }) {
    const maxScrollTop = Math.max(0, input.count * input.rowHeight - input.height)
    const scrollTop = Math.min(Math.max(0, input.scrollTop), maxScrollTop)
    return {
        start: Math.max(0, Math.floor(scrollTop / input.rowHeight) - input.overscan),
        end: Math.min(input.count, Math.ceil((scrollTop + input.height) / input.rowHeight) + input.overscan),
    }
}
