<script lang="ts">
    import {
        ChevronLeftIcon,
        ChevronRightIcon,
        ClipboardIcon,
        DownloadIcon,
        PencilIcon,
        RefreshCwIcon,
        SaveIcon,
        SearchIcon,
        Trash2Icon,
        UploadIcon,
        XIcon,
    } from '@lucide/svelte'
    import { onMount } from 'svelte'
    import { language } from 'src/lang'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import ShInput from 'src/lib/UI/GUI/ShInput.svelte'
    import { alertConfirm } from 'src/ts/alert'
    import { downloadFile } from 'src/ts/globalApi.svelte'
    import {
        clearLLMCache,
        deleteLLMCache,
        exportLLMCacheAsJSON,
        importLLMCacheFromJSON,
        listLLMCache,
        updateLLMCacheValue,
        type LLMTranslationCachePage,
    } from 'src/ts/translator/translator'
    import { selectFileByDom } from 'src/ts/util'

    const emptyPage: LLMTranslationCachePage = {
        rows: [],
        total: 0,
        page: 1,
        pageSize: 100,
        pageCount: 1,
    }

    let result = $state<LLMTranslationCachePage>(emptyPage)
    let totalCount = $state(0)
    let searchDraft = $state('')
    let search = $state('')
    let loading = $state(false)
    let errorMessage = $state('')
    let statusMessage = $state('')
    let editingKey = $state<string | null>(null)
    let editingStorageKey = $state<string | null>(null)
    let editValue = $state('')
    let saving = $state(false)
    let loadToken = 0

    async function load(page = result.page) {
        const token = ++loadToken
        loading = true
        errorMessage = ''
        statusMessage = ''
        try {
            const next = await listLLMCache({ search, page, pageSize: 100 })
            if (token !== loadToken) return
            result = next
            if (!search) totalCount = next.total
        } catch (error) {
            if (token === loadToken) errorMessage = error instanceof Error ? error.message : String(error)
        } finally {
            if (token === loadToken) loading = false
        }
    }

    function applySearch() {
        search = searchDraft.trim()
        void load(1)
    }

    function beginEdit(key: string, value: string, storageKey: string) {
        editingKey = key
        editingStorageKey = storageKey
        editValue = value
    }

    function cancelEdit() {
        editingKey = null
        editingStorageKey = null
        editValue = ''
    }

    async function saveEdit() {
        if (editingKey === null) return
        saving = true
        errorMessage = ''
        try {
            await updateLLMCacheValue(editingKey, editValue, editingStorageKey ?? undefined)
            cancelEdit()
            await load()
            statusMessage = language.editTranslationSave
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error)
        } finally {
            saving = false
        }
    }

    async function copyText(value: string) {
        try {
            await navigator.clipboard.writeText(value)
            statusMessage = language.copied
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error)
        }
    }

    async function removeEntry(key: string, storageKey: string) {
        const label = key.length > 80 ? `${key.slice(0, 77)}...` : key
        if (!await alertConfirm(language.translationCacheDeleteConfirm.replace('{0}', label))) return
        errorMessage = ''
        try {
            await deleteLLMCache(key, storageKey)
            totalCount = Math.max(0, totalCount - 1)
            if (editingKey === key) cancelEdit()
            await load(result.page)
            statusMessage = language.translationCacheDeleted
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error)
        }
    }

    async function clearAll() {
        if (!await alertConfirm(language.clearTranslationCacheConfirm)) return
        loading = true
        errorMessage = ''
        try {
            await clearLLMCache()
            totalCount = 0
            cancelEdit()
            await load(1)
            statusMessage = language.clearTranslationCacheSuccess
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error)
        } finally {
            loading = false
        }
    }

    async function exportCache() {
        errorMessage = ''
        try {
            const cache = await exportLLMCacheAsJSON()
            if (Object.keys(cache).length === 0) {
                errorMessage = language.exportTranslationCacheEmpty
                return
            }
            await downloadFile(
                'translation_cache.json',
                new TextEncoder().encode(JSON.stringify(cache, null, 2)),
            )
            statusMessage = language.exportTranslationCacheSuccess
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error)
        }
    }

    async function importCache() {
        errorMessage = ''
        try {
            const files = await selectFileByDom(['json'])
            if (!files?.[0]) return
            const data: unknown = JSON.parse(await files[0].text())
            if (!data || typeof data !== 'object' || Array.isArray(data)
                || Object.values(data).some((value) => typeof value !== 'string')) {
                throw new Error(language.translationCacheInvalidFile)
            }
            if (!await alertConfirm(language.importTranslationCacheConfirm)) return
            loading = true
            const imported = await importLLMCacheFromJSON(data as Record<string, string>)
            if (imported.failed > 0) {
                throw new Error(language.importTranslationCacheFailed
                    .replace('{0}', String(imported.count))
                    .replace('{1}', String(imported.failed)))
            }
            search = ''
            searchDraft = ''
            await load(1)
            statusMessage = language.importTranslationCacheSuccess.replace('{0}', String(imported.count))
        } catch (error) {
            errorMessage = error instanceof Error ? error.message : String(error)
        } finally {
            loading = false
        }
    }

    onMount(() => {
        void load(1)
    })
