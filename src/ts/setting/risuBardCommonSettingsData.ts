import type { SettingItem } from './types'
import { normalizeRisuBardCanonicalCustomStyle } from '../risubard/risuBardSettings'
import { normalizeArcaChatTitleImageStyle } from '../arcaChatSaverSettings'

export const risuBardCommonSettingsItems: SettingItem[] = [
    {
        id: 'risubard.common.wikiWritingLanguage',
        type: 'select',
        labelKey: 'risuBardWikiWritingLanguage',
        helpKey: 'risuBardWikiWritingLanguage',
        bindKey: 'risuBardWikiWritingLanguage',
        options: { selectOptions: [
            { value: 'ko', label: '한국어' },
            { value: 'en', label: 'English' },
        ] },
        keywords: ['wiki', 'language', 'English', '위키', '언어', '영어'],
    },
    {
        id: 'risubard.common.showSaveLoadShortcuts',
        type: 'check',
        labelKey: 'risuBardShowSaveLoadShortcuts',
        bindKey: 'showRisuBardSaveLoadShortcuts',
        keywords: ['save', 'load', 'shortcut', 'floating', '세이브', '로드', '바로가기'],
    },
    {
        id: 'risubard.common.autosaveInterval',
        type: 'number',
        labelKey: 'risuBardAutosaveInterval',
        helpKey: 'risuBardAutosaveInterval',
        bindKey: 'risuBardAutosaveInterval',
        options: { min: 1, max: 100, step: 1 },
        keywords: ['autosave', 'interval', 'turn', '자동 저장', '간격', '턴'],
    },
    {
        id: 'risubard.common.autosaveRetention',
        type: 'number',
        labelKey: 'risuBardAutosaveRetention',
        helpKey: 'risuBardAutosaveRetention',
        bindKey: 'risuBardAutosaveRetention',
        options: { min: 1, max: 20, step: 1 },
        keywords: ['autosave', 'retention', 'slots', '자동 저장', '보관', '개수'],
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
    {
        id: 'risubard.common.arcaChatExporter',
        type: 'header',
        labelKey: 'risuBardArcaChatExporter',
        options: { level: 'h2' },
        keywords: ['arca', 'archive', 'chat', 'export', '아카라이브', '챗', '추출기'],
    },
    {
        id: 'risubard.common.arcaChatShowTitleImage',
        type: 'check',
        labelKey: 'risuBardArcaChatShowTitleImage',
        helpKey: 'risuBardArcaChatShowTitleImage',
        bindKey: 'risuBardArcaChatShowTitleImage',
        keywords: ['arca', 'title', 'image', 'show', 'hide', '아카라이브', '타이틀', '이미지', '표시'],
    },
    {
        id: 'risubard.common.arcaChatTitleImageStyle',
        type: 'select',
        labelKey: 'risuBardArcaChatTitleImageStyle',
        helpKey: 'risuBardArcaChatTitleImageStyle',
        bindKey: 'risuBardArcaChatTitleImageStyle',
        setValue: (db, value) => {
            db.risuBardArcaChatTitleImageStyle = normalizeArcaChatTitleImageStyle(value)
        },
        condition: (ctx) => ctx.db.risuBardArcaChatShowTitleImage !== false,
        options: { selectOptions: [
            { value: 'oval', labelKey: 'risuBardArcaChatTitleImageOval' },
            { value: 'square', labelKey: 'risuBardArcaChatTitleImageSquare' },
            { value: 'thumbnail-title', labelKey: 'risuBardArcaChatTitleImageThumbnailTitle' },
        ] },
        keywords: ['arca', 'title', 'image', 'oval', 'square', 'thumbnail', '아카라이브', '타이틀', '타원', '정사각형', '썸네일'],
    },
    {
        id: 'risubard.common.arcaChatImageWidth',
        type: 'number',
        labelKey: 'risuBardArcaChatImageWidthPercent',
        helpKey: 'risuBardArcaChatImageWidthPercent',
        bindKey: 'risuBardArcaChatImageWidthPercent',
        options: { min: 10, max: 100, step: 1 },
        keywords: ['arca', 'image', 'width', 'percent', '아카라이브', '이미지', '너비', '퍼센트'],
    },
    {
        id: 'risubard.common.arcaChatFontSize',
        type: 'number',
        labelKey: 'risuBardArcaChatFontSizePx',
        helpKey: 'risuBardArcaChatFontSizePx',
        bindKey: 'risuBardArcaChatFontSizePx',
        options: { min: 10, max: 32, step: 1 },
        keywords: ['arca', 'font', 'size', 'pixel', '아카라이브', '폰트', '글자', '크기'],
    },
    {
        id: 'risubard.common.arcaChatParagraphSpacing',
        type: 'number',
        labelKey: 'risuBardArcaChatParagraphSpacingPercent',
        helpKey: 'risuBardArcaChatParagraphSpacingPercent',
        bindKey: 'risuBardArcaChatParagraphSpacingPercent',
        options: { min: 0, max: 300, step: 10 },
        keywords: ['arca', 'paragraph', 'spacing', 'line break', '아카라이브', '문단', '개행', '간격'],
    },
]
