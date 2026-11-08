import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type {
  SkillHubDetail,
  SkillHubDownload,
  SkillHubPage,
  SkillHubStatus,
} from "@heming/shared";
import { SkillPool, type StorageLike } from "../../lib/skills/index.js";
import { useUiStore } from "../../store/ui.js";
import { HUB_KEY_STORAGE_KEY } from "../../lib/skills/hubClient.js";
import { SkillHubPanel } from "./SkillHubPanel.js";

/**
 * 技能社区面板（d.109）：列表/搜索/分类/空态/失败重试/Key 引导/安装预览与确认/
 * 已装与更新徽标/社区未启用。服务端契约全部用注入 fetch 模拟。
 */

const SHA = "a".repeat(64);
const BASE = "https://hub.test";

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: (key) => void map.delete(key),
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const STATUS: SkillHubStatus = {
  enabled: true,
  source: {
    id: "xiaping",
    name: "虾评",
    homepage: "https://xiaping.coze.com",
    docsUrl: "https://xiaping.coze.com/skill.md",
  },
  reachable: true,
  categories: ["写作", "效率"],
};

const SKILL = {
  id: "xp-1",
  name: "周报助手",
  description: "按本周数据生成周报",
  triggers: ["周报"],
  categories: ["写作"],
  tags: ["官方"],
  ownerName: "虾评",
  version: "1.2.0",
  downloads: 1200,
  stars: 45,
  status: "official",
  requiresApiKey: false,
  featured: true,
  updatedAt: "2026-11-08T00:00:00.000Z",
};

const SKILL_TRIAL = {
  ...SKILL,
  id: "xp-2",
  name: "试用技能",
  status: "trial",
  requiresApiKey: true,
  version: "0.1.0",
  downloads: 3,
  stars: 0,
};

const PAGE: SkillHubPage = {
  skills: [SKILL, SKILL_TRIAL],
  total: 2,
  hasMore: false,
  fetchedAt: "2026-11-08T00:00:00.000Z",
};

const DETAIL: SkillHubDetail = {
  ...SKILL,
  createdAt: "2026-11-01T00:00:00.000Z",
  versionCount: 3,
  securityStatus: "safe",
  securityReport: "# 安全报告\n\n未发现脚本。",
  homepage: "https://xiaping.coze.com/skills/xp-1",
};

const DOWNLOAD: SkillHubDownload = {
  skillId: "xp-1",
  name: "周报助手",
  version: "1.2.0",
  skillMd:
    "---\nname: 周报助手\ndescription: 按本周数据生成周报\nversion: 1.2.0\ntriggers: [周报]\ntags: [官方]\n---\n汇总本周任务与日程，输出进展、风险、下周计划。",
  files: [],
  zipSha256: SHA,
  size: 1024,
};

interface Routes {
  status?: unknown | (() => Promise<Response>);
  page?: unknown | (() => Promise<Response>);
  detail?: unknown | (() => Promise<Response>);
  download?: unknown | (() => Promise<Response>);
  register?: unknown | (() => Promise<Response>);
  downloadFor?: (url: string) => Promise<Response>;
}

