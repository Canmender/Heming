import { useEffect } from "react";
import { useUiStore } from "./store/ui.js";
import { NavSidebar } from "./components/NavSidebar.js";
import { NavRail } from "./components/NavRail.js";
import { FileTree, type TreeItem } from "./components/FileTree.js";

export function App() {
  const page = useUiStore((s) => s.page);
  const navCollapsed = useUiStore((s) => s.navCollapsed);
  const setNavCollapsed = useUiStore((s) => s.setNavCollapsed);
  const setPage = useUiStore((s) => s.setPage);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "\\") {
        e.preventDefault();
        setNavCollapsed(!navCollapsed);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [navCollapsed, setNavCollapsed]);

  const demoItems: TreeItem[] = [];
  const view = (
    <div className="flex h-full flex-1 flex-col p-6">
      <h1 className="text-lg font-extrabold">
        {page === "home" ? "主页" : page === "workspace" ? "工作区" : "占位页面"}
      </h1>
      <p className="mt-2 text-[13px] text-muted">
        {page === "interfaces"
          ? "接口区（MCP/工具）二期开放"
          : page === "memory"
            ? "记忆区（全局记忆 + 知识库）二期开放"
            : "内容随后续任务填充"}
      </p>
      {page !== "chat" ? null : (
        <button
          type="button"
          className="mt-4 w-fit rounded-lg border border-line px-3 py-1.5 text-[13px] shadow-card"
          onClick={() => setPage("workspace")}
        >
          返回工作区
        </button>
      )}
    </div>
  );

  return (
    <div className="flex h-screen overflow-hidden border border-line bg-white">
      {navCollapsed ? <NavRail /> : <NavSidebar />}
      <main className="flex min-w-0 flex-1 flex-col">{view}</main>
      <aside className="w-[240px] shrink-0 border-l border-line-soft">
        <FileTree items={demoItems} localPaths={[]} />
      </aside>
    </div>
  );
}
