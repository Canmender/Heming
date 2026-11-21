import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { FileRefPicker } from "./FileRefPicker.js";
import type { FileFsBridge } from "../lib/fileEdit/bridge.js";
import type { FileRoot } from "../lib/fileEdit/paths.js";

const ROOT: FileRoot = { name: "工作区", path: "D:/项目/和鸣", mode: "write" };

function fakeBridge(paths: string[], opts?: { fail?: boolean }): FileFsBridge {
  return {
    read: async () => ({ ok: false as const, code: "not-found" as const, error: "不该在这里读" }),
    write: async () => ({ ok: true }),
    pickRoot: async () => null,
    glob: async () =>
      opts?.fail
        ? { ok: false as const, code: "io" as const, error: "列目录失败" }
        : { ok: true as const, root: "工作区", paths, truncated: false },
  };
}

const renderPicker = (over: Partial<Parameters<typeof FileRefPicker>[0]> = {}) => {
  const picked: string[][] = [];
  render(
    <FileRefPicker
      bridge={fakeBridge(["D:/项目/和鸣/docs/a.md", "D:/项目/和鸣/src/b.ts"])}
      roots={[ROOT]}
      selected={[]}
      onConfirm={(paths) => picked.push(paths)}
      onClose={() => {}}
      {...over}
    />,
  );
  return { picked };
};

describe("引用工作区文件对话框（d.175）", () => {
  it("列出工作区文件，显示根内相对路径", async () => {
    renderPicker();
    expect(await screen.findByRole("dialog", { name: "引用工作区文件" })).toBeInTheDocument();
    expect(await screen.findByText("docs/a.md")).toBeInTheDocument();
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
  });

  it("勾选后回传绝对路径", async () => {
    const { picked } = renderPicker();
    fireEvent.click(await screen.findByLabelText("docs/a.md"));
    fireEvent.click(screen.getByRole("button", { name: "确定引用" }));
    expect(picked).toEqual([["D:/项目/和鸣/docs/a.md"]]);
  });

  it("搜索框按文件名过滤", async () => {
    renderPicker();
    fireEvent.change(await screen.findByLabelText("搜索工作区文件"), {
      target: { value: "b.ts" },
    });
    await waitFor(() => expect(screen.queryByText("docs/a.md")).not.toBeInTheDocument());
    expect(screen.getByText("src/b.ts")).toBeInTheDocument();
  });

  it("到 3 个上限后其余项禁用，并显示已选计数", async () => {
    const many = ["a.md", "b.md", "c.md", "d.md"].map((n) => `D:/项目/和鸣/${n}`);
    renderPicker({ bridge: fakeBridge(many) });
    for (const name of ["a.md", "b.md", "c.md"]) {
      fireEvent.click(await screen.findByLabelText(name));
    }
    expect(screen.getByText("已选 3 / 3")).toBeInTheDocument();
    expect(screen.getByLabelText("d.md")).toBeDisabled();
  });

  it("列目录失败时给 role=alert，而不是空列表让人以为没有文件", async () => {
    renderPicker({ bridge: fakeBridge([], { fail: true }) });
    expect(await screen.findByRole("alert")).toHaveTextContent("列目录失败");
  });

  it("没有桥时说明不可用，不假装在加载", async () => {
    renderPicker({ bridge: null });
    expect(await screen.findByText("这个工作区里没有可引用的文件。")).toBeInTheDocument();
  });

  it("慢的旧 glob 结果不覆盖已到的新结果（d.412 回归）", async () => {
    let call = 0;
    const resolvers: Array<(paths: string[]) => void> = [];
    const deferredBridge: FileFsBridge = {
      ...fakeBridge([]),
      glob: async () => {
        call++;
        return new Promise((resolve) => {
          resolvers.push((paths) =>
            resolve({ ok: true as const, root: "工作区", paths, truncated: false }),
          );
        });
      },
    };
    const rootB: FileRoot = { name: "B", path: "D:/B", mode: "write" };
    const { rerender } = render(
      <FileRefPicker
        bridge={deferredBridge}
        roots={[{ name: "A", path: "D:/A", mode: "write" }]}
        selected={[]}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    expect(call).toBe(1);
    rerender(
      <FileRefPicker
        bridge={deferredBridge}
        roots={[rootB]}
        selected={[]}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    expect(call).toBe(2);
    // 新请求(#2)先返回
    resolvers[1](["D:/B/new.md"]);
    expect(await screen.findByText("new.md")).toBeInTheDocument();
    // 旧请求(#1)迟到，不能把新结果冲掉
    resolvers[0](["D:/A/old.md"]);
    await waitFor(() => expect(screen.queryByText("old.md")).toBeNull());
    expect(screen.getByText("new.md")).toBeInTheDocument();
  });
});
