<script lang="ts">
    import { language } from 'src/lang'
    import type { SettingItem } from 'src/ts/setting/types'
    import SettingPage from 'src/lib/UI/GUI/SettingPage.svelte'
    import SettingRenderer from '../SettingRenderer.svelte'

    const items: SettingItem[] = [
        {
            id: 'risubard.chat.showRequestStatus',
            type: 'check',
            labelKey: 'showRequestStatus',
            helpKey: 'showRequestStatus',
            bindKey: 'showRequestStatus',
            keywords: ['request', 'context', 'injection', 'status', 'toast', 'token', '요청', '컨텍스트', '주입', '토큰'],
        },
        {
            id: 'risubard.chat.inquiryTargetTokenBudget',
            type: 'number',
            labelKey: 'risuBardInquiryTargetTokenBudget',
            helpKey: 'risuBardInquiryTargetTokenBudget',
            bindKey: 'risuBardInquiryTargetTokenBudget',
            options: { min: 256, max: 32768, step: 256 },
            keywords: ['inquiry', 'target', 'token', '검색', '목표', '토큰'],
        },
        {
            id: 'risubard.chat.inquiryMaximumTokenBudget',
            type: 'number',
            labelKey: 'risuBardInquiryMaximumTokenBudget',
            helpKey: 'risuBardInquiryMaximumTokenBudget',
            bindKey: 'risuBardInquiryMaximumTokenBudget',
            options: { min: 256, max: 32768, step: 256 },
            keywords: ['inquiry', 'maximum', 'token', '검색', '상한', '토큰'],
        },
        {
            id: 'risubard.chat.analysisTokenLimit',
            type: 'number',
            labelKey: 'risuBardAnalysisTokenLimit',
            helpKey: 'risuBardAnalysisTokenLimit',
            bindKey: 'risuBardAnalysisTokenLimit',
            options: { min: 3072, max: 32768, step: 1024 },
            keywords: ['analysis', 'token', 'budget', '분석', '토큰', '상한'],
        },
        {
            id: 'risubard.chat.additionalSearchLimit',
            type: 'number',
            labelKey: 'risuBardAdditionalSearchLimit',
            helpKey: 'risuBardAdditionalSearchLimit',
            bindKey: 'risuBardAdditionalSearchLimit',
            options: { min: 0, max: 4, step: 1 },
            keywords: ['wiki', 'search', 'fallback', '위키', '추가 검색'],
        },
        {
            id: 'risubard.chat.canonicalTargetLimit',
            type: 'number',
            labelKey: 'risuBardCanonicalTargetLimit',
            helpKey: 'risuBardCanonicalTargetLimit',
            bindKey: 'risuBardCanonicalTargetLimit',
            options: { min: 1, max: 8, step: 1 },
            keywords: ['canonical', 'target', 'limit', '정본', '대상', '한도'],
        },
        {
            id: 'risubard.chat.analysisRecentMessages',
            type: 'number',
            labelKey: 'risuBardRecentMessages',
            helpKey: 'risuBardRecentMessages',
            bindKey: 'risuBardRecentMessageCount',
            options: { min: 1, max: 100, step: 1 },
            keywords: ['analysis', 'wiki', 'recent messages', '분석', '위키', '최근 대화'],
        },
        {
            id: 'risubard.chat.responseRecentMessages',
            type: 'number',
            labelKey: 'risuBardResponseRecentMessages',
            helpKey: 'risuBardResponseRecentMessages',
            bindKey: 'risuBardResponseMessageCount',
            options: { min: 1, max: 100, step: 1 },
            keywords: ['recent messages', 'chat history', '최근 채팅', '대화 내역'],
        },
        {
            id: 'risubard.chat.excludeUserMessages',
            type: 'check',
            labelKey: 'risuBardResponseExcludeUsers',
            helpKey: 'risuBardResponseExcludeUsers',
            bindKey: 'risuBardResponseExcludeUserMessages',
            keywords: ['exclude user messages', '사용자 메시지 제외'],
        },
    ]
</script>

<SettingPage
    title={language.risuBardSettings.chat.title}
    description={language.risuBardSettings.chat.description}
>
    <SettingRenderer {items} />
</SettingPage>
