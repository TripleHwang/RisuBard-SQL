export const DEFAULT_ARCA_CHAT_IMAGE_WIDTH_PERCENT = 60;
export const DEFAULT_ARCA_CHAT_FONT_SIZE_PX = 18;
export const DEFAULT_ARCA_CHAT_PARAGRAPH_SPACING_PERCENT = 100;
export const DEFAULT_ARCA_CHAT_SHOW_TITLE_IMAGE = true;
export const DEFAULT_ARCA_CHAT_INCLUDE_USER_MESSAGES = true;

export interface ArcaChatDialogSize {
    width: number;
    height: number;
}

export type ArcaChatTitleImageStyle = 'oval' | 'square' | 'thumbnail-title';
export const DEFAULT_ARCA_CHAT_TITLE_IMAGE_STYLE: ArcaChatTitleImageStyle = 'oval';

function normalizeInteger(value: unknown, fallback: number, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return fallback;
    }
    return Math.min(max, Math.max(min, Math.round(value)));
}

export function normalizeArcaChatImageWidthPercent(value: unknown): number {
    return normalizeInteger(value, DEFAULT_ARCA_CHAT_IMAGE_WIDTH_PERCENT, 10, 100);
}

export function normalizeArcaChatFontSizePx(value: unknown): number {
    return normalizeInteger(value, DEFAULT_ARCA_CHAT_FONT_SIZE_PX, 10, 32);
}

export function normalizeArcaChatParagraphSpacingPercent(value: unknown): number {
    return normalizeInteger(value, DEFAULT_ARCA_CHAT_PARAGRAPH_SPACING_PERCENT, 0, 300);
}

export function normalizeArcaChatShowTitleImage(value: unknown): boolean {
    return typeof value === 'boolean' ? value : DEFAULT_ARCA_CHAT_SHOW_TITLE_IMAGE;
}

export function normalizeArcaChatIncludeUserMessages(value: unknown): boolean {
    return typeof value === 'boolean' ? value : DEFAULT_ARCA_CHAT_INCLUDE_USER_MESSAGES;
}

export function normalizeArcaChatDialogSize(value: unknown): ArcaChatDialogSize | undefined {
    if (!value || typeof value !== 'object') return undefined;
    const source = value as Partial<ArcaChatDialogSize>;
    if (typeof source.width !== 'number' || !Number.isFinite(source.width)
        || typeof source.height !== 'number' || !Number.isFinite(source.height)) {
        return undefined;
    }
    return {
        width: normalizeInteger(source.width, 1152, 480, 2400),
        height: normalizeInteger(source.height, 860, 320, 1600),
    };
}

export function normalizeArcaChatTitleImageStyle(value: unknown): ArcaChatTitleImageStyle {
    return value === 'square' || value === 'thumbnail-title' || value === 'oval'
        ? value
        : DEFAULT_ARCA_CHAT_TITLE_IMAGE_STYLE;
}
