<script lang="ts">
    import { ChevronDownIcon, ChevronUpIcon, LockKeyholeIcon, Trash2Icon } from '@lucide/svelte'
    import CheckInput from 'src/lib/UI/GUI/CheckInput.svelte'
    import OptionInput from 'src/lib/UI/GUI/OptionInput.svelte'
    import SelectInput from 'src/lib/UI/GUI/SelectInput.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import TextAreaInput from 'src/lib/UI/GUI/TextAreaInput.svelte'
    import TextInput from 'src/lib/UI/GUI/TextInput.svelte'
    import { language } from 'src/lang'
    import type { WikiPromptBlock } from 'src/ts/risubard/wikiPromptPreset'

    let {
        block = $bindable(),
        onRemove,
        moveUp,
        moveDown,
        displayName,
    }: {
        block: WikiPromptBlock
        onRemove: () => void
        moveUp: () => void
        moveDown: () => void
        displayName: string
    } = $props()

    $effect(() => {
        if (block.type === 'text' && typeof block.content !== 'string') {
            block.content = ''
        }
    })
</script>

<article
    data-wiki-prompt-block
    data-readonly={block.readonly}
    class:locked={block.readonly}
>
    <header>
        <div class="block-title">
            {#if block.readonly}<LockKeyholeIcon size={15} />{/if}
            {#if block.readonly}
                <strong>{displayName}</strong>
            {:else}
                <TextInput bind:value={block.name} fullwidth />
            {/if}
        </div>
        {#if !block.readonly}
            <div class="block-actions">
                <ShButton variant="ghost" size="icon-sm" onclick={moveUp} aria-label={language.risuBardWikiPrompt.moveUp}>
                    <ChevronUpIcon size={16} />
                </ShButton>
                <ShButton variant="ghost" size="icon-sm" onclick={moveDown} aria-label={language.risuBardWikiPrompt.moveDown}>
                    <ChevronDownIcon size={16} />
                </ShButton>
                {#if block.id !== 'main-wiki-guide'}
                    <ShButton variant="destructive" size="icon-sm" onclick={onRemove} aria-label={language.risuBardWikiPrompt.remove}>
                        <Trash2Icon size={15} />
                    </ShButton>
                {/if}
            </div>
        {/if}
    </header>

    {#if block.readonly}
        <p class="locked-copy">
            {block.type === 'injection'
                ? language.risuBardWikiPrompt.lockedInjectionDescription
                : language.risuBardWikiPrompt.lockedCoreDescription}
        </p>
    {:else}
        <div class="block-options">
            <CheckInput bind:check={block.enabled} name={language.risuBardWikiPrompt.enabled} />
            <SelectInput bind:value={block.target} size="sm">
                <OptionInput value="both">{language.risuBardWikiPrompt.stageBoth}</OptionInput>
                <OptionInput value="analysis">{language.risuBardWikiPrompt.stageAnalysis}</OptionInput>
                <OptionInput value="canonical-rewrite">{language.risuBardWikiPrompt.stageCanonicalRewrite}</OptionInput>
            </SelectInput>
        </div>
        <TextAreaInput
            bind:value={block.content}
            fullwidth
            height="32"
            autocomplete="off"
            placeholder={language.risuBardWikiPrompt.blockPlaceholder}
        />
    {/if}
</article>

<style>
    article {
        padding: 1rem;
        border-top: 1px solid var(--settings-border, var(--risu-theme-darkborderc));
        background: transparent;
    }

    article:first-child {
        border-top: 0;
    }

    article.locked {
        background: color-mix(in srgb, var(--risu-theme-darkbg) 82%, transparent);
    }

    header,
    .block-title,
    .block-actions,
    .block-options {
        display: flex;
        align-items: center;
    }

    header {
        justify-content: space-between;
        gap: .8rem;
    }

    .block-title {
        min-width: 0;
        flex: 1;
        gap: .5rem;
    }

    .block-title strong {
        font-size: .84rem;
        font-weight: 620;
    }

    .block-actions {
        gap: .25rem;
    }

    .block-options {
        justify-content: space-between;
        gap: .8rem;
        margin: .8rem 0;
    }

    .locked-copy {
        margin: .45rem 0 0 1.45rem;
        color: var(--risu-theme-textcolor2);
        font-size: .75rem;
        line-height: 1.45;
    }
</style>
