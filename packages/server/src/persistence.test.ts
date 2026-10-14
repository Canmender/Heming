import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index.js";

describe("SQLite 持久化", () => {
  it("重启后用户与消息仍在", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heming-persist-"));
    const dbPath = join(dir, "p.db");
    try {
      const ctx1 = await startServer(0, "127.0.0.1", dbPath);
      ctx1.store.createUser("alice", "hash-x", "爱丽丝");
      const a = ctx1.store.findUserByUsername("alice")!.user;
      ctx1.store.createUser("bob", "hash-y", "鲍勃");
      const b = ctx1.store.findUserByUsername("bob")!.user;
      ctx1.store.acceptFriendRequest(ctx1.store.createFriendRequest(a.id, "bob").id, b.id);
      const conv = ctx1.store.createDirectConversation(a.id, b.id);
      ctx1.store.addMessage(conv.id, "user", a.id, { text: "重启后我要还在" }, null);
      await ctx1.close();

      const ctx2 = await startServer(0, "127.0.0.1", dbPath);
      expect(ctx2.store.findUserByUsername("alice")?.user.displayName).toBe("爱丽丝");
      const convs = ctx2.store.listConversations(ctx2.store.findUserByUsername("alice")!.user.id);
      const msgs = ctx2.store.listMessages(convs[0].id);
      expect(msgs.map((m) => m.payload.text)).toContain("重启后我要还在");
      await ctx2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
