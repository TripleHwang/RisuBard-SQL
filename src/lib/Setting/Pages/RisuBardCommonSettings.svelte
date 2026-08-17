<script lang="ts">
    import { language } from 'src/lang'
    import { risuBardCommonSettingsItems } from 'src/ts/setting/risuBardCommonSettingsData'
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte'
    import SettingRenderer from '../SettingRenderer.svelte'
</script>

<SettingPage
    title={language.risuBardSettings.common.title}
    description={language.risuBardSettings.common.description}
>
    <SettingRenderer items={risuBardCommonSettingsItems} />
</SettingPage>
