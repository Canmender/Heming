import { useEffect } from "react";
import { useUiStore } from "./store/ui.js";
import { useAuthStore } from "./store/auth.js";
import { getToken } from "./lib/api.js";
import { LoginPage } from "./components/LoginPage.js";
import { NavSidebar } from "./components/NavSidebar.js";
import { NavRail } from "./components/NavRail.js";
import { FileTree, type TreeItem } from "./components/FileTree.js";
import { WorkspacePage } from "./components/WorkspacePage.js";
import { ChatPage } from "./components/ChatPage.js";

export function App() {
  const authStatus = useAuthStore((s) => s.status);
  const authUser = useAuthStore((s) => s.user);
  const restore = useAuthStore((s) => s.restore);

  useEffect(() => {
    void restore();
  }, [restore]);

  const page = useUiStore((s) => s.page);
  const navCollapsed = useUiStore((s) => s.navCollapsed);
  const setNavCollapsed = useUiStore((s) => s.setNavCollapsed);

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

  if (!authUser) {
    return authStatus === "pending" && getToken() ? (
      <div className="flex h-screen items-center justify-center text-muted">加载中…</div>
    ) : (
      <LoginPage />
    );
  }

  const demoItems: TreeItem[] = [];
  const view =
    page === "chat" ? (
      <ChatPage />
    ) : page === "workspace" ? (
      <WorkspacePage />
    ) : page === "home" ? (
      <div className="p-6">
        <h1 className="text-lg font-extrabold">主页</h1>
      </div>
    ) : (
      <div className="p-6">
        <h1 className="text-lg font-extrabold">占位页面</h1>
        <p className="mt-2 text-[13px] text-muted">
          {page === "interfaces"
            ? "接口区（MCP/工具）二期开放"
            : page === "memory"
              ? "记忆区（全局记忆 + 知识库）二期开放"
              : "设置区"}
        </p>
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
