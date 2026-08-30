'use strict';

/**
 * Rebuild the full legacy `Database` object out of the relational SQL store.
 *
 * WHY THIS EXISTS
 *
 * Once a standalone install has migrated to SQL, the client boots
 * "metadata-first" (`bootstrap.ts` -> `openExistingStandaloneSql`) and every
 * subsequent write goes to SQLite through `/api/sql/commit`. Nothing calls
 * `saveDb()` any more, so `save/database/database.bin` stops being written and
 * stays frozen at the byte-for-byte state of the migration.
 *
 * `GET /api/backup/export` used to put that frozen file into the backup as
 * `database.risudat`. A user who imported state A, chatted up to A+, then
 * exported, got A back. This module is the replacement source: when SQL is
 * canonical the export is built from SQL, and `database.bin` is only read on
 * installs that genuinely never migrated.
 *
 * THE ONE RULE
 *
 * This codebase has repeatedly shipped the same defect: something partial got
 * recorded as complete. A summary character exported as a stub; a windowed chat
 * overwriting a full one; a stub migration emptying a history. So there is no
 * best-effort mode here, no skip counter, and no warning-and-continue path.
 * Anything that cannot be proven complete throws `SqlExportIncompleteError`,
 * the export fails with HTTP 500 and a message naming the character or chat,
 * and no zip is written. A backup that is short is worse than no backup,
 * because only one of the two tells the user something is wrong.
 */

/**
 * Mirrors of the client's storage-bookkeeping root keys. These strings are the
 * contract with `src/ts/storage/sql/nodeSqliteStorage.ts` (lines 299 and 320);
 * they are duplicated rather than imported because this file is CommonJS
 * loaded by the server and that file is a browser TypeScript module.
 */
const SQL_MIGRATION_MARKER_KEY = '__risuSqlMigrationInProgress';
const SQL_CHAT_HISTORY_AUDIT_KEY = '__risuSqlChatHistoriesVerified';
const SQL_INTERNAL_SETTING_KEYS = new Set([
    SQL_MIGRATION_MARKER_KEY,
    SQL_CHAT_HISTORY_AUDIT_KEY,
]);

/**
 * `activeBotPresetId` is how the SQL store spells `Database.botPresetsId`; the
 * client's `rebuildBootstrap` turns it back into an index and deletes the key.
 * The rebuilt legacy object has to do exactly the same or a restored backup
 * would carry a root setting no legacy build understands.
 */
const ACTIVE_BOT_PRESET_SETTING_KEY = 'activeBotPresetId';

/**
 * Equal to `MAX_MESSAGE_PAGE_LIMIT` in relational-sqlite.cjs. A larger request
 * is silently clamped there, so asking for more would only make the page count
 * arithmetic below disagree with reality.
 */
const EXPORT_MESSAGE_PAGE_LIMIT = 100;

/**
 * Runtime bookkeeping that `summaryChat()` attaches to every chat the SQL
 * layer hands back. It says how much of a chat is resident, which is a fact
 * about this process, not about the user's data — and `sqlChatData()` strips
 * exactly these before writing, so leaving them in would mean a restored
 * backup describes every chat as half-loaded.
 */
const RUNTIME_CHAT_KEYS = [
    'messageTotal',
    'messagesLoaded',
    'messagesFullyLoaded',
    'detailsLoaded',
];

/**
 * The three keys `loadCharacter` attaches itself. Everything else on a loaded
 * character comes from `character_extension_nodes`, so a character carrying
 * only these three is a character whose nodes were not read: `loadCharacter`
 * writes `readNodeValue(...) || {}` and then decorates the empty object, which
 * still answers `detailsLoaded === true`. That is the exact shape that once
 * exported a character as a stub and destroyed its description and lorebook.
 */
const IDENTITY_CHARACTER_KEYS = new Set(['chaId', 'detailsLoaded', 'chats']);

/**
 * Everything `summaryChat` puts on a chat by itself, after the runtime keys are
 * stripped. A rebuilt chat carrying nothing but these came from a `chats` row
 * whose `chat_extension_nodes` are missing: `loadChat` spells that as `{}` and
 * then decorates it into something that looks like a chat. Every real chat
 * carries at least `localLore`, so anything inside this set and nothing else is
 * a chat whose per-chat settings -- memory config, bound persona, modules,
 * script state -- cannot be read, not a chat that happens to have none.
 */
const IDENTITY_CHAT_KEYS = new Set(['id', 'name', 'note', 'folderId', 'lastDate', 'message']);

