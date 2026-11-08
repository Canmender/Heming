import { useRef, useState } from "react";
import {
  DEFAULT_DAILY_CONFIG,
  resolveDailyConfig,
  type DailyConfig,
} from "../../lib/vault/daily.js";
import { dailyNotePath } from "../../lib/vault/daily.js";
import { formatDateTokens } from "../../lib/vault/template.js";
import { ConfirmDialog } from "../ConfirmDialog.js";

/**
 * 知识库设置弹窗：日记文件夹 / 日期格式 / 日记模板。
 *
 * 校验与路径计算全部交给引擎 `lib/vault/daily.ts`（`resolveDailyConfig` 会给出
 * 回退后的配置与中文原因，`dailyNotePath` 拼路径）；界面只负责编辑与预览，
 * 不再自己实现一份格式合法性判断。
 */

export interface VaultSettingsDialogProps {
  config: DailyConfig;
  /** 可选模板（`templates/*.md`）；为空时只提供「不用模板」。 */
  templates: { rel: string; label: string }[];
  onCancel: () => void;
  onSave: (config: DailyConfig) => void;
}

export function VaultSettingsDialog({
  config,
  templates,
  onCancel,
  onSave,
}: VaultSettingsDialogProps) {
  const [folder, setFolder] = useState(config.folder);
  const [format, setFormat] = useState(config.format);
  const [templatePath, setTemplatePath] = useState(config.templatePath ?? "");
  const folderRef = useRef<HTMLInputElement>(null);
  const today = new Date();

  const resolved = resolveDailyConfig({ folder, format, templatePath: templatePath || undefined });
  const preview = dailyNotePath(resolved.config, today);
  const previewName = formatDateTokens(today, resolved.config.format);

  return (
    <ConfirmDialog
      title="知识库设置"
      onCancel={onCancel}
      initialFocusRef={folderRef}
      footer={
        <>
          <button type="button" className="ui-btn ui-btn-md ui-btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-md ui-btn-primary"
            onClick={() => onSave(resolved.config)}
          >
            保存
          </button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <label className="flex flex-col gap-1">
          <span className="ui-caption">日记文件夹</span>
          <input
            ref={folderRef}
            className="ui-input"
            value={folder}
            onChange={(e) => setFolder(e.target.value)}
            placeholder={DEFAULT_DAILY_CONFIG.folder}
            aria-label="日记文件夹"
          />
          <span className="ui-caption">库内相对目录；留空表示放在库根。</span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="ui-caption">日期格式</span>
          <input
            className="ui-input"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            placeholder={DEFAULT_DAILY_CONFIG.format}
            aria-label="日期格式"
          />
          <span className="ui-caption">
            支持 Y / YY / YYYY / M / MM / D / DD（还可写 H / HH / m / mm / s）。
            今天会打开：<span className="ml-1 text-ink">{preview}</span>
            <span className="ml-1">（{previewName}）</span>
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="ui-caption">日记模板</span>
          <select
            className="ui-input"
            value={templatePath}
            onChange={(e) => setTemplatePath(e.target.value)}
            aria-label="日记模板"
          >
            <option value="">不用模板（只写 date 与标题）</option>
            {templates.map((item) => (
              <option key={item.rel} value={item.rel}>
                {item.label}
              </option>
            ))}
          </select>
          <span className="ui-caption">
            {templates.length > 0
              ? "模板里可用 {{title}} / {{date}} / {{time}} / {{vault}} 占位符。"
              : "还没有模板：在库里建 templates/ 目录并放 .md 文件，这里就会出现候选。"}
          </span>
        </label>

        {resolved.fallback ? (
          <p role="alert" className="ui-alert ui-alert-muted">
            配置有一项不合法，保存时会按引擎的回退值生效：{resolved.reason}
          </p>
        ) : null}
      </div>
    </ConfirmDialog>
  );
}
