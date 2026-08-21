import { basename } from 'node:path'
import { get_encoding, type Tiktoken } from '@dqbd/tiktoken'
import type { MarkdownWikiDocument } from './risubard-markdown-wiki'
import { normalizeRisuBardInquiryTokenBudget } from '../../src/ts/risubard/risuBardSettings'

const MAX_SELECTED_DOCUMENTS = 12
const MAX_SOURCE_CHARACTERS = 2_000
const MAX_CANDIDATES = 64
const MAX_DIRECT_SEEDS = 32
const MAX_EXPANDED_DOCUMENTS_PER_HOP = 8
const MAX_EDGES_PER_DOCUMENT = 16
const MAX_INSPECTED_EDGES = 256
const MAX_HOPS = 2
const MAX_RESERVED_HISTORICAL_EVENTS = 2

const QUERY_STOPWORDS = new Set([
    '그는', '그녀는', '그들은', '나는', '우리는', '이것', '그것', '저것',
    '지금', '현재', '무엇', '무엇을', '어떻게', '왜', '해야', '하지',
    '한다', '했다', '하는', '있는', '있다', '없는', '없다', '대한',
    '관련', '정보', '알려', '해줘', '해', '줘', '그리고', '그러면',
    'the', 'a', 'an', 'is', 'are', 'was', 'were', 'what', 'how', 'why',
    'this', 'that', 'these', 'those', 'about', 'please',
])

let inquiryTokenizer: Tiktoken | undefined

function countInquiryTokens(value: string): number {
    inquiryTokenizer ??= get_encoding('cl100k_base')
    return inquiryTokenizer.encode(value).length
}

export interface MarkdownInquiryInput {
    documents: readonly MarkdownWikiDocument[]
    currentInput: string
    tokenBudget?: {
        target: number
        maximum: number
    }
}

export interface MarkdownInquiryResult {
    mode: 'v2-current'
    graphRevision: number
    indexRevision: number
    cacheStatus: 'current'
    sources: Array<{
        id: string
        kind: 'memory'
        role: 'system'
        content: string
        tokens: number
        priority: number
    }>
    entityCandidates: []
    metrics: {
        candidateCount: number
        inspectedNodeCount: number
        inspectedEdgeCount: number
        selectedNodeCount: number
        selectedTokens: number
        hopCount: number
        auxiliaryModelCalls: 0
    }
}

interface Candidate {
    document: MarkdownWikiDocument
    directScore: number
    hop: number
    linkScore: number
}

interface NormalizedDocument {
    title: string
    content: string
    links: string
    keys: string[]
}

interface InquiryCatalogBase {
    byTarget: Map<string, MarkdownWikiDocument>
    adjacency: Map<string, Set<string>>
}

const normalizedDocumentCache = new WeakMap<
    MarkdownWikiDocument,
    NormalizedDocument
>()
const inquiryCatalogCache = new WeakMap<object, InquiryCatalogBase>()

function normalized(value: string): string {
    return value.normalize('NFKC').toLocaleLowerCase().trim()
}

function queryTerms(value: string): string[] {
    return [...new Set(normalized(value).split(/[^\p{L}\p{N}_]+/u)
        .filter((term) => term.length > 1 && !QUERY_STOPWORDS.has(term)))]
        .slice(0, 32)
}

function hasHistoricalEvidenceIntent(value: string): boolean {
    const past = /(?:과거|예전|이전|당시|처음|초반|원래|회상|기억|past|previous|before|earlier|formerly|used to|昔|以前|当時)/i
        .test(value)
    const causalOrDetail = /(?:왜|원인|이유|계기|인과|영향|분석|세부|근거|why|cause|reason|trigger|analysis|detail|evidence)/i
        .test(value)
    return past || causalOrDetail
}

function hasLinkedCharacterIntent(value: string): boolean {
    return /(?:인물|누구|동료|관계|주변|함께|연결|people|who|companion|relationship|with whom|人物|誰|仲間|関係)/i
        .test(value)
}

function normalizedLinkTarget(rawLink: string): string {
    return normalized(rawLink.split('|')[0]?.split('#')[0] ?? '')
}

function documentKeys(document: MarkdownWikiDocument): string[] {
    const pathWithoutExtension = document.relativePath.replace(/\.md$/i, '')
    return [
        document.title,
        pathWithoutExtension,
        basename(pathWithoutExtension),
    ].map(normalized)
}

