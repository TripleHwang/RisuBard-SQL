'use strict';

const DEFAULT_CHAT_CONTENT_PAGE_SIZE = 200;
const MIN_CHAT_CONTENT_PAGE_SIZE = 10;
const MAX_CHAT_CONTENT_PAGE_SIZE = 500;

function normalizeInteger(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.floor(parsed) : fallback;
}

function normalizeLimit(value) {
    return Math.min(
        MAX_CHAT_CONTENT_PAGE_SIZE,
        Math.max(MIN_CHAT_CONTENT_PAGE_SIZE, normalizeInteger(value, DEFAULT_CHAT_CONTENT_PAGE_SIZE)),
    );
}

function createChatContentPage(chat, requestedOffset, requestedLimit) {
    if (!chat || typeof chat !== 'object') throw new TypeError('Chat content is required');
    const messages = Array.isArray(chat.message) ? chat.message : [];
    const total = messages.length;
    const offset = Math.min(total, Math.max(0, normalizeInteger(requestedOffset, 0)));
    const limit = normalizeLimit(requestedLimit);
    const { message: _message, ...metadata } = chat;
    return {
        chat: metadata,
        messages: messages.slice(offset, offset + limit),
        offset,
        limit,
        total,
    };
}

module.exports = {
    DEFAULT_CHAT_CONTENT_PAGE_SIZE,
    MIN_CHAT_CONTENT_PAGE_SIZE,
    MAX_CHAT_CONTENT_PAGE_SIZE,
    createChatContentPage,
};