class SqlExportIncompleteError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SqlExportIncompleteError';
        this.code = 'SQL_EXPORT_INCOMPLETE';
        // Read by createExpressErrorResponder, so the user sees this sentence
        // instead of a bare "internal server error".
        this.status = 500;
    }
}

function incomplete(message) {
    return new SqlExportIncompleteError(
        `Refusing to export a backup from an incomplete SQL read: ${message} ` +
        'No backup file was written; a short backup would be indistinguishable from a good one.',
    );
}

/**
 * Is the SQL store the canonical copy of the user's data?
 *
 * This is deliberately the same three-part test the client applies in
 * `NodeSqliteStorage.loadDatabase` / `migrationIsIncomplete`
 * (src/ts/storage/sql/nodeSqliteStorage.ts:843), and it has to stay the same:
 *
 *   - answer "canonical" when the client says otherwise and the export ships a
 *     SQL state the running app is ignoring;
 *   - answer "legacy" when the client says canonical and the export ships the
 *     frozen `database.bin` — which is the bug this file exists to fix.
 *
 *   ready == status === 'ready'
 *            AND settings[SQL_MIGRATION_MARKER_KEY] === undefined
 *            AND settings[SQL_CHAT_HISTORY_AUDIT_KEY] !== undefined
 *
 * A half-applied chunked migration never reaches 'ready' (`initialized` stays 0
 * until the final chunk), so no extra check for an in-flight migration session
 * is needed and none is added: an extra condition here would be a condition the
 * client does not have.
 */
function sqlBootstrapIsCanonical(payload) {
    if (!payload || payload.status !== 'ready') return false;
    const settings = payload.settings;
    if (!settings || typeof settings !== 'object') return false;
    if (settings[SQL_MIGRATION_MARKER_KEY] !== undefined) return false;
    if (settings[SQL_CHAT_HISTORY_AUDIT_KEY] === undefined) return false;
    return true;
}

/**
 * Every message of one chat, in position order.
 *
 * `loadChatMessages` pages backwards from the newest message, so the pages are
 * collected newest-first and flattened in reverse at the end. They are kept as
 * a list of pages rather than repeatedly `unshift`ed because a long history
 * would otherwise cost O(n^2).
 *
 * The completeness proof is the `total` the first page reported: the assembled
 * length must equal it exactly. `hasMore` alone is not enough — that is the
 * flag a truncated read would also produce.
 */
function readAllChatMessages(relationalSql, chatId, label) {
    const pages = [];
    let assembled = 0;
    let expectedTotal = null;
    let before;
    let pageCount = 0;
    let pageBudget = Infinity;

    for (;;) {
        const page = relationalSql.loadChatMessages(chatId, before, EXPORT_MESSAGE_PAGE_LIMIT);
        if (!page) {
            throw incomplete(`chat ${label} disappeared from SQL while its history was being read.`);
        }
        if (expectedTotal === null) {
            expectedTotal = Number(page.total);
            if (!Number.isSafeInteger(expectedTotal) || expectedTotal < 0) {
                throw incomplete(
                    `chat ${label} reported a message total of ${JSON.stringify(page.total)}, ` +
                    'which is not a count.',
                );
            }
            // One page of slack over the exact number of pages the reported
            // total needs, so a cursor that stops advancing is caught as a
            // failure instead of spinning forever.
            pageBudget = Math.ceil(expectedTotal / EXPORT_MESSAGE_PAGE_LIMIT) + 2;
        } else if (Number(page.total) !== expectedTotal) {
            throw incomplete(
                `chat ${label} changed size while it was being read (it reported ${expectedTotal} ` +
                `messages and then ${Number(page.total)}).`,
            );
        }
        if (!Array.isArray(page.messages)) {
            throw incomplete(`chat ${label} returned a message page that is not a list.`);
        }
        pages.push(page.messages);
        assembled += page.messages.length;
        if (++pageCount > pageBudget) {
            throw incomplete(
                `chat ${label} did not finish paging after ${pageCount} pages for ` +
                `${expectedTotal} message(s); its page cursor is not advancing.`,
            );
        }
        if (!page.hasMore) break;
        if (page.messages.length === 0) {
            throw incomplete(
                `chat ${label} reported more messages to come but returned an empty page.`,
            );
        }
        // A page that still has more to give must carry the cursor for the next
        // one. `nextBefore` is only ever `null` on the terminal page, which the
        // `hasMore` break above already took, so reaching here without an
        // integer is the backend breaking its own contract.
        if (!Number.isSafeInteger(page.nextBefore)) {
            throw incomplete(
                `chat ${label} reported more messages to come without a usable page cursor ` +
                `(nextBefore = ${JSON.stringify(page.nextBefore)}).`,
            );
        }
        // The page budget below would eventually catch a cursor that stops
        // moving, but only after re-reading the same page ~n times and then
        // blaming the page count. A cursor must walk strictly backwards, so say
        // so at the first page that fails to.
        if (before !== undefined && page.nextBefore >= before) {
            throw incomplete(
                `chat ${label} did not advance its page cursor (it asked before ${before} and was ` +
                `told to ask before ${page.nextBefore} next).`,
            );
        }
        before = page.nextBefore;
    }

    if (assembled !== expectedTotal) {
        throw incomplete(
            `chat ${label} holds ${expectedTotal} message(s) in SQL but only ${assembled} could be ` +
            'read back.',
        );
    }

    const messages = [];
    for (let index = pages.length - 1; index >= 0; index--) {
        for (const message of pages[index]) messages.push(message);
    }
    return messages;
}

