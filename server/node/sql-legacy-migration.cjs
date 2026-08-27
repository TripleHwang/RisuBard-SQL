'use strict';

const crypto = require('crypto');
const NODE_COLUMNS = ['node_id', 'parent_node_id', 'node_order', 'object_key', 'object_key_encoded', 'value_type', 'text_value', 'encoded_text_value', 'number_value', 'boolean_value'];
const MAX_RELATIONAL_NODE_DEPTH = 128;
const MAX_RELATIONAL_NODE_ROWS = 250_000;

function identifier(value) { return typeof value === 'string' && value ? value : crypto.randomUUID(); }
function needsUtf16Encoding(value) {
    const text = String(value);
    return text.includes('\0') || Buffer.from(text, 'utf8').toString('utf8') !== text;
}
function encodedText(value) { const text = String(value); return needsUtf16Encoding(text) ? { text_value: null, encoded_text_value: Buffer.from(text, 'utf16le').toString('base64') } : { text_value: text, encoded_text_value: null }; }
function nodeRows(value, parent = null, key = null, order = 0, rows = [], depth = 0, ancestors = new WeakSet()) {
    if (depth > MAX_RELATIONAL_NODE_DEPTH) throw new Error('Relational value exceeds maximum depth');
    if (rows.length >= MAX_RELATIONAL_NODE_ROWS) throw new Error('Relational value exceeds maximum row count');
    const isReference = value !== null && typeof value === 'object';
    if (isReference && ancestors.has(value)) throw new Error('Relational value contains a cycle');
    if (isReference) ancestors.add(value);
    const node_id = rows.length;
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value === 'object' ? 'object' : typeof value;
    const row = { node_id, parent_node_id: parent, node_order: order, object_key: key, object_key_encoded: null, value_type: type };
    if (key !== null && needsUtf16Encoding(key)) { row.object_key = null; row.object_key_encoded = Buffer.from(key, 'utf16le').toString('base64'); }
    if (type === 'string') Object.assign(row, encodedText(value));
    else if (type === 'number') { if (!Number.isFinite(value)) row.text_value = String(value); else row.number_value = value; }
    else if (type === 'boolean') row.boolean_value = value ? 1 : 0;
    else if (type !== 'null' && type !== 'array' && type !== 'object' && type !== 'undefined') row.value_type = 'undefined';
    rows.push(row);
    if (Array.isArray(value)) value.forEach((child, index) => nodeRows(child, node_id, null, index, rows, depth + 1, ancestors));
    else if (isReference) Object.entries(value).forEach(([childKey, child], index) => nodeRows(child, node_id, childKey, index, rows, depth + 1, ancestors));
    if (isReference) ancestors.delete(value);
    return rows;
}
function contentHash(value) { const serialized = JSON.stringify(value); let hash = 2166136261; for (let index = 0; index < serialized.length; index++) { hash ^= serialized.charCodeAt(index); hash = Math.imul(hash, 16777619); } return `${serialized.length}-${(hash >>> 0).toString(16)}`; }
const SETTING_DOMAINS = {
    model: new Set(['apiType', 'aiModel', 'subModel', 'temperature', 'maxContext', 'maxResponse', 'frequencyPenalty', 'PresensePenalty', 'bias', 'customModels', 'fallbackModels']),
    provider: new Set(['openAIKey', 'proxyKey', 'forceReplaceUrl', 'openrouterKey', 'claudeAPIKey', 'nanogptKey', 'koboldURL', 'textgenWebUIStreamURL', 'textgenWebUIBlockingURL', 'OaiCompAPIKeys']),
    prompt: new Set(['mainPrompt', 'jailbreak', 'globalNote', 'additionalPrompt', 'descriptionPrefix', 'promptTemplate', 'promptSettings', 'instructChatTemplate', 'JinjaTemplate', 'globalscript']),
    memory: new Set(['supaMemoryPrompt', 'supaMemoryKey', 'hypaMemoryKey', 'voyageApiKey', 'hypaMemory', 'hypav2', 'hypaModel', 'memoryAlgorithmType']),
    translation: new Set(['language', 'translator', 'translatorType', 'translatorInputLanguage', 'autoTranslate', 'useAutoTranslateInput', 'deeplOptions', 'deeplXOptions']),
    media: new Set(['sdProvider', 'webUiUrl', 'sdSteps', 'sdCFG', 'sdConfig', 'NAIImgUrl', 'NAIApiKey', 'NAIImgModel', 'NAIImgConfig', 'ttsAutoSpeech', 'elevenLabKey', 'voicevoxUrl']),
    ui: new Set(['zoomsize', 'customBackground', 'fullScreen', 'iconsize', 'theme', 'textTheme', 'customTextTheme', 'colorScheme', 'colorSchemeName', 'customColorScheme', 'characterOrder', 'hotkeys']),
    collection: new Set(['botPresets', 'personas', 'modules', 'loreBook', 'loadouts', 'plugins', 'pluginV2', 'translatorPresets']),
};
function settingDomain(key) {
    // sqliteCommit writes this special persistence field directly with the
    // model domain rather than routing it through SETTING_DOMAINS.
    if (key === 'activeBotPresetId') return 'model';
    for (const [domain, keys] of Object.entries(SETTING_DOMAINS)) if (keys.has(key)) return domain;
    return 'account-sync-compatibility';
}
function pushNodeStatements(statements, table, ownerColumns, ownerValues, value) {
    const columns = [...ownerColumns, ...NODE_COLUMNS]; const sql = `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`;
    for (const row of nodeRows(value)) statements.push({ sql, bind: [...ownerValues, ...NODE_COLUMNS.map((column) => row[column] ?? null)] });
}
function settingStatements(statements, key, value) {
    const root = nodeRows(value)[0];
    statements.push({ sql: 'INSERT INTO system_settings (key,domain,value_type,text_value,encoded_text_value,number_value,boolean_value) VALUES (?,?,?,?,?,?,?)', bind: [key, settingDomain(key), root.value_type, root.text_value ?? null, root.encoded_text_value ?? null, root.number_value ?? null, root.boolean_value ?? null] });
    pushNodeStatements(statements, 'setting_extension_nodes', ['setting_key'], [key], value);
}
function statementsForLegacy(database) {
    const statements = [{ sql: 'DELETE FROM system_settings', bind: [] }, { sql: 'DELETE FROM characters', bind: [] }, { sql: 'DELETE FROM plugin_custom_storage', bind: [] }, { sql: 'DELETE FROM bot_presets', bind: [] }];
    const excluded = new Set(['characters', 'botPresets', 'botPresetsId', 'activeBotPresetId', 'pluginCustomStorage']);
    for (const [key, value] of Object.entries(database || {})) if (!excluded.has(key) && value !== undefined && typeof value !== 'function') settingStatements(statements, key, value);
    for (const [key, value] of Object.entries(database?.pluginCustomStorage || {})) statements.push({ sql: 'INSERT INTO plugin_custom_storage (key,value) VALUES (?,?)', bind: [key, JSON.stringify(value)] });
    const presets = Array.isArray(database?.botPresets) ? database.botPresets : []; const presetIds = [];
    for (const [position, raw] of presets.entries()) { const preset = { ...raw }; const id = identifier(preset.id); presetIds.push(id); delete preset.id; statements.push({ sql: 'INSERT INTO bot_presets (preset_id,position,name,image,api_type,ai_model,data,content_hash) VALUES (?,?,?,?,?,?,?,?)', bind: [id, position, preset.name ?? '', preset.image ?? '', preset.apiType ?? '', preset.aiModel ?? '', JSON.stringify(preset), contentHash(preset)] }); }
    if (presetIds.length) settingStatements(statements, 'activeBotPresetId', presetIds[Math.max(0, Math.min(Number(database?.botPresetsId) || 0, presetIds.length - 1))]);
    for (const [characterPosition, rawCharacter] of (database?.characters || []).entries()) {
        const character = { ...rawCharacter }; const characterId = identifier(character.chaId); const chats = Array.isArray(character.chats) ? character.chats : [];
        delete character.chaId; delete character.chats; delete character.detailsLoaded;
        statements.push({ sql: 'INSERT INTO characters (id,position,kind,name,image,trash_time,creation_time,modification_time,last_interaction_time,details_loaded) VALUES (?,?,?,?,?,?,?,?,?,1)', bind: [characterId, characterPosition, character.type === 'group' ? 'group' : 'character', character.name ?? '', character.image ?? null, character.trashTime ?? null, character.creationDate ?? character.creation_date ?? null, character.modificationDate ?? character.modification_date ?? null, character.lastInteraction ?? null] });
        pushNodeStatements(statements, 'character_extension_nodes', ['character_id'], [characterId], character);
        if (Array.isArray(character.tags)) for (const [position, tag] of character.tags.entries()) if (typeof tag === 'string') statements.push({ sql: 'INSERT INTO character_tags (character_id,position,tag) VALUES (?,?,?)', bind: [characterId, position, tag] });
        for (const [chatPosition, rawChat] of chats.entries()) {
            const chat = { ...rawChat }; const chatId = identifier(chat.id); const messages = Array.isArray(chat.message) ? chat.message : [];
            delete chat.id; delete chat.message; delete chat._placeholder; delete chat.messagesLoaded; delete chat.messagesFullyLoaded; delete chat.messageOffset; delete chat.messageTotal; delete chat._sqlWindow; delete chat.detailsLoaded;
            statements.push({ sql: 'INSERT INTO chats (id,character_id,position,name,note,folder_id,last_message_time,messages_loaded) VALUES (?,?,?,?,?,?,?,0)', bind: [chatId, characterId, chatPosition, chat.name ?? '', chat.note ?? '', chat.folderId ?? null, chat.lastDate ?? null] });
            pushNodeStatements(statements, 'chat_extension_nodes', ['chat_id'], [chatId], chat);
            for (const [messagePosition, rawMessage] of messages.entries()) {
                const message = { ...rawMessage }; const messageId = identifier(message.chatId); delete message.chatId;
                const content = nodeRows(typeof message.data === 'string' ? message.data : String(message.data ?? ''))[0];
                statements.push({ sql: 'INSERT INTO messages (chat_id,id,position,role,content_text,content_encoded,sender_name,sent_time,generation_model,input_tokens,output_tokens) VALUES (?,?,?,?,?,?,?,?,?,?,?)', bind: [chatId, messageId, messagePosition, message.role ?? 'char', content.text_value ?? null, content.encoded_text_value ?? null, message.name ?? null, message.time ?? null, message.generationInfo?.model ?? null, message.generationInfo?.inputTokens ?? null, message.generationInfo?.outputTokens ?? null] });
                pushNodeStatements(statements, 'message_extension_nodes', ['chat_id', 'message_id'], [chatId, messageId], message);
            }
        }
    }
    return statements;
}
function createSqlLegacyMigration({ relationalSql, readLegacy }) {
    let running = false;
    async function migrate({ retry = false } = {}) {
        const before = relationalSql.bootstrap();
        if (before.status === 'ready') return { status: 'ready', revision: before.revision };
        if (running) { const error = new Error('SQL migration already in progress'); error.code = 'SQL_MIGRATION_IN_PROGRESS'; throw error; }
        if (before.migrationState === 'failed' && !retry) return { status: 'failed', revision: before.revision, error: before.migrationError || 'migration failed' };
        running = true; relationalSql.setMigrationState('migrating');
        try {
            const legacy = await readLegacy(); if (!legacy || typeof legacy !== 'object') throw new Error('Legacy database is unavailable');
            const result = relationalSql.commitLegacyMigration(before.revision, statementsForLegacy(legacy)); relationalSql.checkpoint();
            return { status: 'ready', revision: result.revision };
        } catch (error) { relationalSql.setMigrationState('failed', error?.code || 'legacy migration failed'); throw error; }
        finally { running = false; }
    }
    return { migrate };
}
module.exports = { createSqlLegacyMigration, statementsForLegacy, nodeRows, settingDomain };
