<script lang="ts">
    import { language } from 'src/lang'
    import { alertConfirm, alertError, notifySuccess } from 'src/ts/alert'
    import { DBState } from 'src/ts/stores.svelte'
    import {
        ARC_PLOTTER_BUILT_IN_PRESETS,
        ARC_PLOTTER_CUSTOM_SELECTION_ID,
        ARC_PLOTTER_DEFAULT_PRESET_ID,
        createArcPlotterCustomPreset,
        deleteArcPlotterCustomPreset,
        findArcPlotterBuiltInPreset,
        normalizeArcPlotterCustomPresets,
        normalizeArcPlotterSettings,
        overwriteArcPlotterCustomPreset,
        type ArcPlotterPreset,
        type ArcPlotterSettings,
    } from 'src/ts/risubard/arcPlotterSettings'
    import Button from 'src/lib/UI/GUI/Button.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'

    let newPresetName = $state('')
    let customPresets = $derived(normalizeArcPlotterCustomPresets(
        DBState.db.risuBardArcPlotterCustomPresets
    ))
    let selectedPresetId = $derived(
        DBState.db.risuBardArcPlotterPresetId
            ?? ARC_PLOTTER_DEFAULT_PRESET_ID
    )
    let selectedCustomPreset = $derived(
        customPresets.find((preset) => preset.id === selectedPresetId)
    )

    const builtInLabels = $derived([
        language.risuBardArcPlotterPresetShort,
        language.risuBardArcPlotterPresetNovella,
        language.risuBardArcPlotterPresetEpic,
    ])

    function currentSettings(): ArcPlotterSettings {
        return normalizeArcPlotterSettings({
            checkpointSize: DBState.db.risuBardArcPlotterCheckpointSize,
            maxArcs: DBState.db.risuBardArcPlotterMaxArcs,
            maxTurningPoints: DBState.db.risuBardArcPlotterMaxTurningPoints,
            maxOpenThreads: DBState.db.risuBardArcPlotterMaxOpenThreads,
            maxCharacters: DBState.db.risuBardArcPlotterMaxCharacters,
        })
    }

    function applySettings(settings: ArcPlotterSettings): void {
        DBState.db.risuBardArcPlotterCheckpointSize = settings.checkpointSize
        DBState.db.risuBardArcPlotterMaxArcs = settings.maxArcs
        DBState.db.risuBardArcPlotterMaxTurningPoints = settings.maxTurningPoints
        DBState.db.risuBardArcPlotterMaxOpenThreads = settings.maxOpenThreads
        DBState.db.risuBardArcPlotterMaxCharacters = settings.maxCharacters
    }

    function selectPreset(id: string): void {
        DBState.db.risuBardArcPlotterPresetId = id
        if (id === ARC_PLOTTER_CUSTOM_SELECTION_ID) return
        const preset = findArcPlotterBuiltInPreset(id)
            ?? customPresets.find((candidate) => candidate.id === id)
        if (preset) applySettings(preset.settings)
    }

    function savePreset(): void {
        const name = newPresetName.trim()
        if (!name) {
            alertError(language.risuBardArcPlotterPresetNameRequired)
            return
        }
        try {
            const preset: ArcPlotterPreset = {
                id: `user:${crypto.randomUUID()}`,
                name,
                settings: currentSettings(),
            }
            DBState.db.risuBardArcPlotterCustomPresets =
                createArcPlotterCustomPreset(customPresets, preset)
            DBState.db.risuBardArcPlotterPresetId = preset.id
            newPresetName = ''
            notifySuccess(language.risuBardArcPlotterPresetSaved)
        }
        catch {
            alertError(language.risuBardArcPlotterPresetDuplicate)
        }
    }

    async function overwritePreset(): Promise<void> {
        if (!selectedCustomPreset) return
        if (!await alertConfirm(
            language.risuBardArcPlotterPresetOverwriteConfirm
                .replace('{name}', selectedCustomPreset.name)
        )) return
        DBState.db.risuBardArcPlotterCustomPresets =
            overwriteArcPlotterCustomPreset(
                customPresets,
                selectedCustomPreset.id,
                currentSettings()
            )
        notifySuccess(language.risuBardArcPlotterPresetOverwritten)
    }

    async function deletePreset(): Promise<void> {
        if (!selectedCustomPreset) return
        if (!await alertConfirm(
            language.risuBardArcPlotterPresetDeleteConfirm
                .replace('{name}', selectedCustomPreset.name)
        )) return
        DBState.db.risuBardArcPlotterCustomPresets =
            deleteArcPlotterCustomPreset(customPresets, selectedCustomPreset.id)
        DBState.db.risuBardArcPlotterPresetId = ARC_PLOTTER_CUSTOM_SELECTION_ID
        notifySuccess(language.risuBardArcPlotterPresetDeleted)
    }
</script>

<div
    data-setting-row
    data-setting-id="risubard.arcPlotter.presets"
    class="settings-standard-row flex items-center justify-between gap-4 border-t border-darkborderc"
>
    <div class="flex min-w-0 flex-col">
        <label class="text-sm text-textcolor" for="risubard-arc-plotter-preset">
            {language.risuBardArcPlotterPreset}
        </label>
        <p class="mt-0.5 whitespace-pre-line text-xs text-textcolor2">
            {selectedCustomPreset
                ? language.risuBardArcPlotterPresetUserHint
                : language.risuBardArcPlotterPresetBuiltInHint}
        </p>
    </div>
    <div class="shrink-0">
        <select
            id="risubard-arc-plotter-preset"
            class="w-56 max-w-full rounded-md border border-darkborderc bg-transparent px-3 py-1.5 text-sm text-textcolor shadow-xs transition-colors focus:border-borderc focus:outline-hidden focus:ring-2 focus:ring-borderc"
            value={selectedPresetId}
            onchange={(event) => selectPreset(event.currentTarget.value)}
        >
            {#each ARC_PLOTTER_BUILT_IN_PRESETS as preset, index (preset.id)}
                <option value={preset.id} class="bg-darkbg">{builtInLabels[index]}</option>
            {/each}
            <option disabled value="__separator" class="bg-darkbg">──────────</option>
            <option value={ARC_PLOTTER_CUSTOM_SELECTION_ID} class="bg-darkbg">
                {language.risuBardArcPlotterPresetCustom}
            </option>
            {#each customPresets as preset (preset.id)}
                <option value={preset.id} class="bg-darkbg">{preset.name}</option>
            {/each}
        </select>
    </div>
</div>

<div
    data-setting-row
    class="settings-standard-row flex items-center justify-between gap-4 border-t border-darkborderc"
>
    <div class="flex min-w-0 flex-col">
        <label class="text-sm text-textcolor" for="risubard-arc-plotter-preset-name">
            {language.risuBardArcPlotterPresetName}
        </label>
    </div>
    <div class="flex max-w-full flex-wrap items-center justify-end gap-2">
        <TextInput
            id="risubard-arc-plotter-preset-name"
            bind:value={newPresetName}
            placeholder={language.risuBardArcPlotterPresetNamePlaceholder}
            size="sm"
            className="w-48 max-w-full"
        />
        <Button size="sm" onclick={savePreset}>
            {language.risuBardArcPlotterPresetSave}
        </Button>
        <Button
            size="sm"
            disabled={!selectedCustomPreset}
            onclick={overwritePreset}
        >
            {language.risuBardArcPlotterPresetOverwrite}
        </Button>
        <Button
            size="sm"
            styled="danger"
            disabled={!selectedCustomPreset}
            onclick={deletePreset}
        >
            {language.risuBardArcPlotterPresetDelete}
        </Button>
    </div>
</div>