/** One chat, with its complete history, in the legacy `Chat` shape. */
function buildChat(relationalSql, summary, characterLabel) {
    const chatId = summary && summary.id;
    const chatName = summary && typeof summary.name === 'string' ? summary.name : '(unnamed)';
    const label = `"${chatName}" (${chatId === undefined ? 'no id' : String(chatId)}) of ${characterLabel}`;
    if (typeof chatId !== 'string' || chatId.length === 0) {
        throw incomplete(`chat ${label} has no id, so its rows cannot be found.`);
    }

    const loaded = relationalSql.loadChat(chatId);
    if (!loaded || !loaded.chat) {
        throw incomplete(
            `chat ${label} could not be loaded from SQL. Its summary exists but its row does not, ` +
            'so exporting it would emit a chat with no settings and no history.',
        );
    }
    const chat = { ...loaded.chat };
    if (chat.detailsLoaded !== true) {
        throw incomplete(
            `chat ${label} came back without its full detail (detailsLoaded = ` +
            `${JSON.stringify(chat.detailsLoaded)}), which is the summary shape, not the chat.`,
        );
    }

    const declaredTotal = Number(chat.messageTotal);
    const messages = readAllChatMessages(relationalSql, chatId, label);
    if (Number.isSafeInteger(declaredTotal) && declaredTotal !== messages.length) {
        throw incomplete(
            `chat ${label} is listed as holding ${declaredTotal} message(s) but ${messages.length} ` +
            'were read back.',
        );
    }

    for (const key of RUNTIME_CHAT_KEYS) delete chat[key];
    if (Object.keys(chat).every((key) => IDENTITY_CHAT_KEYS.has(key))) {
        throw incomplete(
            `chat ${label} rebuilt to a chat carrying no settings at all — its relational nodes ` +
            'are missing, so its memory configuration, bound persona, modules and script state ' +
            'cannot be read. A full message history would make the export look intact while ' +
            'restoring it silently reset all of them.',
        );
    }
    // `summaryChat` spells "this column is NULL" as `undefined`, which would
    // otherwise add keys the original chat never had.
    if (chat.folderId === undefined) delete chat.folderId;
    if (chat.lastDate === undefined) delete chat.lastDate;
    chat.id = chatId;
    chat.message = messages;
    return chat;
}

/** One character, with every chat fully loaded, in the legacy shape. */
function buildCharacter(relationalSql, summary) {
    const characterId = summary && summary.chaId;
    const characterName = summary && typeof summary.name === 'string' ? summary.name : '(unnamed)';
    const label = `character "${characterName}" (${characterId === undefined ? 'no id' : String(characterId)})`;
    if (typeof characterId !== 'string' || characterId.length === 0) {
        throw incomplete(`${label} has no id, so its rows cannot be found.`);
    }

    const loaded = relationalSql.loadCharacter(characterId);
    if (!loaded || !loaded.character) {
        throw incomplete(
            `${label} could not be loaded from SQL. The bootstrap summary carries only the name, ` +
            'image and chat list — exporting it would replace the description, lorebook and ' +
            'scripts with nothing.',
        );
    }
    const character = { ...loaded.character };
    if (character.detailsLoaded !== true) {
        throw incomplete(
            `${label} came back without its full detail (detailsLoaded = ` +
            `${JSON.stringify(character.detailsLoaded)}), which is the summary shape, not the ` +
            'character.',
        );
    }
    if (!Array.isArray(character.chats)) {
        throw incomplete(`${label} came back without a chat list.`);
    }
    if (Object.keys(character).every((key) => IDENTITY_CHARACTER_KEYS.has(key))) {
        throw incomplete(
            `${label} rebuilt to a character carrying no data at all — its relational nodes are ` +
            'missing, so its description, lorebook and scripts cannot be read. Exporting it ' +
            'would ship a stub in their place.',
        );
    }

    const chatSummaries = character.chats;
    delete character.detailsLoaded;
    character.chaId = characterId;
    // Assembled one character at a time and never held as a separate
    // collection: the finished object is the only full copy in memory, which is
    // the same size `database.bin` was.
    character.chats = chatSummaries.map((chatSummary) => buildChat(relationalSql, chatSummary, label));
    return character;
}

