export interface SaveLoadShortcutPoint {
    left: number
    top: number
}

export interface SaveLoadShortcutBounds extends SaveLoadShortcutPoint {
    right: number
    bottom: number
}

export interface SaveLoadShortcutPlacement {
    horizontal: 'left' | 'right'
    xOffset: number
    vertical: 'top' | 'bottom'
    yOffset: number
}

export function anchorSaveLoadShortcut(
    point: SaveLoadShortcutPoint,
    anchor: SaveLoadShortcutBounds,
): SaveLoadShortcutPlacement {
    const leftDistance = Math.abs(point.left - anchor.left)
    const rightDistance = Math.abs(anchor.right - point.left)
    const topDistance = Math.abs(point.top - anchor.top)
    const bottomDistance = Math.abs(anchor.bottom - point.top)
    const horizontal = leftDistance <= rightDistance ? 'left' : 'right'
    const vertical = topDistance <= bottomDistance ? 'top' : 'bottom'
    return {
        horizontal,
        xOffset: horizontal === 'left'
            ? point.left - anchor.left
            : anchor.right - point.left,
        vertical,
        yOffset: vertical === 'top'
            ? point.top - anchor.top
            : anchor.bottom - point.top,
    }
}

export function normalizeSaveLoadShortcutPlacement(
    value: unknown
): SaveLoadShortcutPlacement | null {
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<SaveLoadShortcutPlacement>
    if ((candidate.horizontal !== 'left'
        && candidate.horizontal !== 'right')
        || (candidate.vertical !== 'top'
            && candidate.vertical !== 'bottom')
        || typeof candidate.xOffset !== 'number'
        || !Number.isFinite(candidate.xOffset)
        || typeof candidate.yOffset !== 'number'
        || !Number.isFinite(candidate.yOffset)) return null
    return {
        horizontal: candidate.horizontal,
        xOffset: candidate.xOffset,
        vertical: candidate.vertical,
        yOffset: candidate.yOffset,
    }
}

export function resolveSaveLoadShortcutPosition(
    placement: SaveLoadShortcutPlacement,
    anchor: SaveLoadShortcutBounds,
    viewport: { width: number, height: number },
    size: { width: number, height: number },
): SaveLoadShortcutPoint {
    const left = placement.horizontal === 'left'
        ? anchor.left + placement.xOffset
        : anchor.right - placement.xOffset
    const top = placement.vertical === 'top'
        ? anchor.top + placement.yOffset
        : anchor.bottom - placement.yOffset
    const horizontalGutter = Math.min(
        viewport.width / 2,
        16 + size.width / 2,
    )
    const verticalGutter = Math.min(
        viewport.height / 2,
        16 + size.height / 2,
    )
    return {
        left: clamp(
            left,
            horizontalGutter,
            Math.max(horizontalGutter, viewport.width - horizontalGutter),
        ),
        top: clamp(
            top,
            verticalGutter,
            Math.max(verticalGutter, viewport.height - verticalGutter),
        ),
    }
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value))
}
