import type { EditorHandle, EditorHostOptions, EditorLoader } from "./EditorPane.js";

/**
 * CodeMirror 6 的真实加载器（**懒加载**：只在知识库页第一次挂编辑器时才 import）。
 *
 * 为什么单独一个文件：`@codemirror/*` 六个包合计几百 KB，静态度 import 会被打进
 * 主 chunk，让主页/聊天首屏跟着付这份成本（规格 §10「CodeMirror 6 增加包体」）。
 * 这里把动态 `import()` 收在一处：
 * - 打包器按静态说明符切出独立 chunk，进知识库页才下载；
 * - 编辑器组件只依赖 `EditorLoader` 接口，jsdom 用例注入假 loader，不加载真编辑器。
 *
 * 主题全部走仓库的 CSS 变量（`--surface` / `--ink` / `--subtle` …），暗色下自动可读；
 * 不写死亮色（d.68 的教训：`bg-white` 这类硬编码亮色在暗色主题下会变成白底浅字）。
 */

export const loadCodeMirrorEditor: EditorLoader = async (
  host: HTMLElement,
  options: EditorHostOptions,
): Promise<EditorHandle> => {
  const [viewMod, stateMod, markdownMod, commandsMod, searchMod, languageMod] = await Promise.all([
    import("@codemirror/view"),
    import("@codemirror/state"),
    import("@codemirror/lang-markdown"),
    import("@codemirror/commands"),
    import("@codemirror/search"),
    import("@codemirror/language"),
  ]);

  const { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection } = viewMod;
  const { EditorState } = stateMod;
  const { markdown } = markdownMod;
  const { defaultKeymap, history, historyKeymap } = commandsMod;
  const { searchKeymap } = searchMod;
  const { defaultHighlightStyle, syntaxHighlighting } = languageMod;

  const theme = EditorView.theme({
    "&": {
      backgroundColor: "var(--surface)",
      color: "var(--ink)",
      height: "100%",
    },
    ".cm-scroller": {
      fontFamily:
        "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Courier New', monospace",
      fontSize: "13px",
      lineHeight: "1.75",
    },
    ".cm-content": { padding: "6px 0" },
    ".cm-gutters": {
      backgroundColor: "var(--subtle)",
      color: "var(--muted)",
      border: "none",
    },
    ".cm-activeLine": { backgroundColor: "var(--subtle-2)" },
    ".cm-activeLineGutter": { backgroundColor: "var(--subtle-3)" },
    "&.cm-focused": { outline: "none" },
    ".cm-panels": {
      backgroundColor: "var(--subtle)",
      color: "var(--ink)",
      borderColor: "var(--line)",
    },
    ".cm-panels.cm-panels-top": { borderBottom: "1px solid var(--line-soft)" },
    ".cm-searchMatch": {
      backgroundColor: "var(--warn-soft, rgba(245, 158, 11, 0.25))",
    },
    ".cm-selectionBackground, ::selection": {
      backgroundColor: "var(--subtle-4)",
    },
  });

  const state = EditorState.create({
    doc: options.doc,
    extensions: [
      lineNumbers(),
      highlightActiveLine(),
      drawSelection(),
      history(),
      markdown(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      theme,
      keymap.of([...searchKeymap, ...historyKeymap, ...defaultKeymap]),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        options.onDocChange(update.state.doc.toString());
      }),
    ],
  });

  const view = new EditorView({ state, parent: host });

  return {
    getValue: () => view.state.doc.toString(),
    setValue: (text: string) => {
      if (view.state.doc.toString() === text) return;
      view.dispatch({
        changes: { from: 0, to: view.state.doc.length, insert: text },
      });
    },
    focus: () => view.focus(),
    scrollToLine: (line: number) => {
      const clamped = Math.min(Math.max(1, line), view.state.doc.lines);
      const target = view.state.doc.line(clamped);
      view.dispatch({
        selection: { anchor: target.from },
        effects: EditorView.scrollIntoView(target.from, { y: "center" }),
      });
      view.focus();
    },
    destroy: () => view.destroy(),
  };
};