/**
 * The complete legacy database object as SQL currently holds it, or `null` when
 * SQL is not canonical and `database/database.bin` is still the live copy.
 *
 * Throws `SqlExportIncompleteError` when SQL *is* canonical but any part of it
 * cannot be read back in full. Callers must let that propagate.
 */
function buildLegacyDatabaseFromSql(relationalSql, { withCharacters = true } = {}) {
    // No `deferRootKeys`: a deferred key is one the caller promises to fetch
    // later, and there is no later here.
    const payload = relationalSql.bootstrap();
    if (!sqlBootstrapIsCanonical(payload)) return null;

    if (Array.isArray(payload.unreadableRootKeys) && payload.unreadableRootKeys.length) {
        throw incomplete(
            `root key(s) ${payload.unreadableRootKeys.join(', ')} are registered in SQL but hold ` +
            'no relational nodes, so their values are unknown rather than empty.',
        );
    }
    if (Array.isArray(payload.deferredRootKeys) && payload.deferredRootKeys.length) {
        throw incomplete(
            `SQL withheld root key(s) ${payload.deferredRootKeys.join(', ')} from a bootstrap that ` +
            'asked for everything.',
        );
    }
    if (!payload.settings || typeof payload.settings !== 'object') {
        throw incomplete('SQL returned no settings map.');
    }
    if (!Array.isArray(payload.botPresets)) {
        throw incomplete('SQL withheld the bot preset list.');
    }
    if (payload.pluginCustomStorage === undefined || payload.pluginCustomStorage === null) {
        throw incomplete(
            'SQL withheld pluginCustomStorage. Withheld is not empty, and an export that shipped ' +
            'it as empty would delete every plugin\'s stored data on restore.',
        );
    }
    if (!Array.isArray(payload.characters)) {
        throw incomplete('SQL withheld the character list.');
    }

    const database = {};
    for (const [key, value] of Object.entries(payload.settings)) {
        // Storage bookkeeping, not user data. See SQL_INTERNAL_SETTING_KEYS in
        // nodeSqliteStorage.ts: these must never ride along inside an object
        // that gets exported and imported back.
        if (SQL_INTERNAL_SETTING_KEYS.has(key)) continue;
        if (key === ACTIVE_BOT_PRESET_SETTING_KEY) continue;
        database[key] = value;
    }

    database.botPresets = payload.botPresets;
    database.botPresetsId = Math.max(0, payload.botPresets.findIndex(
        (preset) => preset && preset.id === payload.settings[ACTIVE_BOT_PRESET_SETTING_KEY],
    ));
    database.pluginCustomStorage = { ...payload.pluginCustomStorage };
    // A settings-only export throws every character away again (see
    // stripToSettingsOnly), so walking them costs one loadChat plus a page of
    // loadChatMessages per chat for nothing -- all synchronous SQLite work on
    // the event loop, which on a phone means the confirm dialog waits on
    // hundreds of blocking reads and every concurrent commit queues behind it.
    // Worse, it would make the settings-only export fail on a damaged character
    // it was never going to carry, and seeding a fresh instance from a damaged
    // one is exactly what that export is for.
    database.characters = withCharacters
        ? payload.characters.map((summary) => buildCharacter(relationalSql, summary))
        : [];
    return database;
}

module.exports = {
    SQL_MIGRATION_MARKER_KEY,
    SQL_CHAT_HISTORY_AUDIT_KEY,
    EXPORT_MESSAGE_PAGE_LIMIT,
    SqlExportIncompleteError,
    sqlBootstrapIsCanonical,
    buildLegacyDatabaseFromSql,
};
