/**
 * 代码高亮（shiki）单例 —— 精细导入版。
 *
 * ## 为什么用 shiki 而不是 highlight.js / prism
 *
 * 三者许可都是 MIT，功能也都能用。选 shiki 是因为它与 VS Code 同一套 TextMate
 * 语法与主题——用户在编辑器里看到的配色，和聊天里看到的完全一致。
 *
 * ## 为什么不用 `createHighlighter`
 *
 * 一开始用的是便捷入口 `createHighlighter({ langs: [...] })`，以为传数组就只打包
 * 那几种。**实测不是**：它的语言表是动态 import 的，Rollup 无法静态裁剪，
 * 结果把 shiki 支持的上百种语言全打进产物——构建产物从 685KB 涨到 **12MB**、
 * 多出 309 个 JS 文件，里面全是 emacs-lisp、wolfram、vue-vine 这些
 * 我们永远不会用到的语法。
 *
 * 所以改用 `createHighlighterCore` + 逐个 `import` 语言模块：
 * 静态依赖能被 bundler 精确裁剪，只留下面这张表里的语言。
 *
 * ## 为什么是异步
 *
 * shiki 需要加载 wasm 引擎与语法定义。同步阻塞会让首条消息卡住，
 * 所以返回 Promise：调用方先渲染纯文本，高亮好了再替换。
 */

import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createOnigurumaEngine } from "shiki/engine/oniguruma";

/**
 * 浅色主题：与和鸣的极简白底一致。
 * 不用深色主题——消息气泡是白底，深色代码块会像贴了张膏药。
 */
const THEME_NAME = "github-light";

let highlighterPromise: Promise<HighlighterCore | null> | null = null;

/**
 * 取共享的高亮器。失败返回 null（调用方回落纯文本）。
 *
 * 失败不抛：高亮是锦上添花，语法定义加载失败不该让整条消息渲染不出来。
 * 也记住失败结果，避免每条消息都重试一遍。
 */
export function getHighlighter(): Promise<HighlighterCore | null> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      try {
        const [theme, engine, ...langs] = await Promise.all([
          import("shiki/themes/github-light.mjs"),
          createOnigurumaEngine(import("shiki/wasm")),
          import("shiki/langs/javascript.mjs"),
          import("shiki/langs/typescript.mjs"),
          import("shiki/langs/tsx.mjs"),
          import("shiki/langs/jsx.mjs"),
          import("shiki/langs/python.mjs"),
          import("shiki/langs/json.mjs"),
          import("shiki/langs/bash.mjs"),
          import("shiki/langs/css.mjs"),
          import("shiki/langs/html.mjs"),
          import("shiki/langs/markdown.mjs"),
          import("shiki/langs/sql.mjs"),
          import("shiki/langs/yaml.mjs"),
          import("shiki/langs/diff.mjs"),
          import("shiki/langs/go.mjs"),
          import("shiki/langs/rust.mjs"),
        ]);
        return await createHighlighterCore({
          themes: [theme.default],
          langs: langs.map((m) => (m as { default: never }).default),
          engine,
        });
      } catch {
        return null;
      }
    })();
  }
  return highlighterPromise;
}

/** 语言别名 → shiki 认识的 id。用户常写 js/py/sh 这类缩写。 */
const ALIASES: Record<string, string> = {
  js: "javascript",
  ts: "typescript",
  py: "python",
  sh: "bash",
  zsh: "bash",
  shell: "bash",
  yml: "yaml",
  md: "markdown",
  htm: "html",
  rs: "rust",
  golang: "go",
};

/**
 * 把代码高亮成 HTML。未知语言或加载失败时返回 null，调用方回落纯文本。
 *
 * @param code 代码正文
 * @param lang 围栏上标注的语言（可能为空、可能是别名、可能是乱写的）
 */
export async function highlightCode(code: string, lang: string): Promise<string | null> {
  const highlighter = await getHighlighter();
  if (!highlighter) return null;

  const normalized = (lang || "").trim().toLowerCase();
  const candidate = ALIASES[normalized] ?? normalized;

  // 没标语言按纯文本处理：不猜，猜错会把中文注释染成关键字
  if (!candidate) return null;

  try {
    if (!highlighter.getLoadedLanguages().includes(candidate)) return null;
    return highlighter.codeToHtml(code, { lang: candidate, theme: THEME_NAME });
  } catch {
    // 语法定义存在但解析失败（罕见，多见于极端嵌套）——回落纯文本
    return null;
  }
}