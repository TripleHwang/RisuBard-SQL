import { describe, expect, it } from 'vitest';
import {
    DEFAULT_ARCA_CHAT_FONT_SIZE_PX,
    DEFAULT_ARCA_CHAT_IMAGE_WIDTH_PERCENT,
    DEFAULT_ARCA_CHAT_PARAGRAPH_SPACING_PERCENT,
    DEFAULT_ARCA_CHAT_SHOW_TITLE_IMAGE,
    DEFAULT_ARCA_CHAT_TITLE_IMAGE_STYLE,
    DEFAULT_ARCA_CHAT_INCLUDE_USER_MESSAGES,
    normalizeArcaChatDialogSize,
    normalizeArcaChatFontSizePx,
    normalizeArcaChatImageWidthPercent,
    normalizeArcaChatParagraphSpacingPercent,
    normalizeArcaChatShowTitleImage,
    normalizeArcaChatIncludeUserMessages,
    normalizeArcaChatTitleImageStyle,
} from './arcaChatSaverSettings';

describe('Arca chat saver settings', () => {
    it('uses the global image, font, and paragraph spacing defaults for missing values', () => {
        expect(DEFAULT_ARCA_CHAT_IMAGE_WIDTH_PERCENT).toBe(60);
        expect(DEFAULT_ARCA_CHAT_FONT_SIZE_PX).toBe(18);
        expect(DEFAULT_ARCA_CHAT_PARAGRAPH_SPACING_PERCENT).toBe(100);
        expect(normalizeArcaChatImageWidthPercent(undefined)).toBe(60);
        expect(normalizeArcaChatFontSizePx(undefined)).toBe(18);
        expect(normalizeArcaChatParagraphSpacingPercent(undefined)).toBe(100);
    });

    it('clamps persisted values to the supported UI ranges', () => {
        expect(normalizeArcaChatImageWidthPercent(2)).toBe(10);
        expect(normalizeArcaChatImageWidthPercent(200)).toBe(100);
        expect(normalizeArcaChatFontSizePx(2)).toBe(10);
        expect(normalizeArcaChatFontSizePx(80)).toBe(32);
        expect(normalizeArcaChatParagraphSpacingPercent(-10)).toBe(0);
        expect(normalizeArcaChatParagraphSpacingPercent(500)).toBe(300);
    });

    it('defaults to a visible oval title image and accepts every supported layout', () => {
        expect(DEFAULT_ARCA_CHAT_SHOW_TITLE_IMAGE).toBe(true);
        expect(DEFAULT_ARCA_CHAT_TITLE_IMAGE_STYLE).toBe('oval');
        expect(normalizeArcaChatShowTitleImage(undefined)).toBe(true);
        expect(normalizeArcaChatShowTitleImage(false)).toBe(false);
        expect(normalizeArcaChatTitleImageStyle(undefined)).toBe('oval');
        expect(normalizeArcaChatTitleImageStyle('square')).toBe('square');
        expect(normalizeArcaChatTitleImageStyle('thumbnail-title')).toBe('thumbnail-title');
        expect(normalizeArcaChatTitleImageStyle('unsupported')).toBe('oval');
    });

    it('defaults to including user messages and normalizes persisted dialog dimensions', () => {
        expect(DEFAULT_ARCA_CHAT_INCLUDE_USER_MESSAGES).toBe(true);
        expect(normalizeArcaChatIncludeUserMessages(undefined)).toBe(true);
        expect(normalizeArcaChatIncludeUserMessages(false)).toBe(false);
        expect(normalizeArcaChatDialogSize(undefined)).toBeUndefined();
        expect(normalizeArcaChatDialogSize({ width: 1200.4, height: 800.6 })).toEqual({
            width: 1200,
            height: 801,
        });
        expect(normalizeArcaChatDialogSize({ width: 1, height: 9999 })).toEqual({
            width: 480,
            height: 1600,
        });
    });
});
