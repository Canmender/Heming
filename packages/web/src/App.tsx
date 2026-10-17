import { useCallback, useEffect, useState } from "react";
import { useUiStore, type Page } from "./store/ui.js";
import { useAuthStore } from "./store/auth.js";
import { getToken, fetchFiles, fetchFileUsage, uploadFile } from "./lib/api.js";
import type { SharedFileMeta } from "@heming/shared";
import { LoginPage } from "./components/LoginPage.js";
import { NavRail, NavPeek } from "./components/NavRail.js";
import { FileTree } from "./components/FileTree.js";
import { FilePreviewModal } from "./components/FilePreviewModal.js";
import { WorkspacePage } from "./components/WorkspacePage.js";
import { ChatPage } from "./components/ChatPage.js";
import { RadarContacts } from "./components/RadarContacts.js";
import { HomePage } from "./components/HomePage.js";
import { SettingsPage } from "./components/SettingsPage.js";
import { MemoryPage } from "./components/MemoryPage.js";

/** Alt+1–Alt+5 目标页（1 主页、2 工作区、3 接口区、4 记忆区、5 设置区）。 */
const SHORTCUT_PAGES: Page[] = [
  "home",
  "workspace",
  "interfaces",
  "memory",
  "settings",
];

function fmtBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${n}B`;
}

export function App() {
  const authStatus = useAuthStore((s) => s.status);
  const authUser = useAuthStore((s) => s.user);
  const restore = useAuthStore((s) => s.restore);

  useEffect(() => {
    void restore();
  }, [restore]);

  const [files, setFiles] = useState<SharedFileMeta[]>([]);
  const [usage, setUsage] = useState<{ used: number; quota: number } | null>(null);
  /** 右栏文件行 hover「预览」的目标文件（null = 模态关闭）。 */
  const [previewFile, setPreviewFile] = useState<SharedFileMeta | null>(null);
  const refreshFiles = useCallback(() => {
    void fetchFiles().then(setFiles);
    void fetchFileUsage()
      .then(setUsage)
      .catch(() => setUsage(null)); // 用量接口失败静默（不影响文件列表）
  }, []);
  useEffect(() => {
    if (authUser) refreshFiles();
  }, [authUser, refreshFiles]);

  const onUpload = async () => {
    const input = document.createElement("input");
    input.type = "file";
    input.onchange = async () => {
      const file = input.files?.[0];
      if (!file) return;
      try {
        await uploadFile(file); // base64 编码与 POST 已下沉到 lib/api
        refreshFiles();
      } catch (e) {
        console.error("上传失败", e);
        window.alert(`上传失败：${e instanceof Error ? e.message : String(e)}`);
      }
    };
    input.click();
  };

  const page = useUiStore((s) => s.page);
  const navCollapsed = useUiStore((s) => s.navCollapsed);
  const setNavCollapsed = useUiStore((s) => s.setNavCollapsed);
  const setPage = useUiStore((s) => s.setPage);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!authUser) return;
      const t = e.target as HTMLElement | null;
      const inText =
        !!t &&
        (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // Alt+1–5 直接切页（不用 ⌘/Ctrl，避开浏览器/输入法组合键冲突）；输入框内不响应
      if (e.altKey && !e.metaKey && !e.ctrlKey && ["1", "2", "3", "4", "5"].includes(e.key)) {
        if (inText) return;
        e.preventDefault();
        setPage(SHORTCUT_PAGES["12345".indexOf(e.key)]);
        return;
      }
      if (!e.metaKey && !e.ctrlKey) return;
      // ⌘/Ctrl+\ 收放导航：无冲突组合，输入框内也生效（聊天中高频操作）
      if (e.key === "\\") {
        e.preventDefault();
        setNavCollapsed(!navCollapsed);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [authUser, navCollapsed, setNavCollapsed, setPage]);

  if (!authUser) {
    return authStatus === "pending" && getToken() ? (
      <div className="flex h-screen items-center justify-center text-muted">加载中…</div>
    ) : (
      <LoginPage />
    );
  }

  const view =
    page === "home" ? (
      <HomePage />
    ) : page === "chat" ? (
      // 会话态：ChatPage 常驻底层（保持 WS/草稿状态）；雷达覆盖层按 contactsHidden
      // 滑出/呼出（面板自身管理 transform，隐藏时平移出容器并由 overflow 裁切）
      <div className="relative h-full min-h-0 w-full overflow-hidden">
        <div className="absolute inset-0 flex flex-col">
          <ChatPage />
        </div>
        <RadarContacts overlay />
      </div>
    ) : page === "workspace" ? (
      <WorkspacePage />
    ) : page === "memory" ? (
      // 记忆区：三层记忆 + 技能池（全部数据只在本机 localStorage）
      <MemoryPage />
    ) : page === "settings" ? (
      <SettingsPage />
    ) : (
      // 仅剩接口区未落地（记忆区已升级为 MemoryPage）
      <div className="p-6">
        <h1 className="text-lg font-extrabold">占位页面</h1>
        <p className="mt-2 text-[13px] text-muted">接口区（MCP/工具）二期开放</p>
      </div>
    );

  return (
    <div className="flex h-screen overflow-hidden border border-line bg-white">
      {navCollapsed ? <NavPeek /> : <NavRail />}
      <main className="flex min-w-0 flex-1 flex-col">{view}</main>
      <aside className="flex w-[240px] shrink-0 flex-col border-l border-line-soft">
        <div className="flex items-center justify-between border-b border-line-soft px-3 py-2">
          <span className="text-[11px] font-bold uppercase tracking-wider text-muted">目录</span>
          {usage && (
            <span className="text-[10px] text-muted">
              {fmtBytes(usage.used)} / {fmtBytes(usage.quota)}
            </span>
          )}
          <button
            type="button"
            onClick={() => void onUpload()}
            className="rounded-md border border-line px-2 py-0.5 text-[11px] shadow-card"
          >
            上传
          </button>
        </div>
        <div className="min-h-0 flex-1">
          <FileTree
            items={files}
            localPaths={[]}
            onPreview={setPreviewFile}
            onSendToConversation={(item) => {
              const { page, activeConversationId } = useUiStore.getState();
              if (page !== "chat" || !activeConversationId) {
                window.alert("先打开一个会话，再从目录发送文件");
                return;
              }
              useUiStore.getState().sendFileToConversation(activeConversationId, {
                id: item.id,
                name: item.name,
                mime: item.mime,
                size: item.size,
              });
            }}
          />
        </div>
        {previewFile && (
          <FilePreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />
        )}
      </aside>
    </div>
  );
}
