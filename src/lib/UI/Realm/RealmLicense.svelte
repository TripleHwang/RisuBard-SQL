<script lang="ts">
    import { CCLicenseData } from "src/ts/licenses";
    import { tooltip } from "src/ts/gui/tooltip";
    import { openURL } from "src/ts/globalApi.svelte";
    import { DBState } from "src/ts/stores.svelte";

    interface Props {
        license?: string;
    }

    let { license = "" }: Props = $props();
    let isKorean = $derived(DBState.db.language === 'ko');
    let licenseTooltip = $derived(
        CCLicenseData[license]?.[1] + (isKorean ? '. 이 라이선스는 텍스트에만 적용됩니다.' : '. The license only applies to the text.'),
    );
</script>

{#if Object.keys(CCLicenseData).includes(license)}
    <div class="w-full flex flex-row">
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <div role="button" tabindex="0" class="flex flex-wrap flex-row gap-1 mt-2 items-center cursor-pointer" use:tooltip={licenseTooltip} onclick={((e) => {
            e.stopPropagation();
            openURL(`https://creativecommons.org/licenses/${CCLicenseData[license][0]}/4.0/`)
        })}>
            <img alt="creative commons" class="cc" src="https://i.creativecommons.org/l/{CCLicenseData[license][0]}/4.0/88x31.png" />
            <span class="text-textcolor2">
                {isKorean ? `${CCLicenseData[license][2]} 라이선스` : `Licensed with ${CCLicenseData[license][2]}`}
            </span>
    
        </div>
    </div>
{/if}


<style>
    .cc{
        width: 88px;
        height: 31px;
        border-width: 0;
    }
</style>
