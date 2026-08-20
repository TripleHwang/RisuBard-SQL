export interface FloatingActionButtonPlacement {
    xRatio: number
    yRatio: number
}

export interface FloatingActionButtonViewport {
    width: number
    height: number
}

export interface FloatingActionButtonSize {
    width: number
    height: number
}

export interface PluginOwnedMenuItem {
    pluginName?: string
    id: string
}

export const FAB_GUTTER = 16
export const FAB_GAP = 12
export const FAB_DRAG_THRESHOLD = 6
export const DEFAULT_FAB_SIZE: FloatingActionButtonSize = {
    width: 52,
    height: 36,
}

export function makeFabLayoutKey(
    pluginName: string,
    providedId: string | undefined,
    name: string
): string {
    return JSON.stringify([
        pluginName,
        providedId ? 'id' : 'name',
        providedId || name,
    ])
}

export function findOwnedMenuIndex(
    items: PluginOwnedMenuItem[],
    pluginName: string,
    id: string
): number {
    return items.findIndex(item => (
        item.pluginName === pluginName && item.id === id
    ))
}

export function normalizeFabPlacement(
    value: unknown
): FloatingActionButtonPlacement | null {
    if (!value || typeof value !== 'object') return null
    const candidate = value as Partial<FloatingActionButtonPlacement>
    if (
        typeof candidate.xRatio !== 'number'
        || !Number.isFinite(candidate.xRatio)
        || typeof candidate.yRatio !== 'number'
        || !Number.isFinite(candidate.yRatio)
    ) {
        return null
    }
    return {
        xRatio: clamp(candidate.xRatio, 0, 1),
        yRatio: clamp(candidate.yRatio, 0, 1),
    }
}

export function defaultFabPosition(
    index: number,
    viewport: FloatingActionButtonViewport,
    size: FloatingActionButtonSize = DEFAULT_FAB_SIZE
): { left: number, top: number } {
    const safeIndex = Math.max(0, Math.floor(index))
    const rows = Math.max(1, Math.floor(
        (viewport.height - FAB_GUTTER * 2 + FAB_GAP)
        / (size.height + FAB_GAP)
    ))
    const column = Math.floor(safeIndex / rows)
    const row = safeIndex % rows
    const placement = placementFromClientPoint(
        viewport.width - FAB_GUTTER - size.width / 2
            - column * (size.width + FAB_GAP),
        FAB_GUTTER + size.height / 2
            + row * (size.height + FAB_GAP),
        viewport,
        size
    )
    return {
        left: Math.round(placement.xRatio * viewport.width),
        top: Math.round(placement.yRatio * viewport.height),
    }
}

export function placementFromClientPoint(
    clientX: number,
    clientY: number,
    viewport: FloatingActionButtonViewport,
    size: FloatingActionButtonSize = DEFAULT_FAB_SIZE
): FloatingActionButtonPlacement {
    const width = Math.max(1, viewport.width)
    const height = Math.max(1, viewport.height)
    const left = clamp(
        clientX,
        Math.min(width / 2, FAB_GUTTER + size.width / 2),
        Math.max(width / 2, width - FAB_GUTTER - size.width / 2)
    )
    const top = clamp(
        clientY,
        Math.min(height / 2, FAB_GUTTER + size.height / 2),
        Math.max(height / 2, height - FAB_GUTTER - size.height / 2)
    )
    return {
        xRatio: left / width,
        yRatio: top / height,
    }
}

export function resolveFabPosition(
    placement: unknown,
    index: number,
    viewport: FloatingActionButtonViewport,
    size: FloatingActionButtonSize = DEFAULT_FAB_SIZE
): { left: number, top: number } {
    const normalized = normalizeFabPlacement(placement)
    if (!normalized) return defaultFabPosition(index, viewport, size)
    const clamped = placementFromClientPoint(
        normalized.xRatio * viewport.width,
        normalized.yRatio * viewport.height,
        viewport,
        size
    )
    return {
        left: Math.round(clamped.xRatio * viewport.width),
        top: Math.round(clamped.yRatio * viewport.height),
    }
}

function clamp(value: number, minimum: number, maximum: number): number {
    return Math.min(maximum, Math.max(minimum, value))
}
