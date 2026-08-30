<script lang="ts">
    /**
     * Renders one `LazyResource`'s state inside the calling component's own
     * subtree.
     *
     * Every element here is in normal flow (or `absolute` within a positioned
     * ancestor the caller opts into). Nothing is `fixed inset-0`: a full-screen
     * blocker is what once made a release unclickable, and loading one surface
     * must never freeze the rest of the app.
     *
     * The failure branch has a default. A component that forgets to write one
     * still shows the user that the load failed, instead of falling through to
     * a rendered empty list -- which reads as "there are none of these" and is
     * a claim nobody is entitled to make about data that could not be read.
     */
    import type { Snippet } from 'svelte'
    import { RefreshCwIcon, TriangleAlertIcon } from '@lucide/svelte'
    import { language } from 'src/lang'
    import type { LazyResource } from 'src/ts/lazyResource.svelte'

    interface Props {
        resource: LazyResource<unknown>
        /** Rendered once the load succeeded. */
        children?: Snippet
        /** Overrides the default spinner row. */
        loading?: Snippet
        /** Overrides the default failure card. Receives the retry callback. */
        failed?: Snippet<[unknown, () => void]>
        /**
         * Rendered before anything has been requested.
         *
         * With no `idle` snippet, what `idle` falls back to depends on what
         * idle means for this resource, which is not the same for both kinds.
         * An AUTO resource requests as soon as its key appears, so idle is the
         * single instant before that and the loading branch is right --
         * rendering real content there flashes an empty state. A MANUAL one
         * (`auto: false`: the character and chat openers, anything behind a
         * button) RESTS at idle, so the loading branch there is a spinner that
         * never stops, sitting above a list nobody has touched; it renders
         * nothing instead.
         */
        idle?: Snippet
        /** Headline for the default failure card. */
        failedTitle?: string
        /** Extra classes on the wrapper of the default loading/failed branches. */
        className?: string
        /** Compact single-line presentation, for toolbars and nav rows. */
        inline?: boolean
    }

    let {
        resource,
        children,
        loading,
        failed,
        idle,
        failedTitle,
        className = '',
        inline = false,
    }: Props = $props()

    const retry = () => { void resource.retry() }
</script>

{#if resource.status === 'ready'}
    {@render children?.()}
{:else if resource.status === 'failed'}
    {#if failed}
        {@render failed(resource.error, retry)}
    {:else}
        <div
            role="alert"
            class={`flex ${inline ? 'flex-row items-center gap-2 px-2 py-1 text-xs' : 'flex-col items-start gap-2 rounded-xl border border-danger-border bg-danger-bg p-3 text-sm'} text-danger ${className}`}
        >
            <span class="flex items-center gap-2">
                <TriangleAlertIcon size={inline ? 14 : 16} />
                <span class="font-medium">{failedTitle ?? language.lazyLoad.failedTitle}</span>
            </span>
            {#if resource.errorMessage}
                <span class="break-all text-xs opacity-70">{resource.errorMessage}</span>
            {/if}
            {#if !inline}
                <span class="text-xs opacity-70">{language.lazyLoad.failedHint}</span>
            {/if}
            <button
                type="button"
                class="inline-flex items-center gap-1.5 rounded-md border border-danger-border px-2 py-1 text-xs transition-colors hover:bg-danger/15"
                onclick={retry}
            >
                <RefreshCwIcon size={12} />
                {language.lazyLoad.retry}
            </button>
        </div>
    {/if}
{:else if resource.status === 'loading' || (!idle && resource.autoRequests)}
    {#if loading}
        {@render loading()}
    {:else}
        <div
            role="status"
            aria-live="polite"
            class={`flex items-center gap-2 text-textcolor2 ${inline ? 'px-2 py-1 text-xs' : 'justify-center p-4 text-sm'} ${className}`}
        >
            <svg
                class="animate-spin"
                style="will-change: transform;"
                width={inline ? 14 : 18}
                height={inline ? 14 : 18}
                xmlns="http://www.w3.org/2000/svg"
                fill="none"
                viewBox="0 0 24 24"
                aria-hidden="true"
            >
                <circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle>
                <path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
            </svg>
            <span>{language.lazyLoad.loading}</span>
        </div>
    {/if}
{:else if idle}
    {@render idle()}
{/if}
<!-- The final branch is deliberately empty: a manual resource at rest, with no
     `idle` snippet, renders nothing at all. -->