function normalizedDocument(
    document: MarkdownWikiDocument
): NormalizedDocument {
    const cached = normalizedDocumentCache.get(document)
    if (cached) return cached
    const value = {
        title: normalized(document.title),
        content: normalized(document.content),
        links: normalized(document.links.join(' ')),
        keys: documentKeys(document),
    }
    normalizedDocumentCache.set(document, value)
    return value
}

function catalogBase(
    documents: readonly MarkdownWikiDocument[]
): InquiryCatalogBase {
    const cacheKey = documents as object
    const cached = inquiryCatalogCache.get(cacheKey)
    if (cached) return cached
    const byTarget = new Map<string, MarkdownWikiDocument>()
    for (const document of documents) {
        for (const key of normalizedDocument(document).keys) {
            byTarget.set(key, document)
        }
    }
    const adjacency = new Map<string, Set<string>>()
    const connect = (left: string, right: string) => {
        if (left === right) return
        const leftSet = adjacency.get(left) ?? new Set<string>()
        leftSet.add(right)
        adjacency.set(left, leftSet)
        const rightSet = adjacency.get(right) ?? new Set<string>()
        rightSet.add(left)
        adjacency.set(right, rightSet)
    }
    for (const document of documents) {
        for (const rawLink of document.links) {
            const target = byTarget.get(normalizedLinkTarget(rawLink))
            if (target) connect(document.id, target.id)
        }
    }
    const value = { byTarget, adjacency }
    inquiryCatalogCache.set(cacheKey, value)
    return value
}

function isEligible(
    document: MarkdownWikiDocument,
    input: MarkdownInquiryInput
): boolean {
    if (document.status !== 'active' || document.contextMode === 'never') {
        return false
    }
    return true
}

function lexicalScore(
    document: MarkdownWikiDocument,
    normalizedQuery: string,
    terms: readonly string[]
): number {
    const { title, content, links } = normalizedDocument(document)
    let score = title === normalizedQuery ? 12 : 0
    if (normalizedQuery.length > 1 && title !== normalizedQuery
        && (title.includes(normalizedQuery)
            || normalizedQuery.includes(title))) score += 6
    if (normalizedQuery.length > 1 && content.includes(normalizedQuery)) score += 2
    if (normalizedQuery.length > 1 && links.includes(normalizedQuery)) score += 4
    for (const term of terms) {
        if (title.includes(term) || (title.length > 1 && term.includes(title))) {
            score += 4
        }
        if (links.includes(term)) score += 3
        if (content.includes(term)) score += 2
    }
    return score
}

function candidateScore(
    candidate: Candidate,
    pastIntent: boolean,
    currentIntent: boolean
): number {
    let score = candidate.directScore + candidate.linkScore
    if (candidate.document.type === 'event') score += pastIntent ? 3 : 0
    else score += currentIntent ? 3 : 1
    return score
}

