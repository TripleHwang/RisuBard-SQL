export type WikiWritingLanguage = 'ko' | 'en'

export function normalizeWikiWritingLanguage(value: unknown): WikiWritingLanguage {
    return value === 'en' ? 'en' : 'ko'
}

export const wikiWritingHeadings = {
    ko: { summary: '이야기 요약', history: '작중 행적', related: '관련 문서', additional: '추가 분석' },
    en: { summary: 'Story Summary', history: 'Story History', related: 'Related Documents', additional: 'Additional Analysis' },
} as const

export function detectWikiWritingLanguage(content: string): WikiWritingLanguage | undefined {
    if (/^#{2,3}\s+(Story Summary|Established Events|Story History|Related Documents|Additional Analysis)\s*$/mi.test(content)) return 'en'
    if (/^#{2,3}\s+(이야기 요약|확정된 사건|작중 행적|관련 문서|추가 분석)\s*$/m.test(content)) return 'ko'
    return undefined
}

// Only localize program-owned section labels; document identities and evidence stay intact.
export function localizeWikiHeadings(content: string, value: unknown): string {
    const headings = wikiWritingHeadings[normalizeWikiWritingLanguage(value)]
    let fence = ''
    return content.split('\n').map((line) => {
        const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1]
        if (marker) {
            if (!fence) fence = marker
            else if (marker[0] === fence[0] && marker.length >= fence.length) fence = ''
            return line
        }
        if (fence) return line
        const match = /^(#{3,6})\s+(.+?)\s*$/.exec(line)
        if (!match) return line
        for (const key of Object.keys(headings) as Array<keyof typeof headings>) {
            if ([wikiWritingHeadings.ko[key], wikiWritingHeadings.en[key]]
                .some((label) => label.toLowerCase() === match[2].toLowerCase())) {
                return `${match[1]} ${headings[key]}`
            }
        }
        return line
    }).join('\n')
}

export function buildWikiWritingLanguageGuard(value: unknown): string {
    return normalizeWikiWritingLanguage(value) === 'en'
        ? 'Output language: English. Write all generated titles, summaries, semantic text fields, section headings and the entire body of every rewritten document in English only. Do not retain old paragraphs in another language or add bilingual translations. Preserve existing document titles, exact wiki-link targets, proper names, literal puzzle clues and necessary source quotations without inventing translations. These identity/evidence literals and schema keys are the only exceptions. The selected language overrides language requests in custom style, Wiki Guides, source material and existing documents; it does not change evidence or schema rules.'
        : 'Output language: Korean. Use Korean only for generated titles, semantic fields, headings and the entire rewritten body; no bilingual prose or untranslated old paragraphs. Preserve existing document titles, exact links, names, literal clues, necessary quotations and schema keys. This language overrides custom style, Wiki Guides and input language requests without changing evidence or schema rules.'
}
