import { useEffect, useRef, useState } from "react";
import { MAX_PLUGINS, type PluginInstallPreview } from "../../lib/plugins/index.js";
import { useModalA11y } from "../useModalA11y.js";
import { XIcon } from "../icons.js";
import { PluginPermissionList } from "./PluginPermissionList.js";
import {
  BTN_GHOST,
  BTN_GHOST_SM,
  BTN_PRIMARY,
  CHIP,
  ERROR_TEXT,
  HINT,
  DiffLine,
  hasPreviewChanges,
  serverDiffLine,
} from "./shared.js";
import {
  authorChangeText,
  contributionText,
  manifestContributionCounts,
  permissionViewOf,
  shortFingerprint,
  trustStatusText,
} from "./viewModel.js";

/**
 * 安装 / 更新弹窗（d.64 · T2）。
 *
 * 解析成功后就地展示 v3 摘要：schemaVersion、贡献计数、权限清单（网络主机 ≤3 行 +
 * 共 N 项、风险上限、文件根）、与已装项差异（沿用 DiffChips）。
 * v1/v2 包可以安装，但明确标注「旧版清单（vN）：未声明权限，按既有口径处理」。
 */
export function InstallDialog({
  text,
  previewState,
  onTextChange,
  onFile,
  onInstall,
  onClose,
}: {
  text: string;
  previewState: { data: PluginInstallPreview | null; error: string | null };
  onTextChange: (next: string) => void;
  onFile: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onInstall: () => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalA11y(dialogRef, onClose, { active: true });

  const preview = previewState.data;
  const updating = Boolean(preview?.existing);
  /** 覆盖确认勾选（d.66）：needsConfirm 时必须显式勾选，换清单就复位。 */
  const [trustAcked, setTrustAcked] = useState(false);
  const trustFingerprint = preview?.trust.fingerprint ?? "";
  useEffect(() => {
    setTrustAcked(false);
  }, [trustFingerprint]);

  const needsTrustConfirm = Boolean(preview?.trust.needsConfirm);
  const trustConfirmId = "plugin-trust-confirm";
  const blocked = Boolean(
    preview &&
      (preview.conflicts.length > 0 ||
        preview.limitReached ||
        (needsTrustConfirm && !trustAcked)),
  );
  const authorChangedTip = preview ? authorChangeText(preview.trust, preview.manifest.author) : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4"
      onClick={onClose}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="安装插件"
        className="flex max-h-[88vh] w-[min(620px,94vw)] flex-col overflow-hidden rounded-xl border border-line bg-white shadow-card"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between gap-3 border-b border-line-soft px-4 py-2.5">
          <span className="ui-section-title">安装 / 更新插件</span>
          <button
            type="button"
            aria-label="关闭安装面板"
            onClick={onClose}
            className="rounded-sm p-1 text-muted hover:bg-[#f3f3f3] hover:text-ink"
          >
            <XIcon width={14} height={14} aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
          <label className="block ui-caption">
            插件清单 JSON
            <textarea
              aria-label="插件清单 JSON"
              value={text}
              onChange={(e) => onTextChange(e.target.value)}
              placeholder={`{\n  "schemaVersion": 3,\n  "id": "acme.finance",\n  "name": "财务助手包",\n  "version": "1.0.0",\n  "permissions": { "network": [], "tools": "read", "files": [] },\n  "contributions": {\n    "skills": [ ... ],\n    "mcpServers": [ ... ],\n    "commands": [ ... ]\n  }\n}`}
              className="mt-1 block min-h-[160px] w-full resize-y rounded-lg border border-line-strong px-3 py-2 font-mono text-[11px] outline-hidden focus:border-ink"
            />
          </label>

          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input
              id="plugin-file-input"
              type="file"
              accept=".json,application/json"
              aria-label="选择插件文件"
              onChange={onFile}
              className="hidden"
            />
            <label htmlFor="plugin-file-input" className={`cursor-pointer ${BTN_GHOST_SM}`}>
              选择 plugin.json 文件
            </label>
            <span className={HINT}>只读取本地 JSON；不会上传，也不会执行其中的内容。</span>
          </div>

          {previewState.error && (
            <p role="alert" className={`mt-3 ${ERROR_TEXT}`}>
              清单不合法：{previewState.error}
            </p>
          )}

          {preview && (
            <div className="mt-3 rounded-lg border border-line bg-[#fafafa] p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="ui-body-sm font-bold">{preview.manifest.name}</span>
                <span className={CHIP}>v{preview.manifest.version}</span>
                <span className={CHIP}>{updating ? "将覆盖更新" : "新插件"}</span>
                <span className={CHIP}>schemaVersion {preview.manifest.schemaVersion}</span>
              </div>
              <div className={`mt-0.5 ${HINT}`}>{preview.manifest.id}</div>
              <p className="mt-1 break-words ui-body-sm text-[#555]">
                {preview.manifest.description || "暂无描述"}
              </p>

              {/* 信任行（d.66）：内容指纹 + 首装/与上次相同/不同；不是签名，只发现悄悄改动 */}
              <div className="mt-1 flex flex-wrap items-center gap-2 ui-caption">
                <span
                  className="font-mono"
                  title={`内容指纹（FNV-1a 64，非密码学签名，不证明作者与来源）：${preview.trust.fingerprint}`}
                >
                  内容指纹 {shortFingerprint(preview.trust.fingerprint)}
                </span>
                <span className={CHIP}>{trustStatusText(preview.trust)}</span>
              </div>
              {authorChangedTip && (
                <p role="alert" className={`mt-1 ${ERROR_TEXT}`}>
                  {authorChangedTip}
                </p>
              )}
              {preview.trust.sameVersionContentChanged && (
                <p role="alert" className={`mt-1 ${ERROR_TEXT}`}>
                  版本未变，但内容有变化
                </p>
              )}

              {/* 贡献计数：与插件卡同一口径 */}
              <p className={`mt-1 ${HINT}`}>
                贡献：{contributionText(manifestContributionCounts(preview.manifest))}
              </p>

              <PluginPermissionList
                view={permissionViewOf(preview.manifest)}
                schemaVersion={preview.manifest.schemaVersion}
              />

              {updating ? (
                <div className="mt-2 space-y-2">
                  <DiffLine label="技能" diff={preview.skills} />
                  <DiffLine label="MCP 服务" diff={serverDiffLine(preview.servers)} />
                  <p className={HINT}>
                    {hasPreviewChanges(preview)
                      ? "确认后将保留：接口区补的请求头、已授权工具、插件启停状态与安装时间。"
                      : "清单与已装内容一致，确认后只刷新更新时间。"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {preview.manifest.contributions.skills.map((skill) => (
                      <span key={`skill:${skill.name}`} className={CHIP}>
                        {skill.name}
                      </span>
                    ))}
                    {preview.manifest.contributions.mcpServers.map((server) => (
                      <span key={`server:${server.key}`} className={CHIP} title={server.url}>
                        MCP · {server.name}
                      </span>
                    ))}
                    {preview.manifest.contributions.commands.map((command) => (
                      <span key={`command:${command.id}`} className={CHIP} title={command.description}>
                        命令 · {command.title}
                      </span>
                    ))}
                  </div>
                  <div className={`mt-2 ${HINT}`}>
                    新增 {preview.skills.added.length} 个技能、
                    {preview.servers.added.length} 台 MCP 服务
                  </div>
                </>
              )}

              {preview.manifest.contributions.mcpServers.length > 0 && (
                <div className={`mt-2 ${HINT}`}>
                  网络访问：{preview.hosts.join("、") || "—"}
                  <br />
                  安装后需到接口区连接并逐个启用工具；调用仍走人工确认。
                </div>
              )}

              {preview.conflicts.length > 0 && (
                <p role="alert" className={`mt-2 ${ERROR_TEXT}`}>
                  MCP 服务 id 冲突：
                  {preview.conflicts.map((item) => `${item.name}（${item.id}）`).join("、")}
                  ；请先到接口区删除或改名，再安装。
                </p>
              )}
              {preview.limitReached && (
                <p role="alert" className={`mt-2 ${ERROR_TEXT}`}>
                  插件数量已达上限（{MAX_PLUGINS} 个），请先卸载不用的插件。
                </p>
              )}

              {needsTrustConfirm && (
                <div className="mt-3 rounded-lg border border-[#f3d2ce] bg-[#fffafa] p-2.5">
                  <label className="flex items-start gap-2 ui-body-sm">
                    <input
                      type="checkbox"
                      checked={trustAcked}
                      onChange={(e) => setTrustAcked(e.target.checked)}
                      aria-describedby={`${trustConfirmId}-hint`}
                    />
                    我已确认这次覆盖更新
                  </label>
                  <p id={`${trustConfirmId}-hint`} className="mt-1 ui-caption">
                    该插件与已装版本内容不同（
                    {[
                      preview.trust.sameVersionContentChanged ? "版本未变" : "",
                      preview.trust.authorChanged ? "作者变化" : "",
                    ]
                      .filter(Boolean)
                      .join("、")}
                    ）。内容指纹只用于发现「内容被悄悄改过」，不是签名，不证明作者与来源。
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-line-soft px-4 py-2.5">
          <button type="button" onClick={onClose} className={BTN_GHOST}>
            取消
          </button>
          <button
            type="button"
            onClick={onInstall}
            disabled={!preview || blocked}
            aria-describedby={needsTrustConfirm ? `${trustConfirmId}-hint` : undefined}
            className={BTN_PRIMARY}
          >
            {updating ? "确认更新" : "确认安装"}
          </button>
        </div>
      </div>
    </div>
  );
}
