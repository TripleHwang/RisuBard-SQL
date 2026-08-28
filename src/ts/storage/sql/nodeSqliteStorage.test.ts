import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteStorage } from "./nodeSqliteStorage";
import { resetDeferredRootKeys } from "./deferredRootKeys";

const { createRelationalSqlite } = require("../../../../server/node/relational-sqlite.cjs");

/**
 * The client asks the server to withhold its deferred bootstrap keys, so these
 * doubles honour `?defer=` exactly like the real route does. `BOOTSTRAP_PATH`
 * is what the client actually requests with the current defer set.
 */
const BOOTSTRAP_PATH = "/api/sql/bootstrap?defer=pluginCustomStorage";

function bootstrapFor(server: { bootstrap(options?: unknown): unknown }, path: string) {
  const defer = new URL(path, "https://risu.invalid").searchParams.get("defer");
  return server.bootstrap({ deferRootKeys: defer ? defer.split(",") : [] });
}

const roots: string[] = [];
afterEach(() => {
  // The deferral registry is module-level state shared by every test in this
  // file; a mark left behind would silently change the next test's semantics.
  resetDeferredRootKeys();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createClient() {
  const root = mkdtempSync(join(tmpdir(), "risu-node-sql-client-"));
  roots.push(root);
  const server = createRelationalSqlite({ dataRoot: root });
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("/api/sql/bootstrap")) {
      return Response.json(bootstrapFor(server, String(input)));
    }
    if (String(input) === "/api/sql/snapshot") {
      return Response.json(server.dump());
    }
    try {
      return Response.json(server.commit(JSON.parse(String(init?.body))));
    } catch (error: any) {
      if (error?.code === "SQL_REVISION_CONFLICT") {
        return Response.json(
          { currentRevision: error.currentRevision },
          { status: 409 },
        );
      }
      throw error;
    }
  };
  return { client: new NodeSqliteStorage(request), server };
}

