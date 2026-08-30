export interface ArcPlotterSettings {
    checkpointSize: number
    maxArcs: number
    maxTurningPoints: number
    maxOpenThreads: number
    maxCharacters: number
}

export interface ArcPlotterRuntimeSettings extends ArcPlotterSettings {
    enabled: boolean
}

export interface ArcPlotterPreset {
    id: string
    name: string
    settings: ArcPlotterSettings
}

export const ARC_PLOTTER_CUSTOM_SELECTION_ID = 'custom'
export const ARC_PLOTTER_DEFAULT_PRESET_ID = 'novella'

export const ARC_PLOTTER_LIMITS = {
    checkpointSize: { min: 1, max: 32 },
    maxArcs: { min: 1, max: 32 },
    maxTurningPoints: { min: 1, max: 64 },
    maxOpenThreads: { min: 0, max: 32 },
    maxCharacters: { min: 1_000, max: 12_000 },
} as const

export const ARC_PLOTTER_BUILT_IN_PRESETS: readonly ArcPlotterPreset[] = [
    {
        id: 'short-story',
        name: '단편소설',
        settings: {
            checkpointSize: 4,
            maxArcs: 4,
            maxTurningPoints: 8,
            maxOpenThreads: 4,
            maxCharacters: 3_500,
        },
    },
    {
        id: ARC_PLOTTER_DEFAULT_PRESET_ID,
        name: '중편소설',
        settings: {
            checkpointSize: 8,
            maxArcs: 8,
            maxTurningPoints: 16,
            maxOpenThreads: 8,
            maxCharacters: 6_000,
        },
    },
    {
        id: 'epic',
        name: '대하소설',
        settings: {
            checkpointSize: 12,
            maxArcs: 16,
            maxTurningPoints: 32,
            maxOpenThreads: 16,
            maxCharacters: 12_000,
        },
    },
] as const

export const ARC_PLOTTER_DEFAULT_SETTINGS: ArcPlotterSettings = {
    ...ARC_PLOTTER_BUILT_IN_PRESETS[1].settings,
}

function boundedInteger(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number
): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
    return Math.max(minimum, Math.min(maximum, Math.round(value)))
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function normalizeArcPlotterSettings(
    value: unknown
): ArcPlotterSettings {
    const source = isRecord(value) ? value : {}
    return {
        checkpointSize: boundedInteger(
            source.checkpointSize,
            ARC_PLOTTER_DEFAULT_SETTINGS.checkpointSize,
            ARC_PLOTTER_LIMITS.checkpointSize.min,
            ARC_PLOTTER_LIMITS.checkpointSize.max
        ),
        maxArcs: boundedInteger(
            source.maxArcs,
            ARC_PLOTTER_DEFAULT_SETTINGS.maxArcs,
            ARC_PLOTTER_LIMITS.maxArcs.min,
            ARC_PLOTTER_LIMITS.maxArcs.max
        ),
        maxTurningPoints: boundedInteger(
            source.maxTurningPoints,
            ARC_PLOTTER_DEFAULT_SETTINGS.maxTurningPoints,
            ARC_PLOTTER_LIMITS.maxTurningPoints.min,
            ARC_PLOTTER_LIMITS.maxTurningPoints.max
        ),
        maxOpenThreads: boundedInteger(
            source.maxOpenThreads,
            ARC_PLOTTER_DEFAULT_SETTINGS.maxOpenThreads,
            ARC_PLOTTER_LIMITS.maxOpenThreads.min,
            ARC_PLOTTER_LIMITS.maxOpenThreads.max
        ),
        maxCharacters: boundedInteger(
            source.maxCharacters,
            ARC_PLOTTER_DEFAULT_SETTINGS.maxCharacters,
            ARC_PLOTTER_LIMITS.maxCharacters.min,
            ARC_PLOTTER_LIMITS.maxCharacters.max
        ),
    }
}