</script>

<details class="mt-4 overflow-hidden rounded-lg border border-darkborderc bg-darkbg/30">
    <summary class="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-textcolor focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-borderc/50">
        <span class="font-medium">{language.translationCacheManager}</span>
        <span class="rounded-full border border-darkborderc px-2 py-0.5 text-xs tabular-nums text-textcolor2">
            {language.translationCacheEntries.replace('{0}', String(totalCount))}
        </span>
    </summary>

    <div class="border-t border-darkborderc p-3 sm:p-4">
        <p class="mb-3 text-sm text-textcolor2">{language.translationCacheManagerDescription}</p>

        <form class="flex flex-col gap-2 sm:flex-row" onsubmit={(event) => { event.preventDefault(); applySearch() }}>
            <label class="sr-only" for="translation-cache-search">{language.translationCacheSearch}</label>
            <ShInput
                id="translation-cache-search"
                bind:value={searchDraft}
                placeholder={language.translationCacheSearchPlaceholder}
                className="flex-1"
            />
            <ShButton type="submit" variant="outline" disabled={loading}>
                <SearchIcon size={15} />
                {language.translationCacheSearch}
            </ShButton>
        </form>

        <div class="my-3 flex flex-wrap items-center gap-2">
            <ShButton variant="ghost" size="sm" onclick={() => void load()} disabled={loading}>
                <RefreshCwIcon size={14} class={loading ? 'animate-spin' : ''} />
                {language.translationCacheRefresh}
            </ShButton>
            <ShButton variant="ghost" size="sm" onclick={() => void importCache()} disabled={loading}>
                <UploadIcon size={14} />
                {language.importTranslationCache}
            </ShButton>
            <ShButton variant="ghost" size="sm" onclick={() => void exportCache()} disabled={loading || totalCount === 0}>
                <DownloadIcon size={14} />
                {language.exportTranslationCache}
            </ShButton>
            <span class="flex-1"></span>
            <ShButton variant="destructive" size="sm" onclick={() => void clearAll()} disabled={loading || totalCount === 0}>
                <Trash2Icon size={14} />
                {language.clearTranslationCache}
            </ShButton>
        </div>

        {#if errorMessage}
            <div class="mb-3 rounded-md border border-draculared/40 bg-draculared/10 px-3 py-2 text-sm text-textcolor" role="alert">
                {errorMessage}
            </div>
        {/if}
        {#if statusMessage}
            <div class="sr-only" role="status">{statusMessage}</div>
        {/if}

        <div class="max-h-[55vh] overflow-y-auto rounded-md border border-darkborderc">
            {#if loading && result.rows.length === 0}
                <div class="flex items-center justify-center gap-2 px-3 py-10 text-sm text-textcolor2">
                    <RefreshCwIcon size={16} class="animate-spin" />
                    {language.loading}
                </div>
            {:else if result.rows.length === 0}
                <div class="px-3 py-10 text-center text-sm text-textcolor2">
                    {search ? language.translationCacheNoResults : language.translationCacheEmpty}
                </div>
            {:else}
                {#each result.rows as row (row.key)}
                    <article class="border-b border-darkborderc p-3 last:border-b-0">
                        <div class="grid gap-2 lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)_auto] lg:items-start">
                            <div class="min-w-0">
                                <div class="mb-1 text-[11px] font-medium uppercase tracking-wide text-textcolor2">{language.translationCacheKey}</div>
                                <div class="line-clamp-3 whitespace-pre-wrap break-all font-mono text-xs text-textcolor" title={row.key}>{row.key}</div>
                            </div>
                            <div class="min-w-0">
                                <div class="mb-1 text-[11px] font-medium uppercase tracking-wide text-textcolor2">{language.translationCacheValue}</div>
                                {#if editingKey === row.key}
                                    <label class="sr-only" for="translation-cache-edit">{language.translationCacheValue}</label>
                                    <textarea
                                        id="translation-cache-edit"
                                        bind:value={editValue}
                                        class="min-h-24 w-full resize-y rounded-md border border-darkborderc bg-transparent p-2 text-base text-textcolor outline-none focus-visible:border-borderc focus-visible:ring-2 focus-visible:ring-borderc/50"
                                    ></textarea>
                                {:else}
                                    <div class="line-clamp-4 whitespace-pre-wrap break-words text-sm text-textcolor2">{row.value}</div>
                                {/if}
                            </div>
                            <div class="flex flex-wrap gap-1 lg:max-w-24 lg:justify-end">
                                {#if editingKey === row.key}
                                    <ShButton variant="primary" size="icon-xs" title={language.editTranslationSave} aria-label={language.editTranslationSave} onclick={() => void saveEdit()} disabled={saving}>
                                        <SaveIcon size={14} />
                                    </ShButton>
                                    <ShButton variant="ghost" size="icon-xs" title={language.cancel} aria-label={language.cancel} onclick={cancelEdit} disabled={saving}>
                                        <XIcon size={14} />
                                    </ShButton>
                                {:else}
                                    <ShButton variant="ghost" size="icon-xs" title={language.translationCacheCopyKey} aria-label={language.translationCacheCopyKey} onclick={() => void copyText(row.key)}>
                                        <ClipboardIcon size={14} />
                                    </ShButton>
                                    <ShButton variant="ghost" size="icon-xs" title={language.translationCacheCopyValue} aria-label={language.translationCacheCopyValue} onclick={() => void copyText(row.value)}>
                                        <ClipboardIcon size={14} />
                                    </ShButton>
                                    <ShButton variant="ghost" size="icon-xs" title={language.editTranslation} aria-label={language.editTranslation} onclick={() => beginEdit(row.key, row.value, row.storageKey)}>
                                        <PencilIcon size={14} />
                                    </ShButton>
                                    <ShButton variant="destructive" size="icon-xs" title={language.remove} aria-label={language.remove} onclick={() => void removeEntry(row.key, row.storageKey)}>
                                        <Trash2Icon size={14} />
                                    </ShButton>
                                {/if}
                            </div>
                        </div>
                    </article>
                {/each}
            {/if}
        </div>

        <div class="mt-3 flex items-center justify-center gap-3 text-sm text-textcolor2">
            <ShButton variant="outline" size="icon-sm" aria-label={language.translationCachePreviousPage} onclick={() => void load(result.page - 1)} disabled={loading || result.page <= 1}>
                <ChevronLeftIcon size={16} />
            </ShButton>
            <span class="min-w-24 text-center tabular-nums">
                {language.translationCachePage.replace('{0}', String(result.page)).replace('{1}', String(result.pageCount))}
            </span>
            <ShButton variant="outline" size="icon-sm" aria-label={language.translationCacheNextPage} onclick={() => void load(result.page + 1)} disabled={loading || result.page >= result.pageCount}>
                <ChevronRightIcon size={16} />
            </ShButton>
        </div>
    </div>
</details>
