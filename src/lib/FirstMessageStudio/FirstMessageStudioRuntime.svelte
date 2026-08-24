<script module lang="ts">
    let studioScopeCounter = 0
</script>

<script lang="ts">
    import DOMPurify from 'dompurify'
    import { untrack } from 'svelte'
    import {
        applyStudioOption,
        backStudioRuntime,
        createScopedStudioCss,
        createStudioRuntime,
        interpolateStudioTemplate,
        localizeStudioText,
        resetStudioRuntime,
        resolveStudioLocale,
        setStudioInput,
        type FirstMessageStudioProject,
        type FirstMessageStudioRuntime,
    } from 'src/ts/firstMessageStudio'

    interface Props {
        project: FirstMessageStudioProject
        variables?: Record<string, string>
        preview?: boolean
        onChange?: (runtime: FirstMessageStudioRuntime) => void
    }

    let { project, variables = {}, preview = false, onChange }: Props = $props()
    const scopeId = `fmstudio-${++studioScopeCounter}`
    let runtime = $state(untrack(() => createStudioRuntime(project, variables)))
    let projectSignature = $state('')
    let validationError = $state('')
    let stage = $derived(project.stages.find((candidate) => candidate.id === runtime.stageId) ?? project.stages[0])
    let stageIndex = $derived(Math.max(0, project.stages.findIndex((candidate) => candidate.id === runtime.stageId)))
    let locale = $derived(resolveStudioLocale(runtime.variables))
    let scopedCss = $derived(createScopedStudioCss(scopeId, project.customCss))
    let customHtml = $derived(DOMPurify.sanitize(
        interpolateStudioTemplate(project.customHtml, runtime.variables),
        { FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed'] },
    ))

    $effect(() => {
        const nextSignature = JSON.stringify(project)
        if (projectSignature && projectSignature !== nextSignature) {
            runtime = createStudioRuntime(project, variables)
            validationError = ''
        }
        projectSignature = nextSignature
    })

    function snapshot(value: FirstMessageStudioRuntime): FirstMessageStudioRuntime {
        return {
            ...value,
            variables: { ...value.variables },
            inputs: { ...value.inputs },
            history: [...value.history],
            baseVariables: { ...value.baseVariables },
            stageIndexById: { ...value.stageIndexById },
        }
    }

    function publish() {
        onChange?.(snapshot(runtime))
    }

    function choose(optionId: string) {
        const result = applyStudioOption(project, runtime, optionId)
        if (result.error === 'required-input') {
            validationError = locale === 'ko' ? '입력값이 필요합니다.' : locale === 'ja' ? '入力が必要です。' : 'This choice needs an input.'
            return
        }
        validationError = ''
        runtime = result.runtime
        publish()
    }

    function updateInput(variable: string, value: string) {
        validationError = ''
        runtime = setStudioInput(runtime, variable, value)
    }

    function goBack() {
        validationError = ''
        runtime = backStudioRuntime(runtime)
        publish()
    }

    function reset() {
        validationError = ''
        runtime = resetStudioRuntime(project, runtime)
        publish()
    }
</script>

{#if scopedCss}
    <svelte:element this={"style"} data-studio-custom-css>{scopedCss}</svelte:element>
{/if}

<section
    id={scopeId}
    class="studio-window skin-{project.appearance.preset}"
    data-first-message-studio-runtime
    data-studio-skin={project.appearance.preset}
    aria-label={project.title}
    style={`--studio-accent:${project.appearance.accentColor};--studio-bg:${project.appearance.backgroundColor};--studio-surface:${project.appearance.surfaceColor};--studio-text:${project.appearance.textColor};--studio-columns:${project.appearance.optionColumns};--studio-radius:${project.appearance.cornerRadius}px`}
>
    {#if project.appearance.showHeader || project.appearance.showProgress}
        <header class="window-header">
            {#if project.appearance.showHeader}<strong>{project.title}</strong>{/if}
            {#if project.appearance.showProgress}
                <div class="progress" aria-label={locale === 'ko' ? '진행 단계' : locale === 'ja' ? '進行段階' : 'Progress'}>
                    {#each project.stages as item, index}
                        <span class:active={index === stageIndex} class:passed={index < stageIndex} title={localizeStudioText(item.title, locale)}>{index + 1}</span>
                    {/each}
                </div>
            {/if}
        </header>
    {/if}

    {#if customHtml}
        <div class="studio-extra" data-studio-extra>{@html customHtml}</div>
    {/if}

    <div class="window-body">
        {#if runtime.completed}
            <div class="complete" aria-live="polite">
                <strong>{locale === 'ko' ? '설정 완료' : locale === 'ja' ? '設定完了' : 'Setup complete'}</strong>
                <p>{locale === 'ko' ? '이제 대화를 시작할 수 있습니다.' : locale === 'ja' ? '会話を始められます。' : 'You can now begin the conversation.'}</p>
            </div>
        {:else if stage}
            <div class="screen" data-studio-stage={stage.id}>
                <div class="screen-heading">
                    {#if localizeStudioText(stage.tag, locale)}<span>{localizeStudioText(stage.tag, locale)}</span>{/if}
                    <h3>{localizeStudioText(stage.title, locale)}</h3>
                </div>
                <div class="description">
                    {#if stage.speaker}<b>{localizeStudioText(stage.speaker, locale)}</b>{/if}
                    <p>{localizeStudioText(stage.description, locale)}</p>
                </div>
                <div class="options">
                    {#each stage.options as option}
                        <div class="option-wrap" class:with-input={Boolean(option.input)}>
                            <button type="button" data-studio-option={option.id} onclick={() => choose(option.id)}>
                                {#if option.badge}<span class="option-badge">{localizeStudioText(option.badge, locale)}</span>{/if}
                                <span class="option-copy">
                                    <strong>{localizeStudioText(option.label, locale)}</strong>
                                    {#if option.description}<small>{localizeStudioText(option.description, locale)}</small>{/if}
                                </span>
                            </button>
                            {#if option.input}
                                <label class="input-panel">
                                    <span>{localizeStudioText(option.input.label, locale)}</span>
                                    <input
                                        data-studio-input={option.input.variable}
                                        value={runtime.inputs[option.input.variable] ?? ''}
                                        placeholder={localizeStudioText(option.input.placeholder, locale)}
                                        oninput={(event) => updateInput(option.input!.variable, event.currentTarget.value)}
                                    />
                                </label>
                            {/if}
                        </div>
                    {/each}
                </div>
                {#if validationError}<p class="validation" role="alert">{validationError}</p>{/if}
            </div>
        {/if}
    </div>

    {#if project.appearance.showNavigation}
        <footer class="window-actions">
            <button type="button" data-studio-back onclick={goBack} disabled={runtime.history.length === 0 || runtime.completed}>
                {locale === 'ko' ? '이전' : locale === 'ja' ? '戻る' : 'Back'}
            </button>
            {#if preview}
                <button type="button" data-studio-reset onclick={reset}>
                    {locale === 'ko' ? '처음부터' : locale === 'ja' ? '最初から' : 'Reset'}
                </button>
            {/if}
        </footer>
    {/if}
</section>

<style>
    .studio-window{position:relative;width:min(34rem,100%);margin:1rem auto;overflow:hidden;border:1px solid color-mix(in srgb,var(--studio-text) 14%,transparent);border-radius:var(--studio-radius);color:var(--studio-text);background:var(--studio-bg);box-shadow:0 1.2rem 3.5rem rgba(0,0,0,.28);font-family:ui-sans-serif,system-ui,sans-serif}
    .skin-glass{border-color:color-mix(in srgb,var(--studio-accent) 35%,transparent);background:linear-gradient(145deg,color-mix(in srgb,var(--studio-bg) 88%,transparent),color-mix(in srgb,var(--studio-accent) 9%,var(--studio-bg)));backdrop-filter:blur(18px)}
    .window-header{display:flex;align-items:center;gap:1rem;padding:.85rem 1rem;border-bottom:1px solid color-mix(in srgb,var(--studio-text) 12%,transparent);background:color-mix(in srgb,var(--studio-surface) 78%,var(--studio-bg))}
    .window-header>strong{overflow:hidden;font-size:.88rem;text-overflow:ellipsis;white-space:nowrap}
    .progress{display:flex;gap:.35rem;margin-left:auto}
    .progress span{display:grid;width:1.45rem;height:1.45rem;place-items:center;border:1px solid color-mix(in srgb,var(--studio-text) 16%,transparent);border-radius:999px;color:color-mix(in srgb,var(--studio-text) 62%,transparent);font-size:.65rem;font-weight:800}
    .progress span.passed{border-color:color-mix(in srgb,var(--studio-accent) 50%,transparent);color:var(--studio-accent)}
    .progress span.active{border-color:var(--studio-accent);color:var(--studio-bg);background:var(--studio-accent)}
    .studio-extra{padding:.8rem 1rem 0}
    .window-body{min-height:18rem;padding:1rem;background:var(--studio-surface)}
    .screen-heading{display:grid;gap:.35rem}
    .screen-heading>span{width:max-content;padding:.18rem .42rem;border-radius:.25rem;color:var(--studio-bg);background:var(--studio-accent);font-size:.62rem;font-weight:850;letter-spacing:.08em}
    .screen-heading h3{margin:0;font-size:1.2rem}
    .description{margin:.8rem 0;padding:.75rem;border-left:3px solid var(--studio-accent);border-radius:.25rem;background:color-mix(in srgb,var(--studio-accent) 8%,transparent)}
    .description b{display:block;margin-bottom:.25rem;color:var(--studio-accent);font-size:.68rem;letter-spacing:.06em}
    .description p{margin:0;font-size:.82rem;line-height:1.55}
    .options{display:grid;grid-template-columns:repeat(var(--studio-columns),minmax(0,1fr));gap:.5rem}
    .option-wrap{display:grid;gap:.35rem}
    .option-wrap.with-input{grid-column:1/-1}
    .option-wrap button{display:flex;width:100%;min-height:3rem;align-items:center;gap:.55rem;padding:.65rem .7rem;border:1px solid color-mix(in srgb,var(--studio-text) 14%,transparent);border-radius:max(4px,calc(var(--studio-radius) / 3));color:var(--studio-text);text-align:left;background:color-mix(in srgb,var(--studio-bg) 55%,var(--studio-surface));transition:border-color .15s ease,background .15s ease}
    .option-wrap button:hover,.option-wrap button:focus-visible{outline:none;border-color:var(--studio-accent);background:color-mix(in srgb,var(--studio-accent) 12%,var(--studio-surface))}
    .option-badge{flex:none;color:var(--studio-accent);font-size:.68rem;font-weight:800}
    .option-copy{display:grid;gap:.12rem}
    .option-copy strong{font-size:.8rem}
    .option-copy small{color:color-mix(in srgb,var(--studio-text) 64%,transparent);font-size:.68rem;line-height:1.35}
    .input-panel{display:grid;gap:.3rem;padding:.55rem;border:1px dashed color-mix(in srgb,var(--studio-accent) 40%,transparent);border-radius:.35rem}
    .input-panel span{color:var(--studio-accent);font-size:.68rem;font-weight:750}
    .input-panel input{width:100%;border:1px solid color-mix(in srgb,var(--studio-text) 16%,transparent);border-radius:.3rem;padding:.5rem;color:var(--studio-text);background:var(--studio-bg)}
    .validation{margin:.6rem 0 0;color:#ff8b79;font-size:.72rem}
    .complete{display:grid;min-height:14rem;place-content:center;text-align:center}
    .complete strong{color:var(--studio-accent);font-size:1.35rem}
    .complete p{font-size:.8rem}
    .window-actions{display:flex;gap:.5rem;justify-content:flex-end;padding:.7rem 1rem;border-top:1px solid color-mix(in srgb,var(--studio-text) 12%,transparent);background:var(--studio-bg)}
    .window-actions button{padding:.48rem .75rem;border:1px solid color-mix(in srgb,var(--studio-text) 16%,transparent);border-radius:.35rem;color:var(--studio-text)}
    .window-actions button:disabled{opacity:.4}
    @media(max-width:34rem){.options{grid-template-columns:1fr}.option-wrap.with-input{grid-column:auto}}
    @media(prefers-reduced-motion:reduce){.option-wrap button{transition:none}}
</style>
