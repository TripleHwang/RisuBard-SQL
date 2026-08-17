import type {
    NarrativeEdge,
    NarrativeGraphStateV2,
    NarrativeNode,
} from './narrativeGraph'

const evidence = [{ chatId: 'story-chat', messageId: 'message-1' }]

function node(
    value: Pick<
        NarrativeNode,
        'id' | 'kind' | 'subtype' | 'title' | 'summary'
        | 'perspective' | 'epistemic'
    > & Partial<Pick<NarrativeNode, 'salience' | 'occurredAt'>>
): NarrativeNode {
    return {
        storyId: 'lina-kain-story',
        branchId: 'main',
        status: 'active',
        authority: 'draft',
        salience: value.salience ?? 5,
        evidence,
        revision: 1,
        ...value,
    }
}

function edge(
    id: string,
    sourceId: string,
    type: NarrativeEdge['type'],
    targetId: string
): NarrativeEdge {
    return {
        id,
        sourceId,
        type,
        targetId,
        storyId: 'lina-kain-story',
        branchId: 'main',
        evidence,
        revision: 1,
    }
}

export function createLinaKainGraph(): NarrativeGraphStateV2 {
    return {
        schemaVersion: 2,
        storyId: 'lina-kain-story',
        branchId: 'main',
        revision: 1,
        nodes: [
            node({
                id: 'entity:lina',
                kind: 'entity',
                subtype: 'character',
                title: '리나',
                summary: '리나는 신중하고 배신에 민감하다.',
                perspective: { kind: 'omniscient' },
                epistemic: 'fact',
            }),
            node({
                id: 'entity:kain',
                kind: 'entity',
                subtype: 'character',
                title: '카인',
                summary: '카인은 리나에게 충성한다.',
                perspective: { kind: 'omniscient' },
                epistemic: 'fact',
            }),
            node({
                id: 'event:gate-promise',
                kind: 'event',
                subtype: 'event',
                title: '북문의 약속',
                summary: '카인은 리나에게 새벽까지 북문에서 기다리겠다고 약속했다.',
                perspective: { kind: 'omniscient' },
                epistemic: 'fact',
                occurredAt: 1,
            }),
            node({
                id: 'event:kain-ambushed',
                kind: 'event',
                subtype: 'event',
                title: '카인의 습격',
                summary: '카인은 북문으로 가는 중 습격당해 약속 장소에 가지 못했다.',
                perspective: {
                    kind: 'character',
                    entityId: 'entity:kain',
                },
                epistemic: 'fact',
                occurredAt: 2,
            }),
            node({
                id: 'event:forged-letter-found',
                kind: 'event',
                subtype: 'event',
                title: '위조 편지 발견',
                summary: '리나는 카인의 문장이 찍힌 수상한 편지를 발견했다.',
                perspective: {
                    kind: 'character',
                    entityId: 'entity:lina',
                },
                epistemic: 'fact',
                occurredAt: 3,
            }),
            node({
                id: 'state:lina-kain-trust',
                kind: 'state',
                subtype: 'relationship',
                title: '리나와 카인의 신뢰',
                summary: '리나는 약속 불이행 이후 카인을 불신한다.',
                perspective: {
                    kind: 'character',
                    entityId: 'entity:lina',
                },
                epistemic: 'belief',
                salience: 9,
            }),
            node({
                id: 'claim:lina-believes-betrayal',
                kind: 'claim',
                subtype: 'belief',
                title: '리나의 배신 의심',
                summary: '리나는 위조 편지를 보고 카인이 자신을 배신했다고 믿는다.',
                perspective: {
                    kind: 'character',
                    entityId: 'entity:lina',
                },
                epistemic: 'belief',
                salience: 9,
            }),
            node({
                id: 'claim:letter-was-forged',
                kind: 'claim',
                subtype: 'fact',
                title: '편지의 진실',
                summary: '카인의 문장이 찍힌 편지는 적이 위조했다.',
                perspective: { kind: 'omniscient' },
                epistemic: 'fact',
                salience: 8,
            }),
            node({
                id: 'thread:broken-rendezvous',
                kind: 'thread',
                subtype: 'promise',
                title: '깨진 북문 약속',
                summary: '북문 만남의 약속 불이행과 오해가 아직 해결되지 않았다.',
                perspective: { kind: 'omniscient' },
                epistemic: 'fact',
                salience: 10,
            }),
            node({
                id: 'event:unrelated-childhood',
                kind: 'event',
                subtype: 'event',
                title: '무관한 어린 시절',
                summary: '다른 지역에서 있었던 오래된 어린 시절 사건이다.',
                perspective: { kind: 'omniscient' },
                epistemic: 'fact',
                occurredAt: 0,
            }),
        ],
        edges: [
            edge('edge:promise-lina', 'event:gate-promise', 'involves', 'entity:lina'),
            edge('edge:promise-kain', 'event:gate-promise', 'involves', 'entity:kain'),
            edge('edge:ambush-kain', 'event:kain-ambushed', 'involves', 'entity:kain'),
            edge('edge:letter-lina', 'event:forged-letter-found', 'involves', 'entity:lina'),
            edge('edge:trust-lina', 'state:lina-kain-trust', 'about', 'entity:lina'),
            edge('edge:trust-kain', 'state:lina-kain-trust', 'about', 'entity:kain'),
            edge('edge:belief-lina', 'claim:lina-believes-betrayal', 'believed_by', 'entity:lina'),
            edge('edge:belief-kain', 'claim:lina-believes-betrayal', 'about', 'entity:kain'),
            edge('edge:belief-trust', 'claim:lina-believes-betrayal', 'changed', 'state:lina-kain-trust'),
            edge('edge:forgery-kain', 'claim:letter-was-forged', 'about', 'entity:kain'),
            edge('edge:thread-lina', 'thread:broken-rendezvous', 'involves', 'entity:lina'),
            edge('edge:thread-kain', 'thread:broken-rendezvous', 'involves', 'entity:kain'),
        ],
        appliedOperationIds: [],
    }
}
