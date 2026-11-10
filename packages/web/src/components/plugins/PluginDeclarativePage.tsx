import type { ReactNode } from "react";
import type { PluginPageBlockV5, PluginPageV5 } from "@heming/shared";
import { pluginStore, type InstalledPlugin, type PluginCommandInfo, type PluginStore } from "../../lib/plugins/index.js";
import { ROUTABLE_PAGE_IDS } from "../../lib/palette/pages.js";
import { runPluginCommandTarget } from "../../lib/palette/pluginCommands.js";
import { skillPool } from "../../lib/skills/index.js";
import { useUiStore } from "../../store/ui.js";
import { PageShell } from "../layout/PageShell.js";
import { MarkdownMessage } from "../MarkdownMessage.js";
import { PluginPageIcon } from "./PluginPageIcon.js";
import { BTN_GHOST_SM, CHIP, HINT } from "./shared.js";

/**
 * 插件页 · 声明式渲染（d.124 A 路径）。
 *
 * 页面内容全部写在清单的 `contributions.page.blocks` 里，由宿主按固定词表渲染：
 * markdown / 指标卡 / 只读表 / 列表 / 动作 / 贡献清单。整页**只读**，不提供任何
 * 「编辑清单」入口——清单的写入仍然只走插件页的安装/更新事务，页面只是展示。
 *
 * ## 为什么逐块容错而不是信任类型
 *
 * 类型来自 `packages/shared` 的 zod 解析，正常安装的清单一定合法；但本机存储可能被
 * 旧版本写过、也可能被手工改坏。规格要求「未知/非法块跳过、生产不白屏」，
 * 所以这里在渲染前逐块做一次形状检查：坏块只丢自己，其余块照常显示。
 *
 * ## 为什么复用聊天侧 markdown 渲染器
 *
 * `MarkdownMessage` 就是聊天消息正文的渲染器，已经按「禁原始 HTML」配置
 * （不挂 rehype-raw）。另写一份轻量渲染器迟早会漏掉这条安全口径，
 * 所以页面里的 markdown 直接复用同一个组件。
 */

/** `PluginPageV5` 的声明式分支（`kind: "blocks"`）。 */
type DeclarativePageSpec = Extract<PluginPageV5, { kind: "blocks" }>;

export interface PluginDeclarativePageProps {
  /** 插件 id（路由 `plugin:<pluginId>` 里的部分，由 App 路由拆出传入）。 */
  pluginId: string;
  /**
   * 插件存储（默认全局单例）。
   *
   * 只依赖 `get()`：页面按 id 现读清单，插件升级/停用后重新进入即按新清单渲染，
   * 不做跨页缓存（缓存会让「更新后还是旧内容」这类问题很难排查）。
   */
  plugins?: Pick<PluginStore, "get">;
}

/** 贡献块的四类 kind 与中文标签（与插件页「贡献」行同一套说法）。 */
const CONTRIBUTION_LABELS = {
  skills: "技能",
  mcpServers: "MCP 服务",
  commands: "命令",
  toolPacks: "工具束",
} as const;

type ContributionKind = keyof typeof CONTRIBUTION_LABELS;

/** 形状检查后的一行指标/列表项（渲染期只认这三个字段）。 */
interface StatItem {
  label: string;
  value: string;
}

interface ListItem {
  title: string;
  description?: string;
  badge?: string;
}

/** 动作目标：与命令 target 同一个联合类型（页面/技能/插件/设置卡/能力单元）。 */
type ActionTarget = PluginCommandInfo["target"];

interface ActionItem {
  label: string;
  target: ActionTarget;
}

/* ───────────────────────── 形状检查（逐块容错） ───────────────────────── */

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asTextArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const out: string[] = [];
  for (const item of value) {
    const text = asText(item);
    if (text === null) return null;
    out.push(text);
  }
  return out;
}

/** 命令目标的最小形状检查：未知 kind / 缺字段即视为非法（该动作按钮跳过）。 */
function asTarget(value: unknown): ActionTarget | null {
  const record = asRecord(value);
  const kind = record ? asText(record.kind) : null;
  if (!record || !kind) return null;
  switch (kind) {
    case "page": {
      const page = asText(record.page);
      return page && page.trim() ? ({ kind: "page", page } as ActionTarget) : null;
    }
    case "skill": {
      const name = asText(record.name);
      return name && name.trim() ? ({ kind: "skill", name } as ActionTarget) : null;
    }
    case "plugin":
      return { kind: "plugin" } as ActionTarget;
    case "settings": {
      const card = asText(record.card);
      return card && card.trim() ? ({ kind: "settings", card } as ActionTarget) : null;
    }
    case "unit": {
      const unitId = asText(record.unitId);
      return unitId && unitId.trim() ? ({ kind: "unit", unitId } as ActionTarget) : null;
    }
    default:
      return null;
  }
}

