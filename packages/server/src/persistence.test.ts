import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "./index.js";

describe("SQLite 持久化", () => {
  it("重启后用户、智能体会话与消息仍在，系统助手已登记", async () => {
    const dir = mkdtempSync(join(tmpdir(), "heming-persist-"));
    const dbPath = join(dir, "p.db");
    try {
      const ctx1 = await startServer(0, "127.0.0.1", dbPath);
      const a = ctx1.store.createUser("alice", "hash-x", "爱丽丝");
      const agent = ctx1.store.createAgent(a.id, { name: "助手", description: "" });
      const conv = ctx1.store.createAgentConversation(a.id, agent.id);
      ctx1.store.addMessage(conv.id, "user", a.id, { text: "重启后我要还在" });
      await ctx1.close();

      const ctx2 = await startServer(0, "127.0.0.1", dbPath);
      expect(ctx2.store.findUserByUsername("alice")?.user.displayName).toBe("爱丽丝");
      expect(ctx2.store.listAgents().some((x) => x.id === "system-assistant")).toBe(true);
      const convs = ctx2.store.listConversations(a.id);
      const msgs = ctx2.store.listMessages(convs[0].id);
      expect(msgs.map((m) => m.payload.text)).toContain("重启后我要还在");
      await ctx2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
