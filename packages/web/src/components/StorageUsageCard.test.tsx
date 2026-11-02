import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within, waitFor } from "@testing-library/react";
import { StorageUsageCard, encryptionStatusLine, type EnumerableStorage } from "./StorageUsageCard.js";
import { utf8Length } from "../lib/memory/storage.js";
import { resetMsgCacheState } from "../lib/e2eSession.js";

/** 可控桥：密文 = `enc:` + base64（状态判定只看外壳，不需要真解密）。 */
function installBridge(): void {
  (window as unknown as { __heming_secrets?: unknown }).__heming_secrets = {
    available: true,
    encrypt: (plain: string) => `enc:${Buffer.from(plain, "utf8").toString("base64")}`,
    decrypt: (data: string) =>
      data.startsWith("enc:") ? Buffer.from(data.slice(4), "base64").toString("utf8") : null,
  };
}

function uninstallBridge(): void {
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
}

/** 模拟浏览器抛的配额异常（构造带 name 的 Error，避免依赖 DOMException 全局）。 */
function quotaError(): Error {
  const e = new Error("quota exceeded");
  e.name = "QuotaExceededError";
  return e;
}

/**
 * 可枚举的假存储。
 *
 * 为什么不用 jsdom 的 localStorage：它没有配额概念，做不出「超 95%」这种读数；
 * 而且要在 setItem 上精确抛 `QuotaExceededError` 才能测配额探测的两条路径。
 */
class FakeStorage implements EnumerableStorage {
  private readonly map = new Map<string, string>();
  /** 已用字节数。 */
  used = 0;
  /** 配额上限（字节）：0 = 不限。 */
  quotaBytes = 0;
  /** 一律写不进去（模拟隐私模式 / 配额已满到探针都写不进）。 */
  alwaysFailWrite = false;
  /** 这些键的 getItem 会抛（模拟坏数据 / 读异常）。 */
  readonly brokenKeys = new Set<string>();
  /** getItem 调用次数：用来钉住「只读一次值」。 */
  getItemCalls = 0;

