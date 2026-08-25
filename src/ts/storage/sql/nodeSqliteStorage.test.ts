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
      botPresets: [{ id: "preset-1", name: "Default" }],
      botPresetsId: 0,
      characters: [{
        chaId: "character-1",
        name: "Character",
        chats: [{
          id: "chat-1",
          name: "Chat",
          message: [{ chatId: "message-1", role: "user", data: "hello" }],
        }],
      }],
    } as any;

    expect((await client.loadDatabase())?.status).toBe("empty");
    expect(await client.replaceDatabase(source)).toBe(true);
    expect((await client.loadDatabase())?.database).toMatchObject(source);
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
