<script lang="ts">
    import { ArrowUpCircleIcon, CheckCircleIcon, DownloadIcon, RefreshCwIcon, ShieldCheckIcon } from '@lucide/svelte'
    import ShAlert from 'src/lib/UI/GUI/ShAlert.svelte'
    import ShBadge from 'src/lib/UI/GUI/ShBadge.svelte'
    import ShButton from 'src/lib/UI/GUI/ShButton.svelte'
    import { language } from 'src/lang'
    import {
        checkRisuUpdate,
        updateInfoStore,
        updatePopupStore,
        type UpdateInfo,
    } from 'src/ts/update'

    let checking = $state(false)
    let checkFailed = $state(false)
    const info: UpdateInfo | null = $derived($updateInfoStore)

    async function checkNow() {
        checking = true
        checkFailed = false
        try {
            const result = await checkRisuUpdate({ showPopup: false })
            checkFailed = !result
        } finally {
            checking = false
        }
    }

    function openUpdate() {
        if (info?.hasUpdate) updatePopupStore.set(info)
    }

    $effect(() => {
        if (!info && !checking) void checkNow()
    })
</script>

<p class="text-textcolor2 text-sm mb-4">{language.systemUpdateDesc}</p>

<div class="border border-darkborderc bg-darkbg/40 rounded-md p-4 mb-4">
    <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="flex items-start gap-3 min-w-0">
            <span class="p-2 rounded-full bg-borderc/15 text-borderc shrink-0" aria-hidden="true">
                <ShieldCheckIcon size={20} />
            </span>
            <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-medium text-textcolor">{language.systemUpdateChannel}</span>
                    <ShBadge variant="secondary">RisuVault</ShBadge>
                    {#if info?.deploymentType}
                        <ShBadge variant="outline">{info.deploymentType}</ShBadge>
                    {/if}
                </div>
                <p class="text-sm text-textcolor2 mt-1 leading-relaxed">{language.systemUpdateTrust}</p>
            </div>
        </div>
        <ShButton variant="outline" onclick={checkNow} disabled={checking}>
            <RefreshCwIcon size={15} class={checking ? 'animate-spin' : ''} />
            {checking ? language.systemUpdateChecking : language.systemUpdateCheck}
        </ShButton>
    </div>
</div>

{#if checkFailed}
    <ShAlert variant="destructive" className="mb-4">{language.systemUpdateCheckFailed}</ShAlert>
{:else if info}
    <div class="border border-darkborderc bg-darkbg/40 rounded-md p-4">
        <div class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm mb-4">
            <span class="text-textcolor2">{language.systemUpdateCurrent}</span>
            <span class="text-textcolor font-mono">{info.currentVersion}</span>
            <span class="text-textcolor2">{language.systemUpdateLatest}</span>
            <span class="text-textcolor font-mono">{info.latestVersion}</span>
        </div>

        {#if info.hasUpdate}
            <ShAlert variant={info.severity === 'optional' ? 'info' : 'warning'} className="mb-4">
                {#snippet icon()}<ArrowUpCircleIcon />{/snippet}
                {language.systemUpdateAvailable.replace('{{version}}', info.latestVersion)}
            </ShAlert>
            <div class="flex justify-end">
                <ShButton variant="primary" onclick={openUpdate}>
                    <DownloadIcon size={15} />
                    {info.canSelfUpdate ? language.selfUpdateNow : language.updatePopupViewRelease}
                </ShButton>
            </div>
        {:else}
            <div class="flex items-center gap-2 text-success text-sm">
                <CheckCircleIcon size={17} />
                {language.systemUpdateUpToDate}
            </div>
        {/if}
    </div>
{/if}
