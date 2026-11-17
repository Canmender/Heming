import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImageModelSettings } from "./ImageModelSettings.js";
import type { ModelRow } from "../../lib/modelCatalog.js";

function row(id: string, vision = false): ModelRow {
  return { id, provider: id.split("/")[0] ?? "", name: "", efforts: [], vision, inCatalog: true };
}

describe("看图与画图模型", () => {
  it("有画图模型时用下拉；选一个就写 settings set imageGen", () => {
    const onRun = vi.fn(async () => true);
    render(
      <ImageModelSettings
        rows={[row("deepseek/deepseek-chat", true)]}
        drawers={[{ id: "copilot/gpt-image-1", name: "GPT Image" }]}
        vision=""
        visionEffort=""
        imageGen=""
        cliReady
        onRun={onRun}
      />,
    );

    fireEvent.change(screen.getByLabelText("画图模型"), { target: { value: "copilot/gpt-image-1" } });
    expect(onRun).toHaveBeenCalledWith("保存画图模型", ["settings", "set", "imageGen", "copilot/gpt-image-1"]);
  });

  it("看图模型只列声明了图片输入的模型；选了写 settings set vision", () => {
    const onRun = vi.fn(async () => true);
    render(
      <ImageModelSettings
        rows={[row("deepseek/deepseek-chat", true), row("openai/gpt-4o", false)]}
        drawers={[]}
        vision=""
        visionEffort=""
        imageGen=""
        cliReady
        onRun={onRun}
      />,
    );

    const select = screen.getByLabelText("看图模型") as HTMLSelectElement;
    const values = Array.from(select.options).map((option) => option.value);
    expect(values).toEqual(["", "off", "deepseek/deepseek-chat"]);

    fireEvent.change(select, { target: { value: "deepseek/deepseek-chat" } });
    expect(onRun).toHaveBeenCalledWith("保存看图模型", ["settings", "set", "vision", "deepseek/deepseek-chat"]);
  });

  it("看图模型可以关掉：带图片的请求直接拒绝", () => {
    const onRun = vi.fn(async () => true);
    render(
      <ImageModelSettings
        rows={[row("deepseek/deepseek-chat", true)]}
        drawers={[]}
        vision=""
        visionEffort=""
        imageGen=""
        cliReady
        onRun={onRun}
      />,
    );

    fireEvent.change(screen.getByLabelText("看图模型"), { target: { value: "off" } });
    expect(onRun).toHaveBeenCalledWith("保存看图模型", ["settings", "set", "vision", "off"]);
  });

  it("思考档列出所选模型自己的档位，清空就 reset", async () => {
    const onRun = vi.fn(async () => true);
    const vision = { ...row("deepseek/deepseek-chat", true), efforts: ["low", "high"] };
    render(
      <ImageModelSettings
        rows={[vision]}
        drawers={[]}
        vision="deepseek/deepseek-chat"
        visionEffort=""
        imageGen=""
        cliReady
        onRun={onRun}
      />,
    );

    const select = screen.getByLabelText("看图模型的思考档") as HTMLSelectElement;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["", "low", "high"]);

    fireEvent.change(select, { target: { value: "high" } });
    expect(onRun).toHaveBeenCalledWith("保存看图模型的思考档", ["settings", "set", "visionEffort", "high"]);

    // 保存期间控件是禁用的：等这一轮结束再改，否则第二次点击会被 busy 挡掉。
    await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1));
    fireEvent.change(select, { target: { value: "" } });
    await waitFor(() =>
      expect(onRun).toHaveBeenCalledWith("保存看图模型的思考档", [
        "settings",
        "reset",
        "visionEffort",
      ]),
    );
  });

  it("网关没列出画图模型时可以手填；关掉走 settings reset", () => {
    const onRun = vi.fn(async () => true);
    render(
      <ImageModelSettings
        rows={[]}
        drawers={[]}
        vision=""
        visionEffort=""
        imageGen="relay/draw"
        cliReady
        onRun={onRun}
      />,
    );

    expect(screen.getByLabelText("画图模型")).toHaveValue("relay/draw");
    fireEvent.click(screen.getByRole("button", { name: "关掉" }));
    expect(onRun).toHaveBeenCalledWith("保存画图模型", ["settings", "reset", "imageGen"]);
  });
});
