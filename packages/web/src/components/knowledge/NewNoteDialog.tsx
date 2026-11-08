import { useRef, useState } from "react";
import { ConfirmDialog } from "../ConfirmDialog.js";
import { ensureMdExt } from "./model.js";

/**
 * 新建笔记弹窗：文件名 + 可选模板。
 *
 * 模板列表由调用方从 `templates/*.md` 里算好传进来（没有就是空列表，只给空白笔记）；
 * 真正的模板内容读取与变量填充由调用方在 `onCreate` 里做（要异步读文件）。
 */

export interface NewNoteDialogProps {
  /** 目标目录（用于提示「建在哪儿」；空串=库根）。 */
  dir: string;
  /** 可选模板；为空时只提供空白。 */
  templates: { rel: string; label: string }[];
  onCancel: () => void;
  onCreate: (fileName: string, templateRel: string | null) => void;
}

export function NewNoteDialog({ dir, templates, onCancel, onCreate }: NewNoteDialogProps) {
  const [name, setName] = useState("");
  const [templateRel, setTemplateRel] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const trimmed = name.trim();

  const submit = () => {
    if (!trimmed) return;
    onCreate(ensureMdExt(trimmed), templateRel || null);
  };

  return (
    <ConfirmDialog
      title="新建笔记"
      onCancel={onCancel}
      initialFocusRef={inputRef}
      footer={
        <>
          <button type="button" className="ui-btn ui-btn-md ui-btn-ghost" onClick={onCancel}>
            取消
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-md ui-btn-primary"
            disabled={!trimmed}
            onClick={submit}
          >
            新建
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex flex-col gap-3"
      >
        <label className="flex flex-col gap-1">
          <span className="ui-caption">笔记名</span>
          <input
            ref={inputRef}
            className="ui-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如 会议纪要"
            aria-label="笔记名"
          />
          <span className="ui-caption">
            建在 {dir ? <span className="text-ink">{dir}/</span> : "库根"}；不写扩展名会自动补 .md，
            可用 目录/文件名 建子目录。
          </span>
        </label>

        <label className="flex flex-col gap-1">
          <span className="ui-caption">模板</span>
          <select
            className="ui-input"
            value={templateRel}
            onChange={(e) => setTemplateRel(e.target.value)}
            aria-label="模板"
          >
            <option value="">空白笔记</option>
            {templates.map((item) => (
              <option key={item.rel} value={item.rel}>
                {item.label}
              </option>
            ))}
          </select>
          {templates.length === 0 ? (
            <span className="ui-caption">
              还没有模板：在库里建 templates/ 目录并放 .md 文件，这里就会出现候选。
            </span>
          ) : (
            <span className="ui-caption">模板里的 {"{{title}}"} / {"{{date}}"} 会被自动填好。</span>
          )}
        </label>
      </form>
    </ConfirmDialog>
  );
}
