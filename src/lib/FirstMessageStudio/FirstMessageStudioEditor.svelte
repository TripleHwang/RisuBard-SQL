<script lang="ts">
    import { onDestroy } from 'svelte'
    import type { character as Character } from 'src/ts/storage/database.svelte'
    import { getCurrentLocale } from 'src/lang'
    import { requestChatData } from 'src/ts/process/request/request'
    import { downloadFile } from 'src/ts/globalApi.svelte'
    import { selectFileByDom } from 'src/ts/util'
    import {
        createBlankStudioProject,
        createStudioAppearance,
        normalizeFirstMessageStudioProject,
        resetFirstMessageStudioScriptstate,
        resolveStudioProjectLocale,
        setStudioTextLanguage,
        type FirstMessageStudioLocale,
        type FirstMessageStudioLanguage,
        type FirstMessageStudioOption,
        type FirstMessageStudioProject,
        type FirstMessageStudioSkinPreset,
        type FirstMessageStudioText,
        type FirstMessageStudioVariable,
    } from 'src/ts/firstMessageStudio'
    import {
        applyFirstMessageStudioTranslations,
        buildFirstMessageStudioTranslationPrompt,
        collectFirstMessageStudioTranslationEntries,
        parseFirstMessageStudioTranslations,
    } from 'src/ts/firstMessageStudioTranslation'
    import {
        compileFirstMessageStudioCompatibility,
        exportFirstMessageStudioProject,
        importFirstMessageStudioProject,
        mergeFirstMessageStudioDefaultVariables,
        mergeFirstMessageStudioTriggers,
    } from 'src/ts/firstMessageStudioSharing'
    import FirstMessageStudioRuntime from './FirstMessageStudioRuntime.svelte'

    interface Props {
        character: Character
        onClose: () => void
    }

    let { character, onClose }: Props = $props()

    function makeInitialProject(): FirstMessageStudioProject {
        const project = character.firstMessageStudio
            ? normalizeFirstMessageStudioProject(structuredClone(character.firstMessageStudio))
            : createBlankStudioProject()
        if (!character.firstMessageStudio || !Object.prototype.hasOwnProperty.call(character.firstMessageStudio, 'fallbackMessage')) {
            project.fallbackMessage = character.firstMessage ?? ''
        }
        return project
    }

    const initialProject = makeInitialProject()
    let draft = $state(initialProject)
    let selectedStageId = $state('')
    let editLocale: FirstMessageStudioLocale = $state(resolveStudioProjectLocale(initialProject, {}, getCurrentLocale()))
    let editorMode: 'content' | 'languages' | 'variables' | 'design' | 'code' | 'share' = $state('content')
    let showAiTranslation = $state(false)
    let translationSource = $state(initialProject.localization.defaultLanguage)
    let translationTarget = $state(initialProject.localization.languages.find((language) => language.id !== initialProject.localization.defaultLanguage)?.id ?? initialProject.localization.defaultLanguage)
    let translating = $state(false)
    let translationMessage = $state('')
    let shareMessage = $state('')
    let translationController: AbortController | undefined
    let selectedStage = $derived(draft.stages.find((stage) => stage.id === selectedStageId) ?? draft.stages[0])

    function localized(value: FirstMessageStudioText | undefined) {
        if (typeof value === 'string') return value
        return value?.[editLocale] ?? ''
    }

    function editStage(id: string) {
        selectedStageId = id
        editorMode = 'content'
    }

    function setLocalized(value: FirstMessageStudioText | undefined, nextValue: string): FirstMessageStudioText {
        return setStudioTextLanguage(value, editLocale, nextValue, draft.localization.languages)
    }

    function newLocalized(value: string): FirstMessageStudioText {
        return setStudioTextLanguage(undefined, editLocale, value, draft.localization.languages)
    }

    function migrateTextLanguage(value: FirstMessageStudioText | undefined, previous: string, next: string) {
        if (!value || typeof value === 'string' || !(previous in value)) return value
        const migrated = { ...value, [next]: value[previous] }
        delete migrated[previous]
        return migrated
    }

    function renameLanguage(language: FirstMessageStudioLanguage, nextIdValue: string) {
        const nextId = nextIdValue.trim().replace(/[^a-zA-Z0-9_-]+/g, '-')
        const previous = language.id
        if (!nextId || nextId === previous || draft.localization.languages.some((candidate) => candidate !== language && candidate.id === nextId)) return
        const migrate = (value: FirstMessageStudioText | undefined) => migrateTextLanguage(value, previous, nextId)
        draft.title = migrate(draft.title)!
        for (const variable of draft.variables) {
            variable.label = migrate(variable.label)!
            for (const choice of variable.choices) {
                choice.label = migrate(choice.label)!
                choice.value = migrate(choice.value)!
            }
        }
        for (const stage of draft.stages) {
            stage.tag = migrate(stage.tag)!
            stage.title = migrate(stage.title)!
            stage.speaker = migrate(stage.speaker)
            stage.description = migrate(stage.description)!
            for (const option of stage.options) {
                option.label = migrate(option.label)!
                option.description = migrate(option.description)
                option.badge = migrate(option.badge)
                for (const effect of option.effects) effect.value = migrate(effect.value)!
                if (option.input) {
                    option.input.label = migrate(option.input.label)!
                    option.input.placeholder = migrate(option.input.placeholder)
                }
            }
        }
        language.id = nextId
        if (draft.localization.defaultLanguage === previous) draft.localization.defaultLanguage = nextId
        if (editLocale === previous) editLocale = nextId
        if (translationSource === previous) translationSource = nextId
        if (translationTarget === previous) translationTarget = nextId
    }

    function addLanguage() {
        const id = uniqueId('language', draft.localization.languages.map((language) => language.id))
        draft.localization.languages.push({ id, label: '새 언어', value: id })
        editLocale = id
        translationTarget = id
    }

    function removeLanguage(index: number) {
        if (draft.localization.languages.length === 1) return
        const [removed] = draft.localization.languages.splice(index, 1)
        const fallback = draft.localization.languages[0].id
        if (draft.localization.defaultLanguage === removed.id) draft.localization.defaultLanguage = fallback
        if (editLocale === removed.id) editLocale = fallback
        if (translationSource === removed.id) translationSource = fallback
        if (translationTarget === removed.id) translationTarget = fallback
    }

    async function translateStudio() {
        translationMessage = ''
        if (translationSource === translationTarget) {
            translationMessage = '원본 언어와 번역 언어가 같습니다.'
            return
        }
        const entries = collectFirstMessageStudioTranslationEntries(draft, translationSource)
        if (entries.length === 0) {
            translationMessage = '원본 언어에 번역할 문구가 없습니다.'
            return
        }
        const source = draft.localization.languages.find((language) => language.id === translationSource)
        const target = draft.localization.languages.find((language) => language.id === translationTarget)
        const controller = new AbortController()
        translationController = controller
        translating = true
        try {
            const response = await requestChatData({
                formated: [{ role: 'user', content: buildFirstMessageStudioTranslationPrompt(entries, source?.label ?? translationSource, target?.label ?? translationTarget) }],
                bias: {},
                currentChar: character,
                useStreaming: false,
                noMultiGen: true,
                tools: [],
                disablePromptCache: true,
                logSource: 'other',
            }, 'model', controller.signal)
            if (controller.signal.aborted) return
            if (response.type !== 'success') throw new Error('translation-request-failed')
            const translations = parseFirstMessageStudioTranslations(response.result, entries.map((entry) => entry.id))
            draft = applyFirstMessageStudioTranslations($state.snapshot(draft), translationTarget, translations)
            editLocale = translationTarget
            translationMessage = `${entries.length}개 문구를 번역했습니다.`
        }
        catch (cause) {
            if (!controller.signal.aborted) {
                translationMessage = cause instanceof Error && cause.message === 'translation-response-incomplete'
                    ? '일부 번역이 빠졌습니다. 다시 시도해 주세요.'
                    : '번역 결과를 적용하지 못했습니다. 다시 시도해 주세요.'
            }
        }
        finally {
            if (translationController === controller) translationController = undefined
            translating = false
        }
    }

    onDestroy(() => translationController?.abort())

    function uniqueId(prefix: string, values: string[]) {
        let index = values.length + 1
        while (values.includes(`${prefix}-${index}`)) index++
        return `${prefix}-${index}`
    }

    function addStage() {
        const id = uniqueId('stage', draft.stages.map((stage) => stage.id))
        draft.stages.push({
            id,
            tag: newLocalized('단계'),
            title: newLocalized('새 화면'),
            description: newLocalized('안내나 질문을 적어 주세요.'),
            options: [],
        })
        selectedStageId = id
    }

    function moveStage(direction: -1 | 1) {
        if (!selectedStage) return
        const index = draft.stages.findIndex((stage) => stage.id === selectedStage.id)
        const target = index + direction
        if (index < 0 || target < 0 || target >= draft.stages.length) return
        const [moved] = draft.stages.splice(index, 1)
        draft.stages.splice(target, 0, moved)
    }

    function removeStage() {
        if (!selectedStage || draft.stages.length === 1) return
        const removed = selectedStage.id
        draft.stages = draft.stages.filter((stage) => stage.id !== removed)
        for (const stage of draft.stages) {
            for (const option of stage.options) if (option.nextStageId === removed) option.nextStageId = undefined
        }
        if (draft.startStageId === removed) draft.startStageId = draft.stages[0].id
        selectedStageId = draft.stages[0].id
    }

    function addOption() {
        if (!selectedStage) return
        selectedStage.options.push({
            id: uniqueId('choice', selectedStage.options.map((option) => option.id)),
            label: newLocalized('새 선택지'),
            description: newLocalized(''),
            effects: draft.variables[0] ? [{ variable: draft.variables[0].name, value: '' }] : [],
        })
    }

    function removeOption(id: string) {
        if (selectedStage) selectedStage.options = selectedStage.options.filter((option) => option.id !== id)
    }

    function moveOption(index: number, direction: -1 | 1) {
        if (!selectedStage) return
        const target = index + direction
        if (target < 0 || target >= selectedStage.options.length) return
        const [moved] = selectedStage.options.splice(index, 1)
        selectedStage.options.splice(target, 0, moved)
    }

    function selectSkin(preset: FirstMessageStudioSkinPreset) {
        draft.appearance = preset === 'custom' ? { ...draft.appearance, preset } : createStudioAppearance(preset)
    }

    function addEffect(option: FirstMessageStudioOption) {
        option.effects.push({ variable: draft.variables[0]?.name ?? 'variable_name', value: '' })
    }

    function toggleInput(option: FirstMessageStudioOption, checked: boolean) {
        option.input = checked ? {
            variable: draft.variables[0]?.name ?? 'custom_input',
            label: newLocalized('직접 입력'),
            placeholder: newLocalized('여기에 입력하세요'),
            required: true,
        } : undefined
    }

    function addVariable() {
        const names = draft.variables.map((variable) => variable.name)
        const name = uniqueId('variable', names)
        draft.variables.push({
            name,
            label: newLocalized('새 변수'),
            defaultValue: '',
            choices: [],
        })
    }

    function removeVariable(index: number) {
        draft.variables.splice(index, 1)
    }

    function renameVariable(variable: FirstMessageStudioVariable, nextName: string) {
        const previousName = variable.name
        variable.name = nextName
        if (!previousName || previousName === nextName) return
        for (const stage of draft.stages) {
            for (const option of stage.options) {
                for (const effect of option.effects) if (effect.variable === previousName) effect.variable = nextName
                if (option.input?.variable === previousName) option.input.variable = nextName
                if (option.input?.displayVariable === previousName) option.input.displayVariable = nextName
            }
        }
    }

    function addVariableChoice(variable: FirstMessageStudioVariable) {
        variable.choices.push({
            label: newLocalized('새 값'),
            value: '',
        })
    }

    function useVariableChoices(variable: FirstMessageStudioVariable) {
        if (!selectedStage) return
        for (const choice of variable.choices) {
            selectedStage.options.push({
                id: uniqueId('choice', selectedStage.options.map((option) => option.id)),
                label: structuredClone(choice.label),
                effects: [{ variable: variable.name, value: structuredClone(choice.value) }],
            })
        }
        editorMode = 'content'
    }

    function save() {
        const project = normalizeFirstMessageStudioProject($state.snapshot(draft))
        character.firstMessageStudio = project
        const currentChat = character.chats?.[character.chatPage]
        if (currentChat) currentChat.scriptstate = resetFirstMessageStudioScriptstate(project, currentChat.scriptstate ?? {})
        if (project.compatibilityEnabled) {
            const compiled = compileFirstMessageStudioCompatibility(project)
            character.firstMessage = compiled.firstMessage
            character.triggerscript = mergeFirstMessageStudioTriggers(character.triggerscript ?? [], compiled.triggers)
            character.defaultVariables = mergeFirstMessageStudioDefaultVariables(character.defaultVariables ?? '', compiled.defaultVariables)
        }
        else {
            character.firstMessage = project.fallbackMessage
            character.triggerscript = mergeFirstMessageStudioTriggers(character.triggerscript ?? [], [])
            character.defaultVariables = mergeFirstMessageStudioDefaultVariables(character.defaultVariables ?? '', '')
        }
        onClose()
    }

    async function exportProject() {
        shareMessage = ''
        const filename = `${character.name || 'character'}-first-message-studio.json`.replace(/[\\/:*?"<>|]+/g, '-')
        await downloadFile(filename, new TextEncoder().encode(exportFirstMessageStudioProject($state.snapshot(draft))))
        shareMessage = '스튜디오 프로젝트를 내보냈습니다.'
    }

    async function importProject() {
        shareMessage = ''
        try {
            const files = await selectFileByDom(['json'])
            if (!files?.[0]) return
            draft = importFirstMessageStudioProject(await files[0].text())
            selectedStageId = draft.startStageId
            editLocale = draft.localization.defaultLanguage
            translationSource = draft.localization.defaultLanguage
            translationTarget = draft.localization.languages.find((language) => language.id !== draft.localization.defaultLanguage)?.id ?? draft.localization.defaultLanguage
            shareMessage = '스튜디오 프로젝트를 불러왔습니다. 저장하기 전까지 캐릭터에는 적용되지 않습니다.'
        }
        catch (cause) {
            shareMessage = cause instanceof Error ? cause.message : '프로젝트를 불러오지 못했습니다.'
        }
    }
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-label="퍼스트 메시지 스튜디오">
    <section class="shell">
        <header class="topbar">
            <div class="title-row" data-studio-title-row>
                <h2>퍼스트 메시지 스튜디오</h2>
                <p>변수와 선택지를 연결하고, 첫 화면의 모양을 직접 구성합니다.</p>
            </div>
            <div class="top-actions">
                <label class="switch" data-studio-enabled-toggle title="끄면 스튜디오 선택기 대신 기존 퍼스트 메시지를 사용합니다."><input type="checkbox" bind:checked={draft.enabled}/> 스튜디오 사용</label>
                <button type="button" aria-label="닫기" onclick={onClose}>✕</button>
            </div>
        </header>

        <main class="workspace">
            <aside class="rail">
                <div class="rail-title"><span>화면</span><button type="button" data-studio-add-stage onclick={addStage}>＋ 새 화면</button></div>
                <div class="stage-list">
                    {#each draft.stages as stage, index}
                        <button
                            type="button"
                            data-studio-editor-stage={stage.id}
                            class:active={!selectedStageId ? stage.id === draft.startStageId : stage.id === selectedStageId}
                            onclick={() => editStage(stage.id)}
                        >
                            <small>STEP {index + 1}</small>
                            <strong>{localized(stage.title)}</strong>
                            <span>{stage.options.length}개 선택지</span>
                        </button>
                    {/each}
                </div>
                <div class="rail-move">
                    <button type="button" data-studio-move-stage-up onclick={() => moveStage(-1)} disabled={draft.stages.indexOf(selectedStage) <= 0}>↑ 이동</button>
                    <button type="button" data-studio-move-stage-down onclick={() => moveStage(1)} disabled={draft.stages.indexOf(selectedStage) >= draft.stages.length - 1}>↓ 이동</button>
                </div>
                <button class="rail-action danger" type="button" data-studio-remove-stage onclick={removeStage} disabled={draft.stages.length === 1}>화면 삭제</button>
            </aside>

            <section class="editor">
                <nav class="mode-tabs" data-studio-primary-toolbar aria-label="스튜디오 편집 영역">
                    <button type="button" data-studio-languages-tab class:active={editorMode === 'languages'} onclick={() => editorMode = 'languages'}>언어</button>
                    <button type="button" data-studio-variables-tab class:active={editorMode === 'variables'} onclick={() => editorMode = 'variables'}>변수</button>
                    <button type="button" data-studio-design-tab class:active={editorMode === 'design'} onclick={() => editorMode = 'design'}>창 디자인</button>
                    <button type="button" data-studio-code-tab class:active={editorMode === 'code'} onclick={() => editorMode = 'code'}>고급 코드</button>
                    <button type="button" data-studio-share-tab class:active={editorMode === 'share'} onclick={() => editorMode = 'share'}>공유</button>
                </nav>

                {#if editorMode === 'content'}
                    <section class="screen-toolbar" data-studio-screen-toolbar aria-label="화면 번역 편집 도구">
                        <span aria-hidden="true"></span>
                        <button
                            type="button"
                            data-studio-ai-translation-toggle
                            class:active={showAiTranslation}
                            title="프로젝트의 모든 화면·선택지·변수 표시 문구를 원본 언어에서 대상 언어로 번역합니다. 변수명과 저장값은 변경하지 않습니다."
                            onclick={() => showAiTranslation = !showAiTranslation}
                        >UI 자동번역</button>
                        <label>편집 언어
                            <select data-studio-edit-language value={editLocale} onchange={(event) => editLocale = event.currentTarget.value}>
                                {#each draft.localization.languages as language}<option value={language.id}>{language.label}</option>{/each}
                            </select>
                        </label>
                    </section>
                {/if}
                {#if editorMode === 'content' && showAiTranslation}
                    <section class="translation-panel" data-studio-ai-translation-panel>
                        <div>
                            <strong>메인 모델로 UI 문구 번역</strong>
                            <small>화면 제목·설명·선택지처럼 사용자에게 보이는 문구만 번역합니다. 변수명과 저장값은 건드리지 않습니다.</small>
                        </div>
                        <label>원본 언어
                            <select value={translationSource} onchange={(event) => translationSource = event.currentTarget.value}>
                                {#each draft.localization.languages as language}<option value={language.id}>{language.label}</option>{/each}
                            </select>
                        </label>
                        <label>번역 언어
                            <select data-studio-ai-target-language value={translationTarget} onchange={(event) => translationTarget = event.currentTarget.value}>
                                {#each draft.localization.languages as language}<option value={language.id}>{language.label}</option>{/each}
                            </select>
                        </label>
                        <button type="button" data-studio-ai-translate disabled={translating || translationSource === translationTarget} onclick={translateStudio}>{translating ? '번역 중…' : '프로젝트 전체 번역'}</button>
                        {#if translationMessage}<p>{translationMessage}</p>{/if}
                    </section>
                {/if}

                {#if editorMode === 'languages'}
                    <section class="language-page" data-studio-language-settings>
                        <div class="section-heading">
                            <div><span>LOCALIZATION</span><h3>프로젝트 언어 설정</h3><p>편집할 언어와 퍼스트 메시지에서 저장할 언어 변수값을 관리합니다.</p></div>
                            <button type="button" data-studio-add-language onclick={addLanguage}>＋ 언어 추가</button>
                        </div>
                        <div class="language-settings">
                            <div class="language-project-fields">
                                <label>언어 변수 이름<input data-studio-language-variable bind:value={draft.localization.variable} placeholder="cv_lang"/></label>
                                <label>기본 언어<select bind:value={draft.localization.defaultLanguage}>{#each draft.localization.languages as language}<option value={language.id}>{language.label}</option>{/each}</select></label>
                            </div>
                            <div class="language-list-heading"><div><strong>프로젝트 언어</strong><small>언어 키는 번역 데이터에, 변수 저장값은 퍼스트 메시지의 언어 선택 결과에 사용됩니다.</small></div></div>
                            <div class="language-list">
                                {#each draft.localization.languages as language, languageIndex}
                                    <article class="language-row" data-studio-language={language.id}>
                                        <b>{String(languageIndex + 1).padStart(2, '0')}</b>
                                        <label>언어 키<input value={language.id} onchange={(event) => renameLanguage(language, event.currentTarget.value)} placeholder="ko"/></label>
                                        <label>표시 이름<input bind:value={language.label} placeholder="한국어"/></label>
                                        <label>변수 저장값<input bind:value={language.value} placeholder="1"/></label>
                                        <button type="button" aria-label={`${language.label} 삭제`} onclick={() => removeLanguage(languageIndex)} disabled={draft.localization.languages.length === 1}>삭제</button>
                                    </article>
                                {/each}
                            </div>
                        </div>
                    </section>
                {:else if editorMode === 'variables'}
                    <section class="variable-editor">
                        <div class="section-heading">
                            <div><span>VARIABLES</span><h3>변수와 선택 가능한 값</h3><p>선택 결과를 저장할 이름과 값 목록을 먼저 등록합니다.</p></div>
                            <button type="button" data-studio-add-variable onclick={addVariable}>＋ 변수 등록</button>
                        </div>
                        {#if draft.variables.length === 0}
                            <div class="empty-state">아직 변수가 없습니다. 변수를 등록한 뒤 각 값으로 선택지를 만들 수 있습니다.</div>
                        {/if}
                        {#each draft.variables as variable, variableIndex}
                            <article class="variable-card" data-studio-variable={variable.name}>
                                <header><strong>{localized(variable.label) || variable.name}</strong><button type="button" onclick={() => removeVariable(variableIndex)}>삭제</button></header>
                                <div class="three-columns">
                                    <label>변수 이름<input data-studio-variable-name value={variable.name} oninput={(event) => renameVariable(variable, event.currentTarget.value)} placeholder="route"/></label>
                                    <label>표시 이름<input value={localized(variable.label)} oninput={(event) => variable.label = setLocalized(variable.label, event.currentTarget.value)}/></label>
                                    <label>기본값<input bind:value={variable.defaultValue} placeholder="default"/></label>
                                </div>
                                <div class="value-heading"><strong>선택 가능한 값</strong><button type="button" data-studio-add-variable-choice onclick={() => addVariableChoice(variable)}>＋ 값 추가</button></div>
                                <div class="value-list">
                                    {#each variable.choices as choice, choiceIndex}
                                        <div class="value-row" data-studio-variable-choice>
                                            <input aria-label="값 표시 이름" value={localized(choice.label)} oninput={(event) => choice.label = setLocalized(choice.label, event.currentTarget.value)} placeholder="표시 이름"/>
                                            <span>→</span>
                                            <input aria-label="저장 값" value={localized(choice.value)} oninput={(event) => choice.value = setLocalized(choice.value, event.currentTarget.value)} placeholder="저장 값"/>
                                            <button type="button" aria-label="값 삭제" onclick={() => variable.choices.splice(choiceIndex, 1)}>✕</button>
                                        </div>
                                    {/each}
                                </div>
                                <button class="use-values" type="button" disabled={variable.choices.length === 0} onclick={() => useVariableChoices(variable)}>현재 화면에 이 값들을 선택지로 추가</button>
                            </article>
                        {/each}
                    </section>
                {:else if editorMode === 'design'}
                    <section class="design-editor">
                        <div class="section-heading"><div><span>WINDOW</span><h3>색상과 형태</h3><p>기본 창의 외형만 설정합니다. 특수 표현은 고급 코드에서 추가할 수 있습니다.</p></div></div>
                        <div class="skin-grid">
                            <button type="button" data-studio-skin="minimal" class:active={draft.appearance.preset === 'minimal'} onclick={() => selectSkin('minimal')}><i class="skin-swatch minimal"></i><strong>Minimal</strong><small>단정한 기본 창</small></button>
                            <button type="button" data-studio-skin="glass" class:active={draft.appearance.preset === 'glass'} onclick={() => selectSkin('glass')}><i class="skin-swatch glass"></i><strong>Glass</strong><small>투명한 패널</small></button>
                            <button type="button" data-studio-skin="custom" class:active={draft.appearance.preset === 'custom'} onclick={() => selectSkin('custom')}><i class="skin-swatch custom"></i><strong>Custom</strong><small>현재 값 직접 조정</small></button>
                        </div>
                        <div class="design-card">
                            <div class="color-grid">
                                <label>강조색<span class="color-input"><input type="color" data-studio-accent-color bind:value={draft.appearance.accentColor}/><input bind:value={draft.appearance.accentColor}/></span></label>
                                <label>창 배경<span class="color-input"><input type="color" bind:value={draft.appearance.backgroundColor}/><input bind:value={draft.appearance.backgroundColor}/></span></label>
                                <label>내용 배경<span class="color-input"><input type="color" bind:value={draft.appearance.surfaceColor}/><input bind:value={draft.appearance.surfaceColor}/></span></label>
                                <label>글자색<span class="color-input"><input type="color" bind:value={draft.appearance.textColor}/><input bind:value={draft.appearance.textColor}/></span></label>
                            </div>
                            <div class="two-columns">
                                <label>선택지 한 줄 개수<select data-studio-option-columns bind:value={draft.appearance.optionColumns}><option value={1}>1개</option><option value={2}>2개</option><option value={3}>3개</option></select></label>
                                <label>모서리 둥글기 <b>{draft.appearance.cornerRadius}px</b><input type="range" min="0" max="32" bind:value={draft.appearance.cornerRadius}/></label>
                            </div>
                        </div>
                        <div class="design-card toggles">
                            <header><strong>보이거나 숨길 기본 요소</strong></header>
                            <label class="check"><input type="checkbox" bind:checked={draft.appearance.showHeader}/> 창 제목</label>
                            <label class="check"><input type="checkbox" bind:checked={draft.appearance.showProgress}/> 진행 단계</label>
                            <label class="check"><input type="checkbox" bind:checked={draft.appearance.showNavigation}/> 이전 / 처음부터 버튼</label>
                        </div>
                    </section>
                {:else if editorMode === 'code'}
                    <section class="code-editor">
                        <div class="section-heading"><div><span>ADVANCED</span><h3>고급 표현 코드</h3><p>기본 기능에 없는 장식이나 상태 표시는 여기서 추가합니다.</p></div></div>
                        <article class="code-card">
                            <header><div><strong>사용자 CSS</strong><small><code>:scope</code>는 이 창 하나를 뜻합니다. 다른 채팅 UI에는 적용되지 않습니다.</small></div></header>
                            <textarea data-studio-custom-css class="code-area" rows="14" bind:value={draft.customCss} spellcheck="false" placeholder={':scope { border-width: 2px; }\n.studio-extra { color: #7dd3fc; }'}></textarea>
                        </article>
                        <article class="code-card">
                            <header><div><strong>추가 HTML</strong><small>창 본문 위에 삽입됩니다. <code>{'{{variable_name}}'}</code>으로 변수를 표시할 수 있습니다. 스크립트와 이벤트 속성은 안전을 위해 제거됩니다.</small></div></header>
                            <textarea data-studio-custom-html class="code-area" rows="10" bind:value={draft.customHtml} spellcheck="false" placeholder={'<div class="studio-extra">선택: {{route}}</div>'}></textarea>
                        </article>
                    </section>
                {:else if editorMode === 'share'}
                    <section class="share-editor" data-studio-share-settings>
                        <div class="section-heading"><div><span>SHARE</span><h3>공유와 Risu 호환</h3><p>편집 가능한 원본과 일반 Risu가 실행할 결과를 함께 관리합니다.</p></div></div>
                        <article class="share-card">
                            <div><strong>스튜디오 프로젝트</strong><small>화면, 선택지, 번역, 디자인과 완료 후 메시지를 하나의 JSON 파일로 옮깁니다.</small></div>
                            <div class="share-actions">
                                <button type="button" data-studio-export-project onclick={exportProject}>프로젝트 내보내기</button>
                                <button type="button" data-studio-import-project onclick={importProject}>프로젝트 가져오기</button>
                            </div>
                        </article>
                        <article class="share-card compatibility-card">
                            <div><strong>일반 Risu 호환 결과</strong><small>저장할 때 표준 퍼스트 메시지, 기본 변수와 버튼 트리거를 생성합니다. 스튜디오 원본은 카드 확장 필드에 그대로 남아 다시 편집할 수 있습니다.</small></div>
                            <label class="switch" data-studio-compatibility-toggle><input type="checkbox" bind:checked={draft.compatibilityEnabled}/> 저장 시 호환 결과 포함</label>
                        </article>
                        <article class="share-card fallback-card">
                            <div><strong>완료 후 원문 메시지</strong><small>선택기가 끝난 뒤 표시할 실제 첫 메시지입니다. 호환 결과 안에 포함되지만 이 원본은 별도로 보존됩니다.</small></div>
                            <textarea data-studio-fallback-message rows="12" bind:value={draft.fallbackMessage}></textarea>
                        </article>
                        {#if shareMessage}<p class="share-message">{shareMessage}</p>{/if}
                    </section>
                {:else}
                    {#if selectedStage}
                        <div class="form-box">
                            <label>화면 태그<input value={localized(selectedStage.tag)} oninput={(event) => selectedStage.tag = setLocalized(selectedStage.tag, event.currentTarget.value)}/></label>
                            <label>화면 제목<input data-studio-stage-title value={localized(selectedStage.title)} oninput={(event) => selectedStage.title = setLocalized(selectedStage.title, event.currentTarget.value)}/></label>
                            <label>화자 <span class="optional">선택 사항 · 비우면 표시하지 않음</span><input data-studio-stage-speaker value={localized(selectedStage.speaker)} oninput={(event) => selectedStage.speaker = event.currentTarget.value ? setLocalized(selectedStage.speaker, event.currentTarget.value) : undefined}/></label>
                            <label>질문 · 설명<textarea rows="2" value={localized(selectedStage.description)} oninput={(event) => selectedStage.description = setLocalized(selectedStage.description, event.currentTarget.value)}></textarea></label>
                        </div>

                        <div class="option-heading">
                            <div><strong>선택지</strong><small>선택하면 저장할 변수와 값을 정합니다.</small></div>
                            <button type="button" data-studio-add-option onclick={addOption}>＋ 선택지 추가</button>
                        </div>
                        <div class="option-list">
                            {#each selectedStage.options as option, optionIndex}
                                <article class="option-card" data-studio-option-card={option.id}>
                                    <header>
                                        <b>{String(optionIndex + 1).padStart(2, '0')}</b><strong>{localized(option.label)}</strong>
                                        <div class="option-actions">
                                            <button type="button" aria-label="선택지 위로 이동" data-studio-move-option-up={option.id} onclick={() => moveOption(optionIndex, -1)} disabled={optionIndex === 0}>↑</button>
                                            <button type="button" aria-label="선택지 아래로 이동" data-studio-move-option-down={option.id} onclick={() => moveOption(optionIndex, 1)} disabled={optionIndex === selectedStage.options.length - 1}>↓</button>
                                            <button class="delete" type="button" data-studio-delete-option={option.id} onclick={() => removeOption(option.id)}>삭제</button>
                                        </div>
                                    </header>
                                    <div class="option-body">
                                        <label>버튼 이름<input value={localized(option.label)} oninput={(event) => option.label = setLocalized(option.label, event.currentTarget.value)}/></label>
                                        <label>짧은 설명<input value={localized(option.description)} oninput={(event) => option.description = setLocalized(option.description, event.currentTarget.value)}/></label>
                                        <div class="two-columns">
                                            <label>다음 화면<select value={option.nextStageId ?? ''} onchange={(event) => option.nextStageId = event.currentTarget.value || undefined}><option value="">현재 화면 유지</option>{#each draft.stages as target}<option value={target.id}>{localized(target.title)}</option>{/each}</select></label>
                                            <label class="check"><input type="checkbox" bind:checked={option.completes}/> 이 선택으로 완료</label>
                                        </div>
                                        <div class="effects">
                                            <div><strong>저장할 변수와 값</strong><button type="button" onclick={() => addEffect(option)}>＋ 추가</button></div>
                                            {#each option.effects as effect, effectIndex}
                                                <div class="effect-row">
                                                    {#if draft.variables.length > 0}
                                                        <select aria-label="변수 이름" bind:value={effect.variable}>
                                                            {#each draft.variables as variable}<option value={variable.name}>{localized(variable.label) || variable.name}</option>{/each}
                                                        </select>
                                                    {:else}
                                                        <input aria-label="변수 이름" bind:value={effect.variable} placeholder="variable_name"/>
                                                    {/if}
                                                    <span>=</span>
                                                    <input aria-label="저장 값" value={localized(effect.value)} oninput={(event) => effect.value = setLocalized(effect.value, event.currentTarget.value)} placeholder="value"/>
                                                    <button type="button" aria-label="변수 삭제" onclick={() => option.effects.splice(effectIndex, 1)}>✕</button>
                                                </div>
                                            {/each}
                                        </div>
                                        <label class="check"><input type="checkbox" checked={Boolean(option.input)} onchange={(event) => toggleInput(option, event.currentTarget.checked)}/> 사용자가 직접 입력하는 선택지</label>
                                        {#if option.input}
                                            <div class="three-columns input-settings">
                                                <label>입력 변수<input bind:value={option.input.variable}/></label>
                                                <label>입력 안내<input value={localized(option.input.label)} oninput={(event) => option.input!.label = setLocalized(option.input!.label, event.currentTarget.value)}/></label>
                                                <label>예시 문구<input value={localized(option.input.placeholder)} oninput={(event) => option.input!.placeholder = setLocalized(option.input!.placeholder, event.currentTarget.value)}/></label>
                                            </div>
                                        {/if}
                                    </div>
                                </article>
                            {/each}
                        </div>
                    {/if}
                {/if}
            </section>

            <aside class="preview">
                <header><strong>실제 미리보기</strong><small>직접 클릭해 전체 흐름을 시험하세요.</small></header>
                <FirstMessageStudioRuntime project={draft} preview/>
                <details>
                    <summary>완료 후 원문 메시지</summary>
                    <p>스튜디오가 꺼져 있거나 완료된 뒤에는 이 원문이 사용됩니다.</p>
                    <textarea rows="7" bind:value={draft.fallbackMessage}></textarea>
                </details>
            </aside>
        </main>

        <footer class="footer">
            <span>스튜디오 데이터는 캐릭터 카드에도 포함됩니다.</span>
            <div><button type="button" onclick={onClose}>취소</button><button class="save" type="button" data-studio-save onclick={save}>저장하고 닫기</button></div>
        </footer>
    </section>
</div>

<style>
    .overlay{position:fixed;z-index:1000;inset:0;padding:1.25rem;background:rgba(3,5,8,.8)}
    .shell{display:grid;grid-template-rows:auto 1fr auto;width:min(96rem,100%);height:100%;margin:auto;overflow:hidden;border:1px solid var(--risu-theme-darkborderc);border-radius:1rem;color:var(--risu-theme-textcolor);background:var(--risu-theme-bgcolor);box-shadow:0 2rem 6rem rgba(0,0,0,.5)}
    .topbar,.footer{display:flex;align-items:center;justify-content:space-between;gap:1rem}
    .topbar{padding:1rem 1.25rem;border-bottom:1px solid var(--risu-theme-darkborderc);background:var(--risu-theme-darkbg)}
    .title-row{display:flex;min-width:0;align-items:baseline;gap:1rem}.topbar h2{flex:none;margin:0;font-size:1.3rem}.topbar p{overflow:hidden;margin:0;color:var(--risu-theme-textcolor2);font-size:.78rem;text-overflow:ellipsis;white-space:nowrap}
    .top-actions{display:flex;flex:none;align-items:center;gap:.7rem}.switch{display:flex;align-items:center;gap:.4rem;padding:.45rem .65rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.45rem;white-space:nowrap}.switch input{flex:none}
    .workspace{display:grid;grid-template-columns:13rem minmax(27rem,1fr) minmax(28rem,36rem);min-height:0}
    .rail,.editor,.preview{min-height:0;overflow:auto}.rail{display:flex;flex-direction:column;padding:.65rem;border-right:1px solid var(--risu-theme-darkborderc);background:var(--risu-theme-darkbg)}
    .rail-title{display:flex;align-items:center;justify-content:space-between;gap:.55rem;padding:.3rem;color:var(--risu-theme-textcolor2);font-size:.7rem;font-weight:800}.rail-title button{padding:.48rem .7rem;border:1px solid var(--risu-theme-darkborderc);background:var(--risu-theme-bgcolor);font-size:.7rem;font-weight:800}
    .stage-list{display:grid;gap:.35rem}.stage-list button{display:grid;gap:.12rem;padding:.62rem;border:1px solid transparent;border-radius:.5rem;text-align:left}
    .stage-list button.active{border-color:var(--risu-theme-primary);background:var(--risu-theme-bgcolor);box-shadow:inset 3px 0 var(--risu-theme-primary)}
    .stage-list small{color:var(--risu-theme-primary);font:700 .6rem ui-monospace,monospace}.stage-list span{color:var(--risu-theme-textcolor2);font-size:.62rem}
    .rail-action{margin-top:.6rem;padding:.45rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.4rem;font-size:.66rem}.rail-move{display:grid;grid-template-columns:1fr 1fr;gap:.3rem;margin-top:.6rem}
    .rail-move button{padding:.4rem .25rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.4rem;font-size:.6rem}.rail-action.danger{color:#ff8b79}
    .editor{padding:1rem}.mode-tabs{position:sticky;z-index:20;top:0;display:grid;grid-template-columns:repeat(5,minmax(7rem,1fr));gap:.35rem;overflow-x:auto;margin-bottom:.8rem;padding:.25rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.65rem;background:var(--risu-theme-darkbg);box-shadow:0 .5rem 1rem color-mix(in srgb,var(--risu-theme-darkbg) 70%,transparent)}
    .mode-tabs button{padding:.58rem;border-radius:.42rem;color:var(--risu-theme-textcolor2);font-weight:800}.mode-tabs button.active{color:var(--risu-theme-darkbg);background:var(--risu-theme-primary)}
    .screen-toolbar{position:sticky;z-index:19;top:3.2rem;display:grid;grid-template-columns:minmax(0,1fr) auto minmax(0,1fr);align-items:center;gap:.65rem;margin-bottom:.8rem;padding:.55rem .7rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.6rem;background:var(--risu-theme-darkbg);box-shadow:0 .5rem 1rem color-mix(in srgb,var(--risu-theme-darkbg) 70%,transparent)}
    .screen-toolbar>button{justify-self:center;border:1px solid var(--risu-theme-darkborderc);font-weight:800}.screen-toolbar>button.active{border-color:var(--risu-theme-primary);color:var(--risu-theme-primary)}.screen-toolbar>label{display:flex;justify-self:end;align-items:center;gap:.45rem;white-space:nowrap}.screen-toolbar select{width:8.5rem}
    .translation-panel{display:grid;grid-template-columns:minmax(12rem,1fr) 9rem 9rem auto;align-items:end;gap:.65rem;margin:-.25rem 0 .8rem;padding:.75rem;border:1px solid var(--risu-theme-primary);border-radius:.6rem;background:var(--risu-theme-darkbg)}
    .translation-panel>div{display:grid;gap:.18rem}.translation-panel small,.language-list-heading small{color:var(--risu-theme-textcolor2);font-size:.62rem}.translation-panel>p{grid-column:1/-1;margin:0;color:var(--risu-theme-primary);font-size:.66rem}
    .language-page{display:grid;gap:.75rem}
    .language-settings{display:grid;gap:.75rem;padding:.75rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.6rem;background:var(--risu-theme-darkbg)}.language-project-fields{display:grid;grid-template-columns:1fr 1fr;gap:.55rem}.language-list-heading{display:flex;align-items:end;justify-content:space-between}.language-list-heading>div{display:grid}.language-list{display:grid;gap:.4rem}.language-row{display:grid;grid-template-columns:auto 1fr 1fr 1fr auto;align-items:end;gap:.45rem;padding:.55rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.45rem;background:var(--risu-theme-bgcolor)}.language-row>b{align-self:center;color:var(--risu-theme-primary);font:800 .62rem ui-monospace,monospace}.language-row>button{align-self:end;color:#ff8b79}
    .form-box,.option-body{display:grid;gap:.65rem;padding:.75rem}.form-box{border:1px solid var(--risu-theme-darkborderc);border-radius:.6rem;background:var(--risu-theme-darkbg)}
    .two-columns,.three-columns{display:grid;grid-template-columns:1fr 1fr;gap:.55rem}.three-columns{grid-template-columns:repeat(3,1fr)}
    label{display:grid;gap:.28rem;color:var(--risu-theme-textcolor2);font-size:.66rem;font-weight:700}label .optional{font-size:.58rem;font-weight:500}
    input,textarea,select{width:100%;border:1px solid var(--risu-theme-darkborderc);border-radius:.38rem;padding:.46rem .52rem;color:var(--risu-theme-textcolor);background:var(--risu-theme-bgcolor);font:inherit;font-size:.74rem}
    .option-heading,.section-heading,.value-heading{display:flex;align-items:end;justify-content:space-between;gap:.7rem}.option-heading{margin:1rem 0 .55rem}.option-heading>div,.section-heading>div,.preview>header,.code-card header>div{display:grid}
    .section-heading span{color:var(--risu-theme-primary);font:800 .6rem ui-monospace,monospace;letter-spacing:.12em}.section-heading h3{margin:.2rem 0;font-size:1.1rem}.section-heading p,.preview small,.option-heading small,.code-card small{margin:0;color:var(--risu-theme-textcolor2);font-size:.68rem}
    .option-list,.variable-editor,.design-editor,.code-editor,.value-list{display:grid;gap:.7rem}.option-card,.variable-card,.design-card,.code-card{overflow:hidden;border:1px solid var(--risu-theme-darkborderc);border-radius:.65rem;background:var(--risu-theme-darkbg)}
    .option-card>header,.variable-card>header,.code-card>header{display:flex;align-items:center;gap:.5rem;padding:.58rem .7rem;border-bottom:1px solid var(--risu-theme-darkborderc)}.option-card>header b{color:var(--risu-theme-primary);font:800 .65rem ui-monospace,monospace}
    .option-actions{display:flex;gap:.25rem;margin-left:auto}.option-actions button{min-width:2rem;border:1px solid var(--risu-theme-darkborderc)}.option-actions .delete,.variable-card>header button{margin-left:auto;color:#ff8b79}
    .check{display:flex;align-items:center;gap:.4rem}.check input{width:auto}.effects{display:grid;gap:.35rem;padding:.5rem;border-radius:.4rem;background:var(--risu-theme-bgcolor)}.effects>div:first-child{display:flex;justify-content:space-between}
    .effect-row,.value-row{display:grid;grid-template-columns:1fr auto 1fr auto;align-items:center;gap:.3rem}.input-settings{padding:.5rem;border:1px dashed var(--risu-theme-darkborderc);border-radius:.4rem}
    .variable-card{display:grid;gap:.7rem;padding-bottom:.8rem}.variable-card>.three-columns,.variable-card>.value-heading,.variable-card>.value-list,.variable-card>.use-values{margin-inline:.8rem}.variable-card>.three-columns{margin-top:.1rem}.value-heading{align-items:center}
    .use-values{padding:.55rem;border:1px solid var(--risu-theme-primary);border-radius:.4rem;color:var(--risu-theme-primary)}.empty-state{padding:1rem;border:1px dashed var(--risu-theme-darkborderc);border-radius:.6rem;color:var(--risu-theme-textcolor2);font-size:.72rem;text-align:center}
    .skin-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:.5rem}.skin-grid button{display:grid;gap:.18rem;padding:.55rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.65rem;text-align:left;background:var(--risu-theme-darkbg)}.skin-grid button.active{border-color:var(--risu-theme-primary);box-shadow:inset 0 0 0 1px var(--risu-theme-primary)}.skin-grid small{color:var(--risu-theme-textcolor2);font-size:.58rem}
    .skin-swatch{height:3rem;margin-bottom:.2rem;border-radius:.4rem}.skin-swatch.minimal{background:linear-gradient(145deg,#1f2937 0 64%,#5b8cff 64% 72%,#111827 72%)}.skin-swatch.glass{background:radial-gradient(circle at 70% 20%,#65d9ff88,transparent 35%),linear-gradient(145deg,#1b4661cc,#101827)}.skin-swatch.custom{background:conic-gradient(from 90deg,#ff6b6b,#ffd166,#65d9ff,#b18cff,#ff6b6b)}
    .design-card{display:grid;gap:.75rem;padding:.8rem}.color-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.6rem}.color-input{display:grid;grid-template-columns:2.35rem 1fr;gap:.35rem}.color-input input[type='color']{height:2rem;padding:.15rem}.design-card.toggles{grid-template-columns:repeat(3,minmax(0,1fr))}.design-card.toggles header{grid-column:1/-1}
    .code-area{min-height:12rem;resize:vertical;border:0;border-radius:0;padding:.85rem;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace;tab-size:2}.code-card header code{color:var(--risu-theme-primary)}
    .share-editor{display:grid;gap:.75rem}.share-card{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.85rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.65rem;background:var(--risu-theme-darkbg)}.share-card>div:first-child{display:grid;gap:.2rem}.share-card small{color:var(--risu-theme-textcolor2);font-size:.66rem}.share-actions{display:flex;flex:none;gap:.45rem}.share-actions button{border:1px solid var(--risu-theme-primary);color:var(--risu-theme-primary)}.compatibility-card>.switch{flex:none}.fallback-card{display:grid}.fallback-card textarea{min-height:15rem}.share-message{margin:0;color:var(--risu-theme-primary);font-size:.7rem}
    .preview{padding:.9rem;border-left:1px solid var(--risu-theme-darkborderc);background:var(--risu-theme-darkbg)}.preview details{margin-top:.7rem;padding:.5rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.45rem}.preview details p{color:var(--risu-theme-textcolor2);font-size:.65rem}
    .footer{padding:.7rem 1rem;border-top:1px solid var(--risu-theme-darkborderc);background:var(--risu-theme-darkbg)}.footer>span{color:var(--risu-theme-textcolor2);font-size:.67rem}.footer>div{display:flex;gap:.45rem}
    button{padding:.4rem .58rem;border-radius:.4rem;color:inherit}button.save{color:var(--risu-theme-darkbg);background:var(--risu-theme-primary);font-weight:800}
    @media(max-width:72rem){.workspace{grid-template-columns:12rem 1fr}.preview{display:none}.translation-panel{grid-template-columns:1fr 1fr}.translation-panel>div{grid-column:1/-1}}@media(max-width:48rem){.overlay{padding:0}.shell{border:0;border-radius:0}.topbar{padding:.75rem}.title-row{gap:.55rem}.title-row p{display:none}.workspace{grid-template-columns:1fr}.rail{max-height:11rem}.stage-list{display:flex;overflow:auto}.stage-list button{min-width:9rem}.mode-tabs{grid-template-columns:repeat(5,minmax(7rem,1fr))}.screen-toolbar{grid-template-columns:minmax(0,1fr) auto minmax(0,1fr)}.screen-toolbar>span{display:block}.screen-toolbar>label{font-size:0}.screen-toolbar>label select{width:7rem;font-size:.7rem}.translation-panel,.language-project-fields,.language-row,.two-columns,.three-columns,.color-grid,.design-card.toggles{grid-template-columns:1fr}.share-card{display:grid}.skin-grid{grid-template-columns:1fr}}
</style>
