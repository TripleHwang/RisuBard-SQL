'use strict';

const { createRelationalSqlite } = require('./relational-sqlite.cjs');

const MAX_STATEMENTS_PER_BATCH = 1000;

function integer(value, name) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${name} must be a non-negative integer`);
    return value;
}

function validateOptions(options) {
    const characters = integer(options.characters, 'characters');
    const messages = integer(options.messages, 'messages');
    const logicalAssetBytes = integer(options.logicalAssetBytes, 'logicalAssetBytes');
    if (characters === 0 || messages % characters !== 0) {
        throw new Error('messages must divide evenly across a non-zero character count');
    }
    return { characters, messages, logicalAssetBytes };
}

function statement(sql, bind) { return { sql, bind }; }

function createReferenceFixture(root, options) {
    const summary = validateOptions(options);
    const store = createRelationalSqlite({ dataRoot: root });
    let revision = store.revision();
    let batch = [];
    const flush = () => {
        if (!batch.length) return;
        revision = store.commit({ baseRevision: revision, action: 'performance-reference-fixture', statements: batch }).revision;
        batch = [];
    };
    const add = (item) => {
        batch.push(item);
        if (batch.length === MAX_STATEMENTS_PER_BATCH) flush();
    };

    try {
        const messagesPerCharacter = summary.messages / summary.characters;
        add(statement('INSERT INTO plugin_custom_storage (key, value) VALUES (?, ?)', [
            'risuvault.performance.reference-assets.v1',
            JSON.stringify({ logicalAssetBytes: summary.logicalAssetBytes, generated: true }),
        ]));
        for (let character = 0; character < summary.characters; character++) {
            const characterId = `reference-character-${String(character).padStart(3, '0')}`;
            const chatId = `reference-chat-${String(character).padStart(3, '0')}`;
            add(statement('INSERT INTO characters (id, position, kind, name) VALUES (?, ?, ?, ?)', [
                characterId, character, 'character', `Reference character ${character}`,
            ]));
            add(statement('INSERT INTO character_extension_nodes (character_id, node_id, parent_node_id, node_order, object_key, value_type) VALUES (?, ?, ?, ?, ?, ?)', [
                characterId, 0, null, 0, null, 'object',
            ]));
            add(statement('INSERT INTO chats (id, character_id, position, name, note) VALUES (?, ?, ?, ?, ?)', [
                chatId, characterId, 0, `Reference chat ${character}`, 'generated-neutral-data',
            ]));
            add(statement('INSERT INTO chat_extension_nodes (chat_id, node_id, parent_node_id, node_order, object_key, value_type) VALUES (?, ?, ?, ?, ?, ?)', [
                chatId, 0, null, 0, null, 'object',
            ]));
            for (let message = 0; message < messagesPerCharacter; message++) {
                const messageId = `reference-message-${String(character).padStart(3, '0')}-${String(message).padStart(5, '0')}`;
                add(statement('INSERT INTO messages (chat_id, id, position, role, sent_time, content_text) VALUES (?, ?, ?, ?, ?, ?)', [
                    chatId, messageId, message, message % 2 ? 'assistant' : 'user', message, `generated-neutral-message-${message}`,
                ]));
                add(statement('INSERT INTO message_extension_nodes (chat_id, message_id, node_id, parent_node_id, node_order, object_key, value_type) VALUES (?, ?, ?, ?, ?, ?, ?)', [
                    chatId, messageId, 0, null, 0, null, 'object',
                ]));
            }
        }
        flush();
        return summary;
    } finally {
        store.close();
    }
}

function inspectReferenceFixture(root) {
    const store = createRelationalSqlite({ dataRoot: root });
    try {
        const tables = store.dump().tables;
        const catalog = tables.plugin_custom_storage.find((row) => row.key === 'risuvault.performance.reference-assets.v1');
        return {
            characters: tables.characters.length,
            messages: tables.messages.length,
            logicalAssetBytes: catalog ? JSON.parse(catalog.value).logicalAssetBytes : 0,
        };
    } finally {
        store.close();
    }
}

module.exports = { MAX_STATEMENTS_PER_BATCH, createReferenceFixture, inspectReferenceFixture };
