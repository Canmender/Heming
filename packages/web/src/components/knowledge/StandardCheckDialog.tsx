import { useRef } from "react";
import { ConfirmDialog } from "../ConfirmDialog.js";
import type { StandardReport } from "../../lib/vault/standard.js";

/**
 * 「标准检查」弹窗（知识库页页头入口）。
 *
 * 只做展示与两个动作：重新检查 / 一键补齐结构。数据面全部来自
 * `lib/vault/standard.ts`（检查是纯函数、补齐只补缺），本组件不读文件、不拼路径。
 *
 * 三条产品口径：
 * 1. **不静默改用户内容**：缺 frontmatter 的页面只列出来，按钮只补目录与根文件；
 * 2. **部分失败要说清楚**：补齐失败项逐条列出（路径 + 中文原因），不把「补了一半」说成成功；
 * 3. **索引未就绪要说明**：frontmatter 检查依赖索引，没索引时明说「这次只查了结构」，
 *    而不是显示一个看似通过的绿色结论。
 */
export interface StandardCheckDialogProps {
  /** 当前库根（展示用；用户在页脚也能看到同一个路径）。 */
  rootPath: string;
  /** 检查结果；null = 还没检查完（或检查失败）。 */
  report: StandardReport | null;
  /** 正在检查。 */
  checking: boolean;
  /** 正在补齐。 */
  repairing: boolean;
  /** 检查/补齐的中文结果（原样展示，不在这里编文案）。 */
  message: string | null;
  /** 补齐失败项。 */
  failures: { rel: string; message: string }[];
  onCheck: () => void;
  onRepair: () => void;
  onClose: () => void;
}

/** 一行「缺失清单」：说明 + 路径列表（超过 8 条折叠成计数，避免弹窗被撑满）。 */
function IssueList({
  title,
  items,
  hint,
}: {
  title: string;
  items: string[];
  hint?: string;
}) {
  if (items.length === 0) return null;
  const shown = items.slice(0, 8);
  return (
    <div className="flex flex-col gap-1">
      <span className="ui-body-sm font-medium text-ink">
        {title}（{items.length}）
      </span>
      <ul className="ui-caption flex flex-col gap-0.5 text-muted">
        {shown.map((item) => (
          <li key={item} className="truncate" title={item}>
            · {item}
          </li>
        ))}
        {items.length > shown.length ? <li>…还有 {items.length - shown.length} 项</li> : null}
      </ul>
      {hint ? <span className="ui-caption text-muted">{hint}</span> : null}
    </div>
  );
}

