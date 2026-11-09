import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { createMemoryStorage } from "../../lib/memory/storage.js";
import { setWorkflowStorage, useWorkflowStore } from "../../lib/workflow/store.js";
import {
  setWorkflowExecutionStorage,
  useWorkflowExecutionsStore,
} from "../../lib/workflow/executions.js";
import {
  setCredentialStorage,
  useWorkflowCredentialsStore,
} from "../../lib/workflow/credentials.js";
import { setNotificationStorage } from "../../store/notifications.js";
import type { Workflow } from "../../lib/workflow/types.js";
import { WorkflowPage } from "./WorkflowPage.js";

/**
 * 画布与节点面板由 wf-canvas 实现，这里只验证**页面壳的接线**：
 * 改画布不影响页面测试（也不会在 jsdom 里跑真实布局）。
 */
vi.mock("./canvas/Canvas.js", () => ({
  WorkflowCanvas: (props: {
    workflow: Workflow;
    selectedIds: string[];
    nodeRunState: Record<string, { state: string }>;
    onRequestAddNode?: (position: { x: number; y: number }) => void;
    onOpenNode?: (nodeId: string) => void;
  }) => (
    <div aria-label="工作流画布">
      <span>节点数 {props.workflow.nodes.length}</span>
      <button type="button" onClick={() => props.onRequestAddNode?.({ x: 10, y: 20 })}>
        添加节点
      </button>
      <button
        type="button"
        onClick={() => {
          const first = props.workflow.nodes[0];
          if (first) props.onOpenNode?.(first.id);
        }}
      >
        打开第一个节点
      </button>
    </div>
  ),
}));

vi.mock("./NodePalette.js", () => ({
  NodePalette: (props: { open: boolean; onPick: (type: string) => void; onClose: () => void }) =>
    props.open ? (
      <div role="dialog" aria-label="节点面板">
        <button type="button" onClick={() => props.onPick("manualTrigger")}>
          选手动触发
        </button>
        <button type="button" onClick={props.onClose}>
          关闭节点面板
        </button>
      </div>
    ) : null,
}));

beforeEach(() => {
  const workflowStorage = createMemoryStorage();
  setWorkflowStorage(workflowStorage);
  setWorkflowExecutionStorage(createMemoryStorage());
  setCredentialStorage(createMemoryStorage());
  setNotificationStorage(createMemoryStorage());
  useWorkflowStore.setState({ workflows: [], selectedId: null });
  useWorkflowExecutionsStore.setState({ executions: [] });
  useWorkflowCredentialsStore.setState({ credentials: [] });
});

describe("WorkflowPage", () => {
  it("渲染页头与三个 Tab，可切换到执行记录/凭据", () => {
    render(<WorkflowPage />);
    expect(screen.getByRole("heading", { name: "工作流" })).toBeInTheDocument();

    const workflowsTab = screen.getByRole("tab", { name: /工作流/ });
    const executionsTab = screen.getByRole("tab", { name: /执行记录/ });
    const credentialsTab = screen.getByRole("tab", { name: /凭据/ });
    expect(workflowsTab).toHaveAttribute("aria-selected", "true");

    fireEvent.click(executionsTab);
    expect(executionsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("还没有执行记录")).toBeInTheDocument();

    fireEvent.click(credentialsTab);
    expect(credentialsTab).toHaveAttribute("aria-selected", "true");
    expect(screen.getAllByRole("button", { name: "新建凭据" }).length).toBeGreaterThan(0);
  });

  it("空态下新建空白工作流：进入编辑器并自动保存到仓库", () => {
    render(<WorkflowPage />);
    expect(screen.getByText("还没有工作流")).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole("button", { name: /新建工作流/ })[0] as HTMLElement);
    const dialog = screen.getByRole("dialog", { name: "新建工作流" });
    fireEvent.click(within(dialog).getByRole("button", { name: /空白工作流/ }));

    // 进入编辑器
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
    expect(screen.getByLabelText("工作流画布")).toBeInTheDocument();
    expect(useWorkflowStore.getState().workflows).toHaveLength(1);
    expect(useWorkflowStore.getState().selectedId).toBe(useWorkflowStore.getState().workflows[0]?.id);
  });

  it("编辑器里打开节点面板添加节点，画布收到新草稿", () => {
    render(<WorkflowPage />);
    fireEvent.click(screen.getAllByRole("button", { name: /新建工作流/ })[0] as HTMLElement);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "新建工作流" })).getByRole("button", {
        name: /空白工作流/,
      }),
    );
    expect(screen.getByLabelText("工作流画布")).toHaveTextContent("节点数 0");

    fireEvent.click(screen.getByRole("button", { name: "添加节点" }));
    const palette = screen.getByRole("dialog", { name: "节点面板" });
    fireEvent.click(within(palette).getByRole("button", { name: "选手动触发" }));

    expect(screen.getByLabelText("工作流画布")).toHaveTextContent("节点数 1");
    expect(screen.getByLabelText("节点详情：手动触发")).toBeInTheDocument();
  });

  it("改名后 Ctrl+S 保存，仓库里的名字同步更新", () => {
    render(<WorkflowPage />);
    fireEvent.click(screen.getAllByRole("button", { name: /新建工作流/ })[0] as HTMLElement);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "新建工作流" })).getByRole("button", {
        name: /空白工作流/,
      }),
    );
    const nameInput = screen.getByLabelText("工作流名称");
    fireEvent.change(nameInput, { target: { value: "每天抓取天气" } });
    fireEvent.keyDown(window, { key: "s", ctrlKey: true });

    expect(useWorkflowStore.getState().workflows[0]?.name).toBe("每天抓取天气");
    expect(screen.queryByText("未保存")).not.toBeInTheDocument();
  });

  it("有未保存修改时返回要先确认，放弃修改回到列表", () => {
    render(<WorkflowPage />);
    fireEvent.click(screen.getAllByRole("button", { name: /新建工作流/ })[0] as HTMLElement);
    fireEvent.click(
      within(screen.getByRole("dialog", { name: "新建工作流" })).getByRole("button", {
        name: /空白工作流/,
      }),
    );
    fireEvent.change(screen.getByLabelText("工作流名称"), { target: { value: "改了没保存" } });
    fireEvent.click(screen.getByRole("button", { name: "返回" }));

    const confirm = screen.getByRole("dialog", { name: "离开编辑器" });
    fireEvent.click(within(confirm).getByRole("button", { name: "放弃修改并返回" }));
    expect(screen.getByRole("tab", { name: /工作流/ })).toBeInTheDocument();
    expect(useWorkflowStore.getState().workflows[0]?.name).not.toBe("改了没保存");
  });

  it("列表卡片显示工作流并提供编辑入口", () => {
    const store = useWorkflowStore.getState();
    const created = store.create({ name: "已存在的工作流" });
    if (!created.ok) throw new Error(created.error);
    useWorkflowStore.setState({ selectedId: null });

    render(<WorkflowPage />);
    const list = screen.getByRole("list", { name: "工作流列表" });
    expect(within(list).getByText("已存在的工作流")).toBeInTheDocument();
    expect(within(list).getByRole("switch", { name: /启用工作流/ })).toBeInTheDocument();

    fireEvent.click(within(list).getByRole("button", { name: "编辑" }));
    expect(screen.getByRole("button", { name: "保存" })).toBeInTheDocument();
  });
});
