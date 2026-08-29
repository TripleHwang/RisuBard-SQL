<script lang="ts">
    import { CheckIcon, CopyIcon, FileTextIcon, LoaderCircleIcon, SparklesIcon } from '@lucide/svelte'
    import { mount, tick, unmount } from 'svelte'
    import { language } from 'src/lang'
    import { exportArcaHtml, resolveArcaImageSource } from 'src/ts/arcaExport'
    import {
        buildArcaLogClipboardHtml,
        buildArcaLogPlainText,
        selectArcaLogMessages,
        type ArcaLogRenderedMessage,
    } from 'src/ts/arcaChatLog'
    import { getCharImage } from 'src/ts/characters'
    import { getFileSrc } from 'src/ts/globalApi.svelte'
    import { ColorSchemeTypeStore } from 'src/ts/gui/colorscheme'
    import { getModelInfo } from 'src/ts/model/modellist'
    import type { Chat as ChatData, Message, character as Character } from 'src/ts/storage/database.svelte'
    import { createSimpleCharacter, DBState } from 'src/ts/stores.svelte'
    import { capitalize } from 'src/ts/util'
    import { notifyError, notifySuccess } from 'src/ts/alert'
    import ShButton from '../UI/GUI/ShButton.svelte'
    import ShDialog from '../UI/GUI/ShDialog.svelte'
    import Chat from './Chat.svelte'

    interface Props {
        open: boolean
        character: Character
        chat: ChatData
        currentUsername: string
        userIcon: string
        onOpenChange(open: boolean): void
    }

    interface LogSource extends Message {
        sourceIndex: number
        firstMessage?: boolean
    }

    let { open, character, chat, currentUsername, userIcon, onOpenChange }: Props = $props()
    let mode = $state<'all' | 'range'>('all')
    let rangeStart = $state(1)
    let rangeEnd = $state(1)
    let previewHtml = $state('')
    let previewPlainText = $state('')
    let preparedKey = $state('')
    let busy = $state(false)
    let copied = $state(false)
    let error = $state('')
    let progress = $state(0)
    let stageRoot = $state<HTMLElement | null>(null)
    let wasOpen = false
    let generationToken = 0

    const sourceMessages = $derived.by((): LogSource[] => {
        const greetingIndex = Number.isFinite(chat.fmIndex) ? chat.fmIndex! : -1
        const greeting = greetingIndex === -1
            ? character.firstMessage
            : character.alternateGreetings[greetingIndex] ?? character.firstMessage
        return [
            {
                role: 'char',
                data: greeting,
                disabled: chat.firstMessageDisabled === true,
                sourceIndex: -1,
                firstMessage: true,
            },
            ...chat.message.map((message, sourceIndex) => ({ ...message, sourceIndex })),
        ]
    })
    const activeMessages = $derived(selectArcaLogMessages(sourceMessages, { mode: 'all' }))
    const selectedMessages = $derived(selectArcaLogMessages(
        sourceMessages,
        mode === 'all'
            ? { mode: 'all' }
            : { mode: 'range', start: rangeStart, end: rangeEnd },
    ))
    const selectionKey = $derived(
        `${chat.id ?? chat.name}:${sourceMessages.length}:${mode}:${mode === 'range' ? `${rangeStart}-${rangeEnd}` : 'all'}`,
    )
    const previewReady = $derived(Boolean(previewHtml) && preparedKey === selectionKey)

    const delay = (milliseconds: number) => new Promise(resolve => setTimeout(resolve, milliseconds))

    function themeColors() {
        const root = document.documentElement
        const style = getComputedStyle(root)
        const color = (property: string, fallback: string) =>
            style.getPropertyValue(property).trim() || root.style.getPropertyValue(property).trim() || fallback
        return {
            background: color('--risu-theme-bgcolor', '#292d3e'),
            panel: color('--risu-theme-darkbg', '#202331'),
            text: color('--risu-theme-textcolor', '#f7f8fc'),
            mutedText: color('--risu-theme-textcolor2', '#aeb6cc'),
            border: color('--risu-theme-darkborderc', '#454b61'),
        }
    }

    async function resolveIcon(reference: string | undefined): Promise<string> {
        if (!reference) return ''
        try {
            const source = await getFileSrc(reference)
            return source ? await resolveArcaImageSource(source) : ''
        }
        catch (cause) {
            console.warn('Arca log profile image skipped:', cause)
            return ''
        }
    }

    async function waitForRenderedBody(host: HTMLElement, allowEmpty: boolean): Promise<HTMLElement> {
        let previous = ''
        let stable = 0
        for (let attempt = 0; attempt < 120; attempt++) {
            await tick()
            await delay(25)
            const body = host.querySelector<HTMLElement>('.chattext')
            if (!body) continue
            const current = body.innerHTML
            if (current === previous && (allowEmpty || current.trim())) stable += 1
            else stable = 0
            if (stable >= 2) return body
            previous = current
        }
        const body = host.querySelector<HTMLElement>('.chattext')
        if (!body) throw new Error(language.arcaChatLog.renderFailed)
        return body
    }

    async function generatePreview(): Promise<void> {
        if (busy || !stageRoot || selectedMessages.length === 0) return
        const token = ++generationToken
        const selection = [...selectedMessages]
        const requestedKey = selectionKey
        busy = true
        copied = false
        error = ''
        progress = 0
        preparedKey = ''

        try {
            const simpleCharacter = createSimpleCharacter(character)
            const [characterIcon, personaIcon, characterImage, personaImage] = await Promise.all([
                resolveIcon(character.image),
                resolveIcon(userIcon),
                getCharImage(character.image ?? '', 'css'),
                getCharImage(userIcon ?? '', 'css'),
            ])
            const rendered: ArcaLogRenderedMessage[] = []

            for (let index = 0; index < selection.length; index++) {
                if (token !== generationToken) return
                const selected = selection[index]
                const source = selected.message
                const host = document.createElement('div')
                stageRoot.replaceChildren(host)
                const instance = mount(Chat, {
                    target: host,
                    props: {
                        message: source.data,
                        name: source.role === 'user' ? currentUsername : character.name,
                        isLastMemory: false,
                        img: source.role === 'user' ? personaImage : characterImage,
                        idx: source.sourceIndex,
                        totalLength: chat.message.length,
                        messageGenerationInfo: source.generationInfo,
                        role: source.role,
                        character: simpleCharacter,
                        firstMessage: source.firstMessage === true,
                        largePortrait: source.role === 'user' ? false : character.largePortrait,
                    },
                })

                try {
                    const body = await waitForRenderedBody(host, !source.data.trim())
                    const bodyHtml = await exportArcaHtml(body, {
                        imageWidthPercent: DBState.db.risuBardArcaChatImageWidthPercent,
                        paragraphSpacingPercent: DBState.db.risuBardArcaChatParagraphSpacingPercent,
                        semanticPalette: $ColorSchemeTypeStore,
                    })
                    const plainText = body.innerText.trim() || body.textContent?.trim() || source.data
                    const isUser = source.role === 'user'
                    rendered.push({
                        number: selected.number,
                        role: source.role,
                        displayName: isUser ? currentUsername : character.name,
                        badge: isUser
                            ? undefined
                            : (source.generationInfo
                                ? capitalize(getModelInfo(source.generationInfo.model).shortName)
                                : 'AI'),
                        iconDataUrl: isUser ? personaIcon : characterIcon,
                        bodyHtml,
                        plainText,
                    })
                }
                finally {
                    await unmount(instance)
                    stageRoot.replaceChildren()
                }
                progress = index + 1
            }

            if (token !== generationToken) return
            const title = chat.name.trim() || character.name
            previewHtml = buildArcaLogClipboardHtml({
                title,
                messages: rendered,
                fontSizePx: DBState.db.risuBardArcaChatFontSizePx,
                showTitleImage: DBState.db.risuBardArcaChatShowTitleImage,
                colors: themeColors(),
            })
            previewPlainText = buildArcaLogPlainText(title, rendered)
            preparedKey = requestedKey
        }
        catch (cause) {
            console.error('Arca chat log generation failed:', cause)
            error = cause instanceof Error ? cause.message : String(cause)
        }
        finally {
            if (token === generationToken) busy = false
        }
    }

    async function copyPreparedLog(): Promise<void> {
        if (!previewReady) {
            await generatePreview()
            return
        }
        if (!window.navigator.clipboard.write || typeof ClipboardItem === 'undefined') {
            notifyError(language.arcaChatLog.clipboardUnsupported)
            return
        }
        try {
            await window.navigator.clipboard.write([
                new ClipboardItem({
                    'text/html': new Blob([previewHtml], { type: 'text/html' }),
                    'text/plain': new Blob([previewPlainText], { type: 'text/plain' }),
                }),
            ])
            copied = true
            notifySuccess(language.arcaChatLog.copied)
        }
        catch (cause) {
            console.error('Arca chat log copy failed:', cause)
            notifyError(language.arcaChatLog.copyFailed)
        }
    }

    function close(next: boolean): void {
        if (!next) {
            generationToken += 1
            busy = false
            stageRoot?.replaceChildren()
        }
        onOpenChange(next)
    }

    $effect(() => {
        if (open && !wasOpen) {
            wasOpen = true
            mode = 'all'
            rangeStart = 1
            rangeEnd = Math.max(1, activeMessages.length)
            previewHtml = ''
            previewPlainText = ''
            preparedKey = ''
            error = ''
            copied = false
            void tick().then(() => generatePreview())
        }
        else if (!open) {
            wasOpen = false
        }
    })
