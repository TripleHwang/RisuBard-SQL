export type ArcaSemanticKind = 'thought' | 'quote' | 'sound' | 'choice';
export type ArcaSemanticPalette = 'dark' | 'light';

interface SemanticMatch {
    kind: ArcaSemanticKind;
    stripSoundMarkers: boolean;
}

type InlinePreset = Record<string, string>;

const CLASS_KIND = new Map<string, ArcaSemanticKind>([
    ['regex-thought-block', 'thought'],
    ['regex-quote-block', 'quote'],
    ['regex-sound-block', 'sound'],
    ['regex-choice-block', 'choice'],
    ['choice-block', 'choice'],
]);

const RAW_MARKER_TAGS = new Set(['P', 'DIV', 'BLOCKQUOTE']);

const SHARED_PRESETS: Record<ArcaSemanticKind, InlinePreset> = {
    thought: {
        display: 'inline-block',
        'border-left-width': '4px',
        'border-left-style': 'solid',
        padding: '0.1em 0.3em 0.1em 0.6em',
        'border-radius': '4px',
        'font-weight': '450',
        'line-height': '1.5',
        'box-sizing': 'border-box',
    },
    quote: {
        display: 'block',
        'border-left-width': '4px',
        'border-left-style': 'solid',
        padding: '0.2em 0.8em 0.1em 0.9em',
        'border-radius': '0 4px 4px 0',
        'font-weight': '500',
        'line-height': '1.6',
        'box-sizing': 'border-box',
    },
    sound: {
        display: 'inline-block',
        'border-width': '1px',
        'border-style': 'solid',
        padding: '0.1em 0.7em',
        'border-radius': '4px',
        'font-weight': '600',
        'font-style': 'italic',
        'line-height': '1.5',
        'vertical-align': 'middle',
        'box-sizing': 'border-box',
    },
    choice: {
        display: 'block',
        'border-left-width': '4px',
        'border-left-style': 'solid',
        padding: '0.4em 0.8em',
        'border-radius': '4px',
        'font-weight': '600',
        'line-height': '1.5',
        'box-sizing': 'border-box',
    },
};

const PALETTE_PRESETS: Record<ArcaSemanticPalette, Record<ArcaSemanticKind, InlinePreset>> = {
    dark: {
        thought: {
            color: 'rgb(127, 171, 241)',
            'background-color': 'rgba(103, 139, 197, 0.02)',
            'border-left-color': 'rgba(49, 93, 236, 0.93)',
        },
        quote: {
            color: 'rgb(241, 187, 87)',
            'background-color': 'rgba(209, 177, 89, 0.02)',
            'border-left-color': 'rgba(243, 168, 56, 0.93)',
        },
        sound: {
            color: 'rgb(208, 123, 231)',
            'background-color': 'rgba(182, 138, 197, 0.02)',
            'border-color': 'rgba(160, 80, 180, 0.2)',
        },
        choice: {
            color: 'rgb(126, 224, 195)',
            'background-color': 'rgba(46, 204, 113, 0.04)',
            'border-left-color': 'rgba(46, 204, 113, 0.85)',
        },
    },
    light: {
        thought: {
            color: 'rgb(46, 204, 113)',
            'background-color': 'rgba(39, 174, 96, 0.04)',
            'border-left-color': 'rgba(34, 153, 84, 0.93)',
        },
        quote: {
            color: 'rgb(230, 126, 34)',
            'background-color': 'rgba(211, 116, 31, 0.04)',
            'border-left-color': 'rgba(192, 106, 28, 0.93)',
        },
        sound: {
            color: 'rgb(231, 76, 60)',
            'background-color': 'rgba(192, 57, 43, 0.04)',
            'border-color': 'rgba(169, 50, 38, 0.25)',
        },
        choice: {
            color: 'rgb(41, 128, 185)',
            'background-color': 'rgba(52, 152, 219, 0.05)',
            'border-left-color': 'rgba(41, 128, 185, 0.85)',
        },
    },
};

function detectSemanticMatch(source: HTMLElement): SemanticMatch | null {
    for (const className of source.classList) {
        const kind = CLASS_KIND.get(className);
        if (kind) {
            return { kind, stripSoundMarkers: kind === 'sound' && /^§[\s\S]+§$/.test(source.textContent?.trim() ?? '') };
        }
    }

    if (!RAW_MARKER_TAGS.has(source.tagName)) {
        return null;
    }
    const text = source.textContent?.trim() ?? '';
    if (/^§[\s\S]+§$/.test(text)) {
        return { kind: 'sound', stripSoundMarkers: true };
    }
    if (/^(?:"[\s\S]+"|“[\s\S]+”)$/.test(text)) {
        return { kind: 'quote', stripSoundMarkers: false };
    }
    if (/^(?:'[\s\S]+'|‘[\s\S]+’)$/.test(text)) {
        return { kind: 'thought', stripSoundMarkers: false };
    }
    return null;
}

function applyMissingStyles(target: HTMLElement, preset: InlinePreset): void {
    for (const [property, value] of Object.entries(preset)) {
        if (!target.style.getPropertyValue(property)) {
            target.style.setProperty(property, value);
        }
    }
}

export function applyArcaSemanticFormatting(
    source: HTMLElement,
    target: HTMLElement,
    palette: ArcaSemanticPalette = 'dark',
): ArcaSemanticKind | null {
    const match = detectSemanticMatch(source);
    if (!match) {
        return null;
    }

    applyMissingStyles(target, SHARED_PRESETS[match.kind]);
    applyMissingStyles(target, PALETTE_PRESETS[palette][match.kind]);
    if (match.stripSoundMarkers) {
        const text = target.textContent?.trim() ?? '';
        target.textContent = text.slice(1, -1).trim();
    }
    return match.kind;
}