  get length(): number {
    return this.map.size;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  getItem(k: string): string | null {
    this.getItemCalls += 1;
    if (this.brokenKeys.has(k)) throw new Error("读取失败");
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    if (this.alwaysFailWrite) throw quotaError();
    const bytes = utf8Length(v);
    const prev = this.map.get(k);
    const prevBytes = prev == null ? 0 : utf8Length(prev);
    if (this.quotaBytes > 0 && this.used - prevBytes + bytes > this.quotaBytes) {
      throw quotaError();
    }
    this.used += bytes - prevBytes;
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    const prev = this.map.get(k);
    if (prev != null) this.used -= utf8Length(prev);
    this.map.delete(k);
  }
  /** 直接塞数据（绕过一次 getItem 计数：只 set 不读）。 */
  put(k: string, v: string): void {
    this.setItem(k, v);
  }
  has(k: string): boolean {
    return this.map.has(k);
  }
}

/** 卡片根节点。 */
function card(): HTMLElement {
  return screen.getByRole("region", { name: "本机存储" });
}

/**
 * 取叶子节点的文本（`children.length === 0` 的那些）。
 *
 * 为什么不用 `getByText`：模块行里「字节数」和外层 span 的 textContent 互相包含，
 * 正则匹配会一次命中好几个元素。叶子节点筛选后每个文本只对应一个元素。
 */
function leafTexts(re: RegExp): string[] {
  return Array.from(document.querySelectorAll("*"))
    .filter((el) => el.children.length === 0 && re.test(el.textContent ?? ""))
    .map((el) => el.textContent ?? "");
}

/** 模块名按显示顺序取出来（明细按字节数降序）。 */
function moduleNames(): string[] {
  return Array.from(card().querySelectorAll("ul li")).map(
    (li) => (li.querySelector("span")?.textContent ?? "").replace(/\d+ 键$/, "").trim(),
  );
}

/** 已用字节数（从水位条的 aria-valuetext 里取，最不容易被文案改动带偏）。 */
function usedBytesFromBar(): number {
  const bar = screen.getByRole("progressbar", { name: "本机存储用量" });
  const text = bar.getAttribute("aria-valuetext") ?? "";
  const m = /已用 ([\d,]+) 字节/.exec(text);
  return m ? Number(m[1].replace(/,/g, "")) : NaN;
}

describe("StorageUsageCard", () => {
  let storage: FakeStorage;

  beforeEach(() => {
    storage = new FakeStorage();
    uninstallBridge();
    resetMsgCacheState();
  });

  afterEach(() => {
    uninstallBridge();
    resetMsgCacheState();
  });

  it("渲染出用量条与模块明细", () => {
    storage.put("heming.msgCache.c1", "a".repeat(1000));
    storage.put("heming.tasks.v1", "b".repeat(2000));
    storage.put("heming.memory.semantic.v1", "c".repeat(3000));

    render(<StorageUsageCard storage={storage} />);

    const bar = screen.getByRole("progressbar", { name: "本机存储用量" });
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-valuenow", expect.stringMatching(/^\d+$/));

    // 明细按字节数降序：记忆(3000) → 任务(2000) → 消息缓存(1000)
    expect(moduleNames()).toEqual(["记忆", "任务", "消息缓存"]);
    // 具体数字要显示出来（不能只有条）
    expect(leafTexts(/3,000 字节/).length).toBeGreaterThan(0);
    expect(leafTexts(/已用/).join(" ")).toContain("6,000 字节");
  });

  it("默认用 5MB 保守估算值并标注「估算」", () => {
    storage.put("heming.tasks.v1", "x".repeat(1024));

    render(<StorageUsageCard storage={storage} />);

    const bar = screen.getByRole("progressbar", { name: "本机存储用量" });
    expect(bar.getAttribute("aria-valuetext")).toContain("配额 5,242,880 字节");
    expect(leafTexts(/配额 5\.00 MB/).length).toBeGreaterThan(0);
    expect(leafTexts(/估算/).length).toBeGreaterThan(0);
  });

  it("用量 ≥ 80% ⇒ 变黄并给提示", () => {
    // 5MB 配额的 80% = 4,194,304 字节，这里放 4,300,000（约 82%）
    storage.put("heming.msgCache.c1", "x".repeat(4_300_000));

    render(<StorageUsageCard storage={storage} />);

    const status = screen.getByRole("status", { name: "存储水位" });
    expect(status.textContent).toContain("本机存储已用掉八成以上");
    expect(status.className).toContain("text-[#b45309]");
    // 黄，不是红
    expect(status.className).not.toContain("text-[#b42318]");
  });

  it("用量 ≥ 95% ⇒ 变红并给提示", () => {
    // 5MB 配额的 95% = 4,980,736 字节，这里放 5,000,000（约 95.4%）
    storage.put("heming.msgCache.c1", "x".repeat(5_000_000));

    render(<StorageUsageCard storage={storage} />);

    const status = screen.getByRole("status", { name: "存储水位" });
    expect(status.textContent).toContain("本机存储快满了");
    expect(status.className).toContain("text-[#b42318]");
  });

  it("用量 < 80% ⇒ 正常态（不用红黄）", () => {
    storage.put("heming.tasks.v1", "x".repeat(1000));

    render(<StorageUsageCard storage={storage} />);

    const status = screen.getByRole("status", { name: "存储水位" });
    expect(status.textContent).toContain("本机存储还有余量");
    expect(status.className).toContain("text-muted");
    expect(status.className).not.toContain("text-[#b45309]");
    expect(status.className).not.toContain("text-[#b42318]");
  });

  it("统计只读键名与值各一次，不重复读", () => {
    storage.put("heming.msgCache.c1", "a".repeat(100));
    storage.put("heming.tasks.v1", "b".repeat(100));
    storage.put("heming.memory.working.v1", "c".repeat(100));

    render(<StorageUsageCard storage={storage} />);

    // 3 个键 ⇒ 3 次 getItem（不是每键读两遍，更不是反复读）
    expect(storage.getItemCalls).toBe(3);
  });

  it("坏数据（值是垃圾 / 超长 / 读取抛错）⇒ 统计不抛", () => {
    storage.put("heming.msgCache.c1", "这不是 JSON，是垃圾");
    storage.put("heming.tasks.v1", "x".repeat(2_000_000));
    storage.put("heming.other.v1", "y");
    storage.brokenKeys.add("heming.broken.v1");
    storage.put("heming.broken.v1", "z");

    expect(() => render(<StorageUsageCard storage={storage} />)).not.toThrow();

    expect(screen.getByRole("progressbar", { name: "本机存储用量" })).toBeInTheDocument();
    expect(moduleNames()).toContain("消息缓存");
    expect(moduleNames()).toContain("其它");
  });

  it("清理消息缓存：先弹确认框，确认后才删键并刷新数字", () => {
    storage.put("heming.msgCache.c1", "a".repeat(1000));
    storage.put("heming.msgCache.c2", "a".repeat(1000));
    storage.put("heming.tasks.v1", "b".repeat(2000));

    render(<StorageUsageCard storage={storage} />);
    const before = usedBytesFromBar();

    fireEvent.click(screen.getByRole("button", { name: "清理消息缓存" }));

    // 确认框先出来，此时一个键都还没删
    const dialog = screen.getByRole("dialog", { name: "清理消息缓存" });
    expect(dialog).toBeInTheDocument();
    expect(storage.has("heming.msgCache.c1")).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "清理" }));

    expect(storage.has("heming.msgCache.c1")).toBe(false);
    expect(storage.has("heming.msgCache.c2")).toBe(false);
    // 界面数字更新
    expect(usedBytesFromBar()).toBeLessThan(before);
    expect(usedBytesFromBar()).toBe(2000);
    expect(moduleNames()).not.toContain("消息缓存");
  });

  it("清理消息缓存：取消确认框则不删任何键", () => {
    storage.put("heming.msgCache.c1", "a".repeat(1000));

    render(<StorageUsageCard storage={storage} />);
    fireEvent.click(screen.getByRole("button", { name: "清理消息缓存" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "清理消息缓存" })).getByRole("button", {
        name: "取消",
      }),
    );

    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(storage.has("heming.msgCache.c1")).toBe(true);
  });

  it("清理任务记录：删掉 heming.tasks.v1，其它键不动", () => {
    storage.put("heming.tasks.v1", "b".repeat(2000));
    storage.put("heming.taskTemplates.v1", "c".repeat(500));
    storage.put("heming.msgCache.c1", "a".repeat(1000));

    render(<StorageUsageCard storage={storage} />);

    fireEvent.click(screen.getByRole("button", { name: "清理任务记录" }));
    const dialog = screen.getByRole("dialog", { name: "清理任务记录" });
    expect(storage.has("heming.tasks.v1")).toBe(true);

    fireEvent.click(within(dialog).getByRole("button", { name: "清理" }));

    expect(storage.has("heming.tasks.v1")).toBe(false);
    // 模板不是任务流水，不该跟着删
    expect(storage.has("heming.taskTemplates.v1")).toBe(true);
    expect(usedBytesFromBar()).toBe(1500);
  });

  it("不可再生的键（记忆、E2E 私钥与棘轮）清理后仍在", () => {
    storage.put("heming.memory.semantic.v1", "c".repeat(3000));
    storage.put("heming.memory.working.v1", "d".repeat(2000));
    storage.put("heming.e2e.identity", "e".repeat(1000));
    storage.put("heming.x3dh.v1", "f".repeat(800));
    storage.put("heming.msgCache.c1", "a".repeat(1000));
    storage.put("heming.tasks.v1", "b".repeat(2000));

    render(<StorageUsageCard storage={storage} />);

    fireEvent.click(screen.getByRole("button", { name: "清理消息缓存" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "清理消息缓存" })).getByRole("button", {
        name: "清理",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "清理任务记录" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "清理任务记录" })).getByRole("button", {
        name: "清理",
      }),
    );

    // 用户资产与密钥：一次都不能少
    expect(storage.has("heming.memory.semantic.v1")).toBe(true);
    expect(storage.has("heming.memory.working.v1")).toBe(true);
    expect(storage.has("heming.e2e.identity")).toBe(true);
    expect(storage.has("heming.x3dh.v1")).toBe(true);
    // 可再生的两个确实没了
    expect(storage.has("heming.msgCache.c1")).toBe(false);
    expect(storage.has("heming.tasks.v1")).toBe(false);
  });

  it("界面上说明为什么记忆与私钥不给清理入口", () => {
    render(<StorageUsageCard storage={storage} />);

    expect(document.body.textContent).toContain("不可再生");
    expect(document.body.textContent).toContain("私钥");
    // 只有两个清理按钮
    expect(screen.getByRole("button", { name: "清理消息缓存" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "清理任务记录" })).toBeInTheDocument();
  });

  it("重新检测：实测配额，探针临时键写完即删", async () => {
    storage.put("heming.tasks.v1", "b".repeat(1000));
    storage.quotaBytes = 200_000; // 只放得下 3 个 64KB 块

    render(<StorageUsageCard storage={storage} />);
    const keysBefore = storage.length;

    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));

    // 实测值：3 块 × 64KB + 已用 1000 = 197,608 字节 = 193.0 KB
    // 等**最终态**文案「配额已实测」，不能等 /实测/：卡片底部的说明文案
    // 「…临时写入最多约 32MB 以实测配额…」是常驻静态文本，永远命中 /实测/，
    // 会让 waitFor 在探测完成前就放行，后续断言随机拿到空串（jsdom 30 变慢后暴露）。
    await waitFor(() => expect(leafTexts(/配额已实测/).length).toBeGreaterThan(0));
    expect(leafTexts(/配额已实测/).join(" ")).toContain("193.0 KB");
    expect(leafTexts(/配额已实测/).join(" ")).toContain("197,608 字节");
    // 探针键没留下
    expect(storage.length).toBe(keysBefore);
  });

  it("重新检测：先渲染「检测中…」再探测（阻塞的探测不再吞掉中间态）", async () => {
    storage.put("heming.tasks.v1", "b".repeat(1000));
    storage.quotaBytes = 200_000;

    render(<StorageUsageCard storage={storage} />);
    fireEvent.click(screen.getByRole("button", { name: "重新检测" }));

    // 探测被推迟到下一轮事件循环：此刻按钮必须已经显示进行态
    const busy = screen.getByRole("button", { name: "检测中…" });
    expect(busy).toBeDisabled();

    await waitFor(() => expect(leafTexts(/配额已实测/).length).toBeGreaterThan(0));
    expect(screen.getByRole("button", { name: "重新检测" })).toBeEnabled();
  });

  it("重新检测：写不进去（隐私模式）⇒ 回落到估算值且不抛", async () => {
    storage.put("heming.tasks.v1", "b".repeat(1000));
    storage.alwaysFailWrite = true;

    render(<StorageUsageCard storage={storage} />);

    expect(() => fireEvent.click(screen.getByRole("button", { name: "重新检测" }))).not.toThrow();
    await waitFor(() => expect(leafTexts(/实测失败/).join(" ")).toContain("5.00 MB"));
    expect(leafTexts(/估算/).length).toBeGreaterThan(0);
  });

  it("重新检测按钮旁写明会临时写入数据", () => {
    render(<StorageUsageCard storage={storage} />);

    expect(document.body.textContent).toContain("临时写入");
  });

  it("清理说明如实写清可恢复边界（B1）：只有窗口内近期消息能重新解密", () => {
    storage.put("heming.msgCache.c1", "a".repeat(1000));
    render(<StorageUsageCard storage={storage} />);

    fireEvent.click(screen.getByRole("button", { name: "清理消息缓存" }));
    const dialog = screen.getByRole("dialog", { name: "清理消息缓存" });
    const text = dialog.textContent ?? "";
    expect(text).toContain("窗口内");
    expect(text).toContain("无法解密"); // 「更早的消息会永久显示为无法解密」
    expect(text).toContain("不可再生"); // 自己发出的消息不可再生
    // 旧口径「重新拉取并解密即可恢复」是错的，不能再出现
    expect(text).not.toContain("重新拉取并解密即可恢复");
  });

  it("迁移期备份键不在清理入口里：主键删掉、备份原样留下", () => {
    storage.put("heming.msgCache.c1", "a".repeat(1000));
    storage.put("heming.msgCache.c1.__heming_plaintext_backup", "b".repeat(500));
    storage.put("heming.msgCache.c2.__heming_undecryptable", "c".repeat(400));

    render(<StorageUsageCard storage={storage} />);
    fireEvent.click(screen.getByRole("button", { name: "清理消息缓存" }));
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "清理消息缓存" })).getByRole("button", { name: "清理" }),
    );

    expect(storage.has("heming.msgCache.c1")).toBe(false); // 可再生主键被清
    expect(storage.has("heming.msgCache.c1.__heming_plaintext_backup")).toBe(true); // 备份留着
    expect(storage.has("heming.msgCache.c2.__heming_undecryptable")).toBe(true);
    // 备份仍计入「消息缓存」组（它们确实占字节）
    expect(moduleNames()).toContain("消息缓存");
    expect(document.body.textContent).toContain("备份");
  });

  it("加密状态标注：磁盘是密文容器且桥可用 ⇒ 显示「已加密」", () => {
    installBridge();
    storage.put(
      "heming.msgCache.c1",
      JSON.stringify({ __hemingMsgCache: "v2", items: [{ id: "m-1", d: "cipher" }] }),
    );

    render(<StorageUsageCard storage={storage} />);

    const status = screen.getByRole("status", { name: "消息缓存加密状态" });
    expect(status.textContent).toContain("消息缓存已加密");
    expect(status.textContent).not.toContain("未加密");
  });

  it("加密状态标注：浏览器无桥且磁盘是明文 ⇒ 如实说「未加密」+原因", () => {
    storage.put(
      "heming.msgCache.c1",
      JSON.stringify([{ id: "m-1", senderId: "u", at: 1, plain: { kind: "text", text: "明文" } }]),
    );

    render(<StorageUsageCard storage={storage} />);

    const status = screen.getByRole("status", { name: "消息缓存加密状态" });
    expect(status.textContent).toContain("未加密");
    expect(status.textContent).toContain("浏览器端没有可用的系统安全存储");
  });

  it("加密状态标注：密文外壳但本机解不开 ⇒ 说「无法解密」而不是「未加密」", () => {
    storage.put("heming.msgCache.c1", "{ 这不是容器也不是明文数组");

    render(<StorageUsageCard storage={storage} />);

    const status = screen.getByRole("status", { name: "消息缓存加密状态" });
    expect(status.textContent).toContain("无法解密");
    expect(status.textContent).not.toContain("未加密");
  });

  it("加密状态文案：配额不足时按 Q2 明说「为保住消息，本次以明文保存」", () => {
    const line = encryptionStatusLine([
      {
        convId: "c1",
        state: {
          desktop: true,
          available: true,
          form: "plaintext",
          encrypted: false,
          reason: "quota",
        },
      },
    ]);
    expect(line?.text).toContain("未加密");
    expect(line?.text).toContain("配额不足");
    expect(line?.text).toContain("为保住消息，本次以明文保存");
  });
});