</script>

<ShDialog {open} onOpenChange={close} size="xl" tier="base"
    closeOnEscape={!busy} closeOnOutsideClick={false}
    contentClass="max-w-6xl h-[min(88vh,860px)] overflow-hidden gap-3"
    bodyClass="min-h-0 flex-1 overflow-hidden" closeAriaLabel={language.close}>
    {#snippet title()}
        <span class="flex items-center gap-2"><FileTextIcon size={20} />{language.arcaChatLog.title}</span>
    {/snippet}
    {#snippet description()}{chat.name || character.name} · {activeMessages.length}{language.arcaChatLog.messages}{/snippet}

    <div class="arca-log-workspace">
        <aside class="arca-log-settings" aria-label={language.arcaChatLog.rangeHeading}>
            <div>
                <span class="arca-log-kicker">{language.arcaChatLog.stepOne}</span>
                <h3>{language.arcaChatLog.rangeHeading}</h3>
                <p>{language.arcaChatLog.rangeHelp}</p>
            </div>

            <div class="arca-log-mode-grid">
                <button type="button" data-arca-log-mode="all" class:active={mode === 'all'} disabled={busy}
                    aria-pressed={mode === 'all'} onclick={() => { mode = 'all'; copied = false }}>
                    <strong>{language.arcaChatLog.wholeChat}</strong>
                    <span>{activeMessages.length}{language.arcaChatLog.messages}</span>
                </button>
                <button type="button" data-arca-log-mode="range" class:active={mode === 'range'} disabled={busy}
                    aria-pressed={mode === 'range'} onclick={() => { mode = 'range'; copied = false }}>
                    <strong>{language.arcaChatLog.range}</strong>
                    <span>{language.arcaChatLog.rangeShortHelp}</span>
                </button>
            </div>

            {#if mode === 'range'}
                <div class="arca-log-range">
                    <label>{language.arcaChatLog.from}
                        <input type="number" min="1" max={activeMessages.length} bind:value={rangeStart} disabled={busy} />
                    </label>
                    <span aria-hidden="true">—</span>
                    <label>{language.arcaChatLog.to}
                        <input type="number" min="1" max={activeMessages.length} bind:value={rangeEnd} disabled={busy} />
                    </label>
                </div>
            {/if}

            <div class="arca-log-selection-summary" aria-live="polite">
                <span>{language.arcaChatLog.selected}</span>
                <strong>{selectedMessages.length}{language.arcaChatLog.messages}</strong>
            </div>
            <p class="arca-log-note">{language.arcaChatLog.exclusionNote}</p>
        </aside>

        <section class="arca-log-preview-panel" aria-label={language.arcaChatLog.preview}>
            <header>
                <div>
                    <span class="arca-log-kicker">{language.arcaChatLog.stepTwo}</span>
                    <h3>{language.arcaChatLog.preview}</h3>
                </div>
                {#if previewReady}
                    <span class="arca-log-ready"><CheckIcon size={14} />{language.arcaChatLog.ready}</span>
                {/if}
            </header>

            <div class="arca-log-preview" data-arca-log-preview>
                {#if busy}
                    <div class="arca-log-state" role="status">
                        <LoaderCircleIcon size={30} class="animate-spin" />
                        <strong>{language.arcaChatLog.generating}</strong>
                        <span>{progress} / {selectedMessages.length}</span>
                        <div class="arca-log-progress"><span style:width={`${selectedMessages.length ? progress / selectedMessages.length * 100 : 0}%`}></span></div>
                    </div>
                {:else if error}
                    <div class="arca-log-state arca-log-error" role="alert">
                        <strong>{language.arcaChatLog.failed}</strong><span>{error}</span>
                    </div>
                {:else if previewHtml}
                    <div class="arca-log-paper">{@html previewHtml}</div>
                {:else}
                    <div class="arca-log-state"><SparklesIcon size={30} /><span>{language.arcaChatLog.emptyPreview}</span></div>
                {/if}
            </div>
        </section>
    </div>

    <div class="arca-log-export-stage" aria-hidden="true" bind:this={stageRoot}></div>

    {#snippet footer()}
        <ShButton variant="ghost" disabled={busy} onclick={() => close(false)}>{language.cancel}</ShButton>
        <ShButton variant="primary" data-arca-log-submit disabled={busy || selectedMessages.length === 0}
            onclick={() => void copyPreparedLog()}>
            {#if busy}
                <LoaderCircleIcon size={16} class="animate-spin" />{language.arcaChatLog.generating}
            {:else if previewReady}
                {#if copied}<CheckIcon size={16} />{language.arcaChatLog.copiedShort}{:else}<CopyIcon size={16} />{language.arcaChatLog.copy}{/if}
            {:else}
                <SparklesIcon size={16} />{language.arcaChatLog.createPreview}
            {/if}
        </ShButton>
    {/snippet}
</ShDialog>

<style>
    .arca-log-workspace { height: 100%; min-height: 0; display: grid; grid-template-columns: minmax(230px, .34fr) minmax(0, 1fr); gap: .875rem; }
    .arca-log-settings, .arca-log-preview-panel { min-height: 0; border: 1px solid var(--color-darkborderc); border-radius: .875rem; background: var(--color-darkbg); }
    .arca-log-settings { display: flex; flex-direction: column; gap: 1rem; padding: 1rem; overflow-y: auto; }
    .arca-log-settings h3, .arca-log-preview-panel h3 { margin: .15rem 0 0; color: var(--color-textcolor); font-size: 1rem; font-weight: 700; }
    .arca-log-settings p { margin-top: .3rem; color: var(--color-textcolor2); font-size: .75rem; line-height: 1.55; }
    .arca-log-kicker { color: var(--color-borderc); font-size: .625rem; font-weight: 800; letter-spacing: .14em; text-transform: uppercase; }
    .arca-log-mode-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: .5rem; }
    .arca-log-mode-grid button { min-width: 0; padding: .75rem; border: 1px solid var(--color-darkborderc); border-radius: .75rem; background: var(--color-bgcolor); color: var(--color-textcolor); text-align: left; transition: border-color .15s ease, background .15s ease, transform .15s ease; }
    .arca-log-mode-grid button:hover { transform: translateY(-1px); border-color: var(--color-borderc); }
    .arca-log-mode-grid button:disabled { cursor: wait; opacity: .58; transform: none; }
    .arca-log-mode-grid button.active { border-color: var(--color-primary); background: color-mix(in srgb, var(--color-primary) 12%, var(--color-bgcolor)); box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--color-primary) 35%, transparent); }
    .arca-log-mode-grid strong, .arca-log-mode-grid span { display: block; }
    .arca-log-mode-grid strong { font-size: .8125rem; }
    .arca-log-mode-grid span { margin-top: .3rem; overflow: hidden; color: var(--color-textcolor2); font-size: .6875rem; white-space: nowrap; text-overflow: ellipsis; }
    .arca-log-range { display: grid; grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr); align-items: end; gap: .5rem; }
    .arca-log-range label { color: var(--color-textcolor2); font-size: .6875rem; }
    .arca-log-range input { width: 100%; height: 2.5rem; margin-top: .35rem; padding: 0 .65rem; border: 1px solid var(--color-darkborderc); border-radius: .625rem; background: var(--color-bgcolor); color: var(--color-textcolor); font-variant-numeric: tabular-nums; }
    .arca-log-range input:focus-visible { outline: 2px solid var(--color-borderc); outline-offset: 2px; }
    .arca-log-range > span { padding-bottom: .7rem; color: var(--color-textcolor2); }
    .arca-log-selection-summary { display: flex; align-items: center; justify-content: space-between; padding: .75rem; border-radius: .75rem; background: var(--color-selected); font-size: .75rem; }
    .arca-log-selection-summary span { color: var(--color-textcolor2); }
    .arca-log-selection-summary strong { color: var(--color-textcolor); font-variant-numeric: tabular-nums; }
    .arca-log-note { margin-top: auto !important; padding-top: .75rem; border-top: 1px solid var(--color-darkborderc); }
    .arca-log-preview-panel { display: flex; flex-direction: column; overflow: hidden; }
    .arca-log-preview-panel > header { display: flex; flex: 0 0 auto; align-items: center; justify-content: space-between; min-height: 3.75rem; padding: .75rem 1rem; border-bottom: 1px solid var(--color-darkborderc); }
    .arca-log-ready { display: inline-flex; align-items: center; gap: .25rem; padding: .25rem .5rem; border: 1px solid var(--color-success-border); border-radius: 999px; background: var(--color-success-bg); color: var(--color-success); font-size: .6875rem; }
    .arca-log-preview { min-height: 0; flex: 1; overflow: auto; padding: 1rem; background: color-mix(in srgb, var(--color-bgcolor) 78%, var(--color-shadow)); scrollbar-gutter: stable; }
    .arca-log-paper { width: min(100%, 760px); margin: 0 auto; filter: drop-shadow(0 18px 30px color-mix(in srgb, var(--color-shadow) 22%, transparent)); }
    .arca-log-state { min-height: 100%; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: .65rem; color: var(--color-textcolor2); text-align: center; }
    .arca-log-state strong { color: var(--color-textcolor); }
    .arca-log-state span { font-size: .75rem; }
    .arca-log-error { color: var(--color-danger); }
    .arca-log-progress { width: min(15rem, 70%); height: .25rem; overflow: hidden; border-radius: 999px; background: var(--color-selected); }
    .arca-log-progress span { display: block; height: 100%; border-radius: inherit; background: var(--color-primary); transition: width .2s ease; }
    .arca-log-export-stage { position: fixed; left: -100000px; top: 0; width: 760px; pointer-events: none; }

    @media (max-width: 640px) {
        .arca-log-workspace { grid-template-columns: minmax(0, 1fr); grid-template-rows: auto minmax(18rem, 1fr); overflow-y: auto; }
        .arca-log-settings { overflow: visible; }
        .arca-log-preview-panel { min-height: 22rem; }
        .arca-log-note { margin-top: 0 !important; }
    }
</style>