export function StandardCheckDialog({
  rootPath,
  report,
  checking,
  repairing,
  message,
  failures,
  onCheck,
  onRepair,
  onClose,
}: StandardCheckDialogProps) {
  const repairRef = useRef<HTMLButtonElement>(null);
  const canRepair =
    report !== null && !report.complete && !checking && !repairing &&
    // 只剩下「缺 frontmatter」时没有可自动补的结构项：按钮不该假装能修
    (report.missingDirs.length > 0 || report.missingFiles.length > 0);

  return (
    <ConfirmDialog
      title="标准检查"
      onCancel={onClose}
      // 只有补齐按钮真的可点时把它当落点；否则退回骨架默认（第一个按钮 = 关闭）
      initialFocusRef={canRepair ? repairRef : undefined}
      footer={
        <>
          <button type="button" className="ui-btn ui-btn-md ui-btn-ghost" onClick={onClose}>
            关闭
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-md ui-btn-ghost"
            onClick={onCheck}
            disabled={checking || repairing}
          >
            {checking ? "检查中…" : "重新检查"}
          </button>
          <button
            ref={repairRef}
            type="button"
            className="ui-btn ui-btn-md ui-btn-primary"
            onClick={onRepair}
            disabled={!canRepair}
            title={
              report && report.complete
                ? "结构已经完整，没有需要补齐的内容"
                : report && !canRepair
                  ? "只缺页面 frontmatter：这类内容不会被自动改写"
                  : "只创建缺失的目录与根文件，不覆盖任何已有内容"
            }
          >
            {repairing ? "补齐中…" : "一键补齐结构"}
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <p className="ui-body-sm text-muted">
          按卡帕西 LLM Wiki 标准：应有 <code className="rounded-sm bg-subtle-3 px-1">raw/</code>、
          <code className="rounded-sm bg-subtle-3 px-1">wiki/{"{类别}"}/</code> 与
          <code className="rounded-sm bg-subtle-3 px-1">index.md</code> /
          <code className="rounded-sm bg-subtle-3 px-1">log.md</code> /
          <code className="rounded-sm bg-subtle-3 px-1">schema.md</code> /
          <code className="rounded-sm bg-subtle-3 px-1">首页.md</code>；
          每篇 .md 都要有 <code className="rounded-sm bg-subtle-3 px-1">created</code> 与{" "}
          <code className="rounded-sm bg-subtle-3 px-1">tags</code>。
        </p>
        {rootPath ? (
          <p className="ui-caption break-all text-muted">当前库根：{rootPath}</p>
        ) : null}

        {message ? (
          <p role="status" className="ui-alert ui-alert-muted">
            {message}
          </p>
        ) : null}

        {failures.length > 0 ? (
          <div role="alert" className="ui-alert ui-alert-danger flex flex-col gap-1">
            <span className="font-medium">这些没补上（可以稍后重试）：</span>
            <ul className="flex flex-col gap-0.5">
              {failures.map((item) => (
                <li key={item.rel} className="break-all">
                  · {item.rel}：{item.message}
                </li>
              ))}
            </ul>
          </div>
        ) : null}

        {checking && !report ? <p className="ui-caption text-muted">正在检查…</p> : null}

        {report ? (
          report.complete ? (
            <p role="status" className="ui-alert ui-alert-muted">
              结构完整：目录、四个根文件
              {report.frontmatterChecked
                ? `与扫过的 ${report.scannedPages} 篇页面的 frontmatter 都符合标准。`
                : "都齐全。（索引还没建好，这次只查了结构；建好索引后可再查页面 frontmatter。）"}
            </p>
          ) : (
            <div className="flex flex-col gap-3">
              <IssueList title="缺目录" items={report.missingDirs} hint="补齐会按标准建好这些文件夹。" />
              <IssueList
                title="缺根文件"
                items={report.missingFiles}
                hint="补齐只创建空模板，已有文件不会被覆盖。"
              />
              <IssueList
                title="缺 frontmatter 的页面"
                items={report.pageIssues.map(
                  (item) => `${item.rel}（缺 ${item.missing.join(" / ")}）`,
                )}
                hint={
                  report.frontmatterChecked
                    ? "这些页面不会被自动改写：created 只有作者知道，请手动补上 YAML 头。"
                    : "索引还没建好，暂时没法检查页面 frontmatter；建好索引后再查一次。"
                }
              />
              {report.pageIssueCount > report.pageIssues.length ? (
                <p className="ui-caption text-muted">
                  还有 {report.pageIssueCount - report.pageIssues.length} 篇未列出（只展示前{" "}
                  {report.pageIssues.length} 篇）。
                </p>
              ) : null}
              {report.missingDirs.length === 0 && report.missingFiles.length === 0 ? (
                <p className="ui-caption text-muted">
                  目录与根文件都齐了，剩下的是页面 frontmatter 问题——避免覆盖你的正文，这类不会自动补。
                </p>
              ) : null}
            </div>
          )
        ) : null}

        <p className="ui-caption text-muted">
          说明：<code className="rounded-sm bg-subtle-3 px-1">index.md</code> /{" "}
          <code className="rounded-sm bg-subtle-3 px-1">log.md</code> 由智能体维护、人这边只做检查；
          <code className="rounded-sm bg-subtle-3 px-1">raw/</code> 是只读来源，编辑器不会允许修改。
        </p>
      </div>
    </ConfirmDialog>
  );
}