function normalizeStats(raw: Record<string, unknown>): StatItem[] | null {
  if (!Array.isArray(raw.items) || raw.items.length === 0) return null;
  const items: StatItem[] = [];
  for (const entry of raw.items) {
    const record = asRecord(entry);
    const label = record ? asText(record.label) : null;
    const value = record ? asText(record.value) : null;
    // 单条坏数据只丢这一条；整块全坏才算非法块
    if (label === null || value === null) continue;
    items.push({ label, value });
  }
  return items.length > 0 ? items : null;
}

function normalizeTable(raw: Record<string, unknown>): {
  columns: string[];
  rows: string[][];
} | null {
  const columns = asTextArray(raw.columns);
  if (!columns || columns.length === 0) return null;
  const rows: string[][] = [];
  for (const entry of Array.isArray(raw.rows) ? raw.rows : []) {
    const row = asTextArray(entry);
    // 列数对不上的行直接跳过：渲染出来会错位，比少一行更难读
    if (!row || row.length !== columns.length) continue;
    rows.push(row);
  }
  return { columns, rows };
}

function normalizeList(raw: Record<string, unknown>): ListItem[] | null {
  if (!Array.isArray(raw.items) || raw.items.length === 0) return null;
  const items: ListItem[] = [];
  for (const entry of raw.items) {
    const record = asRecord(entry);
    if (!record) continue;
    const title = asText(record.title);
    if (title === null) continue;
    const description = asText(record.description) ?? undefined;
    const badge = asText(record.badge) ?? undefined;
    items.push({ title, description, badge });
  }
  return items.length > 0 ? items : null;
}

function normalizeActions(raw: Record<string, unknown>): ActionItem[] | null {
  if (!Array.isArray(raw.items) || raw.items.length === 0) return null;
  const items: ActionItem[] = [];
  for (const entry of raw.items) {
    const record = asRecord(entry);
    const label = record ? asText(record.label) : null;
    const target = record ? asTarget(record.target) : null;
    if (label === null || target === null) continue;
    items.push({ label, target });
  }
  return items.length > 0 ? items : null;
}

/** 把存储里的一块数据收成渲染器认识的最小形状；不认识返回 null（跳过该块）。 */
export function normalizePageBlock(raw: unknown): PluginPageBlockV5 | null {
  const record = asRecord(raw);
  const type = record ? asText(record.type) : null;
  if (!record || !type) return null;
  const title = asText(record.title) ?? undefined;
  const titlePart = title ? { title } : {};

  switch (type) {
    case "markdown": {
      const text = asText(record.text);
      return text === null ? null : ({ type, text, ...titlePart } as PluginPageBlockV5);
    }
    case "stats": {
      const items = normalizeStats(record);
      return items ? ({ type, items, ...titlePart } as PluginPageBlockV5) : null;
    }
    case "table": {
      const table = normalizeTable(record);
      return table ? ({ type, ...table, ...titlePart } as PluginPageBlockV5) : null;
    }
    case "list": {
      const items = normalizeList(record);
      return items ? ({ type, items, ...titlePart } as PluginPageBlockV5) : null;
    }
    case "actions": {
      const items = normalizeActions(record);
      return items ? ({ type, items, ...titlePart } as PluginPageBlockV5) : null;
    }
    case "contributions": {
      const kind = asText(record.kind);
      if (!kind || !(kind in CONTRIBUTION_LABELS)) return null;
      return { type, kind: kind as ContributionKind, ...titlePart } as PluginPageBlockV5;
    }
    default:
      return null;
  }
}

/* ────────────────────────────── 块渲染 ────────────────────────────── */

/** 每个块共用的外壳：可选标题 + 内容。标题为空时只渲染内容，不占一行。 */
function BlockSection({
  title,
  children,
  ariaLabel,
}: {
  title?: string;
  children: ReactNode;
  ariaLabel: string;
}) {
  return (
    <section aria-label={ariaLabel} className="ui-card p-4">
      {title ? <h2 className="ui-section-title">{title}</h2> : null}
      <div className={title ? "mt-2" : ""}>{children}</div>
    </section>
  );
}