export function normalizeArcPlotterRuntimeSettings(
    value: unknown
): ArcPlotterRuntimeSettings {
    const source = isRecord(value) ? value : {}
    return {
        enabled: source.enabled !== false,
        ...normalizeArcPlotterSettings(source),
    }
}

export function isArcPlotterBuiltInPresetId(value: unknown): boolean {
    return typeof value === 'string'
        && ARC_PLOTTER_BUILT_IN_PRESETS.some((preset) => preset.id === value)
}

export function findArcPlotterBuiltInPreset(
    id: unknown
): ArcPlotterPreset | undefined {
    return ARC_PLOTTER_BUILT_IN_PRESETS.find((preset) => preset.id === id)
}

function normalizePresetName(value: unknown): string {
    return typeof value === 'string' ? value.trim().slice(0, 40) : ''
}

function normalizePresetId(value: unknown): string {
    if (typeof value !== 'string') return ''
    const normalized = value.trim()
    return /^user:[A-Za-z0-9._:-]{1,100}$/u.test(normalized)
        ? normalized
        : ''
}

export function normalizeArcPlotterCustomPresets(
    value: unknown
): ArcPlotterPreset[] {
    if (!Array.isArray(value)) return []
    const presets: ArcPlotterPreset[] = []
    const ids = new Set<string>()
    for (const candidate of value) {
        if (!isRecord(candidate)) continue
        const id = normalizePresetId(candidate.id)
        const name = normalizePresetName(candidate.name)
        if (!id || !name || ids.has(id) || isArcPlotterBuiltInPresetId(id)) {
            continue
        }
        ids.add(id)
        presets.push({
            id,
            name,
            settings: normalizeArcPlotterSettings(candidate.settings),
        })
        if (presets.length >= 64) break
    }
    return presets
}

export function normalizeArcPlotterPresetSelection(
    value: unknown,
    customPresets: readonly ArcPlotterPreset[]
): string {
    if (isArcPlotterBuiltInPresetId(value)) return value as string
    if (typeof value === 'string'
        && customPresets.some((preset) => preset.id === value)) return value
    return value === ARC_PLOTTER_CUSTOM_SELECTION_ID
        ? ARC_PLOTTER_CUSTOM_SELECTION_ID
        : ARC_PLOTTER_DEFAULT_PRESET_ID
}

export function createArcPlotterCustomPreset(
    current: unknown,
    preset: ArcPlotterPreset
): ArcPlotterPreset[] {
    const presets = normalizeArcPlotterCustomPresets(current)
    const id = normalizePresetId(preset.id)
    const name = normalizePresetName(preset.name)
    const normalizedName = name.normalize('NFKC').toLocaleLowerCase()
    if (!id || !name || isArcPlotterBuiltInPresetId(id)) {
        throw new Error('Invalid user Archplotter preset')
    }
    if (presets.some((item) => item.id === id)
        || [...ARC_PLOTTER_BUILT_IN_PRESETS, ...presets].some((item) =>
            item.name.normalize('NFKC').toLocaleLowerCase() === normalizedName)) {
        throw new Error('Archplotter preset already exists')
    }
    return [...presets, {
        id,
        name,
        settings: normalizeArcPlotterSettings(preset.settings),
    }]
}

export function overwriteArcPlotterCustomPreset(
    current: unknown,
    id: string,
    settings: unknown
): ArcPlotterPreset[] {
    const presets = normalizeArcPlotterCustomPresets(current)
    if (isArcPlotterBuiltInPresetId(id)) return presets
    return presets.map((preset) => preset.id === id
        ? { ...preset, settings: normalizeArcPlotterSettings(settings) }
        : preset)
}

export function deleteArcPlotterCustomPreset(
    current: unknown,
    id: string
): ArcPlotterPreset[] {
    const presets = normalizeArcPlotterCustomPresets(current)
    if (isArcPlotterBuiltInPresetId(id)) return presets
    return presets.filter((preset) => preset.id !== id)
}
