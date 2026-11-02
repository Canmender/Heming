import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { ToolApprovalModal } from "./ToolApprovalModal.js";
import { classifyCall } from "../lib/hitl/classify.js";
import type { HitlCall } from "../lib/hitl/types.js";
import type { PatchPreview } from "../lib/fileEdit/patchPreview.js";
import { FILE_ROOTS_KEY } from "../lib/fileEdit/roots.js";

/** 造一个待确认调用（带 id，闸门按它对齐裁决）。 */
function call(name: string, args: unknown, id = "c1"): HitlCall {
  return { ...classifyCall(name, JSON.stringify(args)), id };
}

const patchCall = (root = "库") =>
  call("file_patch", {
    patch: ["*** Begin Patch", "*** Update File: notes/a.md", "@@", "-旧", "+新", "*** End Patch"].join("\n"),
    root,
  });

const preview: PatchPreview = {
  summary: "将修改 1 个文件（1 个修改）",
  files: [
    {
      rel: "notes/a.md",
      kind: "M",
      added: 1,
      removed: 1,
      truncated: false,
      lines: [
        { kind: "ctx", text: "第一行" },
        { kind: "del", text: "旧的一行" },
        { kind: "add", text: "新的一行" },
      ],
    },
  ],
  shownLines: 3,
  truncated: false,
};

/** 确认卡渲染（默认注入一个假预览器）。 */
function renderModal(calls: HitlCall[], previewer = async () => preview) {
  const onDecide = vi.fn();
  render(
    <ToolApprovalModal requestId="r1" calls={calls} onDecide={onDecide} patchPreviewer={previewer} />,
  );
  return { onDecide };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("确认卡 · file_patch 的行级 diff", () => {
  it("显示「将修改 N 个文件（A/M/D）」与逐行 diff", async () => {
    renderModal([patchCall()]);
    expect(await screen.findByText(/查看变更（将修改 1 个文件（1 个修改））/)).toBeTruthy();
    expect(screen.getByText(/\+1 −1/)).toBeTruthy();
    expect(screen.getByText(/旧的一行/)).toBeTruthy();
    expect(screen.getByText(/新的一行/)).toBeTruthy();
  });

  it("补丁本身有问题时给出 error 文案（不假装能改）", async () => {
    renderModal([patchCall()], async () => ({
      summary: "补丁无法应用，不会修改任何文件",
      files: [],
      shownLines: 0,
      truncated: false,
      error: "第 1 个 `@@` 块在 notes/a.md 里找不到匹配的原文。",
    }));
    expect(await screen.findByText(/找不到匹配的原文/)).toBeTruthy();
    expect(screen.queryByText(/查看变更/)).toBeNull();
  });

  it("不给 file_patch 提供「本会话内允许此工具」（整工具授权不符合目录前缀口径）", () => {
    renderModal([patchCall()]);
    expect(screen.queryByText("本会话内允许此工具")).toBeNull();
    expect(screen.getByText("仅本次允许")).toBeTruthy();
  });

  it("预览加载中显示占位文案", () => {
    renderModal([patchCall()], () => new Promise(() => {}));
    expect(screen.getByText("正在生成变更预览…")).toBeTruthy();
  });

  it("其它工具仍走原来的参数级预览（不回归）", () => {
    renderModal([
      call("fs__edit_file", {
        path: "notes/a.md",
        old_string: "旧\n第二行",
        new_string: "新\n第二行",
      }),
    ]);
    expect(screen.getByText(/查看变更（\+1 −1）/)).toBeTruthy();
  });
});

describe("确认卡 · 「记住本次选择」的口径", () => {
  it("没有可写根时不显示「记住」，并说明本次不会落规则", () => {
    renderModal([patchCall()]);
    expect(screen.queryByLabelText("记住本次选择")).toBeNull();
    expect(screen.getByText(/无法按目录记住/)).toBeTruthy();
  });

  it("目标在可写根内时显示「记住」，并明确写出将记住的目录前缀", async () => {
    window.localStorage.setItem(
      FILE_ROOTS_KEY,
      JSON.stringify({ roots: [{ name: "库", path: "D:/库", mode: "write" }], outOfRoot: "ask" }),
    );
    renderModal([patchCall()]);
    expect(screen.getByLabelText("记住本次选择")).toBeTruthy();
    await waitFor(() => expect(screen.getByText(/将记住目录：D:\/库\/notes\//)).toBeTruthy());
  });
});
