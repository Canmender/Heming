import { beforeEach, describe, expect, it } from "vitest";
import { createMemoryStorage } from "../memory/storage.js";
import type { StorageLike } from "../memory/types.js";
import { MAX_PROMPT_CHARS } from "./store.js";
import {
  MAX_TEMPLATES,
  TASK_TEMPLATES_KEY,
  normalizeTemplate,
  pruneTemplates,
  readTemplates,
  setTemplateStorage,
  suggestTemplateName,
  useTemplateStore,
  type TaskTemplate,
} from "./templates.js";

let storage: StorageLike;

beforeEach(() => {
  storage = createMemoryStorage();
  setTemplateStorage(storage);
  useTemplateStore.setState({ templates: [] });
});

function makeTemplate(overrides: Partial<TaskTemplate> = {}): TaskTemplate {
  const now = 1_700_000_000_000;
  return {
    id: `tpl-${Math.random().toString(36).slice(2, 8)}`,
    name: "模块依赖梳理",
    prompt: "梳理模块依赖并给出拆分建议",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("suggestTemplateName / normalizeTemplate", () => {
  it("取首个非空行压平后当默认名", () => {
    expect(suggestTemplateName("  第一行  \n第二行")).toBe("第一行");
    expect(suggestTemplateName("\n  \n")).toBe("未命名模板");
  });

  it("名称超过 40 字按码点截断", () => {
    expect([...suggestTemplateName("名".repeat(60))]).toHaveLength(40);
  });

  it("缺名 / 缺正文 / 非对象一律丢弃", () => {
    expect(normalizeTemplate(null)).toBeNull();
    expect(normalizeTemplate({ id: "a", name: "", prompt: "x" })).toBeNull();
    expect(normalizeTemplate({ id: "a", name: "n", prompt: "   " })).toBeNull();
    expect(normalizeTemplate({ name: "n", prompt: "x" })).toBeNull();
  });

  it("正文超长截断、时间戳缺失时补当前时间", () => {
    const t = normalizeTemplate({ id: "a", name: "n", prompt: "字".repeat(MAX_PROMPT_CHARS + 10) });
    expect(t).not.toBeNull();
    expect([...(t?.prompt ?? "")]).toHaveLength(MAX_PROMPT_CHARS);
    expect(typeof t?.createdAt).toBe("number");
  });
});

describe("pruneTemplates / readTemplates", () => {
  it("超过条数上限淘汰最旧", () => {
    const list = Array.from({ length: MAX_TEMPLATES + 5 }, (_, i) =>
      makeTemplate({ createdAt: 1_000 + i }),
    );
    const pruned = pruneTemplates(list);
    expect(pruned).toHaveLength(MAX_TEMPLATES);
    // createdAt 最大的留在最前
    expect(pruned[0].createdAt).toBe(1_000 + MAX_TEMPLATES + 4);
  });

  it("缺键回退空数组，损坏 JSON 同样回退空", () => {
    expect(readTemplates(storage)).toEqual([]);
    storage.setItem(TASK_TEMPLATES_KEY, "{ not json");
    expect(readTemplates(storage)).toEqual([]);
  });

  it("数组里混入坏条目时只丢坏条目", () => {
    storage.setItem(
      TASK_TEMPLATES_KEY,
      JSON.stringify([makeTemplate({ name: "好" }), { id: "x" }, "垃圾"]),
    );
    const list = readTemplates(storage);
    expect(list.map((t) => t.name)).toEqual(["好"]);
  });
});

describe("useTemplateStore", () => {
  it("保存后落盘并按创建时间倒序，空名 / 空正文 / 重名被拒", () => {
    const ok = useTemplateStore.getState().save({ name: "周报", prompt: "汇总本周改动" });
    expect(ok.ok).toBe(true);
    expect(readTemplates(storage).map((t) => t.name)).toEqual(["周报"]);

    expect(useTemplateStore.getState().save({ name: "  ", prompt: "x" })).toEqual({
      ok: false,
      error: "模板名称不能为空",
    });
    expect(useTemplateStore.getState().save({ name: "n", prompt: "  \n " }).ok).toBe(false);
    const dup = useTemplateStore.getState().save({ name: "周报", prompt: "另一段正文" });
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toContain("周报");
  });

  it("名称里换行被压平，重名判定看压平后的名字", () => {
    useTemplateStore.getState().save({ name: "依赖 梳理", prompt: "A" });
    const dup = useTemplateStore.getState().save({ name: "依赖\n梳理", prompt: "B" });
    expect(dup.ok).toBe(false);
  });

  it("正文超过上限时拒绝而不是静默截断（模板要原样可复用）", () => {
    const result = useTemplateStore.getState().save({
      name: "n",
      prompt: "字".repeat(MAX_PROMPT_CHARS + 1),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(String(MAX_PROMPT_CHARS));
  });

  it("满 12 条后保存会淘汰最旧一条", () => {
    useTemplateStore.setState({
      templates: Array.from({ length: MAX_TEMPLATES }, (_, i) =>
        makeTemplate({ name: `T${i}`, createdAt: 1_000 + i }),
      ),
    });
    const saved = useTemplateStore.getState().save({ name: "最新", prompt: "P" });
    expect(saved.ok).toBe(true);
    const list = useTemplateStore.getState().templates;
    expect(list).toHaveLength(MAX_TEMPLATES);
    expect(list.some((t) => t.name === "最新")).toBe(true);
    // createdAt=1000 是最旧的那条，被淘汰
    expect(list.some((t) => t.createdAt === 1_000)).toBe(false);
  });

  it("删除只摘掉指定 id，未知 id 不改动状态", () => {
    const saved = useTemplateStore.getState().save({ name: "删除我", prompt: "P" });
    if (!saved.ok) throw new Error("save failed");
    useTemplateStore.getState().remove("nope");
    expect(useTemplateStore.getState().templates).toHaveLength(1);
    useTemplateStore.getState().remove(saved.template.id);
    expect(useTemplateStore.getState().templates).toEqual([]);
    expect(readTemplates(storage)).toEqual([]);
  });
});
