import { useState, type ReactNode } from "react";
import type { Heading, WikiLink } from "../../lib/vault/types.js";

/**
 * 右栏：反链 / 出链 / 未解析链接 / 大纲 / 属性（frontmatter）。
 *
 * 纯展示 + 回调：数据由知识库页从 `VaultIndex` 与当前文档算好传进来，本组件不 import
 * store 实现；测试可以直接喂最小数据，不依赖引擎。
 *
 * 无障碍：五个面板用标准 tablist/tab/tabpanel，方向键（←/→）切换，Tab 键能进入面板内容。
 */

export type BacklinkTab = "backlinks" | "outlinks" | "unresolved" | "outline" | "properties";

export interface BacklinkPaneProps {
  /** 当前文件 rel（只用于空态文案里点名）。 */
  rel: string;
  /** 指向当前文件的链接（VaultIndex.backlinks）。 */
  backlinks: WikiLink[];
  /** 当前文件指向的链接（解析成功与否都算）。 */
  outlinks: WikiLink[];
  /** 当前文件里未解析的链接（VaultIndex.unresolved 里筛 from=rel）。 */
  unresolved: WikiLink[];
  /** 当前文件的标题大纲。 */
  headings: Heading[];
  /** 当前文件的 frontmatter。 */
  frontmatter: Record<string, string | string[]>;
  /** 打开一个 rel。 */
  onOpen: (rel: string) => void;
  /** 未解析链接 → 创建该页。 */
  onCreatePage: (target: string) => void;
  /** 点大纲跳到编辑器行（1 基）。 */
  onJumpToLine?: (line: number) => void;
  /** 初始面板（缺省反链）。 */
  defaultTab?: BacklinkTab;
}

/** 面板顺序与文案：右侧窄栏按「谁引用我 → 我引用谁 → 断链 → 结构 → 元数据」排。 */
const TABS: { id: BacklinkTab; label: string }[] = [
  { id: "backlinks", label: "反链" },
  { id: "outlinks", label: "出链" },
  { id: "unresolved", label: "未解析" },
  { id: "outline", label: "大纲" },
  { id: "properties", label: "属性" },
];

