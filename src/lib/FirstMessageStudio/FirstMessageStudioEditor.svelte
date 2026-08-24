<script lang="ts">
    import type { character as Character } from 'src/ts/storage/database.svelte'
    import { getCurrentLocale } from 'src/lang'
    import {
        createBlankStudioProject,
        createStudioAppearance,
        normalizeFirstMessageStudioProject,
        type FirstMessageStudioLocale,
        type FirstMessageStudioOption,
        type FirstMessageStudioProject,
        type FirstMessageStudioSkinPreset,
        type FirstMessageStudioText,
        type FirstMessageStudioVariable,
        toFirstMessageStudioLocale,
    } from 'src/ts/firstMessageStudio'
    import FirstMessageStudioRuntime from './FirstMessageStudioRuntime.svelte'

    interface Props {
        character: Character
        onClose: () => void
    }

    let { character, onClose }: Props = $props()

    function makeInitialProject(): FirstMessageStudioProject {
        return character.firstMessageStudio
            ? normalizeFirstMessageStudioProject(structuredClone(character.firstMessageStudio))
            : createBlankStudioProject()
    }

    let draft = $state(makeInitialProject())
    let selectedStageId = $state('')
    let editLocale: FirstMessageStudioLocale = $state(toFirstMessageStudioLocale(getCurrentLocale()))
    let showProjectSettings = $state(false)
    let editorMode: 'content' | 'variables' | 'design' | 'code' = $state('content')
    let selectedStage = $derived(draft.stages.find((stage) => stage.id === selectedStageId) ?? draft.stages[0])

    function localized(value: FirstMessageStudioText | undefined) {
        if (typeof value === 'string') return value
        return value?.[editLocale] ?? ''
    }

    function toggleProjectSettings() {
        if (editorMode !== 'content') {
            editorMode = 'content'
            showProjectSettings = true
            return
        }
        showProjectSettings = !showProjectSettings
    }

    function setLocalized(value: FirstMessageStudioText | undefined, nextValue: string): FirstMessageStudioText {
        const translated = typeof value === 'string'
            ? { ko: value, ja: value, en: value }
            : { ko: value?.ko ?? '', ja: value?.ja ?? value?.ko ?? '', en: value?.en ?? value?.ko ?? '' }
        translated[editLocale] = nextValue
        return translated
    }

    function uniqueId(prefix: string, values: string[]) {
        let index = values.length + 1
        while (values.includes(`${prefix}-${index}`)) index++
        return `${prefix}-${index}`
    }

    function addStage() {
        const id = uniqueId('stage', draft.stages.map((stage) => stage.id))
        draft.stages.push({
            id,
            tag: { ko: '단계', ja: '段階', en: 'STEP' },
            title: { ko: '새 화면', ja: '新しい画面', en: 'New screen' },
            description: { ko: '안내나 질문을 적어 주세요.', ja: '案内や質問を入力してください。', en: 'Write an introduction or question.' },
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
            label: { ko: '새 선택지', ja: '新しい選択肢', en: 'New choice' },
            description: { ko: '', ja: '', en: '' },
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
            label: { ko: '직접 입력', ja: '自由入力', en: 'Custom input' },
            placeholder: { ko: '여기에 입력하세요', ja: 'ここに入力', en: 'Type here' },
            required: true,
        } : undefined
    }

    function addVariable() {
        const names = draft.variables.map((variable) => variable.name)
        const name = uniqueId('variable', names)
        draft.variables.push({
            name,
            label: { ko: '새 변수', ja: '新しい変数', en: 'New variable' },
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
            label: { ko: '새 값', ja: '新しい値', en: 'New value' },
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
        character.firstMessageStudio = normalizeFirstMessageStudioProject($state.snapshot(draft))
        onClose()
    }
</script>

<div class="overlay" role="dialog" aria-modal="true" aria-label="퍼스트 메시지 스튜디오">
    <section class="shell">
        <header class="topbar">
            <div>
                <span class="eyebrow">FIRST MESSAGE BUILDER</span>
                <h2>퍼스트 메시지 스튜디오</h2>
                <p>변수와 선택지를 연결하고, 첫 화면의 모양을 직접 구성합니다.</p>
            </div>
            <div class="top-actions">
                <label class="switch"><input type="checkbox" bind:checked={draft.enabled}/> 스튜디오 사용</label>
                <button type="button" aria-label="닫기" onclick={onClose}>✕</button>
            </div>
        </header>

        <main class="workspace">
            <aside class="rail">
                <div class="rail-title"><span>화면</span><button type="button" data-studio-add-stage onclick={addStage}>＋</button></div>
                <div class="stage-list">
                    {#each draft.stages as stage, index}
                        <button
                            type="button"
                            data-studio-editor-stage={stage.id}
                            class:active={!selectedStageId ? stage.id === draft.startStageId : stage.id === selectedStageId}
                            onclick={() => selectedStageId = stage.id}
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
                <button
                    class="rail-action settings"
                    type="button"
                    data-studio-project-settings
                    aria-expanded={showProjectSettings && editorMode === 'content'}
                    onclick={toggleProjectSettings}
                >프로젝트 설정</button>
            </aside>

            <section class="editor">
                <nav class="mode-tabs" aria-label="스튜디오 편집 영역">
                    <button type="button" class:active={editorMode === 'content'} onclick={() => editorMode = 'content'}>화면과 선택지</button>
                    <button type="button" data-studio-variables-tab class:active={editorMode === 'variables'} onclick={() => editorMode = 'variables'}>변수</button>
                    <button type="button" data-studio-design-tab class:active={editorMode === 'design'} onclick={() => editorMode = 'design'}>창 디자인</button>
                    <button type="button" data-studio-code-tab class:active={editorMode === 'code'} onclick={() => editorMode = 'code'}>고급 코드</button>
                </nav>

                {#if editorMode === 'variables'}
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
                                <label>선택지 한 줄 개수<select value={draft.appearance.optionColumns} onchange={(event) => draft.appearance.optionColumns = Number(event.currentTarget.value) as 1 | 2 | 3}><option value="1">1개</option><option value="2">2개</option><option value="3">3개</option></select></label>
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
                {:else}
                    {#if showProjectSettings}
                        <div class="form-box three-columns" data-studio-project-settings-panel>
                            <label>창 제목<input bind:value={draft.title}/></label>
                            <label>완료 변수<input bind:value={draft.completionVariable}/></label>
                            <label>현재 화면 변수<input value={draft.stageVariable ?? ''} oninput={(event) => draft.stageVariable = event.currentTarget.value || undefined}/></label>
                        </div>
                    {/if}

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
                    <textarea rows="7" value={character.firstMessage ?? ''} oninput={(event) => character.firstMessage = event.currentTarget.value}></textarea>
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
    .topbar h2{margin:.12rem 0;font-size:1.3rem}.topbar p{margin:0;color:var(--risu-theme-textcolor2);font-size:.78rem}
    .eyebrow{color:var(--risu-theme-primary);font:800 .62rem ui-monospace,monospace;letter-spacing:.12em}
    .top-actions{display:flex;align-items:center;gap:.7rem}.switch{display:flex;align-items:center;gap:.4rem;padding:.45rem .65rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.45rem}
    .workspace{display:grid;grid-template-columns:13rem minmax(27rem,1fr) minmax(28rem,36rem);min-height:0}
    .rail,.editor,.preview{min-height:0;overflow:auto}.rail{display:flex;flex-direction:column;padding:.65rem;border-right:1px solid var(--risu-theme-darkborderc);background:var(--risu-theme-darkbg)}
    .rail-title{display:flex;align-items:center;justify-content:space-between;padding:.3rem;color:var(--risu-theme-textcolor2);font-size:.7rem;font-weight:800}
    .stage-list{display:grid;gap:.35rem}.stage-list button{display:grid;gap:.12rem;padding:.62rem;border:1px solid transparent;border-radius:.5rem;text-align:left}
    .stage-list button.active{border-color:var(--risu-theme-primary);background:var(--risu-theme-bgcolor);box-shadow:inset 3px 0 var(--risu-theme-primary)}
    .stage-list small{color:var(--risu-theme-primary);font:700 .6rem ui-monospace,monospace}.stage-list span{color:var(--risu-theme-textcolor2);font-size:.62rem}
    .rail-action{margin-top:.6rem;padding:.45rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.4rem;font-size:.66rem}.rail-move{display:grid;grid-template-columns:1fr 1fr;gap:.3rem;margin-top:.6rem}
    .rail-move button{padding:.4rem .25rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.4rem;font-size:.6rem}.rail-action.danger{color:#ff8b79}.rail-action.settings{margin-top:auto}
    .editor{padding:1rem}.mode-tabs{display:grid;grid-template-columns:repeat(4,1fr);gap:.35rem;margin-bottom:.8rem;padding:.25rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.65rem;background:var(--risu-theme-darkbg)}
    .mode-tabs button{padding:.58rem;border-radius:.42rem;color:var(--risu-theme-textcolor2);font-weight:800}.mode-tabs button.active{color:var(--risu-theme-darkbg);background:var(--risu-theme-primary)}
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
    .preview{padding:.9rem;border-left:1px solid var(--risu-theme-darkborderc);background:var(--risu-theme-darkbg)}.preview details{margin-top:.7rem;padding:.5rem;border:1px solid var(--risu-theme-darkborderc);border-radius:.45rem}.preview details p{color:var(--risu-theme-textcolor2);font-size:.65rem}
    .footer{padding:.7rem 1rem;border-top:1px solid var(--risu-theme-darkborderc);background:var(--risu-theme-darkbg)}.footer>span{color:var(--risu-theme-textcolor2);font-size:.67rem}.footer>div{display:flex;gap:.45rem}
    button{padding:.4rem .58rem;border-radius:.4rem;color:inherit}button.save{color:var(--risu-theme-darkbg);background:var(--risu-theme-primary);font-weight:800}
    @media(max-width:72rem){.workspace{grid-template-columns:12rem 1fr}.preview{display:none}}@media(max-width:48rem){.overlay{padding:0}.shell{border:0;border-radius:0}.workspace{grid-template-columns:1fr}.rail{max-height:11rem}.stage-list{display:flex;overflow:auto}.stage-list button{min-width:9rem}.mode-tabs{grid-template-columns:repeat(2,1fr)}.two-columns,.three-columns,.color-grid,.design-card.toggles{grid-template-columns:1fr}.skin-grid{grid-template-columns:1fr}}
</style>
