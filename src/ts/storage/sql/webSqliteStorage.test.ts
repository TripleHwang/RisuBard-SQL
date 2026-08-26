import { describe, expect, it, vi } from "vitest";

import { createEmptySqlCommit } from "./sqlCommit";
import { WebSqliteStorage } from "./webSqliteStorage";

describe("WebSqliteStorage", () => {
  it("adopts the database revision when a commit conflicts", async () => {
    const storage = Object.create(WebSqliteStorage.prototype) as unknown as {
      _enabled: boolean;
      revision: number;
      run: ReturnType<typeof vi.fn>;
      selectOne: ReturnType<typeof vi.fn>;
    };
    storage._enabled = true;
    storage.revision = 2;
    storage.run = vi.fn();
    storage.selectOne = vi.fn(() => ({ revision: 7 }));

    await expect(
      WebSqliteStorage.prototype.commit.call(
        storage as unknown as WebSqliteStorage,
        createEmptySqlCommit(2),
      ),
    ).rejects.toMatchObject({
      name: "SqlRevisionConflictError",
      currentRevision: 7,
    });

    expect(
      WebSqliteStorage.prototype.getRevision.call(
        storage as unknown as WebSqliteStorage,
      ),
    ).toBe(7);
    expect(storage.run).toHaveBeenCalledWith("ROLLBACK");
  });
});
