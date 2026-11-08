import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { EditorMode } from "../../lib/vault/types.js";
import { loadCodeMirrorEditor } from "./editorCodeMirror.js";

/**
 * 知识库编辑器面板：CodeMirror 6 源码编辑 + 分栏预览 + 阅读态。
 *
 * 三态（`EditorMode`，契约在 `lib/vault/types.ts`）：
 * - `source`：只渲染源码编辑器（行号、搜索面板 Ctrl+F、Ctrl+S 保存）；
 * - `split`：左源码右预览（`renderPreview` 由页面注入，便于按需接双链/嵌入）；
 * - `read`：只渲染预览。
 *
 * 为什么把 CodeMirror 收在 `EditorLoader` 接口后面：
 * - 编辑器必须在**进知识库页**时才下载（规格 §10），静态 import 会进首屏 chunk；
 * - jsdom 跑不了真实编辑器（contenteditable/选区 API 不完整），测试注入假 loader，
 *   只断言宿主节点与回调接线，不测像素。
 *
 * 保存：Ctrl/⌘+S 由外层容器的捕获阶段处理（编辑器、搜索面板里都生效），
 * 不依赖 CodeMirror 的 keymap，因此也不存在「焦点不在编辑器里就存不了」的问题。
 */

/** 编辑器句柄：只暴露组件需要的动作，实现方可以是 CodeMirror 也可以是假实现。 */
export interface EditorHandle {
  getValue(): string;
  setValue(text: string): void;
  focus(): void;
  destroy(): void;
  /** 滚到某一行并聚焦（大纲/搜索跳转用；假实现可以不提供）。 */
  scrollToLine?(line: number): void;
}

/** 挂载参数（回调都是「最新值」语义，加载器只会在挂载时拿一次）。 */
export interface EditorHostOptions {
  doc: string;
  onDocChange: (text: string) => void;
  onSave: () => void;
}

/** 加载器：把宿主节点变成可编辑区域。 */
export type EditorLoader = (host: HTMLElement, options: EditorHostOptions) => Promise<EditorHandle>;

export interface EditorPaneProps {
  /** 当前文件 rel（切换文件时用来重建编辑器内容）。 */
  rel: string;
  /** 正文（受控：外部改动会同步进编辑器）。 */
  text: string;
  mode: EditorMode;
  /** 是否有未保存修改。 */
  dirty: boolean;
  /** 正文变化（写回 store 的 docs 缓存，不落盘）。 */
  onChange?: (text: string) => void;
  /** Ctrl/⌘+S 或工具栏保存。 */
  onSave?: () => void;
  /** 保存中（按钮禁用、文案变化）。 */
  saving?: boolean;
  /** split 模式右侧的预览内容（页面注入，编辑器不依赖预览的数据面）。 */
  renderPreview?: () => ReactNode;
  /** 保存失败等中文提示（直接显示 store.error，不自己编文案）。 */
  error?: string | null;
  /** 跳到某一行并聚焦（大纲/搜索结果跳转）。 */
  revealLine?: number | null;
  /** 测试注入；缺省懒加载 CodeMirror 6。 */
  loader?: EditorLoader;
}