function createClientWithBootstrap() {
  const root = mkdtempSync(join(tmpdir(), "risu-node-sql-bootstrap-"));
  roots.push(root);
  const server = createRelationalSqlite({ dataRoot: root });
  const requests: string[] = [];
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = String(input);
    requests.push(path);
    if (path.startsWith("/api/sql/bootstrap")) return Response.json(bootstrapFor(server, path));
    if (path === "/api/sql/snapshot") return Response.json(server.dump());
    if (path === "/api/sql/commit") return Response.json(server.commit(JSON.parse(String(init?.body))));
    if (path.startsWith("/api/sql/characters/")) {
      const result = server.loadCharacter(decodeURIComponent(path.slice("/api/sql/characters/".length)));
      return result ? Response.json(result) : Response.json({}, { status: 404 });
    }
    if (path.startsWith("/api/sql/chats/")) {
      const url = new URL(path, "https://risu.invalid");
      const chatId = decodeURIComponent(url.pathname.slice("/api/sql/chats/".length, -"/messages".length));
      const before = url.searchParams.has("before") ? Number(url.searchParams.get("before")) : undefined;
      const result = server.loadChatMessages(chatId, before, Number(url.searchParams.get("limit")));
      return result ? Response.json(result) : Response.json({}, { status: 404 });
    }
    if (path.startsWith("/api/sql/chat-drafts?")) {
      const url = new URL(path, "https://risu.invalid");
      return Response.json(server.listChatDraftKeys(url.searchParams.get("after") ?? undefined, Number(url.searchParams.get("limit"))));
    }
    if (path.startsWith("/api/sql/chat-drafts/")) {
      const key = decodeURIComponent(path.slice("/api/sql/chat-drafts/".length));
      const draft = server.getChatDraft(key);
      return draft ? Response.json({ key, draft }) : Response.json({}, { status: 404 });
    }
    if (path.startsWith("/api/sql/cold-storage?")) {
      const url = new URL(path, "https://risu.invalid");
      return Response.json(server.listColdStorageItems(url.searchParams.get("after") ?? undefined, Number(url.searchParams.get("limit"))));
    }
    if (path.startsWith("/api/sql/cold-storage/")) {
      const id = decodeURIComponent(path.slice("/api/sql/cold-storage/".length));
      const item = server.getColdStorageItem(id);
      return item === null ? Response.json({}, { status: 404 }) : Response.json({ id, item });
    }
    if (path.startsWith("/api/sql/revisions?")) {
      const url = new URL(path, "https://risu.invalid");
      return Response.json({ revisions: server.listRevisions(Number(url.searchParams.get("limit"))) });
    }
    if (path.startsWith("/api/sql/search/messages?")) {
      const url = new URL(path, "https://risu.invalid");
      return Response.json({ results: server.searchMessages(url.searchParams.get("query"), Number(url.searchParams.get("limit"))) });
    }
    if (path.startsWith("/api/sql/search/characters?")) {
      const url = new URL(path, "https://risu.invalid");
      const query = url.searchParams.get("query");
      const limit = Number(url.searchParams.get("limit"));
      const results = url.searchParams.get("mode") === "tag"
        ? server.searchCharactersByTag(query, limit)
        : server.searchCharactersByName(query, limit);
      return Response.json({ results });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return { client: new NodeSqliteStorage(request), requests, server };
}

describe("Node server SQLite client", () => {
  it("closes bootstrap timing when the request rejects without snapshot fallback", async () => {
    const requests: string[] = [];
    performance.clearMarks("risu:bootstrap-fetch:start");
    performance.clearMarks("risu:bootstrap-fetch:end");
    const client = new NodeSqliteStorage(async (input) => {
      requests.push(String(input));
      throw new Error("network unavailable");
    });

    await expect(client.init()).rejects.toThrow("network unavailable");

    expect(performance.getEntriesByName("risu:bootstrap-fetch:start", "mark")).toHaveLength(1);
    expect(performance.getEntriesByName("risu:bootstrap-fetch:end", "mark")).toHaveLength(1);
    expect(requests).toEqual([BOOTSTRAP_PATH]);
  });

  it("migrates and round-trips a compatible Database graph", async () => {
    const { client, server } = createClient();
    const source = {
      username: "standalone",
      pluginCustomStorage: { "pagefold.config.v1": { provider: "google" } },
      moduleFolders: [{ id: "folder-1", name: "Modules", color: "#123456" }],
      loadouts: [{
        id: "loadout-1", name: "Recent setup", lastUsed: 1, favorite: true,
        characterIds: ["character-1"], modules: ["module-1"],
        globalVariables: { scene: "night" }, presetName: "Default", personaId: "persona-1",
      }],
      customSidebarItems: [{ id: "sidebar-1", type: "loadout", subType: "quick", label: "Quick" }],
      lastLoadedLoadoutName: "Recent setup",
      botPresets: [{ id: "preset-1", name: "Default" }],
      botPresetsId: 0,
      modules: [{ id: "module-1", name: "Module", description: "", folderId: "folder-1" }],
      characters: [{
        chaId: "character-1",
        name: "Character",
        additionalAssetFolders: [{ id: "asset-folder-1", name: "Assets" }],
        additionalAssetFolderAssignments: { Portrait: "asset-folder-1" },
        chats: [{
          id: "chat-1",
          name: "Chat",
          useLocallySetGlobalVariables: true,
          GLGlobalVariables: { scene: "night" },
          message: [{ chatId: "message-1", role: "user", data: "hello" }],
        }],
      }],
    } as any;

    expect((await client.loadDatabase())?.status).toBe("empty");
    expect(await client.replaceDatabase(source)).toBe(true);
    const loaded = (await client.loadRecoverySnapshot())?.database as any;
    expect(loaded).toMatchObject(source);
    expect(loaded.modules[0].folderId).toBe("folder-1");
    expect(loaded.characters[0].additionalAssetFolders).toEqual(source.characters[0].additionalAssetFolders);
    expect(loaded.characters[0].additionalAssetFolderAssignments).toEqual(source.characters[0].additionalAssetFolderAssignments);
    expect(loaded.characters[0].chats[0].GLGlobalVariables).toEqual({ scene: "night" });
    server.close();
  });

  it("updates its revision hint when the server rejects a stale writer", async () => {
    const { client, server } = createClient();
    await client.init();
    server.commit({ baseRevision: 0, action: "other-writer", statements: [] });

    await expect(client.replaceDatabase({ characters: [] } as any)).rejects.toMatchObject({
      name: "SqlRevisionConflictError",
      currentRevision: 1,
    });
    expect(client.getRevision()).toBe(1);
    server.close();
  });

  it("opens an existing Node SQL database from bootstrap without requesting snapshot", async () => {
    const { client, requests, server } = createClientWithBootstrap();
    await client.replaceDatabase({
      characters: [{ chaId: "character-1", name: "Character", chats: [{ id: "chat-1", name: "Chat", message: [] }] }],
      botPresets: [],
    } as any);
    requests.splice(0);

    await client.init();
    const loaded = await client.loadDatabase({ shallow: true });
    const loadedWithDefaultOptions = await client.loadDatabase();

    expect(loaded?.database?.characters[0]).toMatchObject({
      detailsLoaded: false,
      chats: [{ id: "chat-1", message: [], messagesLoaded: false }],
    });
    expect(loadedWithDefaultOptions?.database).toEqual(loaded?.database);
    expect(requests).toEqual([BOOTSTRAP_PATH]);
    server.close();
  });

  it("keeps representative legacy reads on the cached bootstrap projection", async () => {
    const { client, requests, server } = createClientWithBootstrap();
    await client.replaceDatabase({
      characters: [{ chaId: "character-1", name: "Character", chats: [] }],
      botPresets: [{ id: "preset-1", name: "Default" }],
      botPresetsId: 0,
    } as any);
    requests.splice(0);

    await client.init();
    const presets = await client.listBotPresets();

    expect(presets).toEqual([expect.objectContaining({ id: "preset-1", name: "Default" })]);
    expect(requests).toEqual([BOOTSTRAP_PATH]);
    server.close();
  });

  it("refreshes bootstrap metadata after a commit without requesting snapshot", async () => {
    const { client, requests, server } = createClientWithBootstrap();
    await client.init();
    expect(client.getRevision()).toBe(0);

    await client.replaceDatabase({ characters: [], botPresets: [] } as any);
    const loaded = await client.loadDatabase();

    expect(loaded?.revision).toBe(1);
    expect(client.getRevision()).toBe(1);
    expect(requests).toEqual([
      BOOTSTRAP_PATH,
      "/api/sql/commit",
      BOOTSTRAP_PATH,
    ]);
    server.close();
  });

  it("preserves an empty revision-zero bootstrap without a snapshot", async () => {
    const { client, requests, server } = createClientWithBootstrap();

    await client.init();
    const loaded = await client.loadDatabase();

    expect(loaded).toEqual({ status: "empty", revision: 0, database: null });
    expect(client.getRevision()).toBe(0);
    expect(requests).toEqual([BOOTSTRAP_PATH]);
    server.close();
  });

  it("keeps full snapshot behind an explicit recovery method", async () => {
    const { client, requests, server } = createClientWithBootstrap();

    await client.loadRecoverySnapshot();

    expect(requests).toContain("/api/sql/snapshot");
    server.close();
  });

  it("uses bounded character and reverse-page endpoints for legacy reads", async () => {
    const { client, requests, server } = createClientWithBootstrap();
    await client.replaceDatabase({
      characters: [{
        chaId: "character / 1",
        name: "Character",
        greeting: "Hello",
        chats: [{
          id: "chat / 1",
          name: "Chat",
          message: [{ chatId: "message-1", role: "user", data: "hello" }],
        }],
      }],
      botPresets: [],
    } as any);
    requests.splice(0);

    const character = await client.loadCharacter("character / 1");
    const page = await client.loadChatMessagePage("chat / 1", undefined, 999);

    expect(character).toMatchObject({ chaId: "character / 1", detailsLoaded: true, greeting: "Hello" });
    expect(page).toMatchObject({ messages: [{ chatId: "message-1" }], total: 1, hasMore: false });
    expect(requests).toEqual([
      "/api/sql/characters/character%20%2F%201",
      "/api/sql/chats/chat%20%2F%201/messages?limit=100",
    ]);
    expect(requests).not.toContain("/api/sql/snapshot");
    server.close();
  });

  it("requests a newest-40 chat page without a snapshot", async () => {
    const { client, requests, server } = createClientWithBootstrap();
    await client.replaceDatabase({
      characters: [{
        chaId: "character-1", name: "Character",
        chats: [{
          id: "chat-1", name: "Chat",
          message: Array.from({ length: 41 }, (_, index) => ({ chatId: `message-${index}`, role: "user", data: String(index) })),
        }],
      }],
      botPresets: [],
    } as any);
    requests.splice(0);

    const page = await client.loadChatMessageReversePage("chat-1", undefined, 40);

    expect(page.messages).toHaveLength(40);
    expect(requests).toEqual(["/api/sql/chats/chat-1/messages?limit=40"]);
    expect(requests).not.toContain("/api/sql/snapshot");
    server.close();
  });

  it("reads ancillary SQL data through bounded endpoints", async () => {
    const { client, requests, server } = createClientWithBootstrap();
    await client.replaceDatabase({
      characters: [{
        chaId: "character-1",
        name: "Alice",
        tags: ["fantasy"],
        chats: [{
          id: "chat-1",
          name: "Chat",
          message: [{ chatId: "message-1", role: "user", data: "hello bounded world" }],
        }],
      }],
      botPresets: [],
    } as any);
    await client.setChatDraft("draft / 1", { m: "draft", t: "translate" });
    await client.setColdStorageItem("cold / 1", { name: "Archived" });
    requests.splice(0);

    expect(await client.listChatDraftKeys()).toEqual(["draft / 1"]);
    expect(await client.getChatDraft("draft / 1")).toEqual({ m: "draft", t: "translate" });
    expect(await client.getChatDraft("missing")).toBeNull();
    expect(await client.listColdStorageItems()).toEqual({ items: ["cold / 1"] });
    expect(await client.getColdStorageItem("cold / 1")).toEqual({ name: "Archived" });
    expect(await client.getColdStorageItem("missing")).toBeNull();
    expect(await client.listRevisions(999)).not.toEqual([]);
    expect(await client.searchMessages("hello", "all", 999)).toEqual([
      expect.objectContaining({ chatId: "chat-1", messageId: "message-1" }),
    ]);
    expect(await client.searchCharactersByName("Ali", 999)).toEqual([
      expect.objectContaining({ id: "character-1", name: "Alice" }),
    ]);
    expect(await client.searchCharactersByTag("fantasy", 999)).toEqual([
      expect.objectContaining({ id: "character-1", name: "Alice" }),
    ]);
    expect(requests).toEqual([
      "/api/sql/chat-drafts?limit=100",
      "/api/sql/chat-drafts/draft%20%2F%201",
      "/api/sql/chat-drafts/missing",
      "/api/sql/cold-storage?limit=100",
      "/api/sql/cold-storage/cold%20%2F%201",
      "/api/sql/cold-storage/missing",
      "/api/sql/revisions?limit=100",
      "/api/sql/search/messages?query=hello&limit=50",
      "/api/sql/search/characters?mode=name&query=Ali&limit=100",
      "/api/sql/search/characters?mode=tag&query=fantasy&limit=100",
    ]);
    expect(requests).not.toContain("/api/sql/snapshot");
    server.close();
  });

  it("follows ancillary page cursors and rejects a non-progress cursor", async () => {
    const requests: string[] = [];
    const client = new NodeSqliteStorage(async (input) => {
      const path = String(input);
      requests.push(path);
      if (path === "/api/sql/chat-drafts?limit=100") {
        return Response.json({ keys: ["draft-a"], nextAfter: "draft-a", hasMore: true });
      }
      if (path === "/api/sql/chat-drafts?limit=100&after=draft-a") {
        return Response.json({ keys: ["draft-b"], nextAfter: null, hasMore: false });
      }
      if (path === "/api/sql/cold-storage?limit=100") {
        return Response.json({ items: ["cold-a"], nextAfter: "cold-a", hasMore: true });
      }
      if (path === "/api/sql/cold-storage?limit=100&after=cold-a") {
        return Response.json({ items: ["cold-b"], nextAfter: "cold-a", hasMore: true });
      }
      throw new Error(`Unexpected request: ${path}`);
    });

    expect(await client.listChatDraftKeys()).toEqual(["draft-a", "draft-b"]);
    await expect(client.listColdStorageItems()).rejects.toThrow(/cursor/i);
    expect(requests).toEqual([
      "/api/sql/chat-drafts?limit=100",
      "/api/sql/chat-drafts?limit=100&after=draft-a",
      "/api/sql/cold-storage?limit=100",
      "/api/sql/cold-storage?limit=100&after=cold-a",
    ]);
  });
});
