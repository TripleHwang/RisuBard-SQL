import type { SettingItem } from './types'
import { normalizeRisuBardCanonicalCustomStyle } from '../risubard/risuBardSettings'

export const risuBardCommonSettingsItems: SettingItem[] = [
    {
        id: 'risubard.common.showSaveLoadShortcuts',
        type: 'check',
        labelKey: 'risuBardShowSaveLoadShortcuts',
        bindKey: 'showRisuBardSaveLoadShortcuts',
        keywords: ['save', 'load', 'shortcut', 'floating', '세이브', '로드', '바로가기'],
    },
    {
        id: 'risubard.common.canonicalWritingStyle',
        type: 'select',
        labelKey: 'risuBardCanonicalWritingStyle',
        helpKey: 'risuBardCanonicalWritingStyle',
        bindKey: 'risuBardCanonicalWritingStyle',
        options: {
            selectOptions: [
                { value: 'concise', labelKey: 'risuBardCanonicalStyleConcise' },
                { value: 'standard', labelKey: 'risuBardCanonicalStyleStandard' },
                { value: 'ultra-concise', labelKey: 'risuBardCanonicalStyleUltraConcise' },
                { value: 'custom', labelKey: 'risuBardCanonicalStyleCustom' },
            ],
        },
        keywords: ['canonical', 'writing', 'style', 'concise', '정본', '집필', '문체', '간결'],
    },
    {
        id: 'risubard.common.canonicalCustomStyle',
        type: 'textarea',
        labelKey: 'risuBardCanonicalCustomStyle',
        helpKey: 'risuBardCanonicalCustomStyle',
        bindKey: 'risuBardCanonicalCustomStyle',
        setValue: (db, value) => {
            db.risuBardCanonicalCustomStyle = normalizeRisuBardCanonicalCustomStyle(value)
        },
        condition: ({ db }) => db.risuBardCanonicalWritingStyle === 'custom',
        keywords: ['canonical', 'custom instruction', '정본', '사용자 지정', '지시문'],
    },
]