export function EditorPane({
  rel,
  text,
  mode,
  dirty,
  onChange,
  onSave,
  saving = false,
  renderPreview,
  error,
  revealLine = null,
  loader,
}: EditorPaneProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<EditorHandle | null>(null);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // 回调放 ref：编辑器只在挂载时拿一份 options，之后 props 换新也不能丢
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const showEditor = mode !== "read";

  // 挂载/卸载编辑器。read 模式不挂（只渲染预览，省内存也省一次布局）。
  useEffect(() => {
    if (!showEditor) return;
    const host = hostRef.current;
    if (!host) return;
    let alive = true;
    let handle: EditorHandle | null = null;
    setReady(false);
    setLoadError(null);

    const load = loader ?? loadCodeMirrorEditor;
    void load(host, {
      doc: text,
      onDocChange: (next) => onChangeRef.current?.(next),
      onSave: () => onSaveRef.current?.(),
    })
      .then((created) => {
        if (!alive) {
          created.destroy();
          return;
        }
        handle = created;
        handleRef.current = created;
        setReady(true);
      })
      .catch((err: unknown) => {
        if (!alive) return;
        setLoadError(err instanceof Error ? err.message : "编辑器加载失败");
      });

    return () => {
      alive = false;
      handle?.destroy();
      handle = null;
      handleRef.current = null;
    };
    // rel 变化时彻底重建：换文件等于换文档，保留旧的撤销栈只会串味
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rel, showEditor, loader]);

  // 外部正文变化（例如 watch 检测到文件被改、撤销恢复）→ 同步进编辑器
  useEffect(() => {
    const handle = handleRef.current;
    if (!handle) return;
    if (handle.getValue() !== text) handle.setValue(text);
  }, [text, ready]);

  // 跳行：大纲/搜索结果点过来时滚到目标行（不支持的实现静默跳过）
  useEffect(() => {
    if (revealLine === null) return;
    handleRef.current?.scrollToLine?.(revealLine);
  }, [revealLine, ready]);

  // Ctrl/⌘+S：在捕获阶段拦下，编辑器与搜索面板里都生效；同时阻止浏览器「另存网页」
  const onKeyDownCapture = useCallback(
    (e: React.KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === "s") {
        e.preventDefault();
        e.stopPropagation();
        onSaveRef.current?.();
      }
    },
    [],
  );

  return (
    <div
      data-testid="editor-pane"
      className="flex h-full min-h-0 flex-col bg-surface"
      onKeyDownCapture={onKeyDownCapture}
    >
      {error ? (
        <p role="alert" className="ui-alert ui-alert-danger mx-3 mt-2">
          {error}
        </p>
      ) : null}

      <div className="flex min-h-0 flex-1">
        {showEditor ? (
          <div
            className={`relative min-h-0 overflow-hidden ${
              mode === "split" ? "w-1/2 border-r border-line-soft" : "flex-1"
            }`}
          >
            <div
              ref={hostRef}
              data-testid="vault-editor-host"
              className="h-full w-full overflow-auto"
              title={`编辑 ${rel}`}
            />
            {!ready && !loadError ? (
              <p className="pointer-events-none absolute inset-0 flex items-center justify-center text-[12px] text-muted">
                编辑器加载中…
              </p>
            ) : null}
            {loadError ? (
              <p role="alert" className="p-4 text-[12px] text-danger">
                编辑器加载失败：{loadError}。可以切到「阅读」查看内容。
              </p>
            ) : null}
          </div>
        ) : null}

        {mode !== "source" ? (
          <div
            className={`min-h-0 overflow-y-auto p-4 ${
              mode === "split" ? "w-1/2" : "flex-1"
            }`}
            data-testid="vault-preview-pane"
          >
            {renderPreview ? (
              renderPreview()
            ) : (
              <p className="text-[12px] text-muted">预览暂不可用。</p>
            )}
          </div>
        ) : null}
      </div>

      {/* 状态条：脏标记 + 保存入口；接的是 store 的真实 dirty/saving 状态 */}
      <div className="flex shrink-0 items-center gap-2 border-t border-line-soft px-3 py-1.5 text-[11px] text-muted">
        <span aria-live="polite">
          {saving ? "保存中…" : dirty ? "有未保存的修改" : "已保存"}
        </span>
        <span className="text-[10px]">Ctrl+S 保存{" · "}Ctrl+F 搜索</span>
        <button
          type="button"
          onClick={() => onSaveRef.current?.()}
          disabled={saving || !dirty}
          aria-label="保存当前笔记"
          className="ui-btn ui-btn-sm ui-btn-ghost ml-auto"
        >
          {saving ? "保存中" : "保存"}
        </button>
      </div>
    </div>
  );
}