function makeFetch(routes: Routes = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const resolve = async (
    value: unknown | (() => Promise<Response>) | undefined,
    fallback: unknown,
  ): Promise<Response> =>
    typeof value === "function" ? (value as () => Promise<Response>)() : jsonResponse(value ?? fallback);
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url.includes("/register")) return resolve(routes.register, { apiKey: "xp-key-register-1", name: "snake" });
    if (url.includes("/download")) {
      if (routes.downloadFor) return routes.downloadFor(url);
      return resolve(routes.download, DOWNLOAD);
    }
    if (url.includes("/skills/")) return resolve(routes.detail, DETAIL);
    if (url.includes("/skills")) return resolve(routes.page, PAGE);
    if (url.endsWith("/api/skill-hub")) return resolve(routes.status, STATUS);
    return jsonResponse({ error: "not found" }, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function renderPanel(routes: Routes = {}, pool?: SkillPool) {
  const skills = pool ?? new SkillPool(memoryStorage());
  const { fetchImpl, calls } = makeFetch(routes);
  const onInstalled = vi.fn();
  const onGoAssign = vi.fn();
  const utils = render(
    <SkillHubPanel
      skills={skills}
      deps={{ fetchImpl, baseUrl: BASE }}
      onInstalled={onInstalled}
      onGoAssign={onGoAssign}
    />,
  );
  return { ...utils, skills, calls, onInstalled, onGoAssign };
}

beforeEach(() => {
  useUiStore.setState({ page: "home", pageView: null });
  localStorage.clear();
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
});
afterEach(() => {
  localStorage.clear();
  delete (window as unknown as { __heming_secrets?: unknown }).__heming_secrets;
  vi.restoreAllMocks();
});

describe("SkillHubPanel · 列表与筛选", () => {
  it("渲染卡片：名称/作者/下载/收藏/official|trial/需自备 Key", async () => {
    renderPanel();
    expect(await screen.findByText("周报助手")).toBeInTheDocument();
    expect(screen.getByText("试用技能")).toBeInTheDocument();
    expect(screen.getByText("官方")).toBeInTheDocument();
    expect(screen.getByText("试用")).toBeInTheDocument();
    expect(screen.getByText("需自备 Key")).toBeInTheDocument();
    expect(screen.getAllByText(/虾评/).length).toBeGreaterThan(0);
    expect(screen.getByText(/下载 1\.2k|下载 1200/)).toBeInTheDocument();
    expect(screen.getByText("共 2 个技能")).toBeInTheDocument();
  });

  it("搜索（250ms 防抖）与分类筛选改写请求参数", async () => {
    const { calls } = renderPanel();
    await screen.findByText("周报助手");

    fireEvent.change(screen.getByLabelText("搜索社区技能"), { target: { value: "周报" } });
    await waitFor(
      () => {
        expect(calls.some((call) => call.url.includes("search=%E5%91%A8%E6%8A%A5"))).toBe(true);
      },
      { timeout: 1500 },
    );

    fireEvent.click(screen.getByRole("button", { name: "写作" }));
    await waitFor(() => {
      expect(calls.some((call) => call.url.includes("category=%E5%86%99%E4%BD%9C"))).toBe(true);
    });
    fireEvent.click(screen.getByRole("button", { name: "全部分类" }));
  });

  it("空态与失败重试", async () => {
    const empty = renderPanel({ page: { skills: [], total: 0, hasMore: false, fetchedAt: "" } });
    expect(await screen.findByText("社区里还没有技能")).toBeInTheDocument();
    empty.unmount();

    let failed = false;
    const retry = renderPanel({
      page: async () => {
        if (!failed) {
          failed = true;
          return jsonResponse({ error: "boom" }, 500);
        }
        return jsonResponse(PAGE);
      },
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("社区技能列表加载失败");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("周报助手")).toBeInTheDocument();
    expect(retry.calls.length).toBeGreaterThan(1);
  });

  it("社区未启用：显示「社区未启用」并给原因", async () => {
    renderPanel({ status: { ...STATUS, enabled: false, categories: [] } });
    expect(await screen.findByText("社区未启用")).toBeInTheDocument();
    expect(screen.getByText(/服务端没有开启技能社区/)).toBeInTheDocument();
    expect(screen.queryByLabelText("搜索社区技能")).toBeNull();
  });

  it("已安装/有新版本徽标按 community.skillId + version 匹配", async () => {
    const storage = memoryStorage();
    const pool = new SkillPool(storage);
    pool.create({
      name: "周报助手",
      description: "旧版",
      instructions: "旧版内容",
      triggers: ["周报"],
      tags: [],
      enabled: true,
      version: "1.0.0",
      source: "imported",
      community: {
        source: "xiaping",
        skillId: "xp-1",
        name: "周报助手",
        author: "虾评",
        version: "1.0.0",
        installedAt: "2026-11-01T00:00:00.000Z",
      },
    });
    renderPanel({}, pool);
    expect(await screen.findByText("已安装")).toBeInTheDocument();
    expect(screen.getByText("有新版本")).toBeInTheDocument();
  });
});


  it("恶意 homepage 不渲染链接：仅 http(s) 通过（详情 + 来源外链）", async () => {
    const bad = renderPanel({
      detail: { ...DETAIL, homepage: "javascript:alert(1)" },
    });
    fireEvent.click(await bad.findByRole("button", { name: "查看 周报助手 详情" }));
    const dialog = await bad.findByRole("dialog", { name: "社区技能 周报助手" });
    expect(within(dialog).queryByRole("link", { name: "在社区查看原文" })).toBeNull();
    bad.unmount();

    const badSource = renderPanel({
      status: {
        ...STATUS,
        source: {
          ...STATUS.source,
          homepage: "data:text/html,<script>alert(1)</script>",
          docsUrl: " javascript:alert(1)",
        },
      },
    });
    await badSource.findByText("周报助手");
    fireEvent.click(badSource.getByRole("button", { name: "社区 Key" }));
    const keyDialog = await badSource.findByRole("dialog", { name: "社区 Key" });
    expect(within(keyDialog).queryByRole("link", { name: /去虾评注册/ })).toBeNull();
    expect(within(keyDialog).queryByRole("link", { name: "接入说明" })).toBeNull();
    badSource.unmount();

    const good = renderPanel();
    fireEvent.click(await good.findByRole("button", { name: "查看 周报助手 详情" }));
    const goodDialog = await good.findByRole("dialog", { name: "社区技能 周报助手" });
    expect(within(goodDialog).getByRole("link", { name: "在社区查看原文" })).toHaveAttribute(
      "href",
      "https://xiaping.coze.com/skills/xp-1",
    );
  });

describe("SkillHubPanel · 详情", () => {
  it("详情展示安全结论与可折叠报告；无结论时如实写「上游未提供」", async () => {
    const first = renderPanel();
    fireEvent.click(await screen.findByRole("button", { name: "查看 周报助手 详情" }));
    const dialog = await screen.findByRole("dialog", { name: "社区技能 周报助手" });
    expect(await within(dialog).findByText(/上游安全结论/)).toHaveTextContent("safe");
    fireEvent.click(within(dialog).getByText("查看安全报告"));
    expect(within(dialog).getByText("安全报告")).toBeInTheDocument();

    first.unmount();
    const second = renderPanel({
      detail: { ...DETAIL, securityStatus: undefined, securityReport: undefined },
    });
    fireEvent.click(await second.findByRole("button", { name: "查看 周报助手 详情" }));
    const dialog2 = await second.findByRole("dialog", { name: "社区技能 周报助手" });
    expect(await within(dialog2).findByText(/上游未提供安全检测结论/)).toBeInTheDocument();
  });
});


describe("社区元信息落盘容错", () => {
  it("重读保留 community；坏 community 丢弃但不丢整条技能", () => {
    const storage = memoryStorage();
    const pool = new SkillPool(storage);
    pool.create({
      name: "社区技能",
      description: "",
      instructions: "内容",
      triggers: [],
      tags: [],
      enabled: true,
      version: "1.0.0",
      source: "imported",
      community: {
        source: "xiaping",
        skillId: "xp-9",
        name: "社区技能",
        author: "虾评",
        version: "1.0.0",
        installedAt: "2026-11-08T00:00:00.000Z",
      },
    });
    const reloaded = new SkillPool(storage).list().find((item) => item.name === "社区技能");
    expect(reloaded?.community?.skillId).toBe("xp-9");

    // 手工写入老技能（无 community）与坏 community：都不能影响整条读取
    const raw = JSON.parse(storage.map.get("heming.skills.v1") as string) as { skills: unknown[] };
    const base = {
      description: "",
      instructions: "内容",
      triggers: [],
      tags: [],
      enabled: true,
      builtin: false,
      version: "1.0.0",
      source: "user",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    };
    raw.skills.push({ ...base, id: "old-1", name: "老技能" });
    raw.skills.push({ ...base, id: "bad-1", name: "坏社区技能", community: { source: 1 } });
    storage.setItem("heming.skills.v1", JSON.stringify(raw));

    const list = new SkillPool(storage).list();
    expect(list.find((item) => item.id === "old-1")).toBeTruthy();
    expect(list.find((item) => item.id === "bad-1")?.community).toBeUndefined();
  });
});


describe("SkillHubPanel · 社区更新聚合（d.110）", () => {
  function addCommunitySkill(pool: SkillPool, name: string, version: string, skillId: string) {
    return pool.create({
      name,
      description: "社区技能",
      instructions: "内容",
      triggers: [],
      tags: [],
      enabled: true,
      version,
      source: "imported",
      community: {
        source: "xiaping",
        skillId,
        name,
        author: "虾评",
        version,
        installedAt: "2026-11-01T00:00:00.000Z",
      },
    });
  }

  const md = (name: string, version = "1.2.0") =>
    `---\nname: ${name}\nversion: ${version}\n---\n技能内容。`;

  it("聚合条：已装 N 个社区技能 · M 个可更新；M>0 给「全部更新」", async () => {
    const pool = new SkillPool(memoryStorage());
    addCommunitySkill(pool, "周报助手", "1.0.0", "xp-1");
    addCommunitySkill(pool, "试用技能", "1.0.0", "xp-2");
    renderPanel({}, pool);
    expect(await screen.findByText("已装 2 个社区技能 · 2 个可更新")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "全部更新" })).toBeInTheDocument();
  });


  it("全部更新：确认框列出名称/本地→远程/作者；取消不写本地", async () => {
    localStorage.setItem(HUB_KEY_STORAGE_KEY, JSON.stringify({ key: "bulk-key" }));
    const pool = new SkillPool(memoryStorage());
    addCommunitySkill(pool, "周报助手", "1.0.0", "xp-1");
    const page = {
      skills: [{ ...SKILL, version: "1.2.0" }],
      total: 1,
      hasMore: false,
      fetchedAt: "2026-11-08T00:00:00.000Z",
    };
    renderPanel({ page }, pool);
    expect(await screen.findByText("已装 1 个社区技能 · 1 个可更新")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部更新" }));
    const dialog = await screen.findByRole("dialog", { name: "批量更新社区技能" });
    expect(dialog).toHaveTextContent("周报助手");
    expect(dialog).toHaveTextContent("v1.0.0 → v1.2.0");
    expect(dialog).toHaveTextContent("虾评");
    fireEvent.click(within(dialog).getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog", { name: "批量更新社区技能" })).toBeNull();
    expect(
      pool.list().find((skill) => skill.community?.skillId === "xp-1")?.community?.version,
    ).toBe("1.0.0");
  });

  it("全部更新：确认框列出名称/本地→远程/作者，确认后逐个执行并汇总（手工同名跳过、失败不中断）", async () => {
    localStorage.setItem(HUB_KEY_STORAGE_KEY, JSON.stringify({ key: "bulk-key" }));
    const pool = new SkillPool(memoryStorage());
    addCommunitySkill(pool, "周报助手", "1.0.0", "xp-1");
    addCommunitySkill(pool, "试用技能", "1.0.0", "xp-2");
    addCommunitySkill(pool, "失败技能", "1.0.0", "xp-3");
    pool.create({
      name: "手工技能",
      description: "手工",
      instructions: "手工内容",
      triggers: [],
      tags: [],
      enabled: true,
      version: "1.0.0",
      source: "user",
    });

    const page = {
      skills: [
        { ...SKILL, id: "xp-1", name: "周报助手", version: "1.2.0" },
        { ...SKILL_TRIAL, id: "xp-2", name: "试用技能", version: "2.0.0" },
        { ...SKILL, id: "xp-3", name: "失败技能", version: "3.0.0" },
      ],
      total: 3,
      hasMore: false,
      fetchedAt: "2026-11-08T00:00:00.000Z",
    };
    const { onGoAssign } = renderPanel(
      {
        page,
        downloadFor: async (url) => {
          if (url.includes("xp-3")) return jsonResponse({ error: "boom" }, 500);
          const name = url.includes("xp-2") ? "手工技能" : "周报助手";
          return jsonResponse({
            skillId: url.includes("xp-2") ? "xp-2" : "xp-1",
            name,
            version: url.includes("xp-2") ? "2.0.0" : "1.2.0",
            skillMd: md(name),
            files: [],
            zipSha256: SHA,
            size: 100,
          });
        },
      },
      pool,
    );

    expect(await screen.findByText("已装 3 个社区技能 · 3 个可更新")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部更新" }));
    const dialog = await screen.findByRole("dialog", { name: "批量更新社区技能" });
    expect(dialog).toHaveTextContent("周报助手");
    expect(dialog).toHaveTextContent("v1.0.0 → v1.2.0");
    fireEvent.click(within(dialog).getByRole("button", { name: "确认更新" }));

    expect(
      await within(dialog).findByText(/更新完成：成功 1 \/ 失败 1 \/ 跳过 1/),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("同名手工技能，未覆盖")).toBeInTheDocument();

    const updated = pool.list().find((skill) => skill.community?.skillId === "xp-1");
    expect(updated?.community?.version).toBe("1.2.0");
    const manual = pool.list().find((skill) => skill.name === "手工技能");
    expect(manual?.instructions).toBe("手工内容");

    fireEvent.click(within(dialog).getByRole("button", { name: "去技能区分配" }));
    expect(onGoAssign).toHaveBeenCalled();
    expect(useUiStore.getState().page).toBe("plugins");
    expect(useUiStore.getState().pageView).toBe("skills");
  });
});

describe("SkillHubPanel · Key 与安装", () => {
  it("无 Key 点安装 → Key 引导；保存后下载 → 预览 → 确认写入技能池并记 community", async () => {
    const { skills, onInstalled, onGoAssign } = renderPanel();
    await screen.findByText("周报助手");
    fireEvent.click(screen.getAllByRole("button", { name: "安装" })[0]!);

    const keyDialog = await screen.findByRole("dialog", { name: "社区 Key" });
    expect(within(keyDialog).getByText(/技能来自第三方社区|和鸣不代扣/)).toBeInTheDocument();
    fireEvent.change(within(keyDialog).getByLabelText("社区 API Key"), {
      target: { value: "xp-user-key-1" },
    });
    fireEvent.click(within(keyDialog).getByRole("button", { name: "保存 Key" }));

    const preview = await screen.findByRole("dialog", { name: "安装社区技能" });
    expect(preview).toHaveTextContent("周报助手");
    expect(preview).toHaveTextContent("虾评 · 虾评 · v1.2.0");
    expect(preview).toHaveTextContent("触发词：周报");
    fireEvent.click(within(preview).getByRole("button", { name: "确认安装" }));

    const saved = skills.list().find((skill) => skill.community?.skillId === "xp-1");
    expect(saved).toBeTruthy();
    expect(saved).toMatchObject({
      name: "周报助手",
      source: "imported",
      community: { source: "xiaping", skillId: "xp-1", version: "1.2.0" },
    });
    expect(saved!.enabled).toBe(true);
    // 默认不分配：技能池里没有该技能的智能体分配记录
    expect(onInstalled).toHaveBeenCalled();
    expect(screen.getByText(/已安装「周报助手」/)).toBeInTheDocument();

    // 安装成功后给「去技能区分配」出口：切到技能区 + 由宿主切「技能池」Tab
    fireEvent.click(screen.getByRole("button", { name: "去技能区分配" }));
    expect(onGoAssign).toHaveBeenCalled();
    expect(useUiStore.getState().pageView).toBe("skills");
  });

  it("「用这个名字创建账号」需要明确点击，并把 Key 存到本机", async () => {
    const { calls } = renderPanel();
    await screen.findByText("周报助手");
    fireEvent.click(screen.getByRole("button", { name: "社区 Key" }));
    const dialog = await screen.findByRole("dialog", { name: "社区 Key" });
    expect(within(dialog).getByText(/将在虾评创建一个新账号/)).toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("注册用户名"), { target: { value: "snake" } });
    fireEvent.click(within(dialog).getByRole("button", { name: /用这个名字创建账号/ }));

    await waitFor(() => {
      const call = calls.find((item) => item.url.includes("/register"));
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call!.init?.body))).toEqual({ name: "snake" });
    });
    await waitFor(() => {
      expect(localStorage.getItem(HUB_KEY_STORAGE_KEY)).toContain("xp-key-register-1");
    });
    expect(await within(dialog).findByText(/已在虾评创建账号/)).toBeInTheDocument();
  });

  it("清除 Key：本机键被移除并可重新引导", async () => {
    localStorage.setItem(HUB_KEY_STORAGE_KEY, JSON.stringify({ key: "old-key" }));
    renderPanel();
    await screen.findByText("周报助手");
    fireEvent.click(screen.getByRole("button", { name: "社区 Key" }));
    const dialog = await screen.findByRole("dialog", { name: "社区 Key" });
    fireEvent.click(within(dialog).getByRole("button", { name: "清除 Key" }));
    expect(localStorage.getItem(HUB_KEY_STORAGE_KEY)).toBeNull();
    expect(await within(dialog).findByText(/已清除本机保存的社区 Key/)).toBeInTheDocument();
  });
});
