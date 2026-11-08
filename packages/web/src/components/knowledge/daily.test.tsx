import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DAILY_CONFIG_KEY, dailyRelOf, readDailyConfig, saveDailyConfig, templatesOfTree } from "./daily.js";
import { DEFAULT_DAILY_CONFIG } from "../../lib/vault/daily.js";
import { NewNoteDialog } from "./NewNoteDialog.js";
import { VaultSettingsDialog } from "./VaultSettingsDialog.js";

function fakeStorage(seed: Record<string, string> = {}) {
  const data = new Map(Object.entries(seed));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => {
      data.set(key, value);
    },
    dump: () => Object.fromEntries(data),
  };
}

describe("日记设置（界面侧只存配置，路径交给引擎）", () => {
  it("默认配置来自引擎，不再本地另写一份", () => {
    const storage = fakeStorage();
    expect(readDailyConfig("v1", storage)).toEqual(DEFAULT_DAILY_CONFIG);
  });

  it("按库 id 存取；坏 JSON 回落默认", () => {
    const storage = fakeStorage();
    saveDailyConfig("v1", { folder: "笔记/日记", format: "YYYYMMDD" }, storage);
    expect(readDailyConfig("v1", storage)).toEqual({ folder: "笔记/日记", format: "YYYYMMDD" });
    // 另一个库互不影响
    expect(readDailyConfig("v2", storage)).toEqual(DEFAULT_DAILY_CONFIG);
    // 坏 JSON
    expect(readDailyConfig("v1", fakeStorage({ [DAILY_CONFIG_KEY]: "{oops" }))).toEqual(
      DEFAULT_DAILY_CONFIG,
    );
  });

  it("非法文件夹/格式交给引擎回退，不写非法值", () => {
    const storage = fakeStorage();
    const saved = saveDailyConfig("v1", { folder: "..", format: "not-a-format" }, storage);
    expect(saved).toEqual(DEFAULT_DAILY_CONFIG);
    expect(readDailyConfig("v1", storage)).toEqual(DEFAULT_DAILY_CONFIG);
  });

  it("dailyRelOf 与引擎 dailyNotePath 结果一致（默认 + 自定义格式）", () => {
    const date = new Date(2026, 10, 8);
    expect(dailyRelOf(DEFAULT_DAILY_CONFIG, date)).toBe("daily/2026-11-08.md");
    expect(dailyRelOf({ folder: "", format: "YYYYMMDD" }, date)).toBe("20261108.md");
  });

  it("templatesOfTree 只认 templates/*.md", () => {
    const entries = [
      {
        rel: "templates",
        name: "templates",
        kind: "dir" as const,
        size: 0,
        mtime: "",
        children: [
          { rel: "templates/会议.md", name: "会议.md", kind: "md" as const, size: 1, mtime: "" },
          { rel: "templates/图片.png", name: "图片.png", kind: "image" as const, size: 1, mtime: "" },
        ],
      },
      { rel: "a.md", name: "a.md", kind: "md" as const, size: 1, mtime: "" },
    ];
    expect(templatesOfTree(entries)).toEqual([{ rel: "templates/会议.md", label: "会议" }]);
    expect(templatesOfTree([])).toEqual([]);
  });
});

describe("新建笔记弹窗", () => {
  const templates = [{ rel: "templates/会议.md", label: "会议" }];

  it("输入名字自动补 .md；可选模板", () => {
    const onCreate = vi.fn();
    render(<NewNoteDialog dir="notes" templates={templates} onCancel={vi.fn()} onCreate={onCreate} />);
    fireEvent.change(screen.getByLabelText("笔记名"), { target: { value: "周会" } });
    fireEvent.change(screen.getByLabelText("模板"), { target: { value: "templates/会议.md" } });
    fireEvent.click(screen.getByRole("button", { name: "新建" }));
    expect(onCreate).toHaveBeenCalledWith("周会.md", "templates/会议.md");
  });

  it("名字为空时禁用「新建」；无模板时只给空白", () => {
    render(<NewNoteDialog dir="" templates={[]} onCancel={vi.fn()} onCreate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "新建" })).toBeDisabled();
    expect(screen.getByText(/还没有模板/)).toBeInTheDocument();
  });
});

describe("知识库设置弹窗", () => {
  it("展示引擎算出的今日路径，保存回填引擎配置", () => {
    const onSave = vi.fn();
    render(
      <VaultSettingsDialog
        config={DEFAULT_DAILY_CONFIG}
        templates={[{ rel: "templates/日记.md", label: "日记" }]}
        onCancel={vi.fn()}
        onSave={onSave}
      />,
    );
    // 默认 daily 目录在文案里出现
    expect(screen.getByText(/daily\//)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("日记文件夹"), { target: { value: "日志" } });
    fireEvent.change(screen.getByLabelText("日期格式"), { target: { value: "YYYYMMDD" } });
    fireEvent.change(screen.getByLabelText("日记模板"), {
      target: { value: "templates/日记.md" },
    });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onSave).toHaveBeenCalledWith({
      folder: "日志",
      format: "YYYYMMDD",
      templatePath: "templates/日记.md",
    });
  });

  it("非法配置显示引擎回退原因", () => {
    render(
      <VaultSettingsDialog config={DEFAULT_DAILY_CONFIG} templates={[]} onCancel={vi.fn()} onSave={vi.fn()} />,
    );
    fireEvent.change(screen.getByLabelText("日记文件夹"), { target: { value: "../逃逸" } });
    expect(screen.getByRole("alert")).toHaveTextContent(/日记文件夹/);
  });
});