/** 行按钮：整行可点，左侧主文案 + 右侧次要信息。 */
function Row({
  label,
  meta,
  onClick,
  title,
  ariaLabel,
}: {
  label: ReactNode;
  meta?: ReactNode;
  onClick: () => void;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={ariaLabel}
      className="flex w-full items-start gap-2 rounded-sm px-2 py-1 text-left text-[12px] leading-5 text-body transition-colors hover:bg-subtle-3 hover:text-ink"
    >
      <span className="min-w-0 flex-1 break-words">{label}</span>
      {meta ? <span className="shrink-0 text-[10px] text-muted">{meta}</span> : null}
    </button>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="px-2 py-3 text-[12px] leading-5 text-muted">{children}</p>;
}

export function BacklinkPane({
  rel,
  backlinks,
  outlinks,
  unresolved,
  headings,
  frontmatter,
  onOpen,
  onCreatePage,
  onJumpToLine,
  defaultTab = "backlinks",
}: BacklinkPaneProps) {
  const [tab, setTab] = useState<BacklinkTab>(defaultTab);
  const counts: Record<BacklinkTab, number> = {
    backlinks: backlinks.length,
    outlinks: outlinks.length,
    unresolved: unresolved.length,
    outline: headings.length,
    properties: Object.keys(frontmatter).length,
  };

  const onTabKeyDown = (e: React.KeyboardEvent) => {
    const index = TABS.findIndex((item) => item.id === tab);
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const delta = e.key === "ArrowRight" ? 1 : -1;
    setTab(TABS[(index + delta + TABS.length) % TABS.length].id);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        role="tablist"
        aria-label="笔记结构与链接"
        onKeyDown={onTabKeyDown}
        className="flex shrink-0 items-center gap-0.5 border-b border-line-soft px-1.5 py-1"
      >
        {TABS.map((item) => {
          const active = item.id === tab;
          return (
            <button
              key={item.id}
              type="button"
              role="tab"
              id={`vault-tab-${item.id}`}
              aria-selected={active}
              aria-controls={`vault-panel-${item.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => setTab(item.id)}
              className={`flex items-center gap-1 rounded-sm px-1.5 py-1 text-[11px] transition-colors ${
                active ? "bg-subtle-3 font-medium text-ink" : "text-muted hover:bg-subtle-2 hover:text-ink"
              }`}
            >
              {item.label}
              {counts[item.id] > 0 ? (
                <span className="ui-micro tabular-nums">{counts[item.id]}</span>
              ) : null}
            </button>
          );
        })}
      </div>

      <div
        role="tabpanel"
        id={`vault-panel-${tab}`}
        aria-labelledby={`vault-tab-${tab}`}
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
      >
        {tab === "backlinks" ? (
          backlinks.length === 0 ? (
            <Empty>还没有其它笔记链接到这里。在正文里写 [[{rel.split("/").pop()?.replace(/\.md$/i, "")}]] 就会出现在这里。</Empty>
          ) : (
            backlinks.map((link, index) => (
              <Row
                key={`${link.from}-${link.line}-${index}`}
                label={
                  <>
                    <span className="text-[#2563eb]">{link.from}</span>
                    {link.alias ? <span className="ml-1 text-muted">（{link.alias}）</span> : null}
                  </>
                }
                meta={
                  <>
                    第 {link.line} 行
                    {link.anchor === "miss" ? (
                      <span className="ml-1 text-warn">锚点未命中</span>
                    ) : null}
                  </>
                }
                onClick={() => onOpen(link.from)}
                ariaLabel={`打开反链来源 ${link.from} 第 ${link.line} 行${link.anchor === "miss" ? "（锚点未命中）" : ""}`}
              />
            ))
          )
        ) : null}

        {tab === "outlinks" ? (
          outlinks.length === 0 ? (
            <Empty>这篇笔记还没有出链。</Empty>
          ) : (
            outlinks.map((link, index) => {
              const label = link.alias ?? link.target;
              return (
                <Row
                  key={`${link.target}-${link.line}-${index}`}
                  label={
                    <>
                      {link.resolved ? <span className="text-[#2563eb]">{label}</span> : <span>{label}</span>}
                      {link.heading ? <span className="ml-1 text-muted">#{link.heading}</span> : null}
                      {link.embed ? <span className="ml-1 text-[10px] text-muted">嵌入</span> : null}
                    </>
                  }
                  meta={
                    link.resolved ? (
                      // 锚点未命中：文件已解析、标题找不到 → 黄色提示，不当断链
                      link.anchor === "miss" ? (
                        <span className="text-warn">锚点未命中</span>
                      ) : (
                        "已解析"
                      )
                    ) : (
                      "未解析"
                    )
                  }
                  onClick={() =>
                    link.resolved ? onOpen(link.resolved) : onCreatePage(link.target)
                  }
                  ariaLabel={
                    link.resolved
                      ? `打开出链目标 ${link.resolved}${link.anchor === "miss" ? "（锚点未命中）" : ""}`
                      : `创建页面 ${link.target}（当前未解析）`
                  }
                />
              );
            })
          )
        ) : null}

        {tab === "unresolved" ? (
          unresolved.length === 0 ? (
            <Empty>没有未解析的链接。</Empty>
          ) : (
            unresolved.map((link, index) => (
              <Row
                key={`${link.target}-${link.line}-${index}`}
                label={link.alias ?? link.target}
                meta="创建"
                onClick={() => onCreatePage(link.target)}
                ariaLabel={`创建页面 ${link.target}（当前未解析）`}
              />
            ))
          )
        ) : null}

        {tab === "outline" ? (
          headings.length === 0 ? (
            <Empty>还没有标题。用 # / ## 写小节就会出现在大纲里。</Empty>
          ) : (
            headings.map((heading, index) => (
              <Row
                key={`${heading.line}-${index}`}
                label={heading.text}
                meta={`第 ${heading.line} 行`}
                onClick={() => onJumpToLine?.(heading.line)}
                ariaLabel={`跳到标题 ${heading.text}`}
              />
            ))
          )
        ) : null}

        {tab === "properties" ? (
          Object.keys(frontmatter).length === 0 ? (
            <Empty>这篇笔记没有属性。在文件开头写 --- 包裹的 frontmatter 就会出现。</Empty>
          ) : (
            <table className="w-full border-collapse text-[12px]">
              <tbody>
                {Object.entries(frontmatter).map(([key, value]) => (
                  <tr key={key} className="align-top">
                    <th className="w-[38%] border-b border-line-soft px-2 py-1 text-left font-medium text-muted">
                      {key}
                    </th>
                    <td className="border-b border-line-soft px-2 py-1 text-ink">
                      {Array.isArray(value) ? value.join("、") : value}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )
        ) : null}
      </div>
    </div>
  );
}