function firstHeading(content: string): string {
    return content.match(/^#\s+.+$/m)?.[0]?.trim() ?? ''
}

function matchingIndex(
    content: string,
    normalizedQuery: string,
    terms: readonly string[]
): number {
    const searchable = normalized(content)
    if (normalizedQuery.length > 1) {
        const phrase = searchable.indexOf(normalizedQuery)
        if (phrase >= 0) return phrase
    }
    for (const term of [...terms].sort((left, right) =>
        right.length - left.length)) {
        const index = searchable.indexOf(term)
        if (index >= 0) return index
    }
    return -1
}

function centeredExcerpt(
    section: string,
    heading: string,
    normalizedQuery: string,
    terms: readonly string[]
): string {
    const prefix = heading.length > 0 && !section.trimStart().startsWith(heading)
        ? `${heading}\n\n`
        : ''
    const budget = Math.max(1, MAX_SOURCE_CHARACTERS - prefix.length)
    if (section.length <= budget) return `${prefix}${section}`.trim()
    const match = matchingIndex(section, normalizedQuery, terms)
    if (match < 0) return `${prefix}${section.slice(0, budget)}`.trim()
    const leading = Math.floor(budget * 0.35)
    let start = Math.max(0, match - leading)
    let end = Math.min(section.length, start + budget)
    if (end - start < budget) start = Math.max(0, end - budget)
    const startMarker = start > 0 ? '…' : ''
    const endMarker = end < section.length ? '…' : ''
    const markerLength = startMarker.length + endMarker.length
    const body = section.slice(start, Math.max(start, end - markerLength))
    return `${prefix}${startMarker}${body}${endMarker}`
        .slice(0, MAX_SOURCE_CHARACTERS)
        .trim()
}

function relevantExcerpt(
    content: string,
    normalizedQuery: string,
    terms: readonly string[]
): string {
    if (content.length <= MAX_SOURCE_CHARACTERS) return content
    const heading = firstHeading(content)
    const matches = [...content.matchAll(/^#{1,6}\s+.+$/gm)]
    if (matches.length === 0) {
        return centeredExcerpt(content, heading, normalizedQuery, terms)
    }
    const sections = matches.map((match, index) => {
        const start = match.index ?? 0
        const end = matches[index + 1]?.index ?? content.length
        const section = content.slice(start, end).trim()
        const score = lexicalScore({
            id: '', type: 'other', status: 'active', title: match[0],
            relativePath: '', sourceMessageIds: [], updated: '',
            content: section, links: [], contextMode: 'auto', contentHash: '',
        }, normalizedQuery, terms)
        return { section, score, start }
    }).sort((left, right) =>
        right.score - left.score || left.start - right.start)
    const selected = sections[0]
    if (!selected || selected.score <= 0) return content.slice(0, MAX_SOURCE_CHARACTERS)
    return centeredExcerpt(
        selected.section,
        heading,
        normalizedQuery,
        terms
    )
}

export function inquireMarkdownDocuments(
    input: MarkdownInquiryInput
): MarkdownInquiryResult {
    const normalizedQuery = normalized(input.currentInput.slice(0, 4_096))
    const terms = queryTerms(input.currentInput.slice(0, 4_096))
    const eligibleDocuments = input.documents.filter((document) =>
        isEligible(document, input))
    const requiredDocuments = eligibleDocuments.filter((document) =>
        document.contextMode === 'always'
            || document.type === 'scene')
    if (requiredDocuments.length > MAX_SELECTED_DOCUMENTS) {
        throw new Error('Required wiki context exceeds 12 documents')
    }

    const base = catalogBase(input.documents)
    const byId = new Map(eligibleDocuments.map((document) =>
        [document.id, document]))

    const direct = eligibleDocuments.map((document) => ({
        document,
        directScore: lexicalScore(document, normalizedQuery, terms),
    })).filter(({ directScore }) => directScore > 0)
        .sort((left, right) =>
            right.directScore - left.directScore
            || right.document.updated.localeCompare(left.document.updated)
            || left.document.id.localeCompare(right.document.id))
    const candidates = new Map<string, Candidate>()
    for (const document of requiredDocuments) {
        candidates.set(document.id, {
            document,
            directScore: lexicalScore(document, normalizedQuery, terms),
            hop: 0,
            linkScore: 0,
        })
    }
    for (const item of direct.slice(0, MAX_DIRECT_SEEDS)) {
        if (candidates.size >= MAX_CANDIDATES) break
        candidates.set(item.document.id, {
            ...item,
            hop: 0,
            linkScore: 0,
        })
    }

    let inspectedEdgeCount = 0
    for (let hop = 0; hop < MAX_HOPS; hop += 1) {
        const expandable = [...candidates.values()]
            .filter((candidate) => candidate.hop === hop)
            .sort((left, right) =>
                right.directScore - left.directScore
                || right.linkScore - left.linkScore
                || left.document.id.localeCompare(right.document.id))
            .slice(0, MAX_EXPANDED_DOCUMENTS_PER_HOP)
        for (const candidate of expandable) {
            const neighbors = [...(base.adjacency.get(
                candidate.document.id
            ) ?? [])]
                .slice(0, MAX_EDGES_PER_DOCUMENT)
            for (const neighborId of neighbors) {
                if (inspectedEdgeCount >= MAX_INSPECTED_EDGES) break
                inspectedEdgeCount += 1
                if (candidates.has(neighborId)
                    || candidates.size >= MAX_CANDIDATES) continue
                const neighbor = byId.get(neighborId)
                if (!neighbor) continue
                candidates.set(neighborId, {
                    document: neighbor,
                    directScore: lexicalScore(neighbor, normalizedQuery, terms),
                    hop: hop + 1,
                    linkScore: hop === 0 ? 8 : 4,
                })
            }
            if (inspectedEdgeCount >= MAX_INSPECTED_EDGES) break
        }
        if (inspectedEdgeCount >= MAX_INSPECTED_EDGES) break
    }

    const pastIntent = /(?:과거|예전|이전|당시|처음|초반|원래|회상|기억|past|previous|before|earlier|formerly|used to|昔|以前|当時)/i
        .test(input.currentInput)
    const currentIntent = /(?:현재|지금|최신|상태|current|now|latest|status|現在|今)/i
        .test(input.currentInput)
    const chronologyIntent = /(?:작중\s*행적|행적|모험|여정|연대기|시간\s*순|순서대로|지금까지|journey|adventures?|chronolog|timeline)/i
        .test(input.currentInput)
    const historicalEvidenceIntent = hasHistoricalEvidenceIntent(
        input.currentInput
    )
    const linkedCharacterIntent = hasLinkedCharacterIntent(input.currentInput)
    const chronologySummaryIds = new Set(
        chronologyIntent
            ? eligibleDocuments.filter((document) =>
                document.type === 'character'
                && /^##\s+작중\s*행적\s*$/m.test(document.content)
                && normalizedQuery.includes(normalized(document.title)))
                .map((document) => document.id)
            : []
    )
    const requiredIds = new Set(requiredDocuments.map((document) => document.id))
    const automatic = [...candidates.values()]
        .filter((candidate) => !requiredIds.has(candidate.document.id))
        .filter((candidate) => chronologySummaryIds.size === 0
            || candidate.document.type !== 'event')
        .filter((candidate) => candidate.document.type !== 'character'
            || candidate.hop === 0
            || candidate.directScore > 0
            || historicalEvidenceIntent
            || chronologyIntent
            || linkedCharacterIntent)
        .map((candidate) => ({
            ...candidate,
            score: candidateScore(candidate, pastIntent, currentIntent),
        }))
        .sort((left, right) =>
            right.score - left.score
            || right.document.updated.localeCompare(left.document.updated)
            || left.document.id.localeCompare(right.document.id))
    const availableSlots = MAX_SELECTED_DOCUMENTS - requiredDocuments.length
    const selectedAutomatic = automatic.slice(0, availableSlots)
    const prepared = [
        ...requiredDocuments.map((document) => ({
            document,
            score: 100,
            hop: candidates.get(document.id)?.hop ?? 0,
        })),
        ...selectedAutomatic,
    ].map((candidate) => {
        const content = relevantExcerpt(
            candidate.document.content,
            normalizedQuery,
            terms
        )
        return {
            ...candidate,
            content,
            tokens: countInquiryTokens(content),
        }
    })
    const tokenBudget = normalizeRisuBardInquiryTokenBudget(
        input.tokenBudget?.target,
        input.tokenBudget?.maximum
    )
    const selectedTokenBudget = /(?:자세히|상세히|모든\s+근거|근거까지|전부|모두|in detail|all evidence)/i
        .test(input.currentInput)
        ? tokenBudget.maximum
        : tokenBudget.target
    const selected: typeof prepared = []
    const selectedIds = new Set<string>()
    let selectedTokens = 0
    for (const candidate of prepared.filter((item) =>
        requiredIds.has(item.document.id))) {
        if (selectedTokens + candidate.tokens > tokenBudget.maximum) {
            throw new Error('Required wiki context exceeds token budget')
        }
        selected.push(candidate)
        selectedIds.add(candidate.document.id)
        selectedTokens += candidate.tokens
    }
    const addOptionalIfFits = (candidate: (typeof prepared)[number]) => {
        if (selectedIds.has(candidate.document.id)
            || selectedTokens + candidate.tokens > selectedTokenBudget) {
            return false
        }
        selected.push(candidate)
        selectedIds.add(candidate.document.id)
        selectedTokens += candidate.tokens
        return true
    }
    if (historicalEvidenceIntent && !chronologyIntent) {
        for (const candidate of prepared.filter((item) =>
            !requiredIds.has(item.document.id)
            && item.document.type === 'event'
        ).slice(0, MAX_RESERVED_HISTORICAL_EVENTS)) {
            addOptionalIfFits(candidate)
        }
    }
    for (const candidate of prepared) {
        const required = requiredIds.has(candidate.document.id)
        if (!required) addOptionalIfFits(candidate)
    }

    return {
        mode: 'v2-current',
        graphRevision: input.documents.length,
        indexRevision: input.documents.length,
        cacheStatus: 'current',
        sources: selected.map((candidate) => ({
            id: `narrative-memory:wiki:${candidate.document.relativePath}`,
            kind: 'memory',
            role: 'system',
            content: candidate.content,
            tokens: candidate.tokens,
            priority: candidate.document.contextMode === 'always'
                ? 200
                : 100 + Math.round(candidate.score),
        })),
        entityCandidates: [],
        metrics: {
            candidateCount: candidates.size,
            inspectedNodeCount: eligibleDocuments.length,
            inspectedEdgeCount,
            selectedNodeCount: selected.length,
            selectedTokens,
            hopCount: selected.reduce((maximum, candidate) =>
                Math.max(maximum, candidate.hop), 0),
            auxiliaryModelCalls: 0,
        },
    }
}