function StatsBlock({ block }: { block: Extract<PluginPageBlockV5, { type: "stats" }> }) {
  return (
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {block.items.map((item, index) => (
        <div
          key={`${item.label}:${index}`}
          className="rounded-lg border border-line-soft bg-[var(--subtle-2)] px-3 py-2"
        >
          <dt className="ui-micro text-muted">{item.label}</dt>
          <dd className="ui-numeric mt-0.5 text-[15px] font-bold">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

function TableBlock({ block }: { block: Extract<PluginPageBlockV5, { type: "table" }> }) {
  return (
    // 窄窗里表格会溢出：横向滚动兜住（与聊天 markdown 表格同一做法）
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr>
            {block.columns.map((column, index) => (
              <th
                key={`${column}:${index}`}
                scope="col"
                className="border border-line-soft bg-[var(--subtle-2)] px-2 py-1 text-left font-bold"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {block.rows.map((row, rowIndex) => (
            <tr key={`row:${rowIndex}`}>
              {row.map((cell, cellIndex) => (
                <td
                  key={`cell:${cellIndex}`}
                  className="border border-line-soft px-2 py-1 align-top"
                >
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ListBlock({ block }: { block: Extract<PluginPageBlockV5, { type: "list" }> }) {
  return (
    <ul className="flex flex-col gap-1.5">
      {block.items.map((item, index) => (
        <li key={`${item.title}:${index}`} className="ui-list-row flex-col items-start gap-0.5">
          <div className="flex w-full flex-wrap items-center gap-2">
            <span className="ui-body-sm font-medium">{item.title}</span>
            {item.badge ? <span className={CHIP}>{item.badge}</span> : null}
          </div>
          {item.description ? <p className="ui-caption">{item.description}</p> : null}
        </li>
      ))}
    </ul>
  );
}

/** 贡献块：按 kind 列出本插件该类贡献的名称与数量；空则一句空态。 */
function ContributionsBlock({
  block,
  plugin,
}: {
  block: Extract<PluginPageBlockV5, { type: "contributions" }>;
  plugin: InstalledPlugin;
}) {
  const label = CONTRIBUTION_LABELS[block.kind];
  const contributions = plugin.manifest.contributions;
  const names: string[] = (() => {
    switch (block.kind) {
      case "skills":
        return contributions.skills.map((skill) => skill.name);
      case "mcpServers":
        return contributions.mcpServers.map((server) => server.name);
      case "commands":
        return contributions.commands.map((command) => command.title);
      case "toolPacks":
        return contributions.toolPacks.map((pack) => pack.name);
      default:
        return [];
    }
  })();

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="ui-body-sm font-medium">{label}</span>
        <span className={`${CHIP} ui-numeric`}>{names.length}</span>
      </div>
      {names.length === 0 ? (
        <p className={`mt-1 ${HINT}`}>这个插件还没有声明该类贡献</p>
      ) : (
        <ul className="mt-1 flex flex-wrap gap-1">
          {names.map((name, index) => (
            <li key={`${name}:${index}`} className={CHIP}>
              {name}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * 动作块：只做导航，不执行任何插件代码。
 *
 * target 与命令 target 同形，分发走 `runPluginCommandTarget`（与命令面板同一份真源）；
 * 页面白名单读取 `ROUTABLE_PAGE_IDS`，不在这里复制一份页面 id 列表。
 */
function ActionsBlock({
  block,
  plugin,
}: {
  block: Extract<PluginPageBlockV5, { type: "actions" }>;
  plugin: InstalledPlugin;
}) {
  const setPage = useUiStore((s) => s.setPage);
  const setPaletteIntent = useUiStore((s) => s.setPaletteIntent);

  const run = (target: ActionTarget) => {
    runPluginCommandTarget(target, {
      pluginId: plugin.manifest.id,
      // 声明式页的页面目标沿用「命令面板可路由页面」这一份白名单；
      // 插件页自身（plugin:<id>）由 Lead 的注册表在路由层判可用性。
      canOpenPage: (page) => ROUTABLE_PAGE_IDS.has(page),
      skillIdOf: (name) => skillPool.list().find((skill) => skill.name === name)?.id ?? null,
      setPage,
      setPaletteIntent,
    });
  };

  return (
    <div className="flex flex-wrap gap-2">
      {block.items.map((item, index) => (
        <button
          key={`${item.label}:${index}`}
          type="button"
          className={BTN_GHOST_SM}
          onClick={() => run(item.target)}
        >
          {item.label}
        </button>
      ))}
    </div>
  );
}

function PageBlock({
  block,
  plugin,
}: {
  block: PluginPageBlockV5;
  plugin: InstalledPlugin;
}) {
  const label = block.title ?? "页面内容";
  switch (block.type) {
    case "markdown":
      return (
        <BlockSection title={block.title} ariaLabel={`${label}（markdown）`}>
          <MarkdownMessage text={block.text} />
        </BlockSection>
      );
    case "stats":
      return (
        <BlockSection title={block.title} ariaLabel={`${label}（指标）`}>
          <StatsBlock block={block} />
        </BlockSection>
      );
    case "table":
      return (
        <BlockSection title={block.title} ariaLabel={`${label}（表格）`}>
          <TableBlock block={block} />
        </BlockSection>
      );
    case "list":
      return (
        <BlockSection title={block.title} ariaLabel={`${label}（列表）`}>
          <ListBlock block={block} />
        </BlockSection>
      );
    case "actions":
      return (
        <BlockSection title={block.title} ariaLabel={`${label}（动作）`}>
          <ActionsBlock block={block} plugin={plugin} />
        </BlockSection>
      );
    case "contributions":
      return (
        <BlockSection
          title={block.title}
          ariaLabel={`${block.title ?? CONTRIBUTION_LABELS[block.kind]}（贡献）`}
        >
          <ContributionsBlock block={block} plugin={plugin} />
        </BlockSection>
      );
    default:
      return null;
  }
}

/* ────────────────────────────── 页面本体 ────────────────────────────── */

/** 页面打不开时的统一空态：说明原因 + 回插件页，不渲染半截内容。 */
function UnavailablePage({ message }: { message: string }) {
  const setPage = useUiStore((s) => s.setPage);
  return (
    <PageShell title="插件页面" subtitle="这个页面暂时打不开。" width="readable">
      <section aria-label="插件页面不可用" className="ui-card p-5">
        <p className="ui-body-sm text-muted">{message}</p>
        <button type="button" className={`mt-3 ${BTN_GHOST_SM}`} onClick={() => setPage("plugins")}>
          去插件页
        </button>
      </section>
    </PageShell>
  );
}

export function PluginDeclarativePage({
  pluginId,
  plugins = pluginStore,
}: PluginDeclarativePageProps) {
  const plugin = plugins.get(pluginId);
  if (!plugin) {
    return <UnavailablePage message="没有找到这个插件，它可能已经卸载了。" />;
  }
  const page = plugin.manifest.contributions.page;
  if (!page) {
    return <UnavailablePage message="这个插件没有声明页面。" />;
  }
  // B 路径（界面插件自带页面）由 PluginBundlePage 渲染；这里只做防御性降级，
  // 避免路由错投时把 entry 当声明式页面渲染出一个空壳。
  if (page.kind !== "blocks") {
    return <UnavailablePage message="这个插件自带页面，只在安装版里可用。" />;
  }
  if (!plugin.enabled) {
    return <UnavailablePage message={`插件「${plugin.manifest.name}」已停用，重新启用后页面就能打开。`} />;
  }
  return <DeclarativePageBody plugin={plugin} page={page} />;
}

function DeclarativePageBody({
  plugin,
  page,
}: {
  plugin: InstalledPlugin;
  page: DeclarativePageSpec;
}) {
  // 逐块容错：坏块只丢自己并在控制台记一条，其余块照常渲染（生产不白屏）。
  const blocks = (Array.isArray(page.blocks) ? page.blocks : [])
    .map((raw, index) => {
      const block = normalizePageBlock(raw);
      if (!block) console.warn(`插件页面「${page.title}」的第 ${index + 1} 块无法识别，已跳过`);
      return block;
    })
    .filter((block): block is PluginPageBlockV5 => block !== null);

  return (
    <PageShell
      title={
        <span className="flex min-w-0 items-center gap-2">
          <PluginPageIcon icon={page.icon} size={18} />
          <span className="truncate">{page.title}</span>
        </span>
      }
      subtitle={page.summary || `来自插件「${plugin.manifest.name}」`}
      actions={
        <>
          <span className={CHIP}>声明式插件</span>
          <span className={CHIP}>v{plugin.manifest.version}</span>
        </>
      }
      width="readable"
    >
      <div className="flex flex-col gap-3" aria-label={`插件页面 ${page.title}`}>
        {blocks.length === 0 ? (
          <section aria-label="页面暂无内容" className="ui-card p-5">
            <p className="ui-body-sm text-muted">这个页面还没有可显示的内容。</p>
          </section>
        ) : (
          blocks.map((block, index) => (
            <PageBlock key={`block:${index}`} block={block} plugin={plugin} />
          ))
        )}
      </div>
    </PageShell>
  );
}
