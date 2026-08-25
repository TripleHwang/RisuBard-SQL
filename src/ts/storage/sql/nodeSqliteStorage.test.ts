import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { NodeSqliteStorage } from "./nodeSqliteStorage";

const { createRelationalSqlite } = require("../../../../server/node/relational-sqlite.cjs");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function createClient() {
  const root = mkdtempSync(join(tmpdir(), "risu-node-sql-client-"));
  roots.push(root);
  const server = createRelationalSqlite({ dataRoot: root });
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
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

describe("Node server SQLite client", () => {
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
    const loaded = (await client.loadDatabase())?.database as any;
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
});
